import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  nativeTheme,
  screen,
  session,
  Tray,
  Menu,
  nativeImage,
  type WebContents
} from 'electron'
import { join } from 'path'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import type {
  DebugLogEntry,
  JavaRuntime,
  LauncherSettings,
  MpChatMessage,
  MpDanmaku,
  MpHudState
} from '@shared/types'
import { settings, activeGameDir, allVersionDirs, flushWrites } from './store'
import { initLogger, subscribeLogs } from './logger'
import { startNetworkWorker, stopNetworkWorker } from './broker'
import { DedupCache } from './ipc-cache'
import type { DeviceCodeSession } from './auth'
import { detectJava, isJavaSuitable, javaVersionAt, pickJava } from './java'
import {
  registerMultiplayerIpc,
  forceStopMultiplayer,
  getMultiplayerLobby,
  getMultiplayerPlayers,
  getMultiplayerAppState,
  getMultiplayerHudPlayers
} from './multiplayer'
import {
  devModeStatus,
  enforceDevModeExpiry,
  setDevModeBroadcaster,
  startDevModeExpiryWatch
} from './devmode'
import { registerAuthHandlers } from './handlers/auth'
import { registerAccountsHandlers } from './handlers/accounts'
import { registerVersionsHandlers } from './handlers/versions'
import { registerModsHandlers } from './handlers/mods'
import { registerJavaHandlers } from './handlers/java'
import { registerLaunchHandlers } from './handlers/launch'
import { registerSettingsHandlers } from './handlers/settings'
import { registerHomepageHandlers } from './handlers/homepage'
import { registerNetworkHandlers } from './handlers/network'
import { registerDebugHandlers } from './handlers/debug'
import { registerWindowHandlers } from './handlers/window'
import { registerFilesHandlers } from './handlers/files'
import { registerMultiplayerWindowHandlers } from './handlers/multiplayer'
import type { IpcContext } from './handlers/context'

let mainWindow: BrowserWindow | null = null
let debugWindow: BrowserWindow | null = null
let debugLogListener: ((entry: DebugLogEntry) => void) | null = null
/** 开发模式：独立「开发者工具（F12）」窗口。 */
let devWindow: BrowserWindow | null = null
/** 联机板块：大厅小悬浮窗（无边框、置顶、可拖拽）。 */
let miniWindow: BrowserWindow | null = null
let authSession: DeviceCodeSession | null = null
let gameProcess: ChildProcessWithoutNullStreams | null = null
/** 全部下载任务的取消控制器，按 taskId 区分（版本安装 / Java / 资源下载共用）。 */
const downloadAborts = new Map<string, AbortController>()
/**
 * 正在进行的版本安装（按版本 id）。用于让「需要原版就绪」的后续步骤（如 Forge 安装器）
 * 等待原版下载完成 —— 安装器 jar 的下载可与原版并发，但运行安装器必须等原版下完。
 */
const activeInstalls = new Map<string, Promise<unknown>>()
// ---- 实验性 Win10 桌面的「强置顶外壳」状态 ----
// 桌面模式要连 Windows 的任务栏与开始菜单都盖住：主窗口全屏 + 最高层级置顶 +
// 不进系统任务栏。只设一次不够 —— 别的程序抢到前台后系统会重排顶层窗口，置顶
// 被顶掉任务栏就冒出来了，所以进入该模式期间用定时器把外壳重新钉回去。
let desktopShellOn = false
let desktopShellTimer: ReturnType<typeof setInterval> | null = null
// 高频重复读取通道的去抖 + 结果缓存：多个页面挂载时会独立调用同一 channel，
// 并发重复请求合并为一次底层执行；版本变更时显式失效保证即时刷新。
const versionsCache = new DedupCache(5 * 60 * 1000) // 原版版本清单：TTL 5min（清单很少变；key 含来源策略）
// 已安装版本/世界/服务器列表缓存：本地扫描很重（几十个版本 × 存档 / 服务器 / version JSON），
// 原先 TTL 仅 5s —— 用户在多个版本目录间来回切换时，每次超过 5s 都要重新全量扫描，
// 这是「切换版本目录卡顿 / 未响应」的直接原因之一。
// 所有会改变结果的入口（装版本 / 删 / 改 / 导入 / 版本目录增删改）都已显式 invalidateAll，
// 因此这里可以把 TTL 放宽到 60s：应用内的任何变更仍即时生效，只有「用户手动在文件管理器里
// 改动版本目录」这种外部变化最多延迟 60s 才被感知。
const installedCache = new DedupCache(60 * 1000)

