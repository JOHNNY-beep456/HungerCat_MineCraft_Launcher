/**
 * 启动器主进程逻辑与启动流程。
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  globalShortcut,
  nativeTheme,
  screen,
  session,
  Tray,
  Menu,
  nativeImage,
  type WebContents
} from 'electron'
import { join, resolve } from 'path'
import { accessSync, constants as fsConstants, mkdirSync } from 'fs'
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
import { isPortable, cleanupPendingPortableDelete, PORTABLE_GAME_DIR, resolvePortablePath } from './portable'
import { applyHardwareAcceleration, hardwareAccelerationBooted } from './hardware-accel'
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
import { registerAiHandlers } from './handlers/ai'
import { createAiService, type AiService } from './ai/service'
import { closeAiBall, syncAiBall, aiBallWindow } from './ai/ball'
import { createNeteaseLyricsService, type NeteaseLyricsService } from './netease/service'
import { isSmtcSupported } from './netease/smtc'
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
/**
 * AI 助手服务：对话编排、工具授权与浮层状态都在这一个实例里。
 *
 * 允许为 null —— 它要到 app ready 之后的 `registerIpc()` 才创建，而
 * `syncOverlayWindows()` 这类函数在类型层面无法证明自己一定晚于创建。
 */
let aiService: AiService | null = null
/**
 * 网易云歌词浮层服务（实验性）：轮询系统媒体会话 + 取歌词 + 逐句同步。
 *
 * 与 `aiService` 一样在 `registerIpc()` 里创建；允许为 null 是因为
 * `syncOverlayWindows()` 等函数无法在类型层面证明自己一定晚于它创建。
 */
let lyricsService: NeteaseLyricsService | null = null

/** AI 语音热键（Electron accelerator 写法）。 */
const AI_VOICE_ACCELERATOR = 'Control+Alt+V'
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
 *  按用户主题（system 时取系统明暗）+ 当前皮肤取色，避免浅色模式下闪出深色底。
 *  皮肤为 Material Design 3 时不读背景预设（M3 的背景就是实色 surface，见 index.css），
 *  改按 M3 的表面色取；缺省回落「午夜」（即默认背景）。 */
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

/** M3 表面色：baseline 用官方静态值；you / expressive 由主题色混出色调表面。 */
const M3_SURFACE_DARK = '#141218'
const M3_SURFACE_LIGHT = '#fef7ff'

/** 按比例把一个 hex 色混入另一个 hex 色（t = second 的占比，0~1）。解析失败时返回 base。 */
function mixHex(base: string, second: string, t: number): string {
  const parse = (c: string): [number, number, number] | null => {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim())
    if (!m) return null
    let h = m[1]
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }
  const a = parse(base)
  const b = parse(second)
  if (!a || !b) return base
  const k = Math.max(0, Math.min(1, t))
  const ch = (i: number): string =>
    Math.round(a[i] + (b[i] - a[i]) * k)
      .toString(16)
      .padStart(2, '0')
  return `#${ch(0)}${ch(1)}${ch(2)}`
}

/** Material Design 3 的主窗口底色：与 index.css 里 --m3-surface 的取值保持一致。 */
function materialSurfaceColor(dark: boolean, variant: string, accent: string): string {
  const neutral = dark ? M3_SURFACE_DARK : M3_SURFACE_LIGHT
  if (variant !== 'you' && variant !== 'expressive') return neutral
  // CSS 侧是 color-mix(in srgb, var(--m3-surface) 94%, var(--fill-primary) 6%)
  return mixHex(neutral, accent, 0.06)
}

/**
 * GitHub（Primer）各配色子主题的画布色 canvas-default。
 * 与 index.css 里 [data-gh-theme='…'] 那一组令牌逐字一致（改一处必须同步另一处）。
 */
const GITHUB_CANVAS: Record<string, string> = {
  light: '#ffffff',
  dark: '#0d1117',
  dimmed: '#22272e',
  'light-hc': '#ffffff',
  'dark-hc': '#0a0c10'
}

