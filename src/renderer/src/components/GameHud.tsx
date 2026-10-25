import { useEffect, useRef, useState } from 'react'
import type { AiHudState, MpHudState, NeteaseLyricsState } from '@shared/types'

/**
 * 游戏内 HUD 浮层。
 *
 * 独立窗口，透明 + 置顶 + 鼠标穿透（由主进程设置 `setIgnoreMouseEvents`），
 * 游戏全屏时也能看到当前大厅成员、谁在说话、麦克风状态。
 * 与 MCTier 的 `GameHudOverlay` 对应。
 *
 * AI 助手开启「游戏内浮层」后，**同一扇窗**里多出一块 AI 卡片（需求里说的
 * 「适配联机已有的 HUD 浮层」）：显示当前对话状态与最近一句回复，
 * 按住热键说话时提示「正在听」。两块内容谁有内容显示谁，都没有整窗不显示。
 *
 * 实验性「网易云音乐歌词浮层」也挂在这扇窗上：主进程推来「上一句 / 当前句 /
 * 下一句」三行，这里只负责排版。三块内容各自独立开关，互不牵连。
 *
 * 本组件**不使用 useApp()**：浮层窗口不需要主题/文案体系，内联文案最省事，
 * 也避免因缺少 provider 而渲染失败。
 */