/** 已装版本列表缓存 key：当前版本目录 + 隔离策略决定扫描范围。 */
function installedCacheKey(s: ReturnType<typeof settings.get>): string {
  return `${activeGameDir(s)}|${s.versionIsolation}|${s.isolatedVersions.join(',')}`
}

/**
 * 挑出「适合」运行需要 `required` 大版本游戏的 Java（无合适则返回 null）。
 *
 * 候选 = 自动检测结果 + 「设置」里手动指定的 Java：后者可能是文件对话框选出、
 * 不在自动扫描范围内的路径，必须一并纳入，否则会把本机已有的合适 Java 误判成没有。
 * 判定用 isJavaSuitable（见 java.ts）：老版本（≤1.16.5）不吃更高版本的 Java。
 */
async function suitableJavaFor(s: LauncherSettings, required: number): Promise<JavaRuntime | null> {
  const runtimes = await detectJava(allVersionDirs(s).map((d) => d.path))
  const configured = s.javaPath
  if (configured && !runtimes.some((r) => r.path === configured)) {
    const jr = await javaVersionAt(configured)
    if (jr) runtimes.push(jr)
  }
  return pickJava(
    runtimes.filter((r) => isJavaSuitable(r, required)),
    required
  )
}

/* ------------------------------------------------------------------ */
/* 窗口底色：仅在首帧绘制前 / 拖拽缩放露边时可见                        */
/* ------------------------------------------------------------------ */

/** 主窗口底色。渲染层会用 .app-background 铺满窗口，这里只负责「露底」的那一瞬：
 *  按用户主题（system 时取系统明暗）+ 背景预设取色，避免浅色模式下闪出深色底。
 *  与 index.css 的背景预设一一对应；缺省回落「午夜」（即默认背景）。 */
const WINDOW_BG_DARK: Record<string, string> = {
  midnight: '#04060f',
  sunset: '#2a0a14',
  forest: '#04120f',
  rose: '#2a0a1c',
  mono: '#0d0d10'
}

const WINDOW_BG_LIGHT: Record<string, string> = {
  midnight: '#eef1fa',
  sunset: '#fff4ec',
  forest: '#eefaf3',
  rose: '#fff0f6',
  mono: '#f4f4f6'
}

function windowBackgroundColor(): string {
  const s = settings.get()
  const dark = s.theme === 'dark' || (s.theme === 'system' && nativeTheme.shouldUseDarkColors)
  const table = dark ? WINDOW_BG_DARK : WINDOW_BG_LIGHT
  return table[s.background] ?? (dark ? '#04060f' : '#eef1fa')
}

/** 主题 / 背景预设 / 系统明暗变化后刷新主窗口底色。 */
function applyWindowBackground(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(windowBackgroundColor())
}

/**
 * 判断某个导航目标是不是「外泄型外部地址」（F-05）。
 *
 * 自定义主页跑在 sandbox="allow-scripts" 的 iframe 里，虽然拿不到顶层控制权，
 * 但仍可对「自身」导航（location 赋值 / meta refresh），把拼接出的数据带出去。
 * 这类导航型外泄不受 CSP connect-src 管辖，必须在主进程先行拦截。
 * 协议相对 // 与 http(s) 视为外部；渲染层自身入口（dev server / file / about）放行。
 */
function isExternalNavTarget(rawUrl: string): boolean {
  const url = rawUrl.trim()
  if (!url) return false
  if (url.startsWith('file://') || url.startsWith('about:') || url.startsWith('devtools:')) return false
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev && url.startsWith(dev)) return false
  if (url.startsWith('//')) return true
  return /^https?:\/\//i.test(url)
}

/**
 * 把主窗口重新钉成「强置顶外壳」。
 * 光在进入桌面模式时设一次不够：别的程序（尤其全屏游戏 / 系统弹窗）抢到前台后，
 * Windows 会重排顶层窗口，置顶失效，任务栏与开始菜单就会冒出来盖住桌面。
 */
function pinDesktopShell(): void {
  const w = mainWindow
  if (!desktopShellOn || !w || w.isDestroyed()) return
  // 只维持「普通全屏」，不再强置顶：避免盖住系统任务栏与其它程序（与常见全屏应用一致）。
  if (!w.isFullScreen()) w.setFullScreen(true)
}

