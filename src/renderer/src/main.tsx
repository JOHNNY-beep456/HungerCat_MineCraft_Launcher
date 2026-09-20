import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'

const isDebugWindow = new URLSearchParams(window.location.search).get('window') === 'debug'

async function mount(): Promise<void> {
  const container = document.getElementById('root') as HTMLElement
  const root = ReactDOM.createRoot(container)
  if (isDebugWindow) {
    // 独立日志窗口：只挂载极简日志视图，不加载完整启动器界面。
    const { DebugLogWindow } = await import('./components/DebugLogWindow')
    root.render(<DebugLogWindow />)
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