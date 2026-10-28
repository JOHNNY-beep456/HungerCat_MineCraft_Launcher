/**
 * AI 悬浮球（`?window=ai-ball`）。
 *
 * 这是一个**独立渲染进程**，不挂 AppProvider —— 悬浮球要在主窗口关闭 / 最小化
 * 甚至被全屏游戏盖住时仍然秒开，所以它只做三件事：拿设置、聊一句、拖动自己。
 * 挂上完整启动器会让这扇小窗背上账号 / 主页 / 更新检查那一堆启动开销。
 *
 * 两种形态共用一个窗口（主进程改尺寸，见 main/ai/ball.ts）：
 *   · 收起：圆形按钮，可拖动，单击展开；
 *   · 展开：聊天面板，头部同样可拖动，右上角有「新对话 / 收起」。
 *
 * 展开态不放「关闭」按钮：那等于关掉悬浮球开关，而悬浮球是否出现已经在
 * 「设置 → AI 助手 → 桌面悬浮球」里控制，两处入口表达同一件事容易让人误以为是
 * 「关掉这个面板」。收起（chevronLeft）就够了 —— 要彻底关掉，去设置里关开关。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiToolRequest, LauncherSettings } from '@shared/types'
import { createTranslator, isLocale, type TFunction } from '../i18n'
import { Button, Icon } from './ui'

/** 本地消息（只用于展示，真实历史在主进程）。 */
interface Bubble {
  role: 'user' | 'assistant'
  text: string
  failed?: boolean
}

/** 录音最长时长：防止误触后一直录（也避免转写接口收到超大文件）。 */
const MAX_RECORD_MS = 60_000