/** GitHub 皮肤的主窗口底色：Primer 的画布是实色，与背景预设 / 自定义壁纸无关。 */
function githubCanvasColor(dark: boolean, style: string): string {
  // 'system' 跟随外观里的主题设置，其余子主题一律按自己那一档取（与 Primer 一致：
  // 子主题独立于明暗设置）。
  const key = style === 'system' ? (dark ? 'dark' : 'light') : style
  return GITHUB_CANVAS[key] ?? (dark ? '#0d1117' : '#ffffff')
}

/** WinUI 3（Win11）的画布色：Mica 基底取 SolidBackgroundFillColorBase。 */
const WINUI3_CANVAS = { light: '#f3f3f3', dark: '#202020' } as const
/** WinUI 2（UWP / Win10）的画布色：Acrylic 基底取 SystemControlBackgroundBase。 */
const WINUI2_CANVAS = { light: '#f0f0f0', dark: '#1f1f1f' } as const

/**
 * WinUI 2 / 3 的主窗口底色。
 * 两套皮肤都是系统材质（Mica / Acrylic），底色必须与 CSS 里的
 * --wu*-canvas 完全一致，否则窗口边框处会露出色差。
 */
function winuiCanvasColor(dark: boolean, skin: 'winui2' | 'winui3'): string {
  const table = skin === 'winui3' ? WINUI3_CANVAS : WINUI2_CANVAS
  return dark ? table.dark : table.light
}

/** 我的世界皮肤的主窗口底色：与 CSS 里的 --mc-canvas 逐字一致（改一处必须同步另一处）。 */
const MINECRAFT_CANVAS = { light: '#c6c6c6', dark: '#1e1e1e' } as const