function createWindow(): void {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: windowBackgroundColor(),
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 首帧可见后立即显示窗口，并把「网络进程 fork」推迟到窗口显示之后再稍等一会儿：
  // fork utilityProcess 会拉起一个新的 Node 进程（几百 MB 内存 + CPU 冷启动），
  // 放在建窗口之前会和 Chromium 抢启动资源、拖慢首屏；即使放到 ready-to-show，
  // 也正好与首帧合成 / 渲染进程初始化重叠。这里再延后 1.2s，让首屏彻底稳定后再 fork，
  // 压低「打开启动器」瞬间的内存/CPU 峰值。网络进程只在真正发起网络请求时才会被用到
  // （版本清单 / 主页更新检查等，渲染层已进一步延后到空闲），推迟建立不影响任何功能。
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    const timer = setTimeout(() => startNetworkWorker(), 1200)
    mainWindow?.once('closed', () => clearTimeout(timer))
  })

  // 安全：主页沙箱（iframe）只能渲染，绝不允许自我导航把数据带出去
  // （d01 meta refresh / d02 location 赋值）。这类导航不受 connect-src 管辖，
  // 因此在导航发生「前」拦截，并通知渲染层立刻弹出封锁遮罩（F-05）。
  mainWindow.webContents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return
    const url = details.url
    if (!isExternalNavTarget(url)) return
    details.preventDefault()
    const wc = mainWindow?.webContents
    if (wc && !wc.isDestroyed()) wc.send('homepage:nav-blocked', url)
    console.warn(`[主页安全] 已拦截沙箱主页的对外导航：${url}`)
  })

  // 实验性 Win10 桌面只做「启动器自己的桌面外壳」：不再捕获 / 搬动任何外部窗口，
  // 因此窗口移动与缩放无需做任何外部窗口重新摆放。桌面模式下的 MC 由启动参数强制全屏
  // （见 launch:start 的 winMode），它就是一个正常的独立全屏窗口。

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 关窗拦截：联机进行中时询问「退出 / 放置后台」，避免误关导致掉线与残留进程。
  mainWindow.on('close', (event) => {
    if (isQuitting) return
    // 仅联机进行中才拦截；平时关窗即正常退出，不打扰用户。
    if (getMultiplayerAppState() !== 'in-lobby') return
    event.preventDefault()
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    void (async () => {
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['确认退出', '放置后台', '取消'],
        defaultId: 0,
        cancelId: 2,
        // 中文按钮；noLink 避免 Windows 把按钮渲染成命令链接样式。
        noLink: true,
        title: '退出启动器',
        message: '当前正在联机中',
        detail:
          '「确认退出」将关闭所有联机进程（含虚拟网络）并退出程序；\n' +
          '「放置后台」将隐藏窗口并最小化到系统托盘，联机继续保持。'
      })
      if (response === 0) {
        // 确认退出：关闭所有进程后退出。
        void quitAppCompletely()
      } else if (response === 1) {
        // 放置后台：隐藏窗口 + 建托盘，联机不中断。
        ensureTray()
        win.hide()
      }
      // 取消：什么都不做。
    })()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/** 创建（或唤起）独立日志窗口，并把主进程日志实时推送到该窗口。 */
function createDebugWindow(): void {
  if (debugWindow && !debugWindow.isDestroyed()) {
    if (debugWindow.isMinimized()) debugWindow.restore()
    debugWindow.focus()
    return
  }
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
  debugWindow = new BrowserWindow({
    width: 720,
    height: 520,
    minWidth: 420,
    minHeight: 280,
    title: '启动器日志 - Debug',
    show: false,
    backgroundColor: '#0b0d14',
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  debugWindow.once('ready-to-show', () => debugWindow?.show())

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    debugWindow.loadURL(`${rendererUrl}?window=debug`)
  } else {
    debugWindow.loadFile(join(__dirname, '../renderer/index.html'), { query: { window: 'debug' } })
  }

  // 把增量日志推送到该窗口；窗口关闭时退订，避免泄漏。
  debugLogListener = (entry) => {
    debugWindow?.webContents.send('debug:log', entry)
  }
  subscribeLogs(debugLogListener)

  debugWindow.on('closed', () => {
    debugLogListener = null
    debugWindow = null
  })
}

function closeDebugWindow(): void {
  if (debugWindow && !debugWindow.isDestroyed()) debugWindow.close()
}

/* ------------------------------------------------------------------ */
/* 联机板块：大厅小悬浮窗                                               */
/* ------------------------------------------------------------------ */

/**
 * 打开（或唤起）大厅小悬浮窗。
 *
 * 参考 MCTier 的 MiniWindow：无边框、置顶、可拖拽、不占任务栏，方便玩家在游戏时
 * 随时查看大厅人数与每个人的虚拟 IP。窗口独立于主界面，关闭主界面也仍可用。
 */
function createMiniWindow(): void {
  if (miniWindow && !miniWindow.isDestroyed()) {
    if (miniWindow.isMinimized()) miniWindow.restore()
    miniWindow.show()
    miniWindow.focus()
    return
  }

  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')

  miniWindow = new BrowserWindow({
    width: 300,
    height: 420,
    minWidth: 240,
    minHeight: 180,
    show: false,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 始终置顶：游戏时也能看到（MCTier 的迷你窗同样如此）。
    alwaysOnTop: true,
    hasShadow: false,
    // 透明窗口在部分 Windows 环境（独显 + 缩放）下会出现「窗口在、内容不可见」，
    // 用默认白色底兜底：透明由 CSS 的圆角外壳负责，视觉几乎无差别但可靠得多。
    backgroundColor: '#00000000',
    transparent: true,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 用 did-finish-load 而不是 ready-to-show 来显示：透明窗口在部分 Windows 显卡 /
  // 缩放环境下 ready-to-show 可能一直不触发，窗口就会「创建了但永远不显示」。
  // 页面加载完成即显示，是更可靠的兜底；下面的 ready-to-show 保留为加速路径。
  miniWindow.once('ready-to-show', () => miniWindow?.show())
  miniWindow.webContents.once('did-finish-load', () => miniWindow?.show())
  // 渲染失败必须留痕，否则用户只看到「点了没反应」而无从排查。
  miniWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[悬浮窗] 页面加载失败 code=${code} ${desc} ${url}`)
  })
  miniWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[悬浮窗] 渲染进程退出 reason=${details.reason}`)
  })
  miniWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // 只转发警告/错误，避免刷屏。
    if (level >= 2) console.warn(`[悬浮窗] 控制台(${level}) ${message} (${sourceId}:${line})`)
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void miniWindow.loadURL(`${rendererUrl}?window=mini`)
  } else {
    void miniWindow.loadFile(join(__dirname, '../renderer/index.html'), { query: { window: 'mini' } })
  }

  // 悬浮窗被用户手动关闭时清理引用。
  miniWindow.on('closed', () => {
    miniWindow = null
  })
}

