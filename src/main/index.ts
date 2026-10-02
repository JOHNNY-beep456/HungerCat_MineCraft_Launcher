import { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme, screen, type WebContents } from 'electron'
import { join, basename } from 'path'
import { totalmem, freemem } from 'os'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import type {
  ForgeKind,
  LaunchOptions,
  LoaderKind,
  MinecraftAccount,
  ModrinthType,
  ModpackExportOptions,
  ResourceKind,
  VersionDirKind,
  LauncherSettings,
  UpdateInfo,
  DebugLogEntry,
  HomepageSubmitPayload,
  HomepageUpdate,
  DevModeStatus,
  ConflictPolicy,
  DownloadPhase,
  ResourceUpdateInfo,
  ModSource,
  SourceFilter,
  JavaRuntime
} from '@shared/types'
import {
  accounts,
  settings,
  createOfflineAccount,
  activeGameDir,
  allVersionDirs,
  detectHardware,
  flushWrites,
  invalidateSettingsCache
} from './store'
import { clearUapisKey, getUapisKey, setUapisKey } from './secret'
import { initLogger, getLogBuffer, subscribeLogs } from './logger'
import { startNetworkWorker, stopNetworkWorker, netRequest } from './broker'
import { DedupCache } from './ipc-cache'
import { DeviceCodeSession, refreshAccount } from './auth'
import { loginYggdrasil, commitYggdrasilProfiles, refreshYggdrasil, ensureAuthlibInjector, fetchYggdrasilSiteName } from './yggdrasil'
import { fetchVersionManifest, resolveVersionJson, createVanillaInstance } from './versions'
import { listInstalled } from './installed'
import { scanExternalVersions, importExternalVersion } from './import-version'
import { installVersion } from './downloader'
import { nativeDownloaderStatus } from './native-downloader'
import { detectJava, installJava, invalidateJavaCache, isJavaSuitable, javaVersionAt, pickJava, pickInstallerJava, requiredJavaForMc } from './java'
import { spawnGame } from './launcher'
import { registerMultiplayerIpc, forceStopMultiplayer, getMultiplayerLobby, getMultiplayerPlayers, getMultiplayerAppState } from './multiplayer'
import { loaderVersions, installLoader } from './loaders'
import { forgeVersions, installForge } from './forge'
import { installMod, downloadTo, findFabricApi } from './modrinth'
import { resolveProjectDetail, resolveVersionsFor, searchResources } from './sources'
import { listResources, removeResource, openResourceDir } from './resources'
import { applyResourceUpdate, checkResourceUpdates } from './resource-updates'
import {
  createFile,
  listDir,
  listPlaces,
  openPath,
  readText,
  removeEntry,
  renameEntry,
  revealPath,
  writeText
} from './files'
import { clearWallpaper, pickWallpaper, wallpaperData } from './wallpaper'
import { probeModpack, importModpack, importModpackFromUrl, exportModpack, collectExportInventory, downloadModpack } from './modpack'
import { fetchAbout, fetchAgreement, fetchUpdateInfo, downloadUpdate, runUpdate, compareVersions, isPrerelease, updateFileExists, updateFileName } from './server'
import {
  devModeStatus,
  enforceDevModeExpiry,
  revokeDevMode,
  sendDevModeCode,
  setDevModeBroadcaster,
  setDevModeEnabled,
  setDevModeSecurityMode,
  startDevModeExpiryWatch,
  verifyDevMode
} from './devmode'
import {
  listHomepages,
  readHomepage,
  importHomepage,
  downloadHomepage,
  removeHomepage,
  verifyHomepage,
  confirmHomepage,
  setActiveHomepage,
  blockHomepage,
  openHomepageDir,
  fetchMarket,
  checkHomepageUpdates,
  updateHomepage,
  submitHomepage,
  sendEmailCode,
  installNumbered
} from './homepage'
import {
  enrichMods,
  enrichResources,
  listMods,
  toggleMod,
  deleteMod,
  installLocalMod,
  deleteWorld,
  listSchematics,
  deleteFile,
  deleteVersion,
  renameVersion,
  openVersionDir
} from './manage'

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
// ---- 实验性 Win10 桌面的「强置顶外壳」状态 ----
// 桌面模式要连 Windows 的任务栏与开始菜单都盖住：主窗口全屏 + 最高层级置顶 +
// 不进系统任务栏。只设一次不够 —— 别的程序抢到前台后系统会重排顶层窗口，置顶
// 被顶掉任务栏就冒出来了，所以进入该模式期间用定时器把外壳重新钉回去。
let desktopShellOn = false
let desktopShellTimer: ReturnType<typeof setInterval> | null = null
// 高频重复读取通道的去抖 + 结果缓存：多个页面挂载时会独立调用同一 channel，
// 并发重复请求合并为一次底层执行；版本变更时显式失效保证即时刷新。
const versionsCache = new DedupCache(5 * 60 * 1000) // 原版版本清单：TTL 5min（mirror 固定，清单很少变）
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

  // 首帧可见后立即显示窗口，并把「网络进程 fork」推迟到窗口显示之后：
  // fork utilityProcess 会拉起一个新的 Node 进程（几百 MB 内存 + CPU 冷启动），
  // 放在建窗口之前会和 Chromium 抢启动资源、拖慢首屏。网络进程只在真正发起网络请求时
  // 才会被用到（版本清单 / 主页更新检查），推迟建立不影响任何功能。
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    startNetworkWorker()
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

