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
import type { AgreementStatus, Announcement, HomepageUpdate, LauncherSettings, MinecraftAccount, UpdateInfo, VersionDir } from '@shared/types'
import { defaultSettings } from '@shared/settings'
import { dataUrlToBlobUrl, detectWallpaperTone } from './wallpaper'
import { runWhenIdle } from './startup'
import { selectPendingAnnouncements, seenPatch } from './announcement'
import { createTranslator, isLocale, type Locale, type TFunction } from './i18n'

/**
 * 「当前设置」是否已满足协议要求（用于实时判断同意弹窗是否还需要显示）。
 *
 * 判定口径与主进程 agreementStatus 保持一致：
 *   · 有协议版本 → 记录的版本指纹相同即视为已同意；
 *   · 无版本（本地模式 / 服务端未公布）→ 记录过同意时间即可。
 * 另兼容一种情况：玩家在协议正文加载完成前就点了同意（此时版本指纹只能记空串），
 * 之后核对结果回来不应让弹窗「复活」，故「同意过但没记版本」也算已同意。
 */
function agreementSatisfied(s: LauncherSettings | null, st: AgreementStatus | null): boolean {
  if (!s) return false
  if (st?.version) {
    return s.agreementAcceptedVersion === st.version || (s.agreementAcceptedAt > 0 && !s.agreementAcceptedVersion)
  }
  return s.agreementAcceptedAt > 0
}

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
  /** 全局页面跳转请求（含自增 seq）；由最外层 Shell / Win10 桌面消费。 */
  navRequest: { page: string; seq: number } | null
  /** 请求切到指定页面。 */
  requestNavigate: (page: string) => void
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
  /**
   * 主页安全检测是否由原生（Rust）内核承担：true=原生、false=回退 TS、null=尚未探测。
   * 为 false 时由外层在顶部显示非侵入式提示。
   */
  homepageSecurityNative: boolean | null
  /**
   * 是否需要（重新）同意协议：首次使用，或服务端协议内容发生变化。
   * 由启动时的协议版本核对（agreementStatus）决定；核对完成前按「从未同意」判断。
   */
  needAgreement: boolean
  /** 协议版本核对结果（含正文与版本指纹）；null 表示尚未完成核对。 */
  agreementStatus: AgreementStatus | null
  /** 本次启动要展示的公告（已按展示范围与时机筛选、排序）；空数组表示无。 */
  announcements: Announcement[]
  /** 关闭公告弹窗：把已展示的公告记入 announcementSeen 并清空待展示列表。 */
  dismissAnnouncements: () => Promise<void>
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
  /**
   * 全局页面跳转请求：任意组件（如启动流程）可请求切到某个页面，由最外层 Shell /
   * Win10 桌面消费。用自增 seq 保证「请求同一页面多次」也能触发一次导航。
   */
  const [navRequest, setNavRequest] = useState<{ page: string; seq: number } | null>(null)
  const [homepageUpdates, setHomepageUpdates] = useState<HomepageUpdate[]>([])
  const [launcherUpdateNotice, setLauncherUpdateNotice] = useState<UpdateInfo | null>(null)
  /**
   * 主页安全检测是否由原生（Rust）内核承担：true=原生、false=回退 TS、null=尚未探测。
   * 为 false 时顶部给出非侵入式提示（缺原生产物 / 旧版原生库 / 加载失败）。
   */
  const [homepageSecurityNative, setHomepageSecurityNative] = useState<boolean | null>(null)
  /** 协议版本核对结果；null 表示尚未完成核对。 */
  const [agreementStatus, setAgreementStatus] = useState<AgreementStatus | null>(null)
  /** 本次启动要展示的公告。 */
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  // 启动自动检查只跑一次：React 严格模式下 effect 会重复触发，用 ref 兜底。
  const startupCheckStarted = useRef(false)
  // 公告拉取只跑一次（同上，避免严格模式重复请求）。
  const announcementStarted = useRef(false)
  // 首次启动的硬件检测只跑一次：React 严格模式下 effect 会重复触发，用 ref 兜底。
  const hardwareProbeStarted = useRef(false)
  /**
   * 进入「超低占用模式」前用户自己的「减少动态效果」取值。
   * 低占用会把 reducedMotion 强制为开；退出时要还原成该值，否则动效不会恢复。
   */
  const reducedMotionBeforeLowUsage = useRef<boolean | null>(null)
  // 主页安全检测引擎探测只跑一次（同上，避免严格模式重复请求）。
  const securityEngineProbeStarted = useRef(false)
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
    const root = document.documentElement
    root.dataset['reducedMotion'] = settings?.reducedMotion || settings?.mode === 'lowUsage' ? 'true' : 'false'
  }, [settings?.reducedMotion, settings?.mode])

  // 运行模式 → DOM 标记：
  //   minimal            直接映射为 data-mode='minimal'
  //   lowUsage（超低占用）强制极简：data-mode='minimal' + data-reduced-motion='true'
  //                       + data-low-usage='true'；data-mode 仍是 minimal 以便复用极简样式，
  //                       lowUsage 的额外规则再叠加在最上面以尽量关闭一切动画/渲染。
  //
  // 进出低占用时同步「减少动态效果」：进入前记住用户自己的取值，进入后强制为开；
  // 退出时还原成记住的取值 —— 否则 reducedMotion 一直被低占用置为 true，动效不会恢复。
  useEffect(() => {
    const root = document.documentElement
    const mode = settings?.mode ?? 'normal'
    const lowUsage = mode === 'lowUsage'
    root.dataset['mode'] = lowUsage ? 'minimal' : mode
    root.dataset['lowUsage'] = lowUsage ? 'true' : 'false'

    if (!settings) return
    if (lowUsage) {
      // 仅在首次进入低占用时记录原值，避免把「被强制开启的 true」当成用户原值。
      if (reducedMotionBeforeLowUsage.current === null) {
        reducedMotionBeforeLowUsage.current = settings.reducedMotion
      }
      if (!settings.reducedMotion) void updateSettings({ reducedMotion: true })
    } else if (reducedMotionBeforeLowUsage.current !== null) {
      const prev = reducedMotionBeforeLowUsage.current
      reducedMotionBeforeLowUsage.current = null
      if (settings.reducedMotion !== prev) void updateSettings({ reducedMotion: prev })
    }
    // updateSettings 稳定（useCallback），无需列入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.mode])

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
      objectUrl = dataUrl ? await dataUrlToBlobUrl(dataUrl) : ''
      if (!alive) {
        if (objectUrl) URL.revokeObjectURL(objectUrl)
        return
      }
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
    // 用主进程一并返回的账号列表与选中项更新状态：不再单独发 selected() 重新读盘，
    // 避免「异步落盘尚未完成 → 读到删除前的旧文件 → 左下角仍显示被删用户」的竞态。
    const { accounts: list, selected } = await window.api.accounts.remove(id)
    setAccounts(list)
    setSelectedAccount(selected)
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
   * 首次启动的硬件检测：探测 CPU 年代 / 是否虚拟机 / 内存总量，低配电脑自动开启
   * 「超低占用模式」并弹出一次性提醒。检测结果落到 hardwareChecked（只跑一次）与
   * hardwareLowEnd（供界面限制离开超低占用模式）。
   * 探测（os.cpus()）与随后的设置写盘都偏重，延后到首屏空闲后再做，压低启动瞬时占用。
   */
  useEffect(() => {
    if (!settings || settings.hardwareChecked || hardwareProbeStarted.current) return
    hardwareProbeStarted.current = true
    return runWhenIdle(() => {
      void (async () => {
        try {
          const hw = await window.api.system.hardware()
          if (hw.lowEnd) {
            await updateSettings({ hardwareChecked: true, hardwareLowEnd: true, mode: 'lowUsage' })
            setLowUsageNotice(true)
          } else {
            await updateSettings({ hardwareChecked: true, hardwareLowEnd: false })
          }
        } catch {
          // 探测失败不阻塞启动：仅标记已检测，避免每次启动重试。
          await updateSettings({ hardwareChecked: true })
        }
      })()
    })
  }, [settings, updateSettings])

  const dismissLowUsageNotice = useCallback(() => setLowUsageNotice(false), [])

  /** 请求切到指定页面（由最外层 Shell / Win10 桌面消费；不依赖具体路由实现）。 */
  const requestNavigate = useCallback((page: string) => {
    setNavRequest((prev) => ({ page, seq: (prev?.seq ?? 0) + 1 }))
  }, [])

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
   * 均非首屏必需，延后到首屏空闲后再发起：既降低启动瞬时占用，也避免过早 fork 网络进程。
   */
  useEffect(() => {
    if (!settings || startupCheckStarted.current) return
    if (settings.mode === 'local') return
    startupCheckStarted.current = true
    return runWhenIdle(() => {
      if (settings.autoCheckHomepageUpdate) void refreshHomepageUpdates()
      // 重要版本要「无论是否开启自动更新」都推送，所以这里始终检查一次更新；
      // 普通版本仍只在开启自动更新时提示。
      void window.api.update
        .check()
        .then((r) => {
          if (!r.latest) return
          // 重要版本：服务端标记为重要、且「启动器主版本号 <= 重要版本主版本号」时才推送
          // （不把旧的重要版本推给已升级到更新主版本的用户）；版本号完全一致则无需推送。
          if (r.latestIsImportant && r.importantApplies && r.latest.version !== r.currentVersion) {
            setLauncherUpdateNotice(r.latest)
            return
          }
          // 普通版本：仅在开启自动更新、且服务端最新不是测试版时提示。
          if (settings.autoCheckLauncherUpdate && r.hasUpdate && !r.latestIsPrerelease) {
            setLauncherUpdateNotice(r.latest)
          }
        })
        .catch(() => undefined)
    })
  }, [settings, refreshHomepageUpdates])

  /**
   * 启动时（设置就绪后）核对协议版本并拉取公告，各跑一次：
   *   1. 协议版本核对 → 决定是否需要（重新）同意；
   *   2. 公告拉取 → 按「展示范围 + 时机」筛选出本次要弹出的公告。
   * 本地模式不联网：协议仅按「从未同意」判断，公告直接跳过。
   * 延后到首屏空闲后再发起：协议弹窗本就在首帧之后才需要，公告同理，延后不影响功能。
   */
  useEffect(() => {
    if (!settings || announcementStarted.current) return
    announcementStarted.current = true
    return runWhenIdle(() => {
      void window.api.about
        .agreementStatus()
        .then(setAgreementStatus)
        .catch(() =>
          setAgreementStatus({ version: '', needsConsent: !settings.agreementAcceptedAt, content: null })
        )
      if (settings.mode === 'local') return
      void window.api.about
        .announcements()
        .then((list) =>
          setAnnouncements(
            selectPendingAnnouncements(list, {
              display: settings.announcementDisplay,
              seen: settings.announcementSeen ?? {}
            })
          )
        )
        .catch(() => undefined)
    })
  }, [settings])

  /**
   * 探测主页安全检测引擎（是否使用原生 Rust 内核），设置就绪后只跑一次。
   * 探测失败按「未使用 Rust」处理并给出提示，避免静默降级（与安全相关的降级不应被隐藏）。
   * 该探测会 dlopen 原生 .node，开销不低且非首屏必需，延后到首屏空闲后再加载。
   */
  useEffect(() => {
    if (!settings || securityEngineProbeStarted.current) return
    securityEngineProbeStarted.current = true
    return runWhenIdle(() => {
      void window.api.homepage
        .securityEngine()
        .then((r) => setHomepageSecurityNative(r.native === true))
        .catch(() => setHomepageSecurityNative(false))
    })
  }, [settings])

  /** 关闭公告弹窗：把本次展示的公告记入 seen（避免「发布后首次开启」重复弹出）并清空列表。 */
  const dismissAnnouncements = useCallback(async () => {
    const patch = seenPatch(announcements)
    setAnnouncements([])
    if (Object.keys(patch).length === 0) return
    await updateSettings({ announcementSeen: { ...(settings?.announcementSeen ?? {}), ...patch } })
  }, [announcements, settings, updateSettings])

  const value = useMemo<AppState>(
    () => ({
      ready: settings !== null,
      locale,
      t,
      settings: settings ?? defaultSettings(),
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
      navRequest,
      requestNavigate,
      homepageUpdates,
      refreshHomepageUpdates,
      launcherUpdateNotice,
      dismissLauncherUpdateNotice,
      homepageSecurityNative,
      // 协议核对完成前，按「从未同意过」判断（新用户立即弹窗；老用户核对完成前不弹）。
      // 核对完成后必须再叠加一次「按当前设置实时判断」：agreementStatus 是核对那一刻的
      // 快照，玩家点「同意」只更新了设置、快照不会变，只按快照判断会让弹窗永远关不掉
      //（核对结果返回之前点能关、之后点关不掉 —— 即「有概率无法同意」）。
      needAgreement: agreementStatus
        ? agreementStatus.needsConsent && !agreementSatisfied(settings, agreementStatus)
        : !settings?.agreementAcceptedAt,
      agreementStatus,
      announcements,
      dismissAnnouncements,
      reloadAccounts,
      selectAccount,
      removeAccount
    }),
    [settings, locale, t, accounts, selectedAccount, theme, securityAlert, raiseSecurityAlert, clearSecurityAlert, fileManagerPath, fileManagerSeq, openFileManager, closeFileManager, reloadSettings, updateSettings, lowUsageNotice, dismissLowUsageNotice, navRequest, requestNavigate, homepageUpdates, refreshHomepageUpdates, launcherUpdateNotice, dismissLauncherUpdateNotice, homepageSecurityNative, agreementStatus, announcements, dismissAnnouncements, reloadAccounts, selectAccount, removeAccount]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppState {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}

/** 汇总全部版本目录：默认目录（gameDir）恒在首位，别名固定为「默认」（与主进程语义一致）。 */
export function allVersionDirs(s: LauncherSettings): VersionDir[] {
  return [
    { id: 'default', alias: '默认', path: s.gameDir, isDefault: true },
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

/** 版本目录展示名：优先别名；默认目录无别名时用「默认」，其余回退目录名。 */
export function versionDirLabel(d: VersionDir): string {
  if (d.alias) return d.alias
  if (d.isDefault) return '默认'
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
