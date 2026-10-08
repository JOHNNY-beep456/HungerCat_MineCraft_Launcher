// 窗口域 IPC：最小化 / 最大化 / 关闭 / 全屏 / 置顶 / 桌面外壳 / 安全拦截强制全屏。
import { BrowserWindow, ipcMain } from 'electron'
import type { IpcContext } from './context'

export function registerWindowHandlers(ctx: IpcContext): void {
  // ---- Window controls ----
  ipcMain.handle('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.handle('window:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
  })
  ipcMain.handle('window:close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })
  ipcMain.handle('window:isMaximized', (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false)
  ipcMain.handle('window:setFullscreen', (e, on: boolean) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return false
    // 退出全屏时先还原为普通窗口，避免 Windows 上残留最大化状态
    w.setFullScreen(!!on)
    if (!on) w.unmaximize()
    return w.isFullScreen()
  })
  ipcMain.handle('window:setAlwaysOnTop', (e, on: boolean) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w) return false
    // screen-saver 级别：桌面模式下连系统任务栏也压得住
    w.setAlwaysOnTop(!!on, 'screen-saver')
    return w.isAlwaysOnTop()
  })
  /**
   * 桌面模式外壳：普通全屏（不置顶、不隐藏系统任务栏）。
   * on=true：进入普通全屏（保留系统任务栏图标，便于从任务栏 / Alt+Tab 切回），并定时维持全屏；
   * on=false：全部还原（退出全屏并恢复常规窗口状态）。
   */
  ipcMain.handle('window:setDesktopMode', (e, on: boolean) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w || w.isDestroyed()) return false
    ctx.setDesktopShellOn(on === true)
    if (ctx.desktopShellOn()) {
      // 不能用 setSkipTaskbar(true)：那会让窗口从系统任务栏消失，
      // 全屏时用户就再没有任何入口切回启动器。这里显式置 false，顺带清掉历史状态。
      w.setSkipTaskbar(false)
      w.setFullScreen(true)
      w.show()
      if (!ctx.desktopShellTimer()) {
        const timer = setInterval(() => ctx.pinDesktopShell(), 1000)
        timer.unref()
        ctx.setDesktopShellTimer(timer)
      }
    } else {
      const timer = ctx.desktopShellTimer()
      if (timer) {
        clearInterval(timer)
        ctx.setDesktopShellTimer(null)
      }
      w.setAlwaysOnTop(false)
      w.setSkipTaskbar(false)
      w.setFullScreen(false)
      w.unmaximize()
    }
    return ctx.desktopShellOn()
  })
  /**
   * 安全拦截期间的强制系统全屏：命中危险代码时要连 Windows 任务栏一起盖住，
   * 否则提示可能被别的窗口挡住、用户根本没看到。
   *
   * on=true：先记住这个窗口当时的状态（是否已全屏 / 是否最大化）再全屏；
   * on=false：按记住的状态精确还原 —— Win10 桌面模式本来就在全屏，不会被退回窗口。
   * 没有记录就收到 on=false（例如从未强制过）时什么都不做，避免误改用户的窗口状态。
   */
  const securityFullscreenPrev = new WeakMap<BrowserWindow, { fullScreen: boolean; maximized: boolean }>()
  ipcMain.handle('window:securityFullscreen', (e, on: boolean) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (!w || w.isDestroyed()) return false
    if (on) {
      if (!securityFullscreenPrev.has(w)) {
        securityFullscreenPrev.set(w, { fullScreen: w.isFullScreen(), maximized: w.isMaximized() })
      }
      w.setFullScreen(true)
      w.show()
      w.moveTop()
      return w.isFullScreen()
    }
    const prev = securityFullscreenPrev.get(w)
    if (!prev) return w.isFullScreen()
    securityFullscreenPrev.delete(w)
    if (prev.fullScreen) {
      w.setFullScreen(true)
      return true
    }
    w.setFullScreen(false)
    if (prev.maximized) w.maximize()
    return w.isFullScreen()
  })
}
