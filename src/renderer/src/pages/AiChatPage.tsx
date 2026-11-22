/**
 * 「对话」板块：主窗口内的 AI 聊天页。
 *
 * 与桌面悬浮球共用 `ai:chat` 会话和工具确认弹窗（悬浮球未显示时确认会落到主窗口的
 * AiToolPrompt），这里只负责消息列表与输入；不做拖动、语音和窗口几何。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../store'
import { Button, Markdown } from '../components/ui'

/** 本页展示用消息；真实会话历史仍由主进程维护。 */
interface Bubble {
  role: 'user' | 'assistant'
  text: string
  failed?: boolean
}

export function AiChatPage(): JSX.Element {
  const { t } = useApp()
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [bubbles, busy])

  const send = useCallback(async (): Promise<void> => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setBubbles((b) => [...b, { role: 'user', text }])
    setBusy(true)
    try {
      const r = await window.api.ai.chat(text, '用户正在启动器的「对话」板块与我对话。')
      setBubbles((b) => [
        ...b,
        r.ok
          ? { role: 'assistant', text: r.text }
          : { role: 'assistant', text: r.error || t('ai.analysisFailed', { msg: '' }), failed: true }
      ])
    } catch (err) {
      setBubbles((b) => [
        ...b,
        { role: 'assistant', text: err instanceof Error ? err.message : String(err), failed: true }
      ])
    } finally {
      setBusy(false)
    }
  }, [busy, input, t])

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="display">{t('ai.title')}</h1>
          <p className="caption mt-1">{t('ai.emptyHint')}</p>
        </div>
        <div className="flex gap-2">
          {busy && (
            <Button icon="stop" onClick={() => void window.api.ai.cancel()}>
              {t('settings.common.cancel')}
            </Button>
          )}
          <Button
            icon="refresh"
            disabled={busy || bubbles.length === 0}
            onClick={() => {
              void window.api.ai.reset()
              setBubbles([])
            }}
          >
            {t('ai.newChat')}
          </Button>
        </div>
      </div>

      <div ref={listRef} className="glass min-h-0 flex-1 space-y-3 overflow-y-auto rounded-[24px] p-4">
        {bubbles.length === 0 && !busy && (
          <div className="caption p-4 text-center">
            <p style={{ fontWeight: 600 }}>{t('ai.empty')}</p>
            <p className="mt-1 opacity-80">{t('ai.emptyHint')}</p>
          </div>
        )}
        {bubbles.map((b, i) =>
          b.role === 'user' ? (
            <div
              key={i}
              className="ml-auto max-w-[78%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap"
              style={{ background: 'var(--fill-primary)', color: '#fff' }}
            >
              {b.text}
            </div>
          ) : (
            <div
              key={i}
              className="max-w-[86%] rounded-2xl px-3.5 py-2 text-[13px]"
              style={{
                background: 'var(--glass-well)',
                border: b.failed ? '1px solid var(--fill-danger)' : '1px solid transparent',
                opacity: b.failed ? 0.9 : 1
              }}
            >
              {b.failed ? (
                <span>{b.text}</span>
              ) : (
                <Markdown text={b.text} breaks />
              )}
            </div>
          )
        )}
        {busy && <div className="caption animate-pulse">{t('ai.thinking')}</div>}
      </div>

      <div className="flex items-end gap-2">
        <textarea
          className="input flex-1 resize-none py-2.5"
          rows={3}
          value={input}
          placeholder={t('ai.placeholder')}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <Button
          variant="primary"
          icon="chevronRight"
          title={t('ai.send')}
          aria-label={t('ai.send')}
          disabled={busy || !input.trim()}
          onClick={() => void send()}
        />
      </div>
    </div>
  )
}
