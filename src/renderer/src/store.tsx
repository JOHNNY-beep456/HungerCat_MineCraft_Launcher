import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { HomepageUpdate, LauncherSettings, MinecraftAccount, UpdateInfo, VersionDir } from '@shared/types'
import { dataUrlToBlobUrl, detectWallpaperTone } from './wallpaper'
import { createTranslator, isLocale, type Locale, type TFunction } from './i18n'

/**
 * 自定义主页运行时被安全策略拦截时的全屏提示。
 *
 * 由主页宿主在命中「删除 / 修改文件、格式化、伪装代码」时抛出，渲染在最外层，
 * 覆盖整个启动器界面（含 Win10 桌面模式）。
 */
export interface SecurityAlert {
  /** 被拦截并封锁的脚本标识。 */
  homepageId: string
  /** 命中的危险行为（一句话）。 */
  reason: string
  /** 更详细的上下文：哪个元素 / 哪条指令。 */
  detail: string
}

interface AppState {
  ready: boolean
  settings: LauncherSettings
  /** 当前界面语言（由 settings.language 解析而来）。 */
  locale: Locale
  /** 翻译函数：按当前语言取词，缺失回落简体中文。 */
  t: TFunction
  accounts: MinecraftAccount[]
  selectedAccount: MinecraftAccount | null
  theme: 'light' | 'dark'
  /** 主页脚本被运行时拦截时的全屏提示；null 表示没有。 */
  securityAlert: SecurityAlert | null
  raiseSecurityAlert: (alert: SecurityAlert) => void
  clearSecurityAlert: () => void
  /** 自实现资源管理器当前打开的目录；null 表示窗口未打开。 */
  fileManagerPath: string | null
  /**
   * 每次「打开」都自增的序号。
   *
   * 只靠 fileManagerPath 不够：桌面模式下用户可能先把窗口最小化、再点同一个入口，
   * 此时路径没变，React 会跳过重渲染，外层收不到「又要打开」这件事，表现就是
   * 「点了没反应 / 打不开」。用序号保证每次调用都能真正驱动外层。
   */
  fileManagerSeq: number
  openFileManager: (path: string) => void
  closeFileManager: () => void
  reloadSettings: () => Promise<void>
  updateSettings: (p: Partial<LauncherSettings>) => Promise<void>
  /**
   * 首次启动检测到低配电脑、自动开启「超低占用模式」时的一次性提醒开关。
   * 用户关闭后不再展示（设置页可随时手动切换该模式）。
   */
  lowUsageNotice: boolean
  dismissLowUsageNotice: () => void
  /**
   * 已安装主页脚本的「可更新」列表（每次进入启动器自动检查后填充）。
   * 由主进程比对服务端最新哈希得出；自动检查关闭时保持为空数组。
   */
  homepageUpdates: HomepageUpdate[]
  /** 重新检查主页更新并刷新列表（设置页开关、主页页手动刷新用）。 */
  refreshHomepageUpdates: () => Promise<void>
  /**
   * 启动时自动检查到的新版本启动器信息；非 null 时由外层弹出更新提示。
   * 自动检查关闭 / 无更新 / 服务端不可达时为 null。
   */
  launcherUpdateNotice: UpdateInfo | null
  dismissLauncherUpdateNotice: () => void
  reloadAccounts: () => Promise<void>
  selectAccount: (id: string) => Promise<void>
  removeAccount: (id: string) => Promise<void>
}

const AppContext = createContext<AppState | null>(null)

const DARK_QUERY = '(prefers-color-scheme: dark)'

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

/**
 * 订阅系统明暗模式：用户在系统里切换浅色/深色时实时更新，
 * 使「跟随系统」能立即切换，而不是只在设置变化时读一次。
 */
