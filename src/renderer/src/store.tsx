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

  // 实验性界面皮肤：由 CSS 侧 [data-skin='…'] 接管字体与配色（两项互斥，取单一字段）
  useEffect(() => {
    document.documentElement.dataset['skin'] = settings?.experimental ?? 'off'
  }, [settings?.experimental])

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--fill-primary', settings?.accentColor ?? '#0a84ff')
    root.style.setProperty('--fill-primary-hover', settings?.accentColor ?? '#0a84ff')
    root.dataset['bg'] = settings?.background ?? 'midnight'
  }, [settings?.accentColor, settings?.background])

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
      reloadSettings,
      updateSettings,
      reloadAccounts,
      selectAccount,
      removeAccount
    }),
    [settings, accounts, selectedAccount, theme, securityAlert, raiseSecurityAlert, clearSecurityAlert, reloadSettings, updateSettings, reloadAccounts, selectAccount, removeAccount]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppState {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