function closeMiniWindow(): void {
  if (miniWindow && !miniWindow.isDestroyed()) miniWindow.close()
}

/* ------------------------------------------------------------------ */
/* 联机浮层窗口：HUD（成员状态）与弹幕                                    */
/* ------------------------------------------------------------------ */

/**
 * HUD 浮层 / 弹幕窗口。
 *
 * 二者都是「透明 + 无边框 + 置顶 + 跳过任务栏 + 鼠标穿透」的覆盖窗，与 MCTier 的
 * `gamehud` / `danmaku` 窗口对应：游戏全屏时也能看到，且不抢鼠标焦点。
 * 鼠标穿透用 `setIgnoreMouseEvents(true, { forward: true })`——`forward` 让
 * 点击仍能穿透到下面的游戏，同时本窗口仍能收到 mousemove（用于将来做交互）。
 */
let hudWindow: BrowserWindow | null = null
let danmakuWindow: BrowserWindow | null = null

/**
 * 系统托盘。
 *
 * 「联机时关闭窗口放置后台」用它承载：主窗口隐藏后仍能通过托盘重新唤起或真正退出。
 */
let tray: Tray | null = null
/** 是否正在执行「真正退出」（区分「关闭窗口»隐藏到后台」与「退出程序」）。 */
let isQuitting = false

/**
 * 创建系统托盘（幂等）。
 *
 * 仅在「联机时选择放置后台」后创建：平时不需要托盘，避免常驻占位。
 * 菜单提供「显示主界面 / 退出程序」，双击托盘图标同样唤回主界面。
 */
function ensureTray(): void {
  if (tray) return
  const icon = nativeImage.createFromPath(iconPathForWindows())
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('饥饿猫我的世界启动器')
  const menu = Menu.buildFromTemplate([
    {
      label: '显示主界面',
      click: () => showMainWindow()
    },
    { type: 'separator' },
    {
      label: '退出程序',
      click: () => {
        // 从托盘退出等同于「确认退出」：关闭所有子进程后再退出。
        void quitAppCompletely()
      }
    }
  ])
  tray.setContextMenu(menu)
  tray.on('double-click', () => showMainWindow())
}

/** 销毁托盘（退出时清理）。 */
function destroyTray(): void {
  if (!tray) return
  tray.destroy()
  tray = null
}

