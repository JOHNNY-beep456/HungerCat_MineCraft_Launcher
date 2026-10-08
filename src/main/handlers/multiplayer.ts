// 联机悬浮窗 IPC：大厅迷你窗的打开 / 关闭 / 快照读取 / 主窗口探测 / 尺寸调整。
import { BrowserWindow, ipcMain, screen } from 'electron'
import type { IpcContext } from './context'

export function registerMultiplayerWindowHandlers(ctx: IpcContext): void {
  // 联机悬浮窗：创建 / 关闭 / 读取快照。
  ipcMain.handle('mp:openMiniWindow', () => {
    ctx.createMiniWindow()
    // 窗口就绪后补推一次当前状态（避免首帧空白）。
    setTimeout(() => ctx.pushMiniWindowState(), 300)
  })
  ipcMain.handle('mp:closeMiniWindow', () => ctx.closeMiniWindow())
  ipcMain.handle('mp:miniState', () => ctx.buildMiniState())
  // 悬浮窗据此决定「退出大厅」后是自己关掉还是退回空态：
  // 主界面还在时保持悬浮窗存活（用户可能还要继续用），否则一起关闭。
  ipcMain.handle('mp:hasMainWindow', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return !!win && !win.isDestroyed() && ctx.isMainWindow(win)
  })
  ipcMain.handle('mp:miniResize', (_e, width: number, height: number) => {
    const mw = ctx.miniWindow()
    if (!mw || mw.isDestroyed()) return
    const w = Math.max(240, Math.round(width))
    // 高度上限取「当前显示器工作区」减去一点边距：渲染层按内容自适应高度，
    // 但内容很多时可能超过屏幕，这里兜底夹住，避免窗口超出屏幕导致底部控件点不到。
    // 超出部分由渲染层内容区的滚动承接。
    const bounds = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workAreaSize
    const maxH = Math.max(320, bounds.height - 40)
    const h = Math.min(maxH, Math.max(120, Math.round(height)))
    mw.setContentSize(w, h)
  })
}
