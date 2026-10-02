import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'

const windowKind = new URLSearchParams(window.location.search).get('window')

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