export function GameHud(): JSX.Element | null {
  const [state, setState] = useState<MpHudState | null>(null)
  const [ai, setAi] = useState<AiHudState | null>(null)
  const [lyrics, setLyrics] = useState<NeteaseLyricsState | null>(null)
  /** 语音识别中（麦克风占用）：由热键广播驱动。 */
  const [listening, setListening] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  useEffect(() => {
    let alive = true
    const off = window.api.mp.onHudState((s) => {
      if (alive) setState(s)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  useEffect(() => {
    let alive = true
    const off = window.api.ai.onHudState((s) => {
      if (alive) setAi(s)
    })
    // 窗口刚建好时订阅可能晚于主进程那次推送，主动拉一次当前快照。
    void window.api.ai
      .hudState?.()
      .then((s) => {
        if (alive && s) setAi(s as AiHudState)
      })
      .catch(() => undefined)
    return () => {
      alive = false
      off()
    }
  }, [])

  /**
   * 歌词快照：只有主进程算出「正在放歌」时才会推 enabled=true 的内容，
   * 其余情况（没开开关 / 没在放 / 没网）拿到的是不显示的快照。
   */
  useEffect(() => {
    let alive = true
    const off = window.api.music?.onLyricsState((s) => {
      if (alive) setLyrics(s)
    })
    void window.api.music
      ?.lyricsState()
      .then((s) => {
        if (alive && s) setLyrics(s)
      })
      .catch(() => undefined)
    return () => {
      alive = false
      off?.()
    }
  }, [])

  /**
   * 语音：热键由主进程广播 `ai:voiceToggle`，这里开始 / 结束录音并转写。
   *
   * HUD 本身鼠标穿透、拿不到点击，所以语音入口只能是热键——这也正是游戏内的
   * 常规做法（不打断游戏操作）。
   */
  useEffect(() => {
    const off = window.api.ai.onVoiceToggle?.(() => {
      void toggleVoice()
    })
    return () => off?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 卸载时释放麦克风。
   *
   * 浮层窗口可能在录音途中被关掉（退出游戏 / 关闭开关）。不在这里收尾，
   * MediaRecorder 与它的音轨会一起挂着，系统托盘的「正在使用麦克风」也不会消失。
   */
  useEffect(() => {
    return () => {
      try {
        recorderRef.current?.stop()
      } catch {
        /* 已停止 */
      }
      recorderRef.current = null
    }
  }, [])

  const stopRecording = (): void => {
    recorderRef.current?.stop()
    recorderRef.current = null
  }

  async function toggleVoice(): Promise<void> {
    if (recorderRef.current) {
      stopRecording()
      return
    }
    if (listening) return
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      let rec: MediaRecorder
      try {
        rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
      } catch {
        try {
          rec = new MediaRecorder(stream)
        } catch {
          // 两种构造都失败：必须自己把音轨关掉，否则麦克风会一直被占用。
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
        setListening(false)
        void (async () => {
          const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
          if (blob.size < 1024) return
          const mime = (rec.mimeType || 'audio/webm').split(';')[0]
          const bytes = new Uint8Array(await blob.arrayBuffer())
          const r = await window.api.ai.transcribe(bytes, mime)
          if (!r.ok || !r.text) return
          await window.api.ai.chat(r.text, '用户正在游戏内通过热键语音提问。')
        })()
      }
      rec.start()
      recorderRef.current = rec
      setListening(true)
      // 安全上限：避免忘记结束而一直占用麦克风。
      window.setTimeout(() => {
        if (recorderRef.current === rec) stopRecording()
      }, 60_000)
    } catch {
      setListening(false)
    }
  }
  const mpOn = !!state?.enabled && (state?.players.length ?? 0) > 0
  const aiOn = !!ai?.enabled
  // 歌词卡片只在「确实有正在播放的网易云曲目」时出现；idle / off 一律不画。
  const lyricsOn = !!lyrics?.enabled
  if (!mpOn && !aiOn && !lyricsOn) return null

  return (
    <div
      className="h-screen w-screen p-2"
      style={{ opacity: aiOn && !mpOn ? ai.opacity : state?.opacity, pointerEvents: 'none', userSelect: 'none' }}
    >
      <div className="space-y-2">
        {mpOn && (
          <div
            className="rounded-2xl p-2.5"
            style={{
              background: 'rgba(18, 18, 24, 0.72)',
              backdropFilter: 'blur(10px)',
              border: '1px solid rgba(255,255,255,0.10)',
              boxShadow: '0 8px 28px rgba(0,0,0,0.35)'
            }}
          >
            <div className="mb-1.5 flex items-center gap-1.5">
              <span className="text-[11px] font-semibold" style={{ color: '#8fd', letterSpacing: 0.3 }}>
                MCTier · 大厅状态
              </span>
              <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.45)' }}>
                {state?.players.length ?? 0} 人
              </span>
            </div>
            <div className="space-y-1">
              {(state?.players ?? []).map((p) => (
                <div key={p.id} className="flex items-center gap-2">
                  <span className="truncate text-[12px]" style={{ color: 'rgba(255,255,255,0.86)', flex: 1 }}>
                    {p.name}
                    {p.isSelf ? '（我）' : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {aiOn && ai && (
          <div
            className="rounded-2xl p-2.5"
            style={{
              background: 'rgba(18, 18, 24, 0.72)',
              backdropFilter: 'blur(10px)',
              border: '1px solid rgba(255,255,255,0.10)',
              boxShadow: '0 8px 28px rgba(0,0,0,0.35)'
            }}
          >
            <div className="mb-1 flex items-center gap-1.5">
              <span className="text-[11px] font-semibold" style={{ color: '#c8b6ff', letterSpacing: 0.3 }}>
                AI 助手
              </span>
              <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.45)' }}>
                {listening
                  ? '正在听…（松开热键结束）'
                  : ai.status === 'thinking'
                    ? '思考中…'
                    : ai.status === 'speaking'
                      ? '播报中…'
                      : '待命'}
              </span>
            </div>
            {ai.lastUser && (
              <div className="truncate text-[11px]" style={{ color: 'rgba(255,255,255,0.5)' }}>
                我：{ai.lastUser}
              </div>
            )}
            {ai.text && (
              <div
                className="mt-1 text-[12px] leading-snug"
                style={{
                  color: 'rgba(255,255,255,0.9)',
                  display: '-webkit-box',
                  WebkitLineClamp: 4,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden'
                }}
              >
                {ai.text}
              </div>
            )}
          </div>
        )}

        {lyricsOn && lyrics && (
          <div
            className="rounded-2xl p-2.5"
            style={{
              background: 'rgba(18, 18, 24, 0.72)',
              backdropFilter: 'blur(10px)',
              border: '1px solid rgba(255,255,255,0.10)',
              boxShadow: '0 8px 28px rgba(0,0,0,0.35)'
            }}
          >
            <div className="mb-1 flex items-baseline gap-1.5">
              <span className="text-[11px] font-semibold" style={{ color: '#ff8fa3', letterSpacing: 0.3 }}>
                网易云音乐
              </span>
              <span className="truncate text-[10px]" style={{ color: 'rgba(255,255,255,0.5)', flex: 1 }}>
                {[lyrics.title, lyrics.artist].filter(Boolean).join(' · ')}
              </span>
            </div>
            {lyrics.status === 'sync' ? (
              // 三行布局：上一句淡、当前句亮且稍大、下一句半透明，
              // 与桌面歌词的观感一致（多看几眼就能预判下一句，不用逐字盯）。
              <div className="space-y-0.5 text-center">
                <div className="truncate text-[11px]" style={{ color: 'rgba(255,255,255,0.42)' }}>
                  {lyrics.prev || '\u00a0'}
                </div>
                <div
                  className="text-[14px] font-semibold leading-snug"
                  style={{
                    color: '#ffffff',
                    textShadow: '0 1px 3px rgba(0,0,0,0.55)',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden'
                  }}
                >
                  {lyrics.current || '…'}
                </div>
                <div className="truncate text-[11px]" style={{ color: 'rgba(255,255,255,0.55)' }}>
                  {lyrics.next || '\u00a0'}
                </div>
              </div>
            ) : (
              <div className="text-[11px]" style={{ color: 'rgba(255,255,255,0.6)' }}>
                {lyrics.status === 'loading'
                  ? '正在获取歌词…'
                  : (lyrics.message ?? '未找到这首歌的歌词')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}