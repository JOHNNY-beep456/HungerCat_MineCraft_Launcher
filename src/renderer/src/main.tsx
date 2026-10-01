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