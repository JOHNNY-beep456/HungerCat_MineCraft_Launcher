import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import { AppProvider } from './store'
import { MiniWindow } from './components/MiniWindow'

/**
 * 大厅悬浮窗的独立入口。
 *
 * 悬浮窗虽然复用了主界面的样式与组件，但 MiniWindow 内部通过 useApp() 取文案，
 * 必须被 AppProvider 包住——否则 useApp() 会直接抛错，React 挂载失败，
 * 表现为「点了悬浮窗，窗口一片空白 / 打不开」。
 */
export function mountMiniWindow(): void {
  const container = document.getElementById('root') as HTMLElement
  ReactDOM.createRoot(container).render(
    <AppProvider>
      <MiniWindow />
    </AppProvider>
  )
}
