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

interface AppState {
  ready: boolean
  settings: LauncherSettings
  accounts: MinecraftAccount[]
  selectedAccount: MinecraftAccount | null
  theme: 'light' | 'dark'
  reloadSettings: () => Promise<void>
  updateSettings: (p: Partial<LauncherSettings>) => Promise<void>
  reloadAccounts: () => Promise<void>
  selectAccount: (id: string) => Promise<void>
  removeAccount: (id: string) => Promise<void>
}

const AppContext = createContext<AppState | null>(null)

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function AppProvider({ children }: { children: ReactNode }): JSX.Element {
  const [settings, setSettings] = useState<LauncherSettings | null>(null)
  const [accounts, setAccounts] = useState<MinecraftAccount[]>([])
  const [selectedAccount, setSelectedAccount] = useState<MinecraftAccount | null>(null)

  const theme = useMemo<'light' | 'dark'>(() => {
    if (!settings) return 'dark'
    return settings.theme === 'system' ? systemTheme() : settings.theme
  }, [settings])

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme
  }, [theme])

  useEffect(() => {
    document.documentElement.dataset['reducedMotion'] = settings?.reducedMotion ? 'true' : 'false'
  }, [settings?.reducedMotion])

  useEffect(() => {
    document.documentElement.dataset['mode'] = settings?.mode ?? 'normal'
  }, [settings?.mode])

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--fill-primary', settings?.accentColor ?? '#0a84ff')
    root.style.setProperty('--fill-primary-hover', settings?.accentColor ?? '#0a84ff')
    root.dataset['bg'] = settings?.background ?? 'default'
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
        background: 'default',
        mode: 'normal',
        disabledVersions: [],
        isolatedVersions: [],
        agreementAcceptedAt: 0,
        onboardingDone: false,
        debugMode: false,
        metadataOnlyMods: false
      },
      accounts,
      selectedAccount,
      theme,
      reloadSettings,
      updateSettings,
      reloadAccounts,
      selectAccount,
      removeAccount
    }),
    [settings, accounts, selectedAccount, theme, reloadSettings, updateSettings, reloadAccounts, selectAccount, removeAccount]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp(): AppState {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
