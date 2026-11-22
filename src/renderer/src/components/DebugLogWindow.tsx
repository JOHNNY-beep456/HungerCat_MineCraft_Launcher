import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DebugLogEntry } from '@shared/types'

const MAX_LOGS = 3000
const LEVEL_COLOR: Record<DebugLogEntry['level'], string> = {
  info: 'rgba(255,255,255,0.82)',
  warn: '#ffd60a',
  error: '#ff453a'
}

const TEXT = {
  'zh-CN': {
    title: '启动器日志',
    clear: '清空',
    paused: '已暂停',
    pause: '暂停滚动',
    empty: '暂无日志。',
    loadError: '历史日志加载失败，仍会接收新日志。',
    subscribeError: '实时日志订阅失败。'
  },
  'zh-TW': {
    title: '啟動器日誌',
    clear: '清空',
    paused: '已暫停',
    pause: '暫停捲動',
    empty: '暫無日誌。',
    loadError: '歷史日誌載入失敗，仍會接收新日誌。',
    subscribeError: '即時日誌訂閱失敗。'
  },
  en: {
    title: 'Launcher logs',
    clear: 'Clear',
    paused: 'Paused',
    pause: 'Pause scrolling',
    empty: 'No logs yet.',
    loadError: 'Log history could not be loaded. New logs will still appear.',
    subscribeError: 'Live log subscription failed.'
  }
} as const

type LogLocale = keyof typeof TEXT

function fallbackLocale(value: string): LogLocale | undefined {
  const language = value.trim().replace(/_/g, '-').toLowerCase()
  if (/^zh-(tw|hk|mo|hant)(-|$)/.test(language)) return 'zh-TW'
  if (/^zh(-|$)/.test(language)) return 'zh-CN'
  if (/^en(-|$)/.test(language)) return 'en'
  return undefined
}

function logLocale(embedded = false): LogLocale {
  // 独立窗消费公开语言参数；嵌入视图沿用应用文档/系统语言，不读取设置。
  const language = embedded ? null : new URLSearchParams(window.location.search).get('lang')
  if (language === 'zh-CN' || language === 'zh-TW' || language === 'en') return language
  return (
    fallbackLocale(document.documentElement.lang) ??
    [...(navigator.languages ?? []), navigator.language]
      .map(fallbackLocale)
      .find((locale) => locale !== undefined) ??
    'zh-CN'
  )
}

/**
 * 只消除快照尾部与增量开头的签名重叠，不对内部重复使用 Set 去重。
 * 现有契约只有 ts/level/message；完全相同的边界独立日志与重叠无法消歧。
 */
function mergeSnapshot(initial: DebugLogEntry[], pending: DebugLogEntry[]): DebugLogEntry[] {
  const snapshot = initial.slice(-MAX_LOGS)
  if (pending.length === 0) return snapshot
  const key = (entry: DebugLogEntry): string =>
    JSON.stringify([entry.ts, entry.level, entry.message])
  const keys = pending.map(key)
  // 前缀表保持线性匹配；仅按最大边界重叠合并，不承诺无序号时绝对保留独立重复。
  const prefix = new Array<number>(keys.length).fill(0)
  for (let i = 1, matched = 0; i < keys.length; i += 1) {
    while (matched > 0 && keys[i] !== keys[matched]) matched = prefix[matched - 1]
    if (keys[i] === keys[matched]) matched += 1
    prefix[i] = matched
  }
  let overlap = 0
  for (const entry of snapshot) {
    const entryKey = key(entry)
    while (overlap > 0 && (overlap === keys.length || entryKey !== keys[overlap])) {
      overlap = prefix[overlap - 1]
    }
    if (entryKey === keys[overlap]) overlap += 1
  }
  return [...snapshot, ...pending.slice(overlap)].slice(-MAX_LOGS)
}

