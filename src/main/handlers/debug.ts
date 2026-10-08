// 调试域 IPC：日志窗口与日志上传（Debug），以及开发模式（开发工具窗口 / 原生 DevTools / 授权）。
import { ipcMain } from 'electron'
import type { DebugLogEntry } from '@shared/types'
import { appendExternalLog, getLogBuffer } from '../logger'
import { submitDebugLogs } from '../debug-report'
import { settings } from '../store'
import {
  devModeStatus,
  enforceDevModeExpiry,
  revokeDevMode,
  sendDevModeCode,
  setDevModeEnabled,
  setDevModeSecurityMode,
  verifyDevMode
} from '../devmode'
import type { IpcContext } from './context'

export function registerDebugHandlers(ctx: IpcContext): void {
  // ---- Debug 日志 ----
  ipcMain.handle('debug:getLogs', () => getLogBuffer())
  ipcMain.handle('debug:open', () => {
    ctx.createDebugWindow()
  })
  ipcMain.handle('debug:close', () => {
    ctx.closeDebugWindow()
  })
  ipcMain.handle('debug:isEnabled', () => settings.get().debugMode)
  // 用调试密钥上传诊断日志（设置页手动重传 / 填写后自动上传共用）。
  ipcMain.handle('debug:submit', (_e, key: string) => submitDebugLogs(String(key ?? '')))
  // 渲染层日志转发：汇入同一缓冲，上传时一并带走。
  ipcMain.on('debug:rendererLog', (_e, level: DebugLogEntry['level'], message: string) => {
    appendExternalLog(level, String(message ?? ''))
  })

  // ---- 开发模式（Development Mode）----
  // 授权由服务端签发：邮箱须在后台白名单内，验证码通过后获得 1 天授权；
  // 授权期内可自由开关、调整主页安全防护档位、随时解除；到期自动关闭。
  ipcMain.handle('devmode:status', () => {
    if (enforceDevModeExpiry()) ctx.broadcastDevMode()
    return devModeStatus()
  })
  ipcMain.handle('devmode:sendCode', (_e, email: string) => sendDevModeCode(email))
  ipcMain.handle('devmode:verify', async (_e, email: string, code: string) => {
    const res = await verifyDevMode(email, code)
    ctx.broadcastDevMode()
    return res
  })
  ipcMain.handle('devmode:setEnabled', async (_e, enabled: boolean) => {
    const s = await setDevModeEnabled(enabled)
    // 关闭开发模式即回收独立开发者工具窗口。
    if (!s.enabled) ctx.closeDevWindow()
    if (!s.enabled) ctx.closeNativeDevTools()
    ctx.broadcastDevMode()
    return s
  })
  ipcMain.handle('devmode:revoke', async () => {
    const s = await revokeDevMode()
    ctx.closeDevWindow()
    ctx.closeNativeDevTools()
    ctx.broadcastDevMode()
    return s
  })
  ipcMain.handle('devmode:setSecurityMode', async (_e, mode: 'full' | 'warn' | 'off') => {
    const s = await setDevModeSecurityMode(mode)
    ctx.broadcastDevMode()
    return s
  })
  ipcMain.handle('devmode:openTools', () => {
    ctx.createDevWindow()
  })
  ipcMain.handle('devmode:closeTools', () => {
    ctx.closeDevWindow()
  })
  // 原生 Chromium DevTools（元素 / 控制台 / 网络 / 源代码），以独立窗口（detach）打开，
  // 与主界面分离避免拥挤。仅开发模式开启时可用。
  ipcMain.handle('devmode:openDevTools', () => {
    if (enforceDevModeExpiry()) ctx.broadcastDevMode()
    if (!devModeStatus().enabled) return false
    const w = ctx.mainWindow()
    if (!w || w.isDestroyed()) return false
    if (w.webContents.isDevToolsOpened()) {
      w.webContents.devToolsWebContents?.focus()
      return true
    }
    w.webContents.openDevTools({ mode: 'detach' })
    return true
  })
  ipcMain.handle('devmode:closeDevTools', () => {
    const w = ctx.mainWindow()
    if (w && !w.isDestroyed() && w.webContents.isDevToolsOpened()) {
      w.webContents.closeDevTools()
    }
  })
}
