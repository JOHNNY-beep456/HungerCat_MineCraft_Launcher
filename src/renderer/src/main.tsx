import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'

const windowKind = new URLSearchParams(window.location.search).get('window')

/**
 * 渲染层日志 / 错误统一转发到主进程。
 *
 * 主进程在 Debug 模式或填了调试密钥时会把日志缓冲上传到服务端，方便站长排查问题。
 * 这里做三件事：
 *   1) 转发 console 的 warn/error（保留原生行为，仅旁路一份给主进程）；
 *   2) 捕获 window 的 error / unhandledrejection 全局错误；
 *   3) 上报失败的动态 import（挂载失败最常见的原因）。
 * 日志窗口自身不转发，避免噪音。
 */
function installLogForwarding(): void {
  const report = window.api?.debug?.reportLog
  if (typeof report !== 'function') return
  if (windowKind === 'debug') return
  const send = (level: 'info' | 'warn' | 'error', message: string): void => {
    try {
      report(level, message)
    } catch {
      // 转发失败不能影响渲染层本身。
    }
  }
  const stringify = (value: unknown): string => {
    if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      original(...args)
      send(level, args.map(stringify).join(' '))
    }
  }
  window.addEventListener('error', (e) => {
    if (e.error) send('error', stringify(e.error))
    else send('error', `${e.message} (${e.filename}:${e.lineno}:${e.colno})`)
  })
  window.addEventListener('unhandledrejection', (e) => {
    send('error', `未处理的 Promise 拒绝: ${stringify(e.reason)}`)
  })
}

installLogForwarding()

async function mount(): Promise<void> {
  const container = document.getElementById('root') as HTMLElement
  const root = ReactDOM.createRoot(container)
  if (windowKind === 'debug') {
    // 独立日志窗口：只挂载极简日志视图，不加载完整启动器界面。
    const { DebugLogWindow } = await import('./components/DebugLogWindow')
    root.render(<DebugLogWindow />)
  } else if (windowKind === 'devtools') {
    // 开发模式：独立「开发者工具（F12）」窗口，与主界面分开，避免内容挤乱。
    const { DevToolsWindow } = await import('./components/DevToolsWindow')
    root.render(<DevToolsWindow />)
  } else if (windowKind === 'mini') {
    // 联机板块：大厅悬浮窗（无边框置顶小窗，类似 MCTier 的迷你窗）。
    // MiniWindow 内部用 useApp() 取文案，这里必须补上 AppProvider，
    // 否则 useApp() 抛错会导致整个悬浮窗渲染失败（看起来像「打不开」）。
    const { mountMiniWindow } = await import('./mini-bootstrap')
    mountMiniWindow()
  } else if (windowKind === 'hud') {
    // 联机板块：游戏内 HUD 浮层（透明穿透，显示成员与说话状态）。
    const { GameHud } = await import('./components/GameHud')
    root.render(<GameHud />)
  } else if (windowKind === 'danmaku') {
    // 联机板块：消息弹幕浮层（透明穿透，滚动显示聊天消息）。
    const { DanmakuOverlay } = await import('./components/DanmakuOverlay')
    root.render(<DanmakuOverlay />)
  } else {
    const { default: App } = await import('./App')
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    )
  }
}

void mount()