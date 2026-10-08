// 设置域 IPC：应用设置、应用版本、主显示器信息、系统内存 / 硬件、自定义壁纸。
import { app, ipcMain, screen } from 'electron'
import { freemem, totalmem } from 'os'
import type { LauncherSettings } from '@shared/types'
import { settings, detectHardware } from '../store'
import { clearWallpaper, pickWallpaper, wallpaperData } from '../wallpaper'
import type { IpcContext } from './context'

export function registerSettingsHandlers(ctx: IpcContext): void {
  // ---- Settings ----
  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:set', (_e, partial: Partial<LauncherSettings>) => {
    const next = settings.set(partial)
    // 主题 / 背景预设变化后同步窗口底色
    if (partial.theme !== undefined || partial.background !== undefined) ctx.applyWindowBackground()
    // Debug 模式只控制「是否记录启动日志」，不再自动弹出日志窗口（需要时到设置里手动打开）。
    // 注意：这里不再因填写调试密钥而自动采集 / 上传日志 —— 收集必须经用户在设置页
    // 明确同意后才由 debug:submit 触发，避免「提交反馈即开始收集」。
    return next
  })
  ipcMain.handle('app:version', () => app.getVersion())
  // 主显示器尺寸（逻辑像素）：供「游戏窗口尺寸」的自定义与预览使用。
  ipcMain.handle('display:primary', () => {
    const d = screen.getPrimaryDisplay()
    return {
      width: d.size.width,
      height: d.size.height,
      workWidth: d.workAreaSize.width,
      workHeight: d.workAreaSize.height,
      scaleFactor: d.scaleFactor
    }
  })
  // 自定义壁纸：选图（复制进数据目录）/ 清除 / 取 data URL
  ipcMain.handle('settings:pickWallpaper', () => pickWallpaper())
  ipcMain.handle('settings:clearWallpaper', () => clearWallpaper())
  ipcMain.handle('settings:wallpaperData', () => wallpaperData())
  ipcMain.handle('system:memory', () => {
    const total = Math.round(totalmem() / 1024 / 1024)
    const free = Math.round(freemem() / 1024 / 1024)
    return { total, used: total - free, free }
  })
  // 硬件探测：返回 CPU 核心数 / 内存总量，并判定是否低配（超低占用模式自动开启用）。
  ipcMain.handle('system:hardware', () => detectHardware())
}
