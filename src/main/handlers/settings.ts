// 设置域 IPC：应用设置、应用版本、主显示器信息、系统内存 / 硬件、自定义壁纸。
import { app, ipcMain, screen } from 'electron'
import { freemem, totalmem } from 'os'
import type { LauncherSettings } from '@shared/types'
import { settings, detectHardware } from '../store'
import { syncAiBall } from '../ai/ball'
import { clearWallpaper, pickWallpaper, wallpaperData } from '../wallpaper'
import type { IpcContext } from './context'

export function registerSettingsHandlers(ctx: IpcContext): void {
  // ---- Settings ----
  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:set', (_e, partial: Partial<LauncherSettings>) => {
    const next = settings.set(partial)
    // 主题 / 背景预设 / M3 与 GitHub 皮肤及其配色 / 主题色变化后同步窗口底色
    if (
      partial.theme !== undefined ||
      partial.background !== undefined ||
      partial.experimental !== undefined ||
      partial.materialStyle !== undefined ||
      partial.githubStyle !== undefined ||
      partial.accentColor !== undefined
    ) {
      ctx.applyWindowBackground()
    }
    // Debug 模式只控制「是否记录启动日志」，不再自动弹出日志窗口（需要时到设置里手动打开）。
    // 注意：这里不再因填写调试密钥而自动采集 / 上传日志 —— 收集必须经用户在设置页
    // 明确同意后才由 debug:submit 触发，避免「提交反馈即开始收集」。
    //
    // AI 开关变化后立刻同步悬浮球窗口：设置页与悬浮球自带的「×」都只是改这个开关，
    // 窗口的创建 / 销毁统一由 syncAiBall() 负责，否则关掉开关后球会一直留在屏幕上。
    if (partial.aiEnabled !== undefined || partial.aiBallEnabled !== undefined) {
      syncAiBall()
    }
    // 语音热键是全局抢注的：开关一变就重新占用 / 归还。
    if (partial.aiEnabled !== undefined || partial.aiVoiceEnabled !== undefined) {
      ctx.syncAiShortcuts()
    }
    // 浮层开关同理：进游戏后打开 / 关闭「游戏内浮层」，窗口要当场跟随。
    // 存续条件依赖「设置 + 现场（是否在大厅 / 游戏是否运行）」，只有
    // syncOverlayWindows() 同时掌握两边，所以交给它重算一次。
    // 歌词浮层的开关也在其中；`mode`（切到「本地」会停掉联网歌词）同样要重算。
    if (
      partial.aiHudEnabled !== undefined ||
      partial.aiEnabled !== undefined ||
      partial.multiplayerHudEnabled !== undefined ||
      partial.multiplayerDanmakuEnabled !== undefined ||
      partial.neteaseLyricsHudEnabled !== undefined ||
      partial.mode !== undefined
    ) {
      ctx.syncOverlays()
    }
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
  // 硬件探测：返回 CPU 核心数 / 型号 / 年代、是否虚拟机、物理内存总量。
  ipcMain.handle('system:hardware', () => detectHardware())
}