function registerIpc(): void {
  // IPC 统一插桩：与 logger 相同的 monkey-patch 手法，全局包住 ipcMain.handle，
  // 使每个注册处都已接日志而无需逐个手改、也避免日后新增注册遗漏。
  const origHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel, listener) => {
    origHandle(channel, wrapIpc(channel, listener))
  }) as typeof ipcMain.handle

  // ---- Auth ----
  ipcMain.handle('auth:begin', async (event) => {
    authSession?.cancel()
    authSession = new DeviceCodeSession()
    return authSession.begin((status) => {
      if (status.state === 'success') accounts.upsert(status.account)
      sendToSender(event.sender, 'auth:status', status)
    })
  })
  ipcMain.handle('auth:cancel', () => {
    authSession?.cancel()
    authSession = null
  })
  ipcMain.handle('auth:refresh', async (_e, account: MinecraftAccount) => {
    // 按认证类型分派，与启动前的刷新逻辑保持一致：第三方（Yggdrasil）账号没有 refreshToken，
    // 必须走 refreshYggdrasil；否则会被微软链路当成「缺少刷新令牌」而刷新失败。
    const updated =
      account.authType === 'yggdrasil' ? await refreshYggdrasil(account) : await refreshAccount(account)
    accounts.upsert(updated)
    return updated
  })

  // ---- Accounts ----
  ipcMain.handle('accounts:list', () => accounts.list())
  ipcMain.handle('accounts:selected', () => accounts.selected())
  // 站点名称是后加的字段：进入账号页时一次性补全旧账号（best-effort，失败不影响其它账号）。
  ipcMain.handle('accounts:refreshSiteNames', async () => {
    const targets = accounts.list().filter((a) => a.authType === 'yggdrasil' && !a.siteName && a.yggdrasilServer)
    if (targets.length > 0) {
      const names = await Promise.all(targets.map((a) => fetchYggdrasilSiteName(a.yggdrasilServer as string)))
      targets.forEach((a, i) => {
        const name = names[i]
        if (name) accounts.upsert({ ...a, siteName: name })
      })
    }
    return accounts.list()
  })
  ipcMain.handle('accounts:remove', (_e, id: string) => accounts.remove(id))
  ipcMain.handle('accounts:select', (_e, id: string) => accounts.select(id))
  ipcMain.handle('accounts:addOffline', (_e, name: string) => {
    const acc = createOfflineAccount(name)
    accounts.upsert(acc)
    accounts.select(acc.id)
    return acc
  })
  ipcMain.handle('accounts:addYggdrasil', async (_e, server: string, email: string, password: string) => {
    const result = await loginYggdrasil(server, email, password)
    // 多角色：先不建号，交给界面弹窗选择（可多选）后再提交。
    if (result.kind === 'select') return { profiles: result.profiles }
    accounts.upsert(result.account)
    accounts.select(result.account.id)
    return { account: result.account }
  })
  ipcMain.handle('accounts:addYggdrasilProfiles', (_e, ids: string[]) => {
    const list = commitYggdrasilProfiles(ids)
    for (const acc of list) accounts.upsert(acc)
    if (list[0]) accounts.select(list[0].id)
    return list
  })

  // ---- Versions ----
  ipcMain.handle('versions:list', () =>
    // 下载源固定（官方优先 + BMCLAPI 回退），无用户可选镜像，故不再把 mirror 计入缓存 key。
    versionsCache.get('manifest', () => fetchVersionManifest())
  )
  ipcMain.handle('versions:get', (_e, id: string) => {
    const s = settings.get()
    return resolveVersionJson(id, activeGameDir(s))
  })
  ipcMain.handle('versions:createVanilla', async (_e, baseVersion: string, customName: string) => {
    await createVanillaInstance(activeGameDir(settings.get()), baseVersion, customName)
    installedCache.invalidateAll()
  })
  // 从其它 .minecraft 导入版本：先扫描列出（标注重名），再按策略导入。
  ipcMain.handle('versions:scanExternal', (_e, mcDir: string) =>
    scanExternalVersions(mcDir, activeGameDir(settings.get()))
  )
  ipcMain.handle(
    'versions:importExternal',
    async (_e, mcDir: string, versionId: string, onConflict: ConflictPolicy) => {
      const r = await importExternalVersion(mcDir, versionId, activeGameDir(settings.get()), onConflict)
      installedCache.invalidateAll()
      return r
    }
  )

  // ---- Installed versions / worlds / servers ----
  ipcMain.handle('installed:list', () => {
    const s = settings.get()
    return installedCache.get(installedCacheKey(s), () =>
      listInstalled(activeGameDir(s), s.versionIsolation, s.isolatedVersions)
    )
  })

  // ---- 版本目录（多版本列表根目录） ----
  //
  // 注意：这四个处理器都不再调 installedCache.invalidateAll()。
  // installedCacheKey 里已经含「当前生效目录 + 隔离策略」，切换 / 增删 / 改目录本身就会落到
  // 另一个 key——失效缓存并不会让新目录更快出结果，反而会把「刚扫过的另一个目录」也一并清掉，
  // 用户来回切目录时每次都要重新全量扫描。这才是「切换版本目录很卡」的直接原因之一。
  ipcMain.handle('versionDirs:list', () => allVersionDirs(settings.get()))
  ipcMain.handle('versionDirs:add', (_e, input: { path: string; alias?: string }) => {
    const s = settings.get()
    const path = (input?.path ?? '').trim()
    if (!path) return allVersionDirs(s)
    if (path === s.gameDir || s.versionDirs.some((d) => d.path === path)) return allVersionDirs(s)
    const id = `dir-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    settings.set({
      versionDirs: [...s.versionDirs, { id, alias: (input.alias ?? '').trim(), path }]
    })
    return allVersionDirs(settings.get())
  })
  ipcMain.handle('versionDirs:update', (_e, id: string, patch: { alias?: string; path?: string }) => {
    const s = settings.get()
    if (id === 'default') {
      // 默认目录只允许改别名（其路径即设置页的 gameDir），此处不改路径。
      return allVersionDirs(s)
    }
    settings.set({
      versionDirs: s.versionDirs.map((d) =>
        d.id === id
          ? {
              ...d,
              alias: patch.alias !== undefined ? patch.alias.trim() : d.alias,
              path: patch.path && patch.path.trim() ? patch.path.trim() : d.path
            }
          : d
      )
    })
    return allVersionDirs(settings.get())
  })
  ipcMain.handle('versionDirs:remove', (_e, id: string) => {
    if (id === 'default') return allVersionDirs(settings.get())
    const s = settings.get()
    settings.set({
      versionDirs: s.versionDirs.filter((d) => d.id !== id),
      selectedVersionDirId: s.selectedVersionDirId === id ? '' : s.selectedVersionDirId
    })
    return allVersionDirs(settings.get())
  })
  ipcMain.handle('versionDirs:select', (_e, id: string) => {
    const s = settings.get()
    const valid = id === 'default' || s.versionDirs.some((d) => d.id === id)
    const next = valid ? (id === 'default' ? '' : id) : ''
    settings.set({ selectedVersionDirId: next })
    return next || 'default'
  })

  // ---- Mod loaders (Fabric / Quilt) ----
  ipcMain.handle('loaders:versions', (_e, kind: LoaderKind, mc: string) => loaderVersions(kind, mc))
  ipcMain.handle('loaders:install', async (_e, kind: LoaderKind, mc: string, loader: string, customId?: string) => {
    const id = await installLoader(kind, mc, loader, activeGameDir(settings.get()), customId)
    installedCache.invalidateAll()
    return id
  })

  // ---- Mod loaders (Forge / NeoForge) ----
  ipcMain.handle('forge:versions', (_e, kind: ForgeKind, mc: string) => forgeVersions(kind, mc))
  ipcMain.handle('forge:install', async (event, kind: ForgeKind, mc: string, version: string, customId?: string) => {
    const s = settings.get()
    const dir = activeGameDir(s)
    const jr = await pickInstallerJava(allVersionDirs(s).map((d) => d.path), s.javaPath, requiredJavaForMc(mc))
    if (!jr) throw new Error('未找到可用的 Java，无法运行安装器（请在「设置」中指定 Java 路径）')
    // 安装器下载的 Java 包同样纳入并发下载管理：登记独立控制器，进度带 taskId，
    // 这样多个下载并行时互不覆盖，也能被「进度」页单独取消。
    const taskId = customId || `${kind}-${mc}-${version}`
    const controller = new AbortController()
    downloadAborts.set(taskId, controller)
    try {
      const id = await installForge(kind, mc, version, dir, jr.path, (line) => {
        sendToSender(event.sender, 'forge:log', line)
      }, customId, (p) => {
        sendToSender(event.sender, 'download:progress', { ...p, taskId })
      }, controller.signal)
      installedCache.invalidateAll()
      return id
    } finally {
      downloadAborts.delete(taskId)
    }
  })

  // ---- Download / install ----
  ipcMain.handle('download:install', async (event, id: string) => {
    const s = settings.get()
    const dir = activeGameDir(s)
    const json = await resolveVersionJson(id, dir)
    const controller = new AbortController()
    downloadAborts.set(id, controller)
    try {
      await installVersion(json, dir, s.maxDownloadConcurrency, (p) => {
        sendToSender(event.sender, 'download:progress', { ...p, taskId: id })
      }, controller.signal, s.downloadConnections)
    } finally {
      downloadAborts.delete(id)
    }
    installedCache.invalidateAll()
    return { versionId: json.id, assetIndex: json.assetIndex.id }
  })
  // 取消下载：传 taskId 只取消该任务；不传则全部取消。
  ipcMain.handle('download:cancel', (_e, taskId?: string) => {
    if (taskId) {
      downloadAborts.get(taskId)?.abort()
      return true
    }
    for (const c of downloadAborts.values()) c.abort()
    downloadAborts.clear()
    return true
  })
  // 当前实际使用的下载器：原生（Rust）内核是否可用。「进度」页据此展示。
  ipcMain.handle('download:engine', () => nativeDownloaderStatus())

  // ---- Mods & resources (Modrinth) ----
  // ---- Mods & resources（Modrinth 优先，未命中回落 CurseForge）----
  ipcMain.handle(
    'mods:search',
    (
      _e,
      query: string,
      type?: ModrinthType,
      category?: string,
      gameVersion?: string,
      loader?: string,
      offset?: number,
      source?: SourceFilter
    ) => searchResources({ source: source ?? 'all', query, limit: 24, type: type ?? 'mod', category, gameVersion, loader, offset: offset ?? 0 })
  )
  ipcMain.handle(
    'mods:versions',
    (_e, slug: string, loaders: string[], gameVersions: string[], source?: ModSource, type?: ModrinthType) =>
      resolveVersionsFor(slug, source, type ?? 'mod', loaders, gameVersions)
  )
  // 「完整介绍」弹窗：拉取单个项目的完整信息（含 Markdown 正文 body；CurseForge 无正文）。
  ipcMain.handle('mods:project', (_e, id: string, type?: ModrinthType) =>
    resolveProjectDetail(id, type ?? 'mod')
  )
  ipcMain.handle(
    'mods:install',
    async (event, fileUrl: string, filename: string, versionId: string, type?: ModrinthType, sizeHint?: number) => {
      const s = settings.get()
      const controller = new AbortController()
      downloadAborts.set(filename, controller)
      const emit = (received: number, total: number): void =>
        sendToSender(event.sender, 'download:progress', {
          taskId: filename,
          task: filename,
          current: 0,
          total: 1,
          currentBytes: received,
          totalBytes: total,
          phase: 'mod',
          percent: total > 0 ? Math.round((received / total) * 100) : 0
        })
      try {
        const dest = await installMod(
          fileUrl,
          filename,
          activeGameDir(s),
          versionId,
          isIsolated(versionId),
          type,
          emit,
          controller.signal,
          sizeHint
        )
        sendToSender(event.sender, 'download:progress', {
          taskId: filename,
          task: filename,
          current: 1,
          total: 1,
          currentBytes: 0,
          totalBytes: 0,
          phase: 'done',
          percent: 100
        })
        return dest
      } finally {
        downloadAborts.delete(filename)
      }
    }
  )
  ipcMain.handle('mods:installFabricApi', async (event, mcVersion: string, versionId: string) => {
    const apiVersion = await findFabricApi(mcVersion)
    if (!apiVersion) throw new Error(`未在 Modrinth 找到适配 ${mcVersion} 的 Fabric API`)
    const file = apiVersion.files.find((f) => f.primary) ?? apiVersion.files[0]
    if (!file) throw new Error('Fabric API 版本缺少可下载文件')

    const s = settings.get()
    const controller = new AbortController()
    downloadAborts.set(file.filename, controller)
    const emit = (received: number, total: number): void =>
      sendToSender(event.sender, 'download:progress', {
        taskId: file.filename,
        task: file.filename,
        current: 0,
        total: 1,
        currentBytes: received,
        totalBytes: total,
        phase: 'mod',
        percent: total > 0 ? Math.round((received / total) * 100) : 0
      })
    try {
      const dest = await installMod(file.url, file.filename, activeGameDir(s), versionId, isIsolated(versionId), 'mod', emit, controller.signal)
      sendToSender(event.sender, 'download:progress', {
        taskId: file.filename,
        task: file.filename,
        current: 1,
        total: 1,
        currentBytes: 0,
        totalBytes: 0,
        phase: 'done',
        percent: 100
      })
      return dest
    } finally {
      downloadAborts.delete(file.filename)
    }
  })
  ipcMain.handle('mods:downloadTo', async (event, fileUrl: string, destPath: string, sizeHint?: number) => {
    const filename = destPath.split(/[\\/]/).pop() ?? destPath
    const controller = new AbortController()
    downloadAborts.set(filename, controller)
    const emit = (received: number, total: number): void =>
      sendToSender(event.sender, 'download:progress', {
        taskId: filename,
        task: filename,
        current: 0,
        total: 1,
        currentBytes: received,
        totalBytes: total,
        phase: 'mod',
        percent: total > 0 ? Math.round((received / total) * 100) : 0
      })
    try {
      const dest = await downloadTo(fileUrl, destPath, emit, controller.signal, sizeHint)
      sendToSender(event.sender, 'download:progress', {
        taskId: filename,
        task: filename,
        current: 1,
        total: 1,
        currentBytes: 0,
        totalBytes: 0,
        phase: 'done',
        percent: 100
      })
      return dest
    } finally {
      downloadAborts.delete(filename)
    }
  })

  // ---- Modpack import / export ----
  ipcMain.handle('modpack:probe', (_e, filePath: string) => probeModpack(filePath))
  ipcMain.handle('modpack:download', async (event, url: string, filename: string) => {
    const controller = new AbortController()
    downloadAborts.set(filename, controller)
    try {
      return await downloadModpack(url, filename, (p) => {
        sendToSender(event.sender, 'modpack:progress', p)
        sendToSender(event.sender, 'download:progress', p)
      }, controller.signal)
    } finally {
      downloadAborts.delete(filename)
    }
  })
  ipcMain.handle('modpack:import', async (event, filePath: string, customName?: string) => {
    const s = settings.get()
    const dir = activeGameDir(s)
    const controller = new AbortController()
    const key = `modpack-import:${filePath}`
    downloadAborts.set(key, controller)
    try {
      const id = await importModpack(filePath, dir, customName ?? '', (p) => {
        sendToSender(event.sender, 'modpack:progress', p)
        sendToSender(event.sender, 'download:progress', p)
      }, (line) => {
        sendToSender(event.sender, 'forge:log', line)
      }, controller.signal)
      installedCache.invalidateAll()
      return { versionId: id, name: id }
    } finally {
      downloadAborts.delete(key)
    }
  })
  ipcMain.handle('modpack:importFromUrl', async (event, url: string, filename: string, customName?: string) => {
    const s = settings.get()
    const dir = activeGameDir(s)
    const controller = new AbortController()
    downloadAborts.set(filename, controller)
    try {
      const id = await importModpackFromUrl(url, filename, dir, customName ?? '', (p) => {
        sendToSender(event.sender, 'modpack:progress', p)
        sendToSender(event.sender, 'download:progress', p)
      }, (line) => {
        sendToSender(event.sender, 'forge:log', line)
      }, controller.signal)
      installedCache.invalidateAll()
      return { versionId: id, name: id }
    } finally {
      downloadAborts.delete(filename)
    }
  })
  ipcMain.handle('modpack:exportInventory', (_event, versionId: string) => {
    const s = settings.get()
    return collectExportInventory(activeGameDir(s), versionId, isIsolated(versionId))
  })
  ipcMain.handle('modpack:export', async (event, versionId: string, options: ModpackExportOptions) => {
    const s = settings.get()
    return exportModpack(versionId, activeGameDir(s), options, (p) => {
      sendToSender(event.sender, 'modpack:progress', p)
      sendToSender(event.sender, 'download:progress', p)
    })
  })

  // ---- Resource packs / shaders ----
  ipcMain.handle('resources:list', async (event, versionId: string, kind: ResourceKind) => {
    const s = settings.get()
    const dir = activeGameDir(s)
    const isolated = isIsolated(versionId)
    const files = await listResources(dir, versionId, isolated, kind)
    // 先返回本地列表，随后后台联网补齐 Modrinth 名称 / 图标并逐个推送。
    // 与 manage:mods 保持一致：「仅获取元数据」与本地模式下完全不联网，只显示本地文件名。
    if (s.mode !== 'local' && !s.metadataOnlyMods) {
      void enrichResources(dir, versionId, isolated, kind, (file) => {
        sendToSender(event.sender, 'resources:updated', { versionId, kind, file })
      })
    }
    return files
  })
  ipcMain.handle('resources:remove', (_e, path: string) => removeResource(path))
  ipcMain.handle('resources:open', (_e, versionId: string, kind: ResourceKind) => {
    const s = settings.get()
    return openResourceDir(activeGameDir(s), versionId, isIsolated(versionId), kind)
  })
  // 资源更新检测：进入实例管理时调用。联网关闭（本地模式 / 仅识别元数据）时直接返回空。
  // 返回「已确认可更新」的完整清单，其余项在后台判定完后经 resources:update-checked 逐个推送。
  ipcMain.handle('resources:checkUpdates', async (event, versionId: string) => {
    const s = settings.get()
    if (s.mode === 'local' || s.metadataOnlyMods) return []
    const gameDir = activeGameDir(s)
    // 实例的 MC 版本 / 加载器决定「哪些版本算兼容」，取自已安装列表（带缓存的目录扫描）。
    const installed = await installedCache.get(installedCacheKey(s), () =>
      listInstalled(gameDir, s.versionIsolation, s.isolatedVersions)
    )
    const entry = installed.find((v) => v.id === versionId)
    return checkResourceUpdates(
      gameDir,
      versionId,
      isIsolated(versionId),
      entry?.mcVersion ?? '',
      entry?.loader ?? null,
      {
        onResult: (path, kind, update) =>
          sendToSender(event.sender, 'resources:update-checked', { versionId, path, kind, update })
      }
    )
  })
  ipcMain.handle(
    'resources:applyUpdate',
    (_e, versionId: string, update: ResourceUpdateInfo, enabled: boolean) => {
      const s = settings.get()
      return applyResourceUpdate(activeGameDir(s), versionId, isIsolated(versionId), update, enabled)
    }
  )

  // ---- Version management (mods / worlds / schematics / delete) ----
  ipcMain.handle('manage:mods', async (event, versionId: string) => {
    const s = settings.get()
    const dir = activeGameDir(s)
    const isolated = isIsolated(versionId)
    const mods = await listMods(dir, versionId, isolated)
    // 先返回元数据名列表，随后后台联网补齐 Modrinth 名称/图标并逐个推送
    if (s.mode !== 'local' && !s.metadataOnlyMods) {
      void enrichMods(dir, versionId, isolated, (mod) => {
        sendToSender(event.sender, 'manage:mods-updated', { versionId, mod })
      })
    }
    return mods
  })
  ipcMain.handle('manage:toggleMod', (_e, path: string) => toggleMod(path))
  ipcMain.handle('manage:deleteMod', (_e, path: string) => deleteMod(path))
  ipcMain.handle('manage:installLocalMod', (_e, versionId: string, sourcePath: string) => {
    const s = settings.get()
    return installLocalMod(activeGameDir(s), versionId, isIsolated(versionId), sourcePath)
  })
  ipcMain.handle('manage:deleteWorld', (_e, versionId: string, worldName: string) => {
    const s = settings.get()
    return deleteWorld(activeGameDir(s), versionId, isIsolated(versionId), worldName)
  })
  ipcMain.handle('manage:schematics', (_e, versionId: string) => {
    const s = settings.get()
    return listSchematics(activeGameDir(s), versionId, isIsolated(versionId))
  })
  ipcMain.handle('manage:deleteFile', (_e, path: string) => deleteFile(path))
  ipcMain.handle('manage:deleteVersion', async (_e, versionId: string) => {
    const s = settings.get()
    await deleteVersion(activeGameDir(s), versionId)
    installedCache.invalidateAll()
    return true
  })
  ipcMain.handle('manage:renameVersion', async (_e, versionId: string, newName: string) => {
    const s = settings.get()
    const newId = await renameVersion(activeGameDir(s), versionId, newName)
    installedCache.invalidateAll()
    // 同步更新设置中对旧实例 id 的引用（隔离 / 禁用标记）
    if (newId !== versionId) {
      const needsUpdate =
        s.isolatedVersions.includes(versionId) || s.disabledVersions.includes(versionId)
      if (needsUpdate) {
        settings.set({
          isolatedVersions: s.isolatedVersions.map((id) => (id === versionId ? newId : id)),
          disabledVersions: s.disabledVersions.map((id) => (id === versionId ? newId : id))
        })
      }
    }
    return newId
  })
  ipcMain.handle('manage:openDir', async (_e, versionId: string, kind: VersionDirKind) => {
    const s = settings.get()
    // 只返回目录路径：由渲染层用启动器自实现的资源管理器打开（不再唤起系统资源管理器）
    return await openVersionDir(activeGameDir(s), versionId, isIsolated(versionId), kind)
  })

  // ---- Java ----
  // 传入「全部版本目录」而非仅当前目录：Java 可能装在任一版本目录的 java/ 下，
  // 只看当前目录会导致切换版本目录后已装好的 Java 检测不到。
  ipcMain.handle('java:detect', () => detectJava(allVersionDirs(settings.get()).map((d) => d.path)))
  ipcMain.handle('java:check', async (_e, versionId: string) => {
    const s = settings.get()
    const dir = activeGameDir(s)
    const json = await resolveVersionJson(versionId, dir)
    const required = json.javaVersion?.majorVersion ?? 8
    const available = await detectJava(allVersionDirs(s).map((d) => d.path))
    // 「合适的 Java」= isJavaSuitable 判定通过（见 java.ts）。没有合适的就返回 compatible=false，
    // 由渲染层弹「是否安装 Java {required}」提示，而不是静默用不匹配的 Java 去启动。
    const compatible = (await suitableJavaFor(s, required)) !== null
    return { required, compatible, available }
  })
  ipcMain.handle('java:install', async (event, major: number) => {
    const s = settings.get()
    const taskId = `java-${major}`
    const controller = new AbortController()
    downloadAborts.set(taskId, controller)
    const emit = (
      percent: number,
      task: string,
      currentBytes: number,
      totalBytes: number,
      phase: DownloadPhase
    ): void => {
      sendToSender(event.sender, 'download:progress', {
        taskId,
        task,
        current: percent,
        total: 100,
        currentBytes,
        totalBytes,
        phase,
        percent
      })
    }
    try {
      const path = await installJava(major, activeGameDir(s), emit, controller.signal)
      // 只记录路径，不关闭「自动检测」：否则启动器为某个版本自动装好 Java 后，
      // 自动检测会被自己悄悄关掉，之后换版本启动时就不会再按版本切换 Java 了。
      settings.set({ javaPath: path })
      // 新装了一个 Java：让检测缓存失效，设置页下次拉取就能看到它。
      invalidateJavaCache()
      return path
    } catch (err) {
      // 取消 / 失败都必须补发一条 done：渲染层只在收到 done 时才移除任务条目，
      // 否则「获取下载地址」阶段被取消后浮球上的任务会一直挂着，看起来像取消无效。
      emit(0, '', 0, 0, 'done')
      throw err
    } finally {
      downloadAborts.delete(taskId)
    }
  })
  // 手动指定 Java：选到文件即读取版本信息（自动识别 major / 厂商 / 位数）。
  ipcMain.handle('java:pick', async (event) => {
    const w = BrowserWindow.fromWebContents(event.sender)
    const opts: Electron.OpenDialogOptions = {
      title: '选择 Java 可执行文件',
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Java 可执行文件', extensions: ['exe'] }]
          : [{ name: '所有文件', extensions: ['*'] }]
    }
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return null
    const picked = res.filePaths[0]
    const jr = await javaVersionAt(picked)
    if (!jr) {
      throw new Error('无法识别该文件，请选择 java.exe（Windows）或 bin/java（macOS / Linux）')
    }
    return jr
  })

  // ---- Launch ----

  /** 自定义游戏窗口尺寸的合法范围（逻辑像素）：过小无意义，过大则几乎必然是误输入。 */
  const MIN_WINDOW = 320
  const MAX_WINDOW = 16384

  /**
   * 「最大化」时应使用的游戏窗口**内容区**尺寸。
   *
   * 两个关键点：
   *
   * 1) Minecraft 的 --width/--height 是**内容区**（不含标题栏与边框），而它创建的
   *    是普通带框窗口，不会被系统「最大化」。所以不能直接把工作区尺寸塞进去：
   *    实测（1920×1080 屏、任务栏 48px、窗口装饰 8×57）工作区 1920×1032 作为内容区时，
   *    窗口外框变成 1928×1089 —— 比整屏还高 9px，游戏画面底部约 49px 被任务栏盖住。
   * 2) 因此正确做法是「工作区 − 窗口装饰」：这样窗口外框恰好等于工作区，无论被放在
   *    哪个位置都不会超出、也都不会被任务栏遮挡。
   *
   * 任务栏是否隐藏由系统体现在工作区里（任务栏自动隐藏时工作区 = 整屏），
   * 所以这里不需要自己判断任务栏状态，跨平台也一致。
   *
   * 每次启动都重新测量（不缓存）：用户可能在运行期间改了「自动隐藏任务栏」。
   */
  function getMaximizedContentSize(): { width: number; height: number } {
    const d = screen.getPrimaryDisplay()
    let chromeW = 0
    let chromeH = 0
    let probe: BrowserWindow | null = null
    try {
      // 用同规格的隐藏窗口量出标题栏 + 边框占用的像素（同系统主题下与游戏窗口一致）。
      // 必须带 useContentSize：这样 width/height 才是内容区，getBounds 与 getContentBounds
      // 的差值才等于真实装饰量（实测 8×57）；否则隐藏窗口尚未套用完整装饰，会量成 8×31。
      probe = new BrowserWindow({ show: false, useContentSize: true, width: 400, height: 300 })
      const outer = probe.getBounds()
      const inner = probe.getContentBounds()
      chromeW = Math.max(0, outer.width - inner.width)
      chromeH = Math.max(0, outer.height - inner.height)
    } catch {
      // 无窗口系统 / 测量失败：不退让，仍按工作区尺寸（最多是回到修复前的表现）。
    } finally {
      probe?.destroy()
    }
    return {
      width: Math.max(MIN_WINDOW, d.workAreaSize.width - chromeW),
      height: Math.max(MIN_WINDOW, d.workAreaSize.height - chromeH)
    }
  }

  ipcMain.handle('launch:start', async (event, options: LaunchOptions) => {
    const s = settings.get()
    if (s.disabledVersions.includes(options.versionId)) {
      throw new Error('该版本已被禁用，请在版本管理中启用后再启动')
    }
    let account = accounts.list().find((a) => a.id === options.accountId) ?? accounts.selected()
    if (!account) throw new Error('请先登录一个账号')

    if (account.expiresAt < Date.now() + 60_000) {
      try {
        account =
          account.authType === 'yggdrasil' ? await refreshYggdrasil(account) : await refreshAccount(account)
        accounts.upsert(account)
      } catch (err) {
        throw new Error(`账号令牌已过期且刷新失败：${err instanceof Error ? err.message : err}`)
      }
    }

    const emit = (e: unknown): void => sendToSender(event.sender, 'launch:event', e)

    emit({ state: 'downloading' })
    const installDir = activeGameDir(s)
    const json = await resolveVersionJson(options.versionId, installDir)
    const runDir = isIsolated(options.versionId)
      ? join(installDir, 'versions', options.versionId)
      : installDir
    // 以版本 id 作为任务键：与「进度」页手动安装同一版本共用一条任务，
    // 且不再与其它下载互相覆盖控制器（原先单个变量会让并发任务彼此踩踏）。
    const downloadKey = options.versionId
    const controller = new AbortController()
    downloadAborts.set(downloadKey, controller)
    const result = await installVersion(json, installDir, s.maxDownloadConcurrency, (p) => {
      sendToSender(event.sender, 'download:progress', { ...p, taskId: options.versionId })
    }, controller.signal, s.downloadConnections).finally(() => {
      downloadAborts.delete(downloadKey)
    })

    // Java 选择优先级：启动前提示里当场选择的路径 >（关闭自动检测时）手动指定的 Java >
    // 按该游戏版本所需大版本自动挑选。开启自动检测时忽略手动指定的路径，
    // 这样 1.12.2（Java 8）与 1.20.5+（Java 21）等不同版本能各自用上对的 Java。
    const requiredJava = json.javaVersion?.majorVersion ?? 8
    let javaPath = options.javaPath
    if (!javaPath && !s.javaAutoDetect) javaPath = s.javaPath || undefined
    if (!javaPath) {
      javaPath = (await suitableJavaFor(s, requiredJava))?.path
    }
    if (!javaPath) {
      // 正常情况下渲染层已在启动前弹「是否安装 Java {requiredJava}」提示，这里只是兜底。
      throw new Error(`未找到合适的 Java ${requiredJava} 运行时，请先在「设置」中安装或手动指定 Java 路径`)
    }

    if (account.authType === 'yggdrasil') {
      await ensureAuthlibInjector(installDir)
    }

    emit({ state: 'launching' })
    // 游戏窗口尺寸：桌面模式强制全屏；否则按设置解析成具体分辨率 / 全屏。
    const winMode = s.experimental === 'win10' ? 'fullscreen' : s.gameWindowSize
    const primary = screen.getPrimaryDisplay()
    let fullscreen = false
    let resolution: { width: number; height: number }
    if (winMode === 'fullscreen') {
      fullscreen = true
      resolution = { width: primary.size.width, height: primary.size.height }
    } else if (winMode === 'maximized') {
      // 内容区必须扣掉窗口装饰，否则外框会超出工作区（见 getMaximizedContentSize 注释）。
      resolution = getMaximizedContentSize()
    } else if (winMode === 'custom') {
      const width = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, Math.round(s.gameWindowWidth) || MIN_WINDOW))
      const height = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, Math.round(s.gameWindowHeight) || MIN_WINDOW))
      resolution = { width, height }
      // 超出屏幕时同样给出警告（与设置页的预览警告一致），但不阻止启动。
      if (width > primary.size.width || height > primary.size.height) {
        const opts: Electron.MessageBoxOptions = {
          type: 'warning',
          title: '游戏窗口尺寸超出屏幕',
          message: `自定义的窗口尺寸 ${width}×${height} 超出了当前屏幕（${primary.size.width}×${primary.size.height}）。`,
          detail: '游戏窗口可能显示不全。可在「设置 → 游戏 → 游戏窗口尺寸」中改用较小的尺寸或选择「最大化」。',
          buttons: ['仍然启动'],
          defaultId: 0,
          noLink: true
        }
        if (mainWindow && !mainWindow.isDestroyed()) await dialog.showMessageBox(mainWindow, opts)
        else await dialog.showMessageBox(opts)
      }
    } else {
      resolution = winMode === '1080p' ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }
    }
    const launchOptions: LaunchOptions = {
      ...options,
      ...(fullscreen ? { fullscreen: true } : {}),
      resolution
    }
    gameProcess = spawnGame(
      {
        json,
        installDir,
        runDir,
        javaPath,
        nativesDir: result.nativesDir,
        assetIndexId: result.assetIndexId,
        account,
        options: launchOptions
      },
      emit
    )

    return { pid: gameProcess.pid ?? 0 }
  })
  ipcMain.handle('launch:stop', () => {
    gameProcess?.kill()
    return true
  })

  // ---- Settings ----
  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:set', (_e, partial: Partial<LauncherSettings>) => {
    const next = settings.set(partial)
    // 主题 / 背景预设变化后同步窗口底色
    if (partial.theme !== undefined || partial.background !== undefined) applyWindowBackground()
    // Debug 模式开关联动独立日志窗口（开启即创建，关闭即释放）
    if (typeof partial.debugMode === 'boolean') {
      if (partial.debugMode) createDebugWindow()
      else closeDebugWindow()
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
  // 硬件探测：返回 CPU 核心数 / 内存总量，并判定是否低配（超低占用模式自动开启用）。
  ipcMain.handle('system:hardware', () => detectHardware())

  // ---- 自定义主页（脚本仓管 / 联网校验 / 市场 / 投稿）----
  ipcMain.handle('homepage:list', () => listHomepages())
  ipcMain.handle('homepage:read', (_e, id: string) => readHomepage(id))
  ipcMain.handle('homepage:importFile', () => importHomepage())
  ipcMain.handle('homepage:download', (_e, url: string, filename: string, sizeHint?: number) =>
    downloadHomepage(url, filename, sizeHint)
  )
  ipcMain.handle('homepage:remove', (_e, id: string) => removeHomepage(id))
  ipcMain.handle('homepage:verify', (_e, id: string) => verifyHomepage(id))
  ipcMain.handle('homepage:confirm', (_e, id: string, network: boolean) => confirmHomepage(id, network))
  ipcMain.handle('homepage:setActive', (_e, id: string) => setActiveHomepage(id))
  // 运行时检测到危险代码：封锁脚本并立即停用（渲染层负责弹全屏提示）。
  ipcMain.handle('homepage:block', (_e, id: string, reason: string) => blockHomepage(id, reason))
  ipcMain.handle('homepage:openDir', () => openHomepageDir())
  ipcMain.handle('homepage:market', () => fetchMarket())
  ipcMain.handle('homepage:checkUpdates', () => checkHomepageUpdates())
  ipcMain.handle('homepage:update', (_e, update: HomepageUpdate) => updateHomepage(update))
  ipcMain.handle('homepage:send-email-code', (_e, email: string) => sendEmailCode(email))
  ipcMain.handle('homepage:submit', (_e, payload: HomepageSubmitPayload) => submitHomepage(payload))
  ipcMain.handle(
    'homepage:installNumbered',
    (_e, input: { filename: string; contentBase64: string; replaceId?: string }) => installNumbered(input)
  )
  ipcMain.handle('homepage:log', (_e, level: DebugLogEntry['level'], message: string) => {
    // 脚本日志只在 Debug 模式落地：调试日志窗口仅在 Debug 模式存在。
    if (!settings.get().debugMode) return
    // 折叠换行 / 控制字符：一条脚本日志绝不能伪造出多行「启动器日志」（F-14 / D07）。
    const text = String(message)
      .replace(/[\r\n\u2028\u2029]+/g, ' ⏎ ')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .slice(0, 4000)
    const line = `[主页脚本] ${text}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.info(line)
  })

  // ---- About / agreement / update (remote server) ----
  ipcMain.handle('about:list', () => fetchAbout())
  // 实验性：资源名 / 简介自动翻译（在线接口，实现见 network/translate.ts）
  ipcMain.handle('translate:texts', (_e, texts: string[], target: string) =>
    netRequest<Array<[string, string]>>('translate:texts', { texts, target, apiKey: getUapisKey() }, {
      // 逐条请求外部接口，条数较多时耗时较长，给足超时。
      timeoutMs: 120_000
    })
  )
  // 保存 API KEY：先真实请求一次做连通性测试，通过才加密落盘（在主进程完成，
  // 渲染层既拿不到已保存的 KEY，也无法绕过测试直接写入）。
  ipcMain.handle('translate:setKey', async (_e, apiKey: string) => {
    const key = String(apiKey ?? '').trim()
    if (!key) return { ok: false, message: '未填写 API KEY' }
    const test = await netRequest<{ ok: boolean; message: string }>(
      'translate:testKey',
      { apiKey: key },
      { timeoutMs: 20_000 }
    )
    if (!test.ok) return test
    const err = setUapisKey(key)
    if (err) return { ok: false, message: err }
    // uapisApiKeySet 是「由安全存储派生的字段」，不落 settings.json：密钥变了要让设置缓存失效，
    // 否则设置页仍会显示「未设置」。
    invalidateSettingsCache()
    return { ok: true, message: `${test.message}（已加密保存到本机）` }
  })
  ipcMain.handle('translate:clearKey', () => {
    clearUapisKey()
    invalidateSettingsCache()
    return { ok: true, message: '已删除本机保存的 API KEY，已回到访客额度' }
  })
  ipcMain.handle('about:agreement', () => fetchAgreement())
  ipcMain.handle('update:check', async () => {
    const currentVersion = app.getVersion()
    let latest: UpdateInfo | null = null
    try {
      latest = await fetchUpdateInfo()
    } catch {
      latest = null
    }
    return {
      currentVersion,
      latest,
      hasUpdate: latest ? compareVersions(latest.version, currentVersion) > 0 : false,
      // 测试版（带 - 后缀）：启动自动检查据此静默，避免打扰普通用户。
      latestIsPrerelease: latest ? isPrerelease(latest.version) : false
    }
  })
  ipcMain.handle('update:download', async (event, info: UpdateInfo) => {
    const s = settings.get()
    return downloadUpdate(info, s.gameDir, (p) => {
      sendToSender(event.sender, 'update:progress', p)
    })
  })
  ipcMain.handle('update:downloadAndRun', async (event, info: UpdateInfo) => {
    const s = settings.get()
    // 已经下载过同一版本：直接运行，避免重复下载时再次对同名 exe 做覆盖写（Windows 上易 EPERM）。
    const existing = updateFileExists(s.gameDir, info)
    const path = existing
      ? join(s.gameDir, 'updates', updateFileName(info))
      : await downloadUpdate(info, s.gameDir, (p) => {
          sendToSender(event.sender, 'update:progress', p)
        })
    runUpdate(path)
    return path
  })

  // ---- Debug 日志窗口 ----
  ipcMain.handle('debug:getLogs', () => getLogBuffer())
  ipcMain.handle('debug:open', () => {
    createDebugWindow()
  })
  ipcMain.handle('debug:close', () => {
    closeDebugWindow()
  })
  ipcMain.handle('debug:isEnabled', () => settings.get().debugMode)

  // ---- 开发模式（Development Mode）----
  // 授权由服务端签发：邮箱须在后台白名单内，验证码通过后获得 1 天授权；
  // 授权期内可自由开关、调整主页安全防护档位、随时解除；到期自动关闭。
  ipcMain.handle('devmode:status', () => {
    if (enforceDevModeExpiry()) broadcastDevMode()
    return devModeStatus()
  })
  ipcMain.handle('devmode:sendCode', (_e, email: string) => sendDevModeCode(email))
  ipcMain.handle('devmode:verify', async (_e, email: string, code: string) => {
    const res = await verifyDevMode(email, code)
    broadcastDevMode()
    return res
  })
  ipcMain.handle('devmode:setEnabled', async (_e, enabled: boolean) => {
    const s = await setDevModeEnabled(enabled)
    // 关闭开发模式即回收独立开发者工具窗口。
    if (!s.enabled) closeDevWindow()
    if (!s.enabled) closeNativeDevTools()
    broadcastDevMode()
    return s
  })
  ipcMain.handle('devmode:revoke', async () => {
    const s = await revokeDevMode()
    closeDevWindow()
    closeNativeDevTools()
    broadcastDevMode()
    return s
  })
  ipcMain.handle('devmode:setSecurityMode', async (_e, mode: 'full' | 'warn' | 'off') => {
    const s = await setDevModeSecurityMode(mode)
    broadcastDevMode()
    return s
  })
  ipcMain.handle('devmode:openTools', () => {
    createDevWindow()
  })
  ipcMain.handle('devmode:closeTools', () => {
    closeDevWindow()
  })
  // 原生 Chromium DevTools（元素 / 控制台 / 网络 / 源代码），以独立窗口（detach）打开，
  // 与主界面分离避免拥挤。仅开发模式开启时可用。
  ipcMain.handle('devmode:openDevTools', () => {
    if (enforceDevModeExpiry()) broadcastDevMode()
    if (!devModeStatus().enabled) return false
    if (!mainWindow || mainWindow.isDestroyed()) return false
    if (mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.webContents.devToolsWebContents?.focus()
      return true
    }
    mainWindow.webContents.openDevTools({ mode: 'detach' })
    return true
  })
  ipcMain.handle('devmode:closeDevTools', () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.webContents.closeDevTools()
    }
  })

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
    desktopShellOn = on === true
    if (desktopShellOn) {
      // 不能用 setSkipTaskbar(true)：那会让窗口从系统任务栏消失，
      // 全屏时用户就再没有任何入口切回启动器。这里显式置 false，顺带清掉历史状态。
      w.setSkipTaskbar(false)
      w.setFullScreen(true)
      w.show()
      if (!desktopShellTimer) {
        desktopShellTimer = setInterval(pinDesktopShell, 1000)
        desktopShellTimer.unref()
      }
    } else {
      if (desktopShellTimer) {
        clearInterval(desktopShellTimer)
        desktopShellTimer = null
      }
      w.setAlwaysOnTop(false)
      w.setSkipTaskbar(false)
      w.setFullScreen(false)
      w.unmaximize()
    }
    return desktopShellOn
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

  // ---- 实验性 Win10 桌面：只做「启动器自己的桌面外壳」 ----
  // 外部窗口（MC / 资源管理器）不再被搬进桌面，因此这里没有任何与 Win32 窗口捕获
  // 相关的 IPC；桌面模式下的 MC 由启动参数强制全屏（见 launch:start 里的 winMode）。

  // ---- 自实现的资源管理器（替代系统资源管理器）----
  ipcMain.handle('files:places', () => {
    const s = settings.get()
    // 版本目录排在最前：这是用户最常来的地方（默认目录 + 各别名目录）
    return listPlaces(
      allVersionDirs(s).map((d) => ({
        name: d.isDefault ? '默认版本列表目录' : d.alias || basename(d.path) || d.path,
        path: d.path,
        kind: 'place' as const
      }))
    )
  })
  ipcMain.handle('files:list', (_e, path: string) => listDir(path))
  ipcMain.handle('files:open', (_e, path: string) => openPath(path))
  ipcMain.handle('files:reveal', (_e, path: string) => revealPath(path))
  // 写操作（右键菜单）：改名 / 新建空文件 / 删除 / 读写文本
  ipcMain.handle('files:rename', (_e, path: string, name: string) => renameEntry(path, name))
  ipcMain.handle('files:createFile', (_e, dir: string, name: string) => createFile(dir, name))
  ipcMain.handle('files:remove', (_e, path: string) => removeEntry(path))
  ipcMain.handle('files:readText', (_e, path: string) => readText(path))
  ipcMain.handle('files:writeText', (_e, path: string, content: string) => writeText(path, content))

  // ---- Shell ----
  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))
  ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('shell:chooseDirectory', async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    const r = await dialog.showOpenDialog(w!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle(
    'shell:pickFile',
    async (e, filters?: Array<{ name: string; extensions: string[] }>) => {
      const w = BrowserWindow.fromWebContents(e.sender)
      const r = await dialog.showOpenDialog(w!, { properties: ['openFile'], filters })
      return r.canceled ? null : r.filePaths[0]
    }
  )
  ipcMain.handle(
    'shell:pickFiles',
    async (e, filters?: Array<{ name: string; extensions: string[] }>) => {
      const w = BrowserWindow.fromWebContents(e.sender)
      const r = await dialog.showOpenDialog(w!, { properties: ['openFile', 'multiSelections'], filters })
      return r.canceled ? [] : r.filePaths
    }
  )
  ipcMain.handle('shell:saveFile', async (e, defaultName: string) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    const r = await dialog.showSaveDialog(w!, { defaultPath: defaultName })
    return r.canceled || !r.filePath ? null : r.filePath
  })
}

