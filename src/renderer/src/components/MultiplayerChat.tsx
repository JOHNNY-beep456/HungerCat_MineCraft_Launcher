import { useEffect, useRef, useState } from 'react'
import type { MpChatMessage } from '@shared/types'
import { useApp } from '../store'
import { Icon } from './ui'

/**
 * 大厅聊天面板（消息收发 UI）。
 *
 * 消息来自主进程：启动时拉一次历史，之后订阅 `onChat` 增量追加。
 * 悬浮窗与主界面都能发消息 —— 两条路径最终都走主进程 `mp:sendChat`，
 * 再广播回来，保证所有界面看到同一份消息流。
 */
export function MultiplayerChat(): JSX.Element {
  const { t } = useApp()
  const [messages, setMessages] = useState<MpChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.mp.getMessages().then((m) => {
      if (alive) setMessages(m)
    })
    const off = window.api.mp.onChat((msg) => {
      setMessages((prev) => (prev.some((x) => x.id === msg.id) ? prev : [...prev, msg]))
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  // 新消息自动滚到底部（用户往上翻历史时不强拉，简单判断「是否已在底部附近」）。
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [messages])

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      await window.api.mp.sendChat(text)
      setDraft('')
    } catch (err) {
      console.warn('[联机] 发送消息失败：', err)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="glass relative z-0 flex w-full flex-col rounded-[24px] p-4">
      <div className="mb-2 flex items-center gap-2">
        <Icon name="message" size={16} style={{ color: 'var(--fill-primary)' }} />
        <span className="headline">{t('mp.chat.title')}</span>
        <span className="caption ml-auto">{t('mp.chat.count', { n: messages.length })}</span>
      </div>

      <div ref={listRef} className="mb-2 max-h-64 min-h-[120px] space-y-1.5 overflow-y-auto pr-1">
        {messages.length === 0 ? (
          <div className="caption py-6 text-center">{t('mp.chat.empty')}</div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`flex ${m.isSelf ? 'justify-end' : 'justify-start'}`}>
              <div
                className="glass-soft max-w-[85%] rounded-2xl px-3 py-1.5"
                style={{
                  background: m.isSelf ? 'var(--fill-primary-soft, rgba(10,132,255,0.16))' : undefined
                }}
              >
                {!m.isSelf && (
                  <div className="caption mb-0.5" style={{ fontSize: 11 }}>
                    {m.playerName}
                  </div>
                )}
                <div className="selectable break-words text-[13px] leading-relaxed">{m.content}</div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          className="mp-input flex-1"
          value={draft}
          maxLength={500}
          placeholder={t('mp.chat.placeholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <button
          className="no-drag glass-soft rounded-xl px-3 py-2 text-[13px] transition-transform active:scale-[0.97] disabled:opacity-50"
          disabled={!draft.trim() || sending}
          onClick={() => void send()}
          title={t('mp.chat.send')}
        >
          <Icon name="check" size={16} />
        </button>
      </div>
    </div>
  )
}
