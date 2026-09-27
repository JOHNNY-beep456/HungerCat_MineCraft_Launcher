import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import type { LauncherSettings, MinecraftAccount } from '@shared/types'

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

  const sysTheme = useSystemTheme()
  const theme = useMemo<'light' | 'dark'>(() => {
    if (!settings) return 'dark'
    return settings.theme === 'system' ? sysTheme : settings.theme
  }, [settings, sysTheme])

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme
  }, [theme])

  useEffect(() => {
    document.documentElement.dataset['reducedMotion'] = settings?.reducedMotion ? 'true' : 'false'
  }, [settings?.reducedMotion])

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
   * 自定义壁纸：把主进程读出的图片（data URL）挂到 --wallpaper-image 上，
   * 并用 data-wallpaper 开关交给 CSS 决定是否画。CSP 的 img-src 不含 file:，
   * 所以只能走 data: —— 详见主进程 wallpaper.ts。
   */
  useEffect(() => {
    const root = document.documentElement
    const name = settings?.backgroundImage ?? ''
    if (!name) {
      root.dataset['wallpaper'] = 'off'
      root.style.removeProperty('--wallpaper-image')
      return
    }
    let alive = true
    void window.api.settings.wallpaperData().then((url) => {
      if (!alive) return
      if (url) {
        root.style.setProperty('--wallpaper-image', `url("${url}")`)
        root.dataset['wallpaper'] = 'on'
      } else {
        // 文件丢失 / 格式不认识：退回背景预设，不留下一个残缺的自定义背景
        root.dataset['wallpaper'] = 'off'
        root.style.removeProperty('--wallpaper-image')
      }
    })
    return () => {
      alive = false
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

  const value = useMemo<AppState>(
    () => ({
      ready: settings !== null,
      settings: settings ?? {
        theme: 'system',
        memoryMb: 4096,
        maxDownloadConcurrency: 8,
        mirror: 'mojang',
        gameDir: '',
        javaAutoDetect: true,
        closeOnLaunch: false,
        reducedMotion: false,
        versionIsolation: false,
        accentColor: '#0a84ff',
        background: 'midnight',
        backgroundImage: '',
        mode: 'normal',
        disabledVersions: [],
        isolatedVersions: [],
        agreementAcceptedAt: 0,
        onboardingDone: false,
        debugMode: false,
        metadataOnlyMods: false,
        homepageId: '',
        selectedVersionId: '',
        experimental: 'off'
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
      reloadAccounts,
      selectAccount,
      removeAccount
    }),
    [settings, accounts, selectedAccount, theme, securityAlert, raiseSecurityAlert, clearSecurityAlert, fileManagerPath, fileManagerSeq, openFileManager, closeFileManager, reloadSettings, updateSettings, reloadAccounts, selectAccount, removeAccount]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppState {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
