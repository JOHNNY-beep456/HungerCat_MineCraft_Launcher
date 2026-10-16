import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { childEnvWithoutPortable, installerPayloadDir } from './detect'
import { INSTALLER_APP_NAME, defaultDirFor, normalizeScope } from './paths'
import {
  buildInfo,
  describeError,
  installElevated,
  requestCancel,
  runInstall,
  type InstallOptions,
  type ProgressFn
} from './install'
import { bootstrapHeadless } from './headless'
import { currentUserName } from './paths'

/**
 * 安装模式入口。
 *
 * `Setup.exe` 就是启动器自身（electron-builder 的 portable 目标），因此这里只做
 * 一件事：建一个装界面自己的无边框窗口，跑完安装流程后拉起装好的启动器。
 * 启动器自身的 store / 网络进程 / 多方 IPC / 开发模式等一概不初始化 ——
 * 主入口（src/main/index.ts）会在检测到安装模式时**根本不加载**那些模块。
 */

let win: BrowserWindow | null = null

/** 安装器界面资源：随渲染层原样拷到 out/renderer/installer/（见 src/renderer/public）。 */
const UI_DIR = join('renderer', 'installer')

/**
 * 构建产物根目录 `out/` 的绝对路径。
 *
 * 同 app.ts：入口用动态 `import('./installer')`，本模块被切成
 * `out/main/chunks/index-<hash>.js`，`__dirname` 落在 chunks/，故要回退两层。
 */
const OUT_DIR = resolve(__dirname, '..', '..')

/** 向渲染层推送进度。 */
const onProgress: ProgressFn = (phase, percent, detail) => {
  if (win && !win.isDestroyed()) win.webContents.send('installer:progress', { phase, percent, detail })
}

/** 创建安装器窗口（尺寸 / 无边框 / 背景色沿用原独立安装器）。 */
function createWindow(): void {
  win = new BrowserWindow({
    width: 820,
    height: 620,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    backgroundColor: '#0b0c14',
    show: false,
    webPreferences: {
      preload: join(OUT_DIR, UI_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.setMenuBarVisibility(false)
  win.loadFile(join(OUT_DIR, UI_DIR, 'index.html'))
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => {
    win = null
  })
}

/** 注册 installer:* 通道（与原独立安装器完全同名同参）。 */
function registerIpc(src: string): void {
  ipcMain.handle('installer:info', () => buildInfo(src, currentUserName()))

  ipcMain.handle('installer:chooseDir', async (_e, scope: string) => {
    const options = {
      title: '选择安装目录',
      defaultPath: defaultDirFor(normalizeScope(scope)),
      properties: ['openDirectory', 'createDirectory'] as const
    }
    const r = win
      ? await dialog.showOpenDialog(win, { ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle('installer:start', async (_e, opts: InstallOptions) => {
    if (normalizeScope(opts?.scope) === 'all') return installElevated(src, opts, onProgress)
    return runInstall(src, opts, onProgress)
  })

  ipcMain.handle('installer:cancel', () => requestCancel())

  ipcMain.handle('installer:launch', async (_e, exePath: string) => {
    if (!exePath || !existsSync(exePath)) return { ok: false }
    // 不用 shell.openPath：它拉起的进程会继承父进程环境，把 portable 变量一并带过去，
    // 已安装的启动器会因此再次进入安装模式（弹出来的还是安装向导）。详见
    // childEnvWithoutPortable 的注释。
    try {
      const child = spawn(exePath, [], {
        detached: true,
        stdio: 'ignore',
        env: childEnvWithoutPortable()
      })
      child.unref()
    } catch (err) {
      return { ok: false, error: describeError(err) }
    }
    return { ok: true }
  })

  ipcMain.handle('installer:openFolder', (_e, dir: string) => {
    if (dir) void shell.openPath(dir)
    return true
  })

  ipcMain.handle('installer:quit', () => {
    app.quit()
    return true
  })

  ipcMain.handle('installer:minimize', () => {
    win?.minimize()
    return true
  })
}

/** 本次是以什么凭据进入安装模式的 —— 排障时第一眼要看的东西。 */
function detectionReason(): string {
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    return `便携包（PORTABLE_EXECUTABLE_FILE=${process.env.PORTABLE_EXECUTABLE_FILE}）`
  }
  const flag = process.argv.find((a) => a.startsWith('--hc-'))
  return `命令行开关（${flag ?? '未知'}）`
}

/**
 * 启动安装模式。返回 true 表示已接管（调用方不要再走正常启动路径）。
 */
export function runInstallerMode(): boolean {
  // 任务栏 / Alt-Tab 里的名字要显示「安装程序」而不是启动器名 —— 两者现在是同一个
  // 可执行文件，只靠 setName 区分。
  app.setName(INSTALLER_APP_NAME)

  const src = installerPayloadDir()
  console.info(
    `[安装器] 进入安装模式：${detectionReason()}；载荷源 ${src}`
  )

  app.whenReady().then(() => {
    registerIpc(src)
    if (bootstrapHeadless(src)) return
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => app.quit())

  return true
}