function useSystemTheme(): 'light' | 'dark' {
  const [sys, setSys] = useState<'light' | 'dark'>(systemTheme)
  useEffect(() => {
    const mq = window.matchMedia(DARK_QUERY)
    const onChange = (): void => setSys(mq.matches ? 'dark' : 'light')
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return sys
}

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [settings, setSettings] = useState<LauncherSettings | null>(null)
  const [accounts, setAccounts] = useState<MinecraftAccount[]>([])
  const [selectedAccount, setSelectedAccount] = useState<MinecraftAccount | null>(null)
  const [securityAlert, setSecurityAlert] = useState<SecurityAlert | null>(null)
  const [fileManagerPath, setFileManagerPath] = useState<string | null>(null)
  const [fileManagerSeq, setFileManagerSeq] = useState(0)
  const [lowUsageNotice, setLowUsageNotice] = useState(false)
  const [homepageUpdates, setHomepageUpdates] = useState<HomepageUpdate[]>([])
  const [launcherUpdateNotice, setLauncherUpdateNotice] = useState<UpdateInfo | null>(null)
  // 启动自动检查只跑一次：React 严格模式下 effect 会重复触发，用 ref 兜底。
  const startupCheckStarted = useRef(false)
  // 首次启动的硬件检测只跑一次：React 严格模式下 effect 会重复触发，用 ref 兜底。
  const hardwareProbeStarted = useRef(false)
  /**
   * 壁纸整体色调（实验性「背景自适应明暗」用）：'light' / 'dark'；未设壁纸、采样失败
   * 或功能关闭时为 null（此时仍由 theme 决定明暗）。
   */
  const [wallpaperTone, setWallpaperTone] = useState<'light' | 'dark' | null>(null)

  const sysTheme = useSystemTheme()
  const theme = useMemo<'light' | 'dark'>(() => {
    if (!settings) return 'dark'
    // 实验性：开启且已成功采样到壁纸色调时，明暗以壁纸为准。
    if (settings.autoThemeFromWallpaper && wallpaperTone) return wallpaperTone
    return settings.theme === 'system' ? sysTheme : settings.theme
  }, [settings, sysTheme, wallpaperTone])

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme
  }, [theme])

  // 界面语言：由设置驱动，非法值回落简体中文；同步 <html lang> 供无障碍 / 字体选择使用。
  const locale = useMemo<Locale>(
    () => (isLocale(settings?.language) ? settings.language : 'zh-CN'),
    [settings?.language]
  )
  const t = useMemo<TFunction>(() => createTranslator(locale), [locale])
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  useEffect(() => {
    document.documentElement.dataset['reducedMotion'] = settings?.reducedMotion ? 'true' : 'false'
  }, [settings?.reducedMotion])

  // 超低占用模式：只降低「持续开销」（不可见时暂停动画/轮询、放缓刷新），不改变任何观感。
  useEffect(() => {
    document.documentElement.dataset['lowUsage'] = settings?.lowUsageMode ? 'true' : 'false'
  }, [settings?.lowUsageMode])

  // 窗口可见性：最小化 / 被完全遮挡时标记 data-window-hidden，
  // 供 CSS 暂停装饰动画、供页面暂停轮询（重新可见立即恢复）。
  useEffect(() => {
    const root = document.documentElement
    const sync = (): void => {
      root.dataset['windowHidden'] = document.visibilityState === 'hidden' ? 'true' : 'false'
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])

  useEffect(() => {
    document.documentElement.dataset['mode'] = settings?.mode ?? 'normal'
  }, [settings?.mode])

  // 界面皮肤：由 CSS 侧 [data-skin='…'] 接管材质令牌与控件复位。
  // 注意「实验项 → 皮肤」不是同名映射：默认（off）呈现的是「原毛玻璃」观感，
  // 它对应 CSS 里的 [data-skin='glass']；实验项 mica 才对应基础的 3D 云母（无覆盖规则）。
  useEffect(() => {
    const skin = settings?.experimental === 'off' ? 'glass' : (settings?.experimental ?? 'glass')
    document.documentElement.dataset['skin'] = skin
  }, [settings?.experimental])

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--fill-primary', settings?.accentColor ?? '#0a84ff')
    root.style.setProperty('--fill-primary-hover', settings?.accentColor ?? '#0a84ff')
    root.dataset['bg'] = settings?.background ?? 'midnight'
  }, [settings?.accentColor, settings?.background])

  /**
   * 自定义壁纸：把主进程读出的图片挂到 --wallpaper-image 上，并用 data-wallpaper
   * 开关交给 CSS 决定是否画。CSP 的 img-src 不含 file:，所以主进程把图读成 data URL
   * （详见主进程 wallpaper.ts）；这里再转成 blob: 对象地址，绕开浏览器对 url() 长度
   * （约 2MB）的限制——否则大图会被判为无效、设了也不生效。
   */
  useEffect(() => {
    const root = document.documentElement
    const name = settings?.backgroundImage ?? ''
    if (!name) {
      root.dataset['wallpaper'] = 'off'
      root.style.removeProperty('--wallpaper-image')
      setWallpaperTone(null)
      return
    }
    let alive = true
    /** 本次创建的对象地址：换图 / 卸载时释放，避免内存泄漏。 */
    let objectUrl = ''
    void window.api.settings.wallpaperData().then(async (dataUrl) => {
      if (!alive) return
      objectUrl = dataUrl ? dataUrlToBlobUrl(dataUrl) : ''
      if (objectUrl) {
        root.style.setProperty('--wallpaper-image', `url("${objectUrl}")`)
        root.dataset['wallpaper'] = 'on'
        // 采样壁纸整体色调，供实验性「背景自适应明暗」使用（未开启时该值不参与明暗计算）。
        const tone = await detectWallpaperTone(objectUrl)
        if (alive) setWallpaperTone(tone)
      } else {
        // 文件丢失 / 格式不认识：退回背景预设，不留下一个残缺的自定义背景
        root.dataset['wallpaper'] = 'off'
        root.style.removeProperty('--wallpaper-image')
        setWallpaperTone(null)
      }
    })
    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [settings?.backgroundImage])

  const reloadSettings = useCallback(async () => {
    setSettings(await window.api.settings.get())
  }, [])

  const updateSettings = useCallback(async (p: Partial<LauncherSettings>) => {
    setSettings(await window.api.settings.set(p))
  }, [])

  const reloadAccounts = useCallback(async () => {
    const [list, selected] = await Promise.all([
      window.api.accounts.list(),
      window.api.accounts.selected()
    ])
    setAccounts(list)
    setSelectedAccount(selected)
  }, [])

  const selectAccount = useCallback(async (id: string) => {
    const a = await window.api.accounts.select(id)
    if (a) setSelectedAccount(a)
  }, [])

  const removeAccount = useCallback(async (id: string) => {
    const list = await window.api.accounts.remove(id)
    setAccounts(list)
    setSelectedAccount(await window.api.accounts.selected())
  }, [])

  const raiseSecurityAlert = useCallback((alert: SecurityAlert) => {
    setSecurityAlert(alert)
  }, [])

  const clearSecurityAlert = useCallback(() => {
    setSecurityAlert(null)
  }, [])

  // 自实现资源管理器：只保存「当前要看的目录」，窗口本身由外层渲染。
  //
  // 传空目录（例如尚未设置游戏目录时的「打开游戏目录」）时退到「常用位置」的第一项
  // ——主进程的 places 把游戏目录排在最前、未设置时是「下载」，所以这里一定拿得到一个
  // 真实存在的目录，入口不会静默失效。同时自增序号，让「同一目录再次打开」也能触发
  // 外层（还原被最小化的窗口）。
  const openFileManager = useCallback((path: string) => {
    const show = (dir: string): void => {
      setFileManagerPath(dir)
      setFileManagerSeq((n) => n + 1)
    }
    const direct = (path ?? '').trim()
    if (direct) {
      show(direct)
      return
    }
    void window.api.files
      .places()
      .then((ps) => {
        const fallback = (ps[0]?.path ?? '').trim()
        if (fallback) show(fallback)
      })
      .catch(() => undefined)
  }, [])

  const closeFileManager = useCallback(() => {
    setFileManagerPath(null)
  }, [])

  useEffect(() => {
    void Promise.all([reloadSettings(), reloadAccounts()])
  }, [reloadSettings, reloadAccounts])

  /**
   * 首次启动的硬件检测：探测 CPU 核心数与内存总量，低配电脑自动开启「超低占用模式」，
   * 并弹出一次性提醒。检测结果落到 hardwareChecked，保证只执行一次。
   */
  useEffect(() => {
    if (!settings || settings.hardwareChecked || hardwareProbeStarted.current) return
    hardwareProbeStarted.current = true
    void (async () => {
      try {
        const hw = await window.api.system.hardware()
        if (hw.lowEnd) {
          await updateSettings({ hardwareChecked: true, lowUsageMode: true })
          setLowUsageNotice(true)
        } else {
          await updateSettings({ hardwareChecked: true })
        }
      } catch {
        // 探测失败不阻塞启动：仅标记已检测，避免每次启动重试。
        await updateSettings({ hardwareChecked: true })
      }
    })()
  }, [settings, updateSettings])

  const dismissLowUsageNotice = useCallback(() => setLowUsageNotice(false), [])

  /** 重新检查主页更新（服务端不可达时静默保持原列表）。 */
  const refreshHomepageUpdates = useCallback(async () => {
    try {
      setHomepageUpdates(await window.api.homepage.checkUpdates())
    } catch {
      /* 网络失败不打断界面，保留上一次结果 */
    }
  }, [])

  const dismissLauncherUpdateNotice = useCallback(() => setLauncherUpdateNotice(null), [])

  /**
   * 每次进入启动器（设置就绪后）自动检查：
   *   1. 启动器自身更新 → 有新版则弹提示（可在设置关闭，默认开启）；
   *   2. 已安装的联网校验主页更新 → 填充「可更新」栏（可在设置关闭，默认开启）。
   * 两项都只在「设置首次就绪」时跑一次，且跳过本地模式（本地模式不联网）。
   */
  useEffect(() => {
    if (!settings || startupCheckStarted.current) return
    if (settings.mode === 'local') return
    startupCheckStarted.current = true
    if (settings.autoCheckHomepageUpdate) void refreshHomepageUpdates()
    if (settings.autoCheckLauncherUpdate) {
      void window.api.update
        .check()
        .then((r) => {
          // 服务端最新为测试版（带 - 后缀）时不打扰用户：仅在设置页手动检查时才提示。
          if (r.hasUpdate && r.latest && !r.latestIsPrerelease) setLauncherUpdateNotice(r.latest)
        })
        .catch(() => undefined)
    }
  }, [settings, refreshHomepageUpdates])

  const value = useMemo<AppState>(
    () => ({
      ready: settings !== null,
      locale,
      t,
      settings: settings ?? {
        theme: 'system',
        language: 'zh-CN',
        memoryMb: 4096,
        maxDownloadConcurrency: 8,
        mirror: 'mojang',
        gameDir: '',
        versionDirs: [],
        selectedVersionDirId: '',
        javaAutoDetect: true,
        closeOnLaunch: false,
        reducedMotion: false,
        lowUsageMode: false,
        hardwareChecked: false,
        versionIsolation: false,
        accentColor: '#0a84ff',
        background: 'midnight',
        backgroundImage: '',
        autoThemeFromWallpaper: false,
        gameWindowSize: '720p',
        gameWindowWidth: 1280,
        gameWindowHeight: 720,
        mode: 'normal',
        disabledVersions: [],
        isolatedVersions: [],
        agreementAcceptedAt: 0,
        onboardingDone: false,
        debugMode: false,
        metadataOnlyMods: false,
        homepageId: '',
        selectedVersionId: '',
        experimental: 'off',
        devModeGrantedUntil: 0,
        devModeToken: '',
        devModeEmailMasked: '',
        devModeEnabled: false,
        devModeSecurityMode: 'full',
        autoCheckLauncherUpdate: true,
        autoCheckHomepageUpdate: true,
        autoTranslateResources: false,
        translateResourceNames: true,
        uapisApiKeySet: false
      },
      accounts,
      selectedAccount,
      theme,
      securityAlert,
      raiseSecurityAlert,
      clearSecurityAlert,
      fileManagerPath,
      fileManagerSeq,
      openFileManager,
      closeFileManager,
      reloadSettings,
      updateSettings,
      lowUsageNotice,
      dismissLowUsageNotice,
      homepageUpdates,
      refreshHomepageUpdates,
      launcherUpdateNotice,
      dismissLauncherUpdateNotice,
      reloadAccounts,
      selectAccount,
      removeAccount
    }),
    [settings, locale, t, accounts, selectedAccount, theme, securityAlert, raiseSecurityAlert, clearSecurityAlert, fileManagerPath, fileManagerSeq, openFileManager, closeFileManager, reloadSettings, updateSettings, lowUsageNotice, dismissLowUsageNotice, homepageUpdates, refreshHomepageUpdates, launcherUpdateNotice, dismissLauncherUpdateNotice, reloadAccounts, selectAccount, removeAccount]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppState {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}

/** 汇总全部版本目录：默认目录（gameDir）恒在首位（与主进程语义一致）。 */
export function allVersionDirs(s: LauncherSettings): VersionDir[] {
  return [
    { id: 'default', alias: '', path: s.gameDir, isDefault: true },
    ...(s.versionDirs ?? [])
  ]
}

/** 当前生效的版本目录（选中项失效时回退默认目录）。 */
export function activeVersionDir(s: LauncherSettings): VersionDir {
  const dirs = allVersionDirs(s)
  return dirs.find((d) => d.id === s.selectedVersionDirId) ?? dirs[0]
}

/** 当前生效的版本列表根目录路径：启动时传给主进程，保证实例落在当前版本目录里。 */
export function activeGameDir(s: LauncherSettings): string {
  return activeVersionDir(s).path
}

/** 版本目录展示名：优先别名；默认目录无别名时用「默认版本列表目录」，其余回退目录名。 */
export function versionDirLabel(d: VersionDir): string {
  if (d.alias) return d.alias
  if (d.isDefault) return '默认版本列表目录'
  const p = (d.path ?? '').replace(/[\\/]+$/, '')
  const seg = p.split(/[\\/]/).pop() ?? ''
  return seg || p || '未命名目录'
}

/**
 * 自适应轮询：常规模式下行为与普通 setInterval 完全一致（固定 baseMs 执行）；
 * 超低占用模式下放宽到 3 倍间隔，并在窗口不可见时跳过本轮，重新可见立即补一次。
 * 功能与观感不变（可见时照常刷新，只是周期更长），仅削减后台持续开销。
 */
export function useAdaptivePolling(fn: () => void, baseMs: number, lowUsage: boolean): void {
  const saved = useRef(fn)
  saved.current = fn
  useEffect(() => {
    if (!lowUsage) {
      const timer = window.setInterval(() => saved.current(), baseMs)
      return () => window.clearInterval(timer)
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') saved.current()
    }, baseMs * 3)
    const onVisible = (): void => {
      if (document.visibilityState !== 'hidden') saved.current()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [baseMs, lowUsage])
}