/** 唤回并聚焦主窗口（从托盘 / 二次启动时调用）。 */
function showMainWindow(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

/**
 * 真正退出程序：停止联机（关闭 EasyTier 等子进程）后退出。
 *
 * 与「关闭窗口放置后台」相对；托盘菜单的「退出程序」与关闭确认框的「确认退出」都走这里。
 */
async function quitAppCompletely(): Promise<void> {
  if (isQuitting) return
  isQuitting = true
  destroyTray()
  try {
    await forceStopMultiplayer()
  } catch {
    /* 联机可能未启动，忽略 */
  }
  app.quit()
}

function iconPathForWindows(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
}

/** 创建一个浮层窗口（透明 / 置顶 / 穿透），并挂载指定 `?window=` 入口。 */
function createOverlayWindow(kind: 'hud' | 'danmaku'): BrowserWindow {
  const workArea = screen.getPrimaryDisplay().workArea
  const isHud = kind === 'hud'
  const win = new BrowserWindow({
    width: isHud ? 360 : workArea.width,
    height: isHud ? 300 : workArea.height,
    x: isHud ? workArea.x + workArea.width - 380 : workArea.x,
    y: isHud ? workArea.y + 20 : workArea.y,
    show: false,
    frame: false,
    transparent: true,
    resizable: isHud,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false,
    backgroundColor: '#00000000',
    icon: iconPathForWindows(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  // 鼠标穿透：游戏里点击不会被浮层吃掉。
  win.setIgnoreMouseEvents(true, { forward: true })
  // 置顶等级：屏幕保护之上，保证全屏游戏也可见。
  win.setAlwaysOnTop(true, 'screen-saver')

  win.once('ready-to-show', () => win.show())
  win.webContents.once('did-finish-load', () => {
    win.show()
    // HUD 是「只订阅、不拉取」的展示窗：加载完成时主动补推一次，
    // 否则若窗口是在已有成员之后才创建，会出现「打开了却一直空白」。
    if (kind === 'hud') pushHudState()
  })
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[${kind}] 页面加载失败 code=${code} ${desc}`)
  })
  win.on('closed', () => {
    if (kind === 'hud') hudWindow = null
    else danmakuWindow = null
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void win.loadURL(`${rendererUrl}?window=${kind}`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { window: kind } })
  }
  return win
}

function createHudWindow(): void {
  if (hudWindow && !hudWindow.isDestroyed()) {
    hudWindow.show()
    return
  }
  hudWindow = createOverlayWindow('hud')
}

function closeHudWindow(): void {
  if (hudWindow && !hudWindow.isDestroyed()) hudWindow.close()
}

function createDanmakuWindow(): void {
  if (danmakuWindow && !danmakuWindow.isDestroyed()) {
    danmakuWindow.show()
    return
  }
  danmakuWindow = createOverlayWindow('danmaku')
}

function closeDanmakuWindow(): void {
  if (danmakuWindow && !danmakuWindow.isDestroyed()) danmakuWindow.close()
}

/** 按设置同步两个浮层窗口的存续（进入大厅且开关开启时创建，否则关闭）。 */
function syncOverlayWindows(): void {
  const s = settings.get()
  const inLobby = !!getMultiplayerLobby()
  if (inLobby && s.multiplayerHudEnabled) createHudWindow()
  else closeHudWindow()
  if (inLobby && s.multiplayerDanmakuEnabled) createDanmakuWindow()
  else closeDanmakuWindow()
}

/** 向 HUD 浮层推送最新成员状态。 */
function pushHudState(): void {
  if (!hudWindow || hudWindow.isDestroyed()) return
  const s = settings.get()
  const payload: MpHudState = {
    enabled: s.multiplayerHudEnabled,
    opacity: s.multiplayerHudOpacity,
    players: getMultiplayerHudPlayers()
  }
  hudWindow.webContents.send('mp:hudState', payload)
}

/** 把一条聊天消息推给弹幕窗口（按弹幕设置渲染）。 */
function pushDanmaku(msg: MpChatMessage): void {
  if (!danmakuWindow || danmakuWindow.isDestroyed()) return
  const s = settings.get()
  if (!s.multiplayerDanmakuEnabled) return
  const payload: MpDanmaku = {
    id: msg.id,
    text: msg.isSelf ? `我：${msg.content}` : `${msg.playerName}：${msg.content}`,
    fontSize: s.multiplayerDanmakuFontSize,
    speed: s.multiplayerDanmakuSpeed,
    opacity: s.multiplayerDanmakuOpacity,
    tracks: s.multiplayerDanmakuTracks
  }
  danmakuWindow.webContents.send('mp:danmaku', payload)
}

/** 向所有渲染层广播事件（聊天 / 语音信令等）。 */
function broadcastToRenderers(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** 是否为主界面（用于「主界面是否存在」判断，悬浮窗按此决定自己的行为）。 */
function isMainWindow(win: BrowserWindow): boolean {
  return !!mainWindow && !mainWindow.isDestroyed() && win.id === mainWindow.id
}

/** 向悬浮窗推送最新的大厅快照。 */
function pushMiniWindowState(): void {
  if (!miniWindow || miniWindow.isDestroyed()) return
  miniWindow.webContents.send('mp:miniState', buildMiniState())
}

/**
 * 大厅状态变化时同步所有界面。
 *
 * 关键：主界面与悬浮窗是两个独立渲染进程，谁发起的操作都只改主进程里的那份状态。
 * 原来只推悬浮窗，导致「在悬浮窗里退出大厅」后主界面仍显示在大厅中（且表单页
 * 停留不跳转）。这里统一广播 mp:lobbyChanged，两个界面各自监听并重新拉取状态。
 * 顺带把悬浮窗快照也推一次，保持置顶小窗实时。
 */
function broadcastLobbyChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('mp:lobbyChanged')
  }
  pushMiniWindowState()
  // HUD 浮层与大厅成员状态同步（含说话指示）。
  pushHudState()
  // 进入 / 离开大厅时按设置增删浮层窗口（创建/关闭均为幂等）。
  syncOverlayWindows()
}

/** 组装悬浮窗所需的大厅快照。 */
function buildMiniState(): {
  lobby: ReturnType<typeof getMultiplayerLobby>
  players: ReturnType<typeof getMultiplayerPlayers>
  appState: string
} {
  return {
    lobby: getMultiplayerLobby(),
    players: getMultiplayerPlayers(),
    appState: getMultiplayerAppState()
  }
}

/**
 * 开发模式：打开独立「开发者工具（F12）」窗口。
 * 单独开窗而非在主界面内嵌面板，避免内容过多把主界面挤乱（用户明确要求）。
 * 仅当开发模式处于开启状态时允许打开。
 */
function createDevWindow(): void {
  if (enforceDevModeExpiry()) broadcastDevMode()
  if (!devModeStatus().enabled) return
  if (devWindow && !devWindow.isDestroyed()) {
    if (devWindow.isMinimized()) devWindow.restore()
    devWindow.focus()
    return
  }
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
  devWindow = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 560,
    minHeight: 400,
    title: '开发者工具 - 开发模式',
    show: false,
    backgroundColor: '#0b0d14',
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  devWindow.once('ready-to-show', () => devWindow?.show())

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    devWindow.loadURL(`${rendererUrl}?window=devtools`)
  } else {
    devWindow.loadFile(join(__dirname, '../renderer/index.html'), { query: { window: 'devtools' } })
  }

  devWindow.on('closed', () => {
    devWindow = null
  })
}

/** 关闭独立开发者工具窗口（关闭开发模式 / 授权失效时调用）。 */
function closeDevWindow(): void {
  if (devWindow && !devWindow.isDestroyed()) devWindow.close()
}

/** 关闭主窗口的原生 Chromium DevTools（关闭开发模式 / 授权失效时调用）。 */
function closeNativeDevTools(): void {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.isDevToolsOpened()) {
    mainWindow.webContents.closeDevTools()
  }
}

/** 把开发模式状态广播给全部窗口（主窗口设置页 + 开发者工具窗口）。 */
function broadcastDevMode(): void {
  const s = devModeStatus()
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('devmode:changed', s)
  }
}

function sendToSender(sender: WebContents, channel: string, payload: unknown): void {
  if (!sender.isDestroyed()) sender.send(channel, payload)
}

/** 判断某个实例是否隔离（全局隔离或整合包实例强制隔离）。 */
function isIsolated(versionId: string): boolean {
  const s = settings.get()
  return s.versionIsolation || s.isolatedVersions.includes(versionId)
}

/**
 * 解析目标版本目录路径：显式给 dirId 时用它（找不到则回退生效目录），否则用生效目录。
 * 供「资源下载时安装到指定目录里的实例」使用——实例可能位于非当前生效的目录。
 */
function dirPathById(s: ReturnType<typeof settings.get>, dirId?: string): string {
  if (dirId) {
    const d = allVersionDirs(s).find((x) => x.id === dirId)
    if (d) return d.path
  }
  return activeGameDir(s)
}

/** 「进行中安装」的登记键：含目录，避免同名实例在不同目录互相覆盖登记。 */
function installKey(versionId: string, dirId?: string): string {
  return `${dirId || ''}|${versionId}`
}

/* ------------------------------------------------------------------ */
/* IPC 统一插桩：让每个 ipcMain.handle 调用都打印开始/完成/失败日志        */
/* ------------------------------------------------------------------ */

/**
 * 高频 / 纯读取通道：跳过起止日志，避免刷屏（多数被渲染层周期轮询）。
 * 失败 / 异常仍会记录（不用 quiet 判定失败路径）。
 */
const QUIET_CHANNELS = new Set([
  'system:memory', // 首页每 30s 轮询
  'window:isMaximized', // 标题栏状态轮询
  'app:version',
  'settings:get',
  'debug:isEnabled',
  'accounts:list',
  'accounts:selected',
  'homepage:log' // 脚本日志按条触发，本身已落到调试日志缓冲，无需再记 IPC 起止
])

/** 该频道中哪些参数位是敏感字符串（如账号密码），一律只记 <redacted>，绝不打印明文。 */
const SECRET_ARG_POS: Record<string, number[]> = {
  'accounts:addYggdrasil': [2] // 第 0=server、1=email、2=password
}

/** 把单个参数转成可疑日志的安全摘要：字符串截断、对象只列字段名（隐藏具体值）。 */
function summarizeArg(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return v.length > 100 ? `${v.slice(0, 100)}…` : v
  if (typeof v !== 'object') return String(v)
  if (Array.isArray(v)) return v.length ? `[${v.length}项]` : '[]'
  const keys = Object.keys(v as object)
  return keys.length ? `{${keys.join(',')}}` : '{}'
}

/** 汇总 IPC 参数为日志摘要（敏感位替换为 <redacted>）。 */
function ipcArgsSummary(channel: string, args: unknown[]): string {
  if (!args.length) return '-'
  const secret = SECRET_ARG_POS[channel] ?? []
  return args.map((a, i) => (secret.includes(i) ? '<redacted>' : summarizeArg(a))).join(' ')
}

/** 包装单个 IPC handler，记录开始 / 完成 / 失败。不改变返回结构，异常原样抛出。 */
function wrapIpc(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): typeof listener {
  return async (event, ...args) => {
    const quiet = QUIET_CHANNELS.has(channel)
    if (!quiet) console.info(`[IPC] 开始 ${channel} 参数={${ipcArgsSummary(channel, args)}}`)
    const started = Date.now()
    try {
      const result = await listener(event, ...args)
      if (!quiet) console.info(`[IPC] 完成 ${channel} (${Date.now() - started}ms)`)
      return result
    } catch (err) {
      console.error(`[IPC] 失败 ${channel}: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
  }
}

/**
 * 供各域处理器使用的共享上下文。
 *
 * 可变引用（窗口 / 进程 / 缓存等）通过取值 / 赋值函数暴露，动作函数直接指向本文件中等价的
 * 辅助实现，保证与拆分前完全一致的行为。
 */
const ipcContext: IpcContext = {
  mainWindow: () => mainWindow,
  setMainWindow: (w) => {
    mainWindow = w
  },
  miniWindow: () => miniWindow,
  setMiniWindow: (w) => {
    miniWindow = w
  },
  gameProcess: () => gameProcess,
  setGameProcess: (p) => {
    gameProcess = p
  },
  authSession: () => authSession,
  setAuthSession: (s) => {
    authSession = s
  },
  desktopShellOn: () => desktopShellOn,
  setDesktopShellOn: (v) => {
    desktopShellOn = v
  },
  desktopShellTimer: () => desktopShellTimer,
  setDesktopShellTimer: (t) => {
    desktopShellTimer = t
  },
  downloadAborts,
  activeInstalls,
  versionsCache,
  installedCache,
  installedCacheKey,
  suitableJavaFor,
  applyWindowBackground,
  pinDesktopShell,
  isIsolated,
  dirPathById,
  installKey,
  sendToSender,
  createDebugWindow,
  closeDebugWindow,
  createMiniWindow,
  closeMiniWindow,
  pushMiniWindowState,
  isMainWindow,
  buildMiniState,
  createDevWindow,
  closeDevWindow,
  closeNativeDevTools,
  broadcastDevMode
}

function registerIpc(): void {
  // IPC 统一插桩：与 logger 相同的 monkey-patch 手法，全局包住 ipcMain.handle，
  // 使每个注册处都已接日志而无需逐个手改、也避免日后新增注册遗漏。
  const origHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel, listener) => {
    origHandle(channel, wrapIpc(channel, listener))
  }) as typeof ipcMain.handle

  // 各域处理器已拆分到 src/main/handlers/，此处仅做注册编排。
  registerAuthHandlers(ipcContext)
  registerAccountsHandlers(ipcContext)
  registerVersionsHandlers(ipcContext)
  registerModsHandlers(ipcContext)
  registerJavaHandlers(ipcContext)
  registerLaunchHandlers(ipcContext)
  registerSettingsHandlers(ipcContext)
  registerHomepageHandlers(ipcContext)
  registerNetworkHandlers(ipcContext)
  registerDebugHandlers(ipcContext)
  registerWindowHandlers(ipcContext)
  registerFilesHandlers(ipcContext)
}

app.setName('HungerCatLauncher')

// 远端语音通过 <audio> 播放 WebRTC 轨道。Chromium 默认的自动播放策略会拦截
// 「无用户手势」的音频播放，表现为：连接已建立、说话指示也正常，但**听不到对方说话**。
// 语音是大厅里的显式交互功能（由用户主动开麦触发），这里放开自动播放限制。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// 进程级兜底：主进程出现未处理拒绝 / 未捕获异常时先落日志（进 debug 窗口），避免
// “静默退到命令提示符”（无异常日志、无从排查）。拿到具体堆栈后可再根治对应模块。
process.on('unhandledRejection', (reason) => {
  console.error('[主进程-未处理拒绝]', reason instanceof Error ? reason.stack ?? reason.message : reason)
})
process.on('uncaughtException', (err) => {
  console.error('[主进程-未捕获异常]', err.stack ?? err)
})

app.whenReady().then(() => {
  initLogger()
  // 联机语音需要麦克风。必须**显式**放行 media 权限：
  // 未设置该处理函数时，是否放行取决于 Electron 版本（部分版本对 media 默认拒绝），
  // 被拒后 getUserMedia 会直接抛 NotAllowedError，而渲染层只写进控制台 ——
  // 界面上毫无反应，表现正是「语音聊天无法使用」。这里只放行媒体类权限，其余一律拒绝。
  // 注意：麦克风 / 摄像头的权限名就是 'media'（'audioCapture' / 'videoCapture' 是
  // macOS 上 systemPreferences.askForMediaAccess 的媒体类型，不属于该枚举）。
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })
  // 同步权限检查：`enumerateDevices` 读取设备名（label）、以及部分版本下 getUserMedia
  // 的前置校验都会走这里。若不放行，设备下拉只能显示「麦克风 1」这类占位名，且个别
  // Electron 版本会因此拒绝采集。这里只放行媒体类，其余保持默认拒绝。
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media')
  registerIpc()
  // 联机板块（MCTier 移植）：注册 mp:* 通道。组网资源在首次调用时才真正使用，
  // 这里只挂 IPC，不产生额外启动开销。
  registerMultiplayerIpc({
    onLobbyChanged: broadcastLobbyChanged,
    // 说话状态：只刷新 HUD 浮层。交谈中该状态每秒可切换多次，
    // 若走 broadcastLobbyChanged（全窗口广播 + 同步浮层窗口）会造成持续卡顿。
    onSpeakingChanged: pushHudState,
    openHudWindow: createHudWindow,
    closeHudWindow,
    openDanmakuWindow: createDanmakuWindow,
    closeDanmakuWindow,
    syncOverlays: () => {
      syncOverlayWindows()
      pushHudState()
    },
    // 新消息：广播给所有渲染层（主界面 / 悬浮窗据此处提示音、聊天面板），并推给弹幕窗口。
    broadcastChat: (msg) => {
      broadcastToRenderers('mp:chat', msg)
      pushDanmaku(msg)
    },
    // 语音音频：收到某成员的 UDP 音频帧后推给渲染层解码播放。
    broadcastVoiceAudio: (peerId, data) =>
      broadcastToRenderers('mp:voiceAudio', { from: peerId, data: new Uint8Array(data) })
  })
  // 联机悬浮窗：创建 / 关闭 / 读取快照。
  registerMultiplayerWindowHandlers(ipcContext)
  // 注意：不再在启动关键路径上 fork 网络进程。netRequest 首次调用时会经 ensureNetworkWorker
  // 自动拉起，因此这里改为在窗口 ready-to-show 之后再建立（见 createWindow），
  // 避免 utilityProcess 冷启动与 Chromium 抢资源、拖慢首屏。
  createWindow()
  // 用户在系统里切换明暗模式时，同步窗口底色（主题为「跟随系统」时才实际变化）。
  nativeTheme.on('updated', applyWindowBackground)
  // 开发模式：注册状态广播 + 到期兜底检查（到期自动关闭并回收开发者工具窗口）。
  setDevModeBroadcaster((s) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('devmode:changed', s)
    }
    if (!s.enabled) closeDevWindow()
    if (!s.enabled) closeNativeDevTools()
  })
  startDevModeExpiryWatch()
  if (enforceDevModeExpiry()) broadcastDevMode()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // 托盘后台模式下不退出：窗口虽全部关闭，程序仍在托盘常驻（联机继续）。
  if (tray) return
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  isQuitting = true
  destroyTray()
  // 回收网络进程并拒绝所有在途网络请求。
  stopNetworkWorker()
  // 把在途的设置 / 账号异步写盘刷完，避免退出时丢掉最后一次修改。
  void flushWrites()
  // 联机板块：退出启动器时停掉 EasyTier 与虚拟网卡，避免残留虚拟网卡影响下次启动。
  void forceStopMultiplayer()
  closeMiniWindow()
})
