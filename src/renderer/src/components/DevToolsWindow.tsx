import { useEffect, useRef, useState } from 'react'
import type { DebugLogEntry, DevModeStatus } from '@shared/types'

const MAX_LOGS = 3000
const LEVEL_COLOR: Record<DebugLogEntry['level'], string> = {
  info: 'rgba(255,255,255,0.82)',
  warn: '#ffd60a',
  error: '#ff453a'
}

const TEXT = {
  'zh-CN': {
    title: '开发者工具',
    enabled: '开发模式已开启',
    disabled: '开发模式已关闭',
    unauthorized: '未授权',
    security: '安全防护',
    email: '授权邮箱',
    remaining: '剩余',
    requestAuthorization: '请先在设置页验证授权邮箱以开启开发模式',
    effectiveMode: '生效档位',
    logs: '主进程日志',
    clear: '清空',
    paused: '已暂停',
    pause: '暂停滚动',
    empty: '暂无日志。主页脚本日志需在设置页开启「Debug 模式」后才会采集。',
    loadError: '历史日志加载失败，仍会接收新日志。',
    subscribeError: '实时日志订阅失败。',
    statusSubscribeError: '开发模式状态订阅失败。',
    statusError: '开发模式状态加载失败。',
    securityError: '安全防护设置失败，请重试。',
    expired: '已过期',
    hour: '小时',
    minute: '分钟',
    full: '完全模拟',
    warn: '仅提示',
    off: '完全关闭'
  },
  'zh-TW': {
    title: '開發者工具',
    enabled: '開發模式已開啟',
    disabled: '開發模式已關閉',
    unauthorized: '未授權',
    security: '安全防護',
    email: '授權信箱',
    remaining: '剩餘',
    requestAuthorization: '請先在設定頁驗證授權信箱以開啟開發模式',
    effectiveMode: '生效檔位',
    logs: '主程序日誌',
    clear: '清空',
    paused: '已暫停',
    pause: '暫停捲動',
    empty: '暫無日誌。主頁腳本日誌需在設定頁開啟「Debug 模式」後才會採集。',
    loadError: '歷史日誌載入失敗，仍會接收新日誌。',
    subscribeError: '即時日誌訂閱失敗。',
    statusSubscribeError: '開發模式狀態訂閱失敗。',
    statusError: '開發模式狀態載入失敗。',
    securityError: '安全防護設定失敗，請重試。',
    expired: '已過期',
    hour: '小時',
    minute: '分鐘',
    full: '完全模擬',
    warn: '僅提示',
    off: '完全關閉'
  },
  en: {
    title: 'Developer tools',
    enabled: 'Developer mode on',
    disabled: 'Developer mode off',
    unauthorized: 'Unauthorized',
    security: 'Security',
    email: 'Authorized email',
    remaining: 'Remaining',
    requestAuthorization: 'Verify the authorized email in Settings to enable developer mode',
    effectiveMode: 'Effective level',
    logs: 'Main process logs',
    clear: 'Clear',
    paused: 'Paused',
    pause: 'Pause scrolling',
    empty: 'No logs yet. Enable “Debug mode” in Settings to collect homepage script logs.',
    loadError: 'Log history could not be loaded. New logs will still appear.',
    subscribeError: 'Live log subscription failed.',
    statusSubscribeError: 'Developer mode status subscription failed.',
    statusError: 'Developer mode status could not be loaded.',
    securityError: 'Security setting failed. Please try again.',
    expired: 'Expired',
    hour: 'h',
    minute: 'min',
    full: 'Full simulation',
    warn: 'Warn only',
    off: 'Disabled'
  }
} as const

type DevToolsLocale = keyof typeof TEXT
type DevToolsText = { [K in keyof typeof TEXT['zh-CN']]: string }
type DevToolsError = 'loadError' | 'subscribeError' | 'statusSubscribeError' | 'statusError' | 'securityError'

const SEC_LABEL: Record<DevModeStatus['securityMode'], keyof typeof TEXT['zh-CN']> = {
  full: 'full',
  warn: 'warn',
  off: 'off'
}

function fallbackLocale(value: string): DevToolsLocale | undefined {
  const language = value.trim().replace(/_/g, '-').toLowerCase()
  if (/^zh-(tw|hk|mo|hant)(-|$)/.test(language)) return 'zh-TW'
  if (/^zh(-|$)/.test(language)) return 'zh-CN'
  if (/^en(-|$)/.test(language)) return 'en'
  return undefined
}

