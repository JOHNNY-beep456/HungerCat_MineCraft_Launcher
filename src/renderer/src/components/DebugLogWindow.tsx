import { useEffect, useRef, useState } from 'react'
import type { DebugLogEntry } from '@shared/types'

const LEVEL_COLOR: Record<DebugLogEntry['level'], string> = {
  info: 'rgba(255,255,255,0.82)',
  warn: '#ffd60a',
  error: '#ff453a'
}

/** 独立主进程日志窗口（深色简约视图）。 */
export function DebugLogWindow(): JSX.Element {
  const [logs, setLogs] = useState<DebugLogEntry[]>([])
  const [paused, setPaused] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // 先取滚动缓冲，再订阅增量，避免漏收窗口创建后的日志。
    void window.api.debug.getLogs().then((initial) => setLogs(initial))
    return window.api.debug.onLog((entry) => {
      setLogs((prev) => [...prev, entry].slice(-3000))
    })
  }, [])

  // 自动滚动到底部（暂停或用户上翻时不滚动）。
  useEffect(() => {
    const el = listRef.current
    if (!el || paused) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [logs, paused])

  return (
    <div
      className="flex h-full flex-col"
      style={{ background: '#0b0d14', color: 'rgba(255,255,255,0.85)' }}
    >
      {/* 顶部工具条 */}
      <div
        className="flex items-center justify-between gap-3 px-4 py-2"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
      >
        <span className="text-[13px] font-semibold opacity-90">启动器日志</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setLogs([])
              setPaused(false)
            }}
            className="rounded-md px-2 py-1 text-[12px] opacity-80 transition-colors hover:bg-white/10"
            style={{ border: '1px solid rgba(255,255,255,0.14)' }}
          >
            清空
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
            {paused ? '已暂停' : '暂停滚动'}
          </button>
        </div>
      </div>

      {/* 滚动日志列表 */}
      <div
        ref={listRef}
        className="selectable min-h-0 flex-1 overflow-y-auto px-4 py-3 font-mono text-[12px] leading-relaxed"
      >
        {logs.length === 0 ? (
          <div style={{ opacity: 0.4 }}>暂无日志。</div>
        ) : (
          logs.map((l, i) => {
            const t = new Date(l.ts)
            const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`
            return (
              <div key={i} className="whitespace-pre-wrap break-all">
                <span style={{ opacity: 0.45 }}>{time}</span>
                {' '}
                <span style={{ color: LEVEL_COLOR[l.level], fontWeight: l.level === 'error' ? 600 : 400 }}>
                  [{l.level.toUpperCase()}]
                </span>
                {' '}
                <span>{l.message}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}