function windowBackgroundColor(): string {
  const s = settings.get()
  const dark = s.theme === 'dark' || (s.theme === 'system' && nativeTheme.shouldUseDarkColors)
  // M3 皮肤的背景是实色 surface，与背景预设 / 自定义壁纸无关
  if (s.experimental === 'material') return materialSurfaceColor(dark, s.materialStyle, s.accentColor)
  // GitHub（Primer）同理：实色 canvas-default
  if (s.experimental === 'github') return githubCanvasColor(dark, s.githubStyle)
  // WinUI 2 / 3：系统材质（Mica / Acrylic），同样是实色基底
  if (s.experimental === 'winui2' || s.experimental === 'winui3') {
    return winuiCanvasColor(dark, s.experimental)
  }
  // 我的世界：库存面板灰（浅色）/ 石头深灰（深色），实色、无渐变无纹理
  if (s.experimental === 'minecraft') {
    return dark ? MINECRAFT_CANVAS.dark : MINECRAFT_CANVAS.light
  }
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

/**
 * 构建产物根目录 `out/` 的绝对路径 —— 渲染层页面与预加载脚本都从这里解析。
 *
 * **不要直接用 `__dirname` 拼这些相对路径**：入口 src/main/index.ts 为了在安装模式
 * 下不加载本模块，用的是动态 `import('./app')`，Rollup 因此把本模块切成了
 * `out/main/chunks/app-<hash>.js`，`__dirname` 落在 `chunks/` 而不是原来的 `out/main/`。
 * 少回退一层就会去找 `out/main/renderer/index.html`，打包后直接 ERR_FILE_NOT_FOUND。
 */
const OUT_DIR = resolve(__dirname, '..', '..')

function createWindow(): void {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
  // 主窗口是自绘标题栏（登录框、状态灯、窗口按钮都在渲染层），所以必须去掉系统标题栏。
  // Windows / macOS 用 titleBarStyle: 'hidden'；Linux 不认识这个选项，只能显式 frame: false，
  // 否则会出现「系统标题栏 + 自绘标题栏」两层。
  const isLinux = process.platform === 'linux'
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    ...(isLinux ? { frame: false } : { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 18, y: 18 } }),
    backgroundColor: windowBackgroundColor(),
    icon: iconPath,
    webPreferences: {
      preload: join(OUT_DIR, 'preload/index.js'),
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
    mainWindow.loadFile(join(OUT_DIR, 'renderer/index.html'))
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
        // 托盘建不起来（Linux 缺 AppIndicator 等）时不能隐藏：隐藏后就再也唤不回来了。
        if (tray) win.hide()
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
      preload: join(OUT_DIR, 'preload/index.js'),
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
    debugWindow.loadFile(join(OUT_DIR, 'renderer/index.html'), { query: { window: 'debug' } })
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
      preload: join(OUT_DIR, 'preload/index.js'),
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
    void miniWindow.loadFile(join(OUT_DIR, 'renderer/index.html'), { query: { window: 'mini' } })
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
  try {
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  } catch (err) {
    // Linux 上托盘依赖桌面环境的 AppIndicator / StatusNotifier 支持，缺了会直接抛异常。
    // 托盘只是「窗口隐藏后唤回」的一个入口，没有它也不该让整个流程崩掉：
    // 记一条日志，转为「直接显示主窗口」的降级行为。
    console.warn('[tray] 创建托盘失败，已降级为不使用托盘：', err)
    tray = null
    return
  }
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
  /**
   * 开了歌词浮层时把 HUD 窗口放宽 / 放高一点：歌词是整句中文，360px 宽的卡片
   * 一行放不下几句、换行也多；而三行歌词 + 歌名至少要 400px 才不至于挤成一团。
   * 其它两种内容（大厅成员 / AI 回复）对尺寸不敏感，跟着一起放大没有副作用。
   */
  const lyricsWide = isHud && settings.get().neteaseLyricsHudEnabled === true
  const hudWidth = lyricsWide ? 460 : 360
  const hudHeight = lyricsWide ? 420 : 300
  const win = new BrowserWindow({
    width: isHud ? hudWidth : workArea.width,
    height: isHud ? hudHeight : workArea.height,
    x: isHud ? workArea.x + workArea.width - (hudWidth + 20) : workArea.x,
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
      preload: join(OUT_DIR, 'preload/index.js'),
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
    void win.loadFile(join(OUT_DIR, 'renderer/index.html'), { query: { window: kind } })
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

/**
 * 按设置同步两个浮层窗口的存续（进入大厅且开关开启时创建，否则关闭）。
 *
 * AI 浮层（`aiHudEnabled` + 游戏运行中）与联机 HUD 复用**同一个窗口**：
 * 两个独立的透明置顶窗口会互相遮挡、也各自消耗一个渲染进程，而它们在游戏里
 * 本来就是叠在同一块区域上的两块信息。谁需要就创建，两个都不需要才关闭。
 */
function syncOverlayWindows(): void {
  const s = settings.get()
  const inLobby = !!getMultiplayerLobby()
  const mpHud = inLobby && s.multiplayerHudEnabled
  const aiHud = aiService?.hudState().enabled ?? false
  /**
   * 网易云歌词浮层：只要实验开关开着就常驻。
   *
   * 与 AI 浮层不同，它的展示时机不依赖「游戏是否在跑」——歌词浮层本身就是
   * 「桌面上想边听边看词」的用法，而且检测播放器与是否开着游戏毫无关系。
   * 没有曲目时窗口里什么都不画（`GameHud` 自己返回 null），不会挡住桌面。
   */
  const lyricsHud = isSmtcSupported() && s.neteaseLyricsHudEnabled === true
  // 轮询 / 取歌词的启停跟着同一个条件走，避免「窗口关了就没人停轮询」。
  lyricsService?.sync()
  if (mpHud || aiHud || lyricsHud) {
    createHudWindow()
    resizeHudForLyrics(lyricsHud)
  } else closeHudWindow()
  if (inLobby && s.multiplayerDanmakuEnabled) createDanmakuWindow()
  else closeDanmakuWindow()
  pushHudState()
}

/**
 * 按「歌词浮层开没开」把 HUD 窗口调到对应尺寸。
 *
 * 窗口尺寸是在创建那一刻定下的；而用户完全可能先开着「联机 HUD」进游戏、
 * 再回设置里打开歌词开关 —— 那时窗口已经存在，不在这里补一次，歌词卡片就会
 * 挤在 360px 的窄窗里（三行中文几乎放不下）。
 */
function resizeHudForLyrics(wide: boolean): void {
  const win = hudWindow
  if (!win || win.isDestroyed()) return
  const targetW = wide ? 460 : 360
  const targetH = wide ? 420 : 300
  const [w, h] = win.getSize()
  if (w === targetW && h === targetH) return
  const { workArea } = screen.getPrimaryDisplay()
  win.setBounds({
    x: workArea.x + workArea.width - (targetW + 20),
    y: workArea.y + 20,
    width: targetW,
    height: targetH
  })
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
  // AI 浮层与联机 HUD 同窗，快照一起推，免得窗口刚建好时 AI 那块是空的。
  hudWindow.webContents.send('ai:hudState', aiService?.hudState() ?? null)
  // 歌词同理：窗口可能是「开关刚打开」时才建的，补推一次才不会有空白等待。
  if (lyricsService) hudWindow.webContents.send('music:lyricsState', lyricsService.current())
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

/**
 * AI 语音热键：Ctrl+Alt+V，按一下开始说话、再按一下结束并发送。
 *
 * 为什么需要热键：游戏内浮层是**鼠标穿透**窗口（`setIgnoreMouseEvents(true)`），
 * 拿不到点击；用户在全屏游戏里也不该为了问一句话去切窗口。所以由主进程注册
 * 全局快捷键，按下时把事件转给「当下能录音的那扇窗」：
 *   游戏内浮层（正在游戏） > 悬浮球（桌面） > 无（不做任何事）。
 *
 * 只在「AI 已开启 + 语音聊天已开启」时响应：热键常驻注册（开销可忽略），
 * 但要不要理会它按设置当场判断，这样改设置不必重注册、也不会出现
 * 「快捷键被别处抢注」的时序问题。
 */
function handleAiVoiceHotkey(): void {
  const s = settings.get()
  if (!s.aiEnabled || !s.aiVoiceEnabled) return
  const target =
    hudWindow && !hudWindow.isDestroyed() ? hudWindow : aiBallWindow()
  if (!target) return
  target.webContents.send('ai:voiceToggle')
}

/**
 * 按设置同步 AI 全局快捷键。
 *
 * 只在「AI 已开启 且 语音已开启」时占用 `Ctrl+Alt+V`。之前是无条件注册：
 * 于是从没开过 AI 的用户也会被抢走这个组合键（其它软件里按了没反应），
 * 属于明显的侵入性副作用。关掉开关时主动注销，把键还回去。
 */
function syncAiShortcuts(): void {
  const s = settings.get()
  const want = s.aiEnabled && s.aiVoiceEnabled
  if (!want) {
    if (globalShortcut.isRegistered(AI_VOICE_ACCELERATOR)) globalShortcut.unregister(AI_VOICE_ACCELERATOR)
    return
  }
  if (globalShortcut.isRegistered(AI_VOICE_ACCELERATOR)) return
  try {
    const ok = globalShortcut.register(AI_VOICE_ACCELERATOR, handleAiVoiceHotkey)
    if (!ok) console.warn(`[AI] 语音热键 ${AI_VOICE_ACCELERATOR} 注册失败（可能被其他程序占用）`)
  } catch (err) {
    console.warn('[AI] 语音热键注册异常', err)
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
      preload: join(OUT_DIR, 'preload/index.js'),
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
    devWindow.loadFile(join(OUT_DIR, 'renderer/index.html'), { query: { window: 'devtools' } })
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
  broadcastDevMode,
  // AI 工具「启动实例」不自己跑一遍启动流程，而是请主界面按用户点按钮的那条路走。
  requestLaunch: (versionId) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ai:launchRequest', versionId)
      // 主窗口在后台时把它拉到前面：用户要求「帮我启动游戏」，看不见反应会以为没生效。
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
    }
  },
  // 设置里改「游戏内浮层」开关后立刻让它生效：否则玩家在游戏里打开开关，
  // 得等下一次启动才会出现浮层。
  syncOverlays: () => {
    syncOverlayWindows()
  },
  // 语音热键按开关动态占用 / 归还，避免没用 AI 的用户被抢走组合键。
  syncAiShortcuts: () => {
    syncAiShortcuts()
  }
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

  // AI 助手：服务实例在 IPC 注册时创建（它要广播事件给所有窗口），
  // 处理器只负责参数检查与转发。
  aiService = createAiService({
    ctx: ipcContext,
    /**
     * AI 事件的路由。
     *
     * 工具确认（`ai:toolRequest`）要出现在**用户正看着的那扇窗**：悬浮球存在时
     * 只发给它，否则才广播（主窗口有一份同样的确认 UI）。都广播会让两处同时弹框。
     * 浮层状态则是纯广播——只有 HUD 窗口订阅它，其余窗口收到也不做任何事。
     */
    broadcast: (channel, payload) => {
      if (channel === 'ai:toolRequest') {
        const ball = aiBallWindow()
        if (ball) {
          ball.webContents.send(channel, payload)
          return
        }
      }
      broadcastToRenderers(channel, payload)
    }
  })
  registerAiHandlers(ipcContext, aiService)

  /**
   * 网易云歌词浮层（实验性）。
   *
   * 服务本身自己管理「要不要跑」（`sync()` 读设置），这里只给它一条出口：
   * 算出的歌词快照直接推给 HUD 窗口 —— 只有这扇窗订阅它。
   */
  lyricsService = createNeteaseLyricsService({
    push: (state) => {
      if (hudWindow && !hudWindow.isDestroyed()) {
        hudWindow.webContents.send('music:lyricsState', state)
      }
    }
  })
  ipcMain.handle('music:lyricsState', () => lyricsService?.current() ?? null)

  // 硬件加速是进程级开关（Chromium 只允许在 app ready 之前决定是否启用），
  // 改完必须重启才生效：这里把「本次启动实际用的值」暴露给设置页，
  // 并提供重启入口。重启走与托盘「退出程序」相同的收尾，
  // 先停联机子进程（EasyTier 等），否则重启后会残留。
  ipcMain.handle('app:hardwareAccelerationBooted', () => hardwareAccelerationBooted())
  ipcMain.handle('app:relaunch', async () => {
    app.relaunch()
    await quitAppCompletely()
  })
}

app.setName('HungerCatLauncher')

// ---------- 内存优化（必须在 app ready 之前生效） ----------
// 实测说明（Windows / Electron 33）：
//   · 硬件加速：默认关闭（设置项「硬件加速」可开，见 hardware-accel.ts）。
//     关闭时 disableHardwareAcceleration + disable-gpu：GPU 进程**不会消失**
//     （Chromium 在 Windows 上即使禁用硬件加速也会保留一个 GPU 进程做软件合成，
//     实测仍 ~110MB），但它把渲染转成软件模式，对低端 GPU / 集成显卡能省显存并
//     降低 GPU 相关崩溃，长期看也有助于压低 GPU 工作集。开启后走正常硬件合成，
//     模糊玻璃等特效更流畅，但会占用更多显存。
//   · SpareRendererForSitePerProcess：Chromium 默认会常驻一个「备用渲染进程」
//     （约 80~100MB）以备快速打开新窗口。本应用主窗口常驻、不频繁开窗口，禁用它
//     可在确实出现备用进程的场合省掉这一路。
//   · max-old-space-size：限制各进程 V8 老生代堆上限，避免 GC 后堆不回缩导致
//     内存虚高（对主进程 / 渲染进程都生效）。这是最稳的一档优化。
// 硬件加速是进程级开关，必须在 ready 之前决定，所以这里在设置缓存初始化前读一次。
applyHardwareAcceleration(settings.get().hardwareAcceleration)
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=96')
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,CalculateNativeWinOcclusion')

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

/**
 * 便携版默认目录（启动器旁边的 .minecraft）可读写检查。
 *
 * 只提示、不阻塞启动：放在只读介质 / Program Files 里时，用户需要立刻知道
 * 「存档和版本写不进去」，而不是等到装版本时才看到一屏 EPERM。
 */
function checkPortableGameDir(): void {
  if (!isPortable) return
  const dir = resolvePortablePath(PORTABLE_GAME_DIR)
  let reason = ''
  try {
    mkdirSync(dir, { recursive: true })
    accessSync(dir, fsConstants.R_OK | fsConstants.W_OK)
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err)
  }
  if (!reason) return
  void dialog.showMessageBox({
    type: 'warning',
    title: '便携版目录不可用',
    message: '无法读写启动器目录下的 .minecraft',
    detail: `${dir}\n\n${reason}\n\n请把启动器放到可写的位置（用户目录或 U 盘）后重新运行。`,
    buttons: ['知道了']
  })
}

app.whenReady().then(() => {
  initLogger()
  checkPortableGameDir()
  // 上次自更新时旧版本 exe 若被占用没删掉，这里补一刀
  cleanupPendingPortableDelete()
  // 启动器是自绘界面（含标题栏、菜单跳转全在渲染层），不需要 Electron 的默认应用菜单。
  // Windows 下它本来就被隐藏，但 Linux 会把默认菜单栏画进窗口内部 —— 那会出现
  // 「自绘标题栏下面多一条 File/Edit/View」的错位，所以这里直接去掉。
  Menu.setApplicationMenu(null)
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
    openHudWindow: createHudWindow,
    /**
     * 渲染层说的「关闭 HUD」只代表**联机那块**不再需要这扇窗。
     *
     * 这扇窗同时承载 AI 浮层与网易云歌词浮层（见 syncOverlayWindows）。
     * 渲染层在「不在大厅」时会无条件调一次 closeHudWindow()（启动时就会发生一次），
     * 直接 close 会把刚按设置建好的歌词浮层当场拆掉 —— 表现为「开关开了却什么都看不到」。
     * 所以这里改成「按当前设置重算存续」：谁还需要它，它就留着。
     */
    closeHudWindow: () => {
      syncOverlayWindows()
    },
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
    }
  })
  // 联机悬浮窗：创建 / 关闭 / 读取快照。
  registerMultiplayerWindowHandlers(ipcContext)
  // 注意：不再在启动关键路径上 fork 网络进程。netRequest 首次调用时会经 ensureNetworkWorker
  // 自动拉起，因此这里改为在窗口 ready-to-show 之后再建立（见 createWindow），
  // 避免 utilityProcess 冷启动与 Chromium 抢资源、拖慢首屏。
  createWindow()
  // AI 悬浮球：按设置恢复（位置由 aiBallX / aiBallY 持久化，见 ai/ball.ts）。
  syncAiBall()
  // 网易云歌词浮层：开着的用户启动即恢复轮询与浮层窗口（没开则什么也不做）。
  syncOverlayWindows()
  // AI 语音热键：游戏内 / 桌面都能一键说话（浮层是鼠标穿透的，只能靠热键）。
  syncAiShortcuts()
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
})

app.on('window-all-closed', () => {
  // 托盘后台模式下不退出：窗口虽全部关闭，程序仍在托盘常驻（联机继续）。
  if (tray) return
  app.quit()
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
  // 悬浮球是独立窗口，主窗口关掉不会带走它。
  closeAiBall()
  // 歌词采样是常驻 PowerShell 子进程，必须显式收掉，否则会残留到下次启动。
  lyricsService?.dispose()
  lyricsService = null
  // 全局快捷键必须显式释放，否则重启后可能被上一次的注册占着。
  globalShortcut.unregisterAll()
})