/** 独立窗口优先使用显式语言，再回退到原生设置、文档和系统语言。 */
export function resolveDevToolsLocale(): DevToolsLocale {
  const explicit = new URLSearchParams(window.location.search).get('lang')
  if (explicit === 'zh-CN' || explicit === 'zh-TW' || explicit === 'en') return explicit
  const native = (window as Window & { __HC_DEVTOOLS_LOCALE__?: unknown }).__HC_DEVTOOLS_LOCALE__
  if (native === 'zh-CN' || native === 'zh-TW' || native === 'en') return native
  return (
    fallbackLocale(document.documentElement.lang) ??
    [...(navigator.languages ?? []), navigator.language]
      .map(fallbackLocale)
      .find((locale) => locale !== undefined) ??
    'zh-CN'
  )
}

function logKey(entry: DebugLogEntry): string {
  return JSON.stringify([entry.ts, entry.level, entry.message])
}

/** 有界地合并快照和订阅日志；同一时间、级别、内容只保留一份。 */
export function mergeDevToolsLogs(initial: DebugLogEntry[], pending: DebugLogEntry[]): DebugLogEntry[] {
  const merged: DebugLogEntry[] = []
  const seen = new Set<string>()
  for (const entry of [...initial.slice(-MAX_LOGS), ...pending]) {
    const key = logKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(entry)
  }
  return merged.slice(-MAX_LOGS)
}

/** 追加实时日志并保持去重与上限。 */
export function appendDevToolsLog(logs: DebugLogEntry[], entry: DebugLogEntry): DebugLogEntry[] {
  return mergeDevToolsLogs(logs, [entry])
}

/**
 * 开发模式：独立「开发者工具（F12）」窗口。
 *
 * 单独开窗而非在主界面内嵌面板，避免内容过多把主界面挤乱（用户明确要求）。
 * 内容分三块：开发模式状态、三档安全防护切换、主进程日志（含主页脚本日志）。
 */
