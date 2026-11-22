import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import { AppProvider } from './store'
import { MiniWindow } from './components/MiniWindow'

const MINI_READY_TIMEOUT_MS = 5000
const MINI_READY_ATTEMPTS = 25
const MINI_READY_RETRY_MS = 150

/** 页面加载可能早于原生 owner promote；只重试快照握手，不并发堆积原生请求。 */
function waitForMiniReady(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let attempts = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (retry !== undefined) clearTimeout(retry)
      if (deadline !== undefined) clearTimeout(deadline)
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve()
    }
    const abort = (): void => finish(new Error('迷你窗挂载已取消 / 迷你窗掛載已取消 / Mini window mounting was cancelled'))
    const failed = (): void => finish(new Error('联机小窗初始化失败，请从主窗口重新打开 / 連線小窗初始化失敗，請從主視窗重新開啟 / Mini window initialization failed; reopen it from the main window'))
    const attempt = (): void => {
      if (settled || signal.aborted) { abort(); return }
      attempts += 1
      // 先检查取消再发起调用；未返回的调用只由总超时结束等待，不继续叠加请求。
      void Promise.resolve().then(() => {
        if (settled || signal.aborted) return
        return window.api.mp.miniState()
      }).then(() => {
        if (!settled && !signal.aborted) finish()
      }).catch(() => {
        if (settled || signal.aborted) return
        if (attempts >= MINI_READY_ATTEMPTS) { failed(); return }
        retry = setTimeout(attempt, MINI_READY_RETRY_MS)
      })
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    deadline = setTimeout(failed, MINI_READY_TIMEOUT_MS)
    attempt()
  })
}

/** Tauri 不支持 Electron 的 app-region；拖动只触发当前精确小窗的内部原生命令。 */
function installMiniDrag(signal: AbortSignal): void {
  const start = (event: PointerEvent): void => {
    if (event.button !== 0 || !event.isPrimary || !(event.target instanceof Element)) return
    const target = event.target
    if (!target.closest('[data-mini-drag]') || target.closest('.no-drag, button, input, textarea, select, a')) return
    event.preventDefault()
    void import('../../tauri/native-invoke').then(({ nativeInvoke }) =>
      nativeInvoke<void>('launcher_call', { channel: 'mp:miniDrag', args: [] })
    ).catch((error: unknown) => console.warn('联机小窗拖动失败：', error))
  }
  document.addEventListener('pointerdown', start)
  signal.addEventListener('abort', () => document.removeEventListener('pointerdown', start), { once: true })
}

/** mini 只创建一个 React root；Tauri 先握手再挂载受限 Provider，Electron 保持原入口。 */
export async function mountMiniWindow(signal: AbortSignal): Promise<void> {
  const tauri = '__TAURI_INTERNALS__' in window
  if (signal.aborted) return
  if (tauri) await waitForMiniReady(signal)
  if (signal.aborted) return
  if (tauri) installMiniDrag(signal)
  const container = document.getElementById('root')
  if (!container) throw new Error('迷你窗缺少挂载节点 / 迷你窗缺少掛載節點 / Mini window mount point is missing')
  const root = ReactDOM.createRoot(container)
  signal.addEventListener('abort', () => root.unmount(), { once: true })
  root.render(
    <AppProvider scope="mini">
      <MiniWindow />
    </AppProvider>
  )
}