app.setName('HungerCatLauncher')

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
  registerIpc()
  // 联机板块（MCTier 移植）：注册 mp:* 通道。组网资源在首次调用时才真正使用，
  // 这里只挂 IPC，不产生额外启动开销。
  registerMultiplayerIpc(broadcastLobbyChanged)
  // 联机悬浮窗：创建 / 关闭 / 读取快照。
  ipcMain.handle('mp:openMiniWindow', () => {
    createMiniWindow()
    // 窗口就绪后补推一次当前状态（避免首帧空白）。
    setTimeout(pushMiniWindowState, 300)
  })
  ipcMain.handle('mp:closeMiniWindow', () => closeMiniWindow())
  ipcMain.handle('mp:miniState', () => buildMiniState())
  // 悬浮窗据此决定「退出大厅」后是自己关掉还是退回空态：
  // 主界面还在时保持悬浮窗存活（用户可能还要继续用），否则一起关闭。
  ipcMain.handle('mp:hasMainWindow', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return !!win && !win.isDestroyed() && isMainWindow(win)
  })
  ipcMain.handle('mp:miniResize', (_e, width: number, height: number) => {
    if (!miniWindow || miniWindow.isDestroyed()) return
    const w = Math.max(240, Math.round(width))
    const h = Math.max(120, Math.round(height))
    miniWindow.setContentSize(w, h)
  })
  // 注意：不再在启动关键路径上 fork 网络进程。netRequest 首次调用时会经 ensureNetworkWorker
  // 自动拉起，因此这里改为在窗口 ready-to-show 之后再建立（见 createWindow），
  // 避免 utilityProcess 冷启动与 Chromium 抢资源、拖慢首屏。
  createWindow()
  // 用户在系统里切换明暗模式时，同步窗口底色（主题为「跟随系统」时才实际变化）。
  nativeTheme.on('updated', applyWindowBackground)
  // Debug 模式开启时，启动即创建独立日志窗口；默认关闭则不创建，零成本。
  if (settings.get().debugMode) createDebugWindow()
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
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  // 回收网络进程并拒绝所有在途网络请求。
  stopNetworkWorker()
  // 把在途的设置 / 账号异步写盘刷完，避免退出时丢掉最后一次修改。
  void flushWrites()
  // 联机板块：退出启动器时停掉 EasyTier 与虚拟网卡，避免残留虚拟网卡影响下次启动。
  void forceStopMultiplayer()
  closeMiniWindow()
})
