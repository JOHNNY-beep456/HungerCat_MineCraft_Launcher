import { useEffect, useLayoutEffect, useState } from 'react'
import type { AiHudState } from '@shared/types'

const MAX_PAYLOAD_TEXT = 65_536
const PAGE_CLASS = 'hc-tauri-ai-hud--page'
const TEXT = {
  'zh-CN': { title: 'AI 助手', idle: '待命', thinking: '思考中', speaking: '播报中', listening: '聆听中', user: '你', empty: '等待下一条助手回复。', inApp: '仅在启动器内显示' },
  'zh-TW': { title: 'AI 助手', idle: '待命', thinking: '思考中', speaking: '播報中', listening: '聆聽中', user: '你', empty: '等待下一則助手回覆。', inApp: '僅在啟動器內顯示' },
  en: { title: 'AI assistant', idle: 'Ready', thinking: 'Thinking', speaking: 'Speaking', listening: 'Listening', user: 'You', empty: 'Waiting for the next assistant reply.', inApp: 'Visible inside the launcher only' }
} as const

function hudLocale(embedded: boolean): keyof typeof TEXT {
  if (!embedded && '__TAURI_INTERNALS__' in window && ['win32', 'darwin', 'linux'].includes(window.api.platform) && new URLSearchParams(window.location.search).get('window') === 'ai-hud') {
    const native = (window as Window & { __HC_AI_HUD_LOCALE__?: unknown }).__HC_AI_HUD_LOCALE__
    if (native === 'zh-CN' || native === 'zh-TW' || native === 'en') return native
  }
  for (const value of [document.documentElement.lang, ...(navigator.languages ?? []), navigator.language]) {
    if (typeof value !== 'string') continue
    const language = value.trim().replace(/_/g, '-').toLowerCase()
    if (/^zh-(tw|hk|mo|hant)(-|$)/.test(language)) return 'zh-TW'
    if (/^zh(-|$)/.test(language)) return 'zh-CN'
    if (/^en(-|$)/.test(language)) return 'en'
  }
  return 'zh-CN'
}

/** 只投影既有六字段；超长载荷拒绝，展示另做截断，不消费额外业务数据。 */
function projectHudState(value: unknown): AiHudState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const state = value as Record<string, unknown>
  if (typeof state.enabled !== 'boolean' || typeof state.active !== 'boolean') return null
  if (typeof state.opacity !== 'number' || !Number.isFinite(state.opacity)) return null
  if (state.status !== 'idle' && state.status !== 'thinking' && state.status !== 'speaking' && state.status !== 'listening') return null
  if (typeof state.text !== 'string' || state.text.length > MAX_PAYLOAD_TEXT) return null
  if (typeof state.lastUser !== 'string' || state.lastUser.length > MAX_PAYLOAD_TEXT) return null
  return {
    enabled: state.enabled, active: state.active, opacity: Math.max(0, Math.min(1, state.opacity)),
    status: state.status, text: state.text, lastUser: state.lastUser
  }
}

/** 单个消费者先订阅再读取无参快照；任何新事件均使这次旧快照失效。 */
export function useAiHudState(): AiHudState | null {
  const [state, setState] = useState<AiHudState | null>(null)
  useEffect(() => {
    let disposed = false
    let receivedEvent = false
    let off: (() => void) | undefined
    try {
      off = window.api.ai.onHudState((value) => {
        if (disposed) return
        receivedEvent = true
        const next = projectHudState(value)
        if (!next) return
        setState((previous) => disposed ? previous : next)
      })
    } catch { /* 订阅失败仍可读取快照，不回显底层异常。 */ }
    void (async () => {
      try {
        const snapshot: unknown = await window.api.ai.hudState()
        if (disposed || receivedEvent) return
        const next = projectHudState(snapshot)
        if (next) setState((previous) => disposed || receivedEvent ? previous : next)
      } catch { /* 快照失败不能清空已收到或随后到达的实时状态。 */ }
    })()
    return () => {
      disposed = true
      try { off?.() } catch { /* 已失活的监听器即使退订失败也不能再写视图。 */ }
    }
  }, [])
  return state
}

function clippedText(value: string, maximum: number): string {
  const characters = Array.from(value)
  return characters.length <= maximum ? value : `${characters.slice(0, maximum).join('')}…`
}

/** Tauri 专用只读卡片；移动宿主复用此消费者，不触发录音、聊天或任何设置读取。 */
export function TauriAiHud({ embedded = false, stacked = false }: { embedded?: boolean; stacked?: boolean } = {}): JSX.Element | null {
  const state = useAiHudState()
  return <TauriAiHudCard state={state} embedded={embedded} stacked={stacked} />
}

/** 独立桌面栈与移动只读消费者共享卡片；状态由各自受限订阅提供。 */
export function TauriAiHudCard({ state, embedded = false, stacked = false }: { state: AiHudState | null; embedded?: boolean; stacked?: boolean }): JSX.Element | null {
  const text = TEXT[hudLocale(embedded)]
  useLayoutEffect(() => {
    // 只给真正的 Tauri 独立 AI 页透明背景；卸载恢复原 class 所有权。
    if (embedded || !('__TAURI_INTERNALS__' in window) || !['win32', 'darwin', 'linux'].includes(window.api.platform) || new URLSearchParams(window.location.search).get('window') !== 'ai-hud') return
    const body = document.body
    const existed = body.classList.contains(PAGE_CLASS)
    body.classList.add(PAGE_CLASS)
    return () => { if (!existed) body.classList.remove(PAGE_CLASS) }
  }, [embedded])
  // active 是现场信号，不替代服务端 enabled 的统一显示判定。
  if (!state?.enabled) return null
  return (
    <aside className={`hc-tauri-ai-hud${embedded ? ' hc-tauri-ai-hud--embedded' : ''}`} aria-label={text.title} data-status={state.status} style={{ opacity: state.opacity, ...(stacked ? { position: 'relative', inset: 'auto', width: '100%', maxHeight: 300 } as const : {}) }}>
      <header className="hc-tauri-ai-hud__header">
        <span className="hc-tauri-ai-hud__title">{text.title}</span>
        <span className="hc-tauri-ai-hud__status"><span className="hc-tauri-ai-hud__dot" aria-hidden="true" />{text[state.status]}</span>
      </header>
      {state.lastUser && <p className="hc-tauri-ai-hud__user"><span>{text.user}: </span>{clippedText(state.lastUser, 180)}</p>}
      <p className="hc-tauri-ai-hud__reply">{state.text ? clippedText(state.text, 700) : text.empty}</p>
      {embedded && <p className="hc-tauri-ai-hud__scope">{text.inApp}</p>}
    </aside>
  )
}