export function DevToolsWindow(): JSX.Element {
  const [locale] = useState<DevToolsLocale>(() => resolveDevToolsLocale())
  const text = TEXT[locale]
  const [dev, setDev] = useState<DevModeStatus | null>(null)
  const [logs, setLogs] = useState<DebugLogEntry[]>([])
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState<DevToolsError | null>(null)
  const clearLogsRef = useRef<() => void>(() => {})
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = text.title
  }, [locale, text.title])

  // 订阅开发模式状态（主进程广播开关 / 解除 / 到期）。订阅必须先于快照，避免漏掉竞态更新。
  useEffect(() => {
    let disposed = false
    let revision = 0
    const snapshotRevision = revision
    let unsubscribe: (() => void) | undefined
    const onChanged = (next: DevModeStatus): void => {
      if (disposed) return
      revision += 1
      setDev(next)
    }
    try {
      unsubscribe = window.api.devMode.onChanged(onChanged)
    } catch {
      setError((previous) => previous ?? 'statusSubscribeError')
    }
    void Promise.resolve().then(() => window.api.devMode.status()).then((next) => {
      if (disposed || revision !== snapshotRevision) return
      setDev(next)
    }).catch(() => {
      if (disposed || revision !== snapshotRevision) return
      setError((previous) => previous ?? 'statusError')
    })
    return () => {
      disposed = true
      unsubscribe?.()
      unsubscribe = undefined
    }
  }, [])

  // 先订阅增量，再取滚动缓冲；等待期间的实时日志在快照返回时合并。
  useEffect(() => {
    let disposed = false
    let loading = true
    let cleared = false
    let pending: DebugLogEntry[] = []
    let unsubscribe: (() => void) | undefined
    clearLogsRef.current = () => {
      cleared = true
      pending = []
      setLogs([])
    }
    const append = (entry: DebugLogEntry): void => {
      if (disposed) return
      if (loading) pending = appendDevToolsLog(pending, entry)
      setLogs((previous) => (disposed ? previous : appendDevToolsLog(previous, entry)))
    }
    try {
      unsubscribe = window.api.debug.onLog(append)
    } catch {
      setError((previous) => previous ?? 'subscribeError')
    }
    void Promise.resolve().then(() => window.api.debug.getLogs()).then((initial) => {
      if (disposed) return
      loading = false
      const merged = cleared ? [] : mergeDevToolsLogs(initial, pending)
      pending = []
      setLogs((previous) => (disposed || cleared ? previous : merged))
    }).catch(() => {
      if (disposed) return
      loading = false
      pending = []
      setError((previous) => previous ?? 'loadError')
    })
    return () => {
      disposed = true
      loading = false
      pending = []
      clearLogsRef.current = () => {}
      unsubscribe?.()
    }
  }, [])

  // 自动滚动到底部（暂停或用户上翻时不滚动）。
  useEffect(() => {
    const el = listRef.current
    if (!el || paused) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [logs, paused])

  const setSecurity = (securityMode: DevModeStatus['securityMode']): void => {
    void window.api.devMode.setSecurityMode(securityMode).then((next) => {
      setDev(next)
      setError(null)
    }).catch(() => setError('securityError'))
  }

  const mode = dev?.securityMode ?? 'full'
  const statusText = dev?.granted
    ? `${text.email} ${dev.emailMasked || '—'} ｜ ${text.remaining} ${fmtRemaining(dev.expiresAt, text)}`
    : text.requestAuthorization
  const errorText = error ? ` ｜ ${text[error]}` : ''

  return (
    <div className="flex h-full flex-col" style={{ background: '#0b0d14', color: 'rgba(255,255,255,0.85)' }}>
      {/* 顶部工具条 */}
      <div
        className="flex items-center justify-between gap-3 px-4 py-2"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold opacity-90">{text.title}</span>
          {dev?.granted ? (
            <span
              className="rounded-md px-2 py-0.5 text-[11px]"
              style={{
                border: '1px solid rgba(255,255,255,0.14)',
                color: dev.enabled ? '#30d158' : 'rgba(255,255,255,0.6)'
              }}
            >
              {dev.enabled ? text.enabled : text.disabled}
            </span>
          ) : (
            <span className="rounded-md px-2 py-0.5 text-[11px]" style={{ border: '1px solid rgba(255,255,255,0.14)', color: '#ff453a' }}>
              {text.unauthorized}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] opacity-50">{text.security}</span>
          {(['full', 'warn', 'off'] as const).map((securityMode) => (
            <button
              key={securityMode}
              onClick={() => setSecurity(securityMode)}
              disabled={!dev?.granted}
              className="rounded-md px-2 py-1 text-[12px] transition-colors hover:bg-white/10"
              style={{
                border: '1px solid rgba(255,255,255,0.14)',
                opacity: !dev?.granted ? 0.4 : securityMode === mode ? 1 : 0.65,
                background: securityMode === mode ? 'rgba(255,255,255,0.12)' : 'transparent'
              }}
            >
              {text[SEC_LABEL[securityMode]]}
            </button>
          ))}
        </div>
      </div>

      {/* 状态条 */}
      <div
        className="flex items-center justify-between gap-3 px-4 py-1.5 text-[12px]"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', opacity: 0.7 }}
      >
        <span>{statusText}{errorText}</span>
        <span>{text.effectiveMode}：{text[SEC_LABEL[dev?.effectiveSecurityMode ?? 'full']]}</span>
      </div>

      {/* 日志工具条 */}
      <div
        className="flex items-center justify-between gap-3 px-4 py-2"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
      >
        <span className="text-[13px] font-semibold opacity-90">{text.logs}</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              clearLogsRef.current()
              setPaused(false)
            }}
            className="rounded-md px-2 py-1 text-[12px] opacity-80 transition-colors hover:bg-white/10"
            style={{ border: '1px solid rgba(255,255,255,0.14)' }}
          >
            {text.clear}
          </button>
          <button
            onClick={() => setPaused((v) => !v)}
            className="rounded-md px-2 py-1 text-[12px] transition-colors hover:bg-white/10"
            style={{
              border: '1px solid rgba(255,255,255,0.14)',
              opacity: paused ? 1 : 0.8,
              color: paused ? '#ffd60a' : 'inherit'
            }}
          >
            {paused ? text.paused : text.pause}
          </button>
        </div>
      </div>

      {/* 滚动日志列表 */}
      <div ref={listRef} className="selectable min-h-0 flex-1 overflow-y-auto px-4 py-3 font-mono text-[12px] leading-relaxed">
        {logs.length === 0 ? (
          <div style={{ opacity: 0.4 }}>{text.empty}</div>
        ) : (
          logs.map((log, i) => {
            const timestamp = new Date(log.ts)
            const time = `${String(timestamp.getHours()).padStart(2, '0')}:${String(timestamp.getMinutes()).padStart(2, '0')}:${String(timestamp.getSeconds()).padStart(2, '0')}`
            return (
              <div key={i} className="whitespace-pre-wrap break-all">
                <span style={{ opacity: 0.45 }}>{time}</span>{' '}
                <span style={{ color: LEVEL_COLOR[log.level], fontWeight: log.level === 'error' ? 600 : 400 }}>
                  [{log.level.toUpperCase()}]
                </span>{' '}
                <span>{log.message}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/** 把到期时间格式化为「x 小时 y 分钟」/「x 分钟」。 */
function fmtRemaining(expiresAt: number, text: DevToolsText): string {
  const ms = expiresAt - Date.now()
  if (ms <= 0) return text.expired
  const totalMin = Math.floor(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h} ${text.hour} ${m} ${text.minute}` : `${m} ${text.minute}`
}