/** 独立主进程日志窗口（深色简约视图）。 */
export function DebugLogWindow({ embedded = false }: { embedded?: boolean } = {}): JSX.Element {
  const [locale] = useState(() => logLocale(embedded))
  const text = TEXT[locale]
  const [logs, setLogs] = useState<DebugLogEntry[]>([])
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState<'loadError' | 'subscribeError' | null>(null)
  const clearLogsRef = useRef<() => void>(() => {})
  const listRef = useRef<HTMLDivElement>(null)
  const followTailRef = useRef(true)

  const resumeFollowing = (): void => {
    followTailRef.current = true
    const element = listRef.current
    if (element) element.scrollTop = element.scrollHeight
  }

  useEffect(() => {
    if (embedded) return
    document.documentElement.lang = locale
    document.title = text.title
  }, [embedded, locale, text.title])

  useEffect(() => {
    let disposed = false
    let loading = true
    let cleared = false
    let pending: DebugLogEntry[] = []
    let unsubscribe: (() => void) | undefined
    clearLogsRef.current = () => {
      // 等待快照时清空也不能被迟到的历史记录覆盖。
      cleared = true
      pending = []
      setLogs([])
    }
    try {
      // 同步订阅后才请求快照；等待期间的增量仍即时显示并单独保留。
      unsubscribe = window.api.debug.onLog((entry) => {
        if (disposed) return
        if (loading) pending = [...pending, entry].slice(-MAX_LOGS)
        setLogs((previous) => (disposed ? previous : [...previous, entry].slice(-MAX_LOGS)))
      })
    } catch {
      setError('subscribeError')
    }
    void (async () => {
      try {
        const initial = await window.api.debug.getLogs()
        if (disposed) return
        const merged = cleared ? pending : mergeSnapshot(initial, pending)
        loading = false
        pending = []
        setLogs((previous) => (disposed ? previous : merged))
      } catch {
        if (disposed) return
        loading = false
        pending = []
        setError((previous) => previous ?? 'loadError')
      }
    })()
    return () => {
      disposed = true
      loading = false
      pending = []
      clearLogsRef.current = () => {}
      unsubscribe?.()
    }
  }, [])

  // 是否跟随由上一次滚动位置决定，不能用追加后的高度误判为用户上翻。
  useLayoutEffect(() => {
    const element = listRef.current
    if (element && !paused && followTailRef.current) element.scrollTop = element.scrollHeight
  }, [logs, paused])

  return (
    <div
      className={embedded ? 'hc-mobile-debug__content flex h-full flex-col' : 'flex h-full flex-col'}
      style={{ background: '#0b0d14', color: 'rgba(255,255,255,0.85)' }}
    >
      {/* 顶部工具条 */}
      <div
        className={`${embedded ? 'hc-mobile-debug__toolbar ' : ''}flex items-center justify-between gap-3 px-4 py-2`}
        style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
      >
        <span className="text-[13px] font-semibold opacity-90">{text.title}</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              clearLogsRef.current()
              resumeFollowing()
              setPaused(false)
            }}
            className="rounded-md px-2 py-1 text-[12px] opacity-80 transition-colors hover:bg-white/10"
            style={{ border: '1px solid rgba(255,255,255,0.14)' }}
          >
            {text.clear}
          </button>
          <button
            onClick={() => {
              // 暂停只停止跟随，不丢日志；再次点击明确恢复到底部并继续跟随。
              if (paused) resumeFollowing()
              setPaused(!paused)
            }}
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

      {error && (
        <div role="alert" className="px-4 py-2 text-[12px]" style={{ color: '#ff9f9a' }}>
          {text[error]}
        </div>
      )}

      {/* 滚动日志列表：消息仅作为文本显示。 */}
      <div
        ref={listRef}
        onScroll={(event) => {
          const element = event.currentTarget
          followTailRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60
        }}
        className={`${embedded ? 'hc-mobile-debug__list ' : ''}selectable min-h-0 flex-1 overflow-y-auto px-4 py-3 font-mono text-[12px] leading-relaxed`}
      >
        {logs.length === 0 ? (
          <div style={{ opacity: 0.4 }}>{text.empty}</div>
        ) : (
          logs.map((entry, index) => {
            const date = new Date(entry.ts)
            const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
            return (
              <div key={index} className="whitespace-pre-wrap break-all">
                <span style={{ opacity: 0.45 }}>{time}</span>
                {' '}
                <span style={{ color: LEVEL_COLOR[entry.level], fontWeight: entry.level === 'error' ? 600 : 400 }}>
                  [{entry.level.toUpperCase()}]
                </span>
                {' '}
                <span>{entry.message}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
