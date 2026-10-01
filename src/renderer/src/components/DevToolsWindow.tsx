import { useEffect, useRef, useState } from 'react'
import type { DebugLogEntry, DevModeStatus } from '@shared/types'

const LEVEL_COLOR: Record<DebugLogEntry['level'], string> = {
  info: 'rgba(255,255,255,0.82)',
  warn: '#ffd60a',
  error: '#ff453a'
}

const SEC_LABEL: Record<DevModeStatus['securityMode'], string> = {
  full: '完全模拟',
  warn: '仅提示',
  off: '完全关闭'
}

/**
 * 开发模式：独立「开发者工具（F12）」窗口。
 *
 * 单独开窗而非在主界面内嵌面板，避免内容过多把主界面挤乱（用户明确要求）。
 * 内容分三块：开发模式状态、三档安全防护切换、主进程日志（含主页脚本日志）。
 */
export function DevToolsWindow(): JSX.Element {
  const [dev, setDev] = useState<DevModeStatus | null>(null)
  const [logs, setLogs] = useState<DebugLogEntry[]>([])
  const [paused, setPaused] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  // 订阅开发模式状态（主进程广播开关 / 解除 / 到期）。
  useEffect(() => {
    void window.api.devMode.status().then(setDev).catch(() => {})
    return window.api.devMode.onChanged(setDev)
  }, [])

  // 先取滚动缓冲，再订阅增量，避免漏收窗口创建后的日志。
  useEffect(() => {
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

  const setSecurity = (mode: DevModeStatus['securityMode']): void => {
    void window.api.devMode.setSecurityMode(mode).then(setDev)
  }

  const mode = dev?.securityMode ?? 'full'

  return (
    <div className="flex h-full flex-col" style={{ background: '#0b0d14', color: 'rgba(255,255,255,0.85)' }}>
      {/* 顶部工具条 */}
      <div
        className="flex items-center justify-between gap-3 px-4 py-2"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold opacity-90">开发者工具</span>
          {dev?.granted ? (
            <span
              className="rounded-md px-2 py-0.5 text-[11px]"
              style={{
                border: '1px solid rgba(255,255,255,0.14)',
                color: dev.enabled ? '#30d158' : 'rgba(255,255,255,0.6)'
              }}
            >
              {dev.enabled ? '开发模式已开启' : '开发模式已关闭'}
            </span>
          ) : (
            <span className="rounded-md px-2 py-0.5 text-[11px]" style={{ border: '1px solid rgba(255,255,255,0.14)', color: '#ff453a' }}>
              未授权
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] opacity-50">安全防护</span>
          {(['full', 'warn', 'off'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setSecurity(m)}
              disabled={!dev?.granted}
              className="rounded-md px-2 py-1 text-[12px] transition-colors hover:bg-white/10"
              style={{
                border: '1px solid rgba(255,255,255,0.14)',
                opacity: !dev?.granted ? 0.4 : m === mode ? 1 : 0.65,
                background: m === mode ? 'rgba(255,255,255,0.12)' : 'transparent'
              }}
            >
              {SEC_LABEL[m]}
            </button>
          ))}
        </div>
      </div>

      {/* 状态条 */}
      <div
        className="flex items-center justify-between gap-3 px-4 py-1.5 text-[12px]"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', opacity: 0.7 }}
      >
        <span>
          {dev?.granted
            ? `授权邮箱 ${dev.emailMasked || '—'} ｜ 剩余 ${fmtRemaining(dev.expiresAt)}`
            : '请先在设置页验证授权邮箱以开启开发模式'}
        </span>
        <span>生效档位：{SEC_LABEL[dev?.effectiveSecurityMode ?? 'full']}</span>
      </div>

      {/* 日志工具条 */}
      <div
        className="flex items-center justify-between gap-3 px-4 py-2"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
      >
        <span className="text-[13px] font-semibold opacity-90">主进程日志</span>
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
      <div ref={listRef} className="selectable min-h-0 flex-1 overflow-y-auto px-4 py-3 font-mono text-[12px] leading-relaxed">
        {logs.length === 0 ? (
          <div style={{ opacity: 0.4 }}>暂无日志。主页脚本日志需在设置页开启「Debug 模式」后才会采集。</div>
        ) : (
          logs.map((l, i) => {
            const t = new Date(l.ts)
            const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`
            return (
              <div key={i} className="whitespace-pre-wrap break-all">
                <span style={{ opacity: 0.45 }}>{time}</span>{' '}
                <span style={{ color: LEVEL_COLOR[l.level], fontWeight: l.level === 'error' ? 600 : 400 }}>
                  [{l.level.toUpperCase()}]
                </span>{' '}
                <span>{l.message}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/** 把到期时间格式化为「x 小时 y 分钟」/「x 分钟」。 */
function fmtRemaining(expiresAt: number): string {
  const ms = expiresAt - Date.now()
  if (ms <= 0) return '已过期'
  const totalMin = Math.floor(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`
}