export function AiBall(): JSX.Element {
  const [settings, setSettings] = useState<LauncherSettings | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const [toolReq, setToolReq] = useState<AiToolRequest | null>(null)
  const [notice, setNotice] = useState('')

  const tRef = useRef<TFunction>((k: string) => k)
  const listRef = useRef<HTMLDivElement | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recordTimerRef = useRef<number | null>(null)

  const t = tRef.current

  /* -------------------- 设置 / 文案 -------------------- */

  useEffect(() => {
    let alive = true
    void (async () => {
      const s = await window.api.settings.get()
      if (!alive) return
      setSettings(s)
      tRef.current = createTranslator(isLocale(s.language) ? s.language : 'zh-CN')
      // 语言变了要重渲染（译函数换了），用一个空状态更新驱动。
      setNotice('')
    })()
    return () => {
      alive = false
    }
  }, [])

  /** 订阅「需要用户确认的工具调用」。 */
  useEffect(() => window.api.ai.onToolRequest((req) => setToolReq(req)), [])

  /**
   * 订阅主进程的展开 / 收起结果。
   *
   * 窗口尺寸由主进程改动（`expandAiBall`），渲染层必须跟着切换形态，否则会出现
   * 「窗口已经是 400×580、里面画着的还是 76×76 的圆球」这种错位。
   * 渲染层自己点开时也已经本地 setExpanded 过，这里再收一次是幂等的。
   */
  useEffect(() => {
    return window.api.ai.onBallExpanded((open) => setExpanded(open))
  }, [])

  /** 滚动到最新一条。 */
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [bubbles, busy])

  /**
   * 卸载收尾：停录音、清定时器、停朗读。
   *
   * 悬浮球关闭（在设置里关掉开关）时窗口会被销毁。这些资源不跟着释放的话，
   * 麦克风指示灯会一直亮着，朗读也会继续念下去。
   */
  useEffect(() => {
    return () => {
      if (recordTimerRef.current) {
        window.clearTimeout(recordTimerRef.current)
        recordTimerRef.current = null
      }
      try {
        recorderRef.current?.stop()
      } catch {
        /* 已停止 */
      }
      recorderRef.current = null
      try {
        window.speechSynthesis?.cancel()
      } catch {
        /* 无语音合成能力 */
      }
    }
  }, [])

  /* -------------------- 朗读 -------------------- */

  /** 去掉 Markdown 记号再朗读，否则会把星号、反引号念出来。 */
  const speak = useCallback((text: string): void => {
    if (!settings?.aiVoiceEnabled || !text.trim()) return
    try {
      const clean = text
        .replace(/```[\s\S]*?```/g, '（代码块略）')
        .replace(/[`*_#>]/g, '')
        .replace(/\[(.*?)\]\(.*?\)/g, '$1')
        .slice(0, 800)
      const utter = new SpeechSynthesisUtterance(clean)
      utter.lang = 'zh-CN'
      utter.onstart = () => void window.api.ai.setHudStatus('speaking')
      utter.onend = () => void window.api.ai.setHudStatus('idle')
      // 合成被中断（切到别的语句、系统取消）时不一定有 onend，
      // 不处理的话浮层会一直停在「播报中…」。
      utter.onerror = () => void window.api.ai.setHudStatus('idle')
      window.speechSynthesis.cancel()
      window.speechSynthesis.speak(utter)
    } catch {
      // 无语音合成能力时静默跳过：文字回答仍然完整。
    }
  }, [settings])

  /* -------------------- 对话 -------------------- */

  const send = useCallback(
    async (raw: string): Promise<void> => {
      const text = raw.trim()
      if (!text || busy) return
      setInput('')
      setBubbles((b) => [...b, { role: 'user', text }])
      setBusy(true)
      void window.api.ai.setHudStatus('thinking')
      try {
        const r = await window.api.ai.chat(text, '用户正在通过桌面悬浮球与我对话。')
        if (r.ok) {
          if (r.text) {
            setBubbles((b) => [...b, { role: 'assistant', text: r.text }])
            speak(r.text)
          }
        } else {
          setBubbles((b) => [...b, { role: 'assistant', text: r.error || t('ai.analysisFailed', { msg: '' }), failed: true }])
        }
      } catch (err) {
        setBubbles((b) => [
          ...b,
          { role: 'assistant', text: err instanceof Error ? err.message : String(err), failed: true }
        ])
      } finally {
        setBusy(false)
        void window.api.ai.setHudStatus('idle')
      }
    },
    [busy, speak, t]
  )

  /* -------------------- 语音输入 -------------------- */

  const stopRecording = useCallback((): void => {
    if (recordTimerRef.current) {
      window.clearTimeout(recordTimerRef.current)
      recordTimerRef.current = null
    }
    recorderRef.current?.stop()
    recorderRef.current = null
  }, [])

  const startRecording = useCallback(async (): Promise<void> => {
    if (recording || busy) return
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      setNotice(t('ai.voiceUnsupported'))
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // 优先 webm（Chromium 全平台支持）；个别系统会抛 NotSupportedError，此时用默认格式。
      let rec: MediaRecorder
      try {
        rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
      } catch {
        try {
          rec = new MediaRecorder(stream)
        } catch {
          // 两种构造都失败：自己关掉音轨，否则麦克风会一直亮着。
          stream.getTracks().forEach((tr) => tr.stop())
          throw new Error('无法创建录音器')
        }
      }
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop())
        setRecording(false)
        void (async () => {
          const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
          if (blob.size < 1024) return
          setNotice(t('ai.listening'))
          const mime = (rec.mimeType || 'audio/webm').split(';')[0]
          const bytes = new Uint8Array(await blob.arrayBuffer())
          const r = await window.api.ai.transcribe(bytes, mime)
          setNotice('')
          if (r.ok && r.text) await send(r.text)
          else if (!r.ok) setNotice(t('ai.voiceError', { msg: r.error ?? '' }))
        })()
      }
      rec.start()
      recorderRef.current = rec
      setRecording(true)
      setNotice('')
      recordTimerRef.current = window.setTimeout(stopRecording, MAX_RECORD_MS)
    } catch (err) {
      setRecording(false)
      setNotice(t('ai.voiceError', { msg: err instanceof Error ? err.message : String(err) }))
    }
  }, [busy, recording, send, stopRecording, t])

  /* -------------------- 拖动 / 点击 -------------------- */

  /** 当前按住的那一次操作。`px/py` 为空表示窗口起点还没取到（会在第一次 move 时补）。 */
  const dragRef = useRef<{ sx: number; sy: number; px: number | null; py: number | null; moved: boolean } | null>(
    null
  )
  /**
   * 窗口当前位置缓存。
   *
   * `pointerdown` 必须**同步**建好拖动状态：
   *   · 若先 `await` 一次 IPC 再建，这期间到达的 pointermove 会因 dragRef 为 null 被丢掉；
   *   · React 在 async 处理器 `await` 之后会把 `event.currentTarget` 置空，
   *     那时再 `setPointerCapture` 会抛异常，指针一移出 76px 的小球窗口就收不到事件。
   * 所以捕获与建状态全同步完成，起点位置取缓存；缓存由挂载、展开收起、每次移动后校正。
   */
  const posRef = useRef<{ x: number; y: number } | null>(null)

  /** 刷新窗口位置缓存。 */
  const refreshPos = useCallback((): void => {
    void window.api.ai.ball
      .position()
      .then((p) => {
        posRef.current = p
      })
      .catch(() => {})
  }, [])

  // 挂载与展开 / 收起后窗口几何都会变，重新取一次。
  useEffect(() => {
    refreshPos()
  }, [expanded, refreshPos])

  /** 展开面板（点击语义的唯一入口，鼠标与键盘都走这里）。 */
  const openPanel = useCallback((): void => {
    if (expanded) return
    setExpanded(true)
    void window.api.ai.ball.expand(true)
  }, [expanded])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    // 头部右侧那组「新对话 / 收起 / 关闭」按钮标了 data-no-drag：它们要自己收 click。
    // 一旦在祖先上 `setPointerCapture`，指针会被锁到祖先，click 就不再落到按钮上。
    //
    // 注意不能写成 `closest('button')`：收起态的圆球本身就是一个铺满窗口的
    // <button>，那样会让球彻底拖不动。只有显式标记的按钮组才跳过拖动。
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return

    const origin = posRef.current
    dragRef.current = {
      sx: e.screenX,
      sy: e.screenY,
      px: origin?.x ?? null,
      py: origin?.y ?? null,
      moved: false
    }
    // 同步捕获：让指针移出小窗口后仍能收到 move。
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // 失败不致命：窗口内仍可拖动，只是拖出边界会中断。
    }
    if (!origin) refreshPos()
  }, [refreshPos])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const d = dragRef.current
    if (!d) return
    // 起点缓存迟到的补救：按下时没取到，这里补上（此时窗口尚未被移动，起点仍然有效）。
    if (d.px === null || d.py === null) {
      const o = posRef.current
      if (!o) return
      d.px = o.x
      d.py = o.y
    }
    const dx = e.screenX - d.sx
    const dy = e.screenY - d.sy
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    d.moved = true
    void window.api.ai.ball.move(d.px + dx, d.py + dy, false).then((applied) => {
      // 贴边时主进程会夹住坐标，用返回值校正，避免「越拖越偏」。
      if (applied) posRef.current = applied
    })
  }, [])

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const d = dragRef.current
      dragRef.current = null
      if (!d) return
      if (d.moved) {
        if (d.px === null || d.py === null) return
        const dx = e.screenX - d.sx
        const dy = e.screenY - d.sy
        // 松手时落盘，位置下次启动还在（设置里的 aiBallX / aiBallY）。
        void window.api.ai.ball.move(d.px + dx, d.py + dy, true).then((applied) => {
          if (applied) posRef.current = applied
        })
        return
      }
      // 没移动 = 点击。必须在 pointerup 里判，不能依赖 click：
      // 容器设了指针捕获后，内部按钮收不到 click（收起态整个球就是那个按钮）。
      // 头部按钮组已被 data-no-drag 排除，不会走到这里。
      openPanel()
    },
    [openPanel]
  )

  /* -------------------- 工具确认 -------------------- */

  const decide = useCallback(
    async (approved: boolean): Promise<void> => {
      const req = toolReq
      setToolReq(null)
      if (req) await window.api.ai.decideTool(req.id, approved)
    },
    [toolReq]
  )

  /* -------------------- 渲染 -------------------- */

  // 收起态：只是一个圆球。尺寸由主进程控制窗口，球本身铺满。
  if (!expanded) {
    return (
      <div
        className="flex h-screen w-screen items-center justify-center"
        style={{ padding: 4 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <button
          type="button"
          aria-label={t('ai.ballTip')}
          title={t('ai.ballTip')}
          // 鼠标点击由容器上的 pointerup 统一处理（见 onPointerUp）：
          // 容器一旦持有指针捕获，这里的 click 就不会触发，所以不挂 onClick。
          // 这里只负责键盘可达性（Tab 聚焦后按 Enter / 空格）。
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              openPanel()
            }
          }}
          className="flex h-full w-full items-center justify-center rounded-full transition-transform active:scale-95"
          style={{
            // 跟随主题：底色用主题主色，图标用主色上的前景色；
            // 外阴影用主题玻璃阴影，明暗主题下都能自然贴合。
            background: 'var(--fill-primary)',
            color: '#fff',
            boxShadow: 'var(--glass-shadow)',
            border: '1px solid var(--glass-border)',
            cursor: 'grab'
          }}
        >
          <Icon name="message" size={30} />
        </button>
      </div>
    )
  }

  return (
    <div
      className="glass-strong flex h-screen w-screen flex-col overflow-hidden"
      style={{ borderRadius: 14, border: '1px solid var(--glass-border)' }}
    >
      {/* 头部：可拖动 */}
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ borderBottom: '1px solid var(--glass-border)', cursor: 'grab' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <span style={{ color: 'var(--fill-primary)', display: 'flex' }} aria-hidden>
          <Icon name="message" size={18} />
        </span>
        <strong className="text-sm">{t('ai.title')}</strong>
        <div className="ml-auto flex items-center gap-1" data-no-drag>
          <Button
            size="sm"
            icon="refresh"
            title={t('ai.newChat')}
            aria-label={t('ai.newChat')}
            onClick={async () => {
              await window.api.ai.reset()
              setBubbles([])
            }}
          />
          <Button
            size="sm"
            icon="chevronLeft"
            title={t('ai.collapse')}
            aria-label={t('ai.collapse')}
            onClick={async () => {
              setExpanded(false)
              await window.api.ai.ball.expand(false)
            }}
          />
        </div>
      </div>

      {/* 消息区 */}
      <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto px-3 py-2" style={{ userSelect: 'text' }}>
        {bubbles.length === 0 && !busy && (
          <div className="caption">
            <p style={{ fontWeight: 600 }}>{t('ai.empty')}</p>
            <p className="mt-1 opacity-80">{t('ai.emptyHint')}</p>
          </div>
        )}
        {bubbles.map((b, i) => (
          <div
            key={i}
            className="rounded-lg px-2.5 py-1.5 text-[13px] leading-relaxed whitespace-pre-wrap"
            style={{
              background: b.role === 'user' ? 'var(--fill-primary)' : 'var(--glass-well)',
              color: b.role === 'user' ? '#fff' : 'var(--text-primary)',
              marginLeft: b.role === 'user' ? 28 : 0,
              marginRight: b.role === 'user' ? 0 : 28,
              opacity: b.failed ? 0.85 : 1,
              border: b.failed ? '1px solid var(--fill-danger)' : '1px solid transparent'
            }}
          >
            {b.text}
          </div>
        ))}
        {busy && <div className="caption animate-pulse">{t('ai.thinking')}</div>}
        {notice && <div className="caption">{notice}</div>}
      </div>

      {/* 工具确认 */}
      {toolReq && (
        <div className="mx-3 mb-2 rounded-lg p-2.5 text-[13px]" style={{ background: 'var(--glass-well)', border: '1px solid var(--fill-danger)' }}>
          <div className="flex items-center gap-2">
            <strong>{t('ai.confirmTitle')}</strong>
            {toolReq.risk === 'dangerous' && (
              <span className="caption" style={{ color: 'var(--fill-danger)' }}>
                {t('ai.confirmRisk')}
              </span>
            )}
          </div>
          <p className="mt-1 opacity-90">{toolReq.summary}</p>
          <pre className="caption mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all">
            {JSON.stringify(toolReq.args, null, 2)}
          </pre>
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" onClick={() => void decide(false)}>
              {t('ai.confirmDeny')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => void decide(true)}>
              {t('ai.confirmAllow')}
            </Button>
          </div>
        </div>
      )}

      {/* 输入区 */}
      <div className="flex items-end gap-2 px-3 pb-3">
        <textarea
          className="input flex-1 resize-none py-2"
          rows={2}
          value={input}
          placeholder={t('ai.placeholder')}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send(input)
            }
          }}
          style={{ height: 'auto', minHeight: 44 }}
        />
        {settings?.aiVoiceEnabled && (
          <Button
            size="md"
            variant={recording ? 'danger' : 'secondary'}
            icon={recording ? 'stop' : 'mic'}
            title={recording ? t('ai.voiceRecording') : t('ai.voiceHold')}
            aria-label={recording ? t('ai.voiceRecording') : t('ai.voiceHold')}
            onPointerDown={() => void startRecording()}
            onPointerUp={() => stopRecording()}
            onPointerLeave={() => recording && stopRecording()}
          />
        )}
        <Button
          variant="primary"
          icon="chevronRight"
          title={t('ai.send')}
          aria-label={t('ai.send')}
          disabled={busy || !input.trim()}
          onClick={() => void send(input)}
        />
      </div>
    </div>
  )
}