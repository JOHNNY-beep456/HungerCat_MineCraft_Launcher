// ---------------------------------------------------------------------------
// 加载与错误态：把主页条目、启动器版本号、内存、已安装版本、版本目录、
// 选中版本与账号信息装载进组件，供能力桥与渲染共用。
//
// 这里的异步装载都带 alive 标记，卸载后不再 setState；已安装列表首次挂载
// 延后到首屏空闲再扫描，避免与首屏渲染抢 IO。
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type {
  HomepageSource,
  InstalledVersion,
  LauncherSettings,
  MinecraftAccount,
  SystemMemoryInfo,
  VersionDir
} from '@shared/types'
import { useAdaptivePolling } from '../../store'
import { runWhenIdle } from '../../startup'
import { yggdrasilSiteLabel } from '../../components/ui'
import { avatarUrl, loaderLabel, toVersionDirInfo } from './mapping'
import type { AccountInfo, ModelSkin, SelectedVersionInfo, VersionDirInfo } from './types'

export interface HomepageDataOptions {
  id: string
  selectedAccount: MinecraftAccount | null
  settings: LauncherSettings
  updateSettings: (p: Partial<LauncherSettings>) => Promise<void>
  reloadSettings: () => Promise<void>
}

export interface HomepageData {
  entry: HomepageSource | null
  setEntry: Dispatch<SetStateAction<HomepageSource | null>>
  /** 主页条目读取失败时的错误信息。 */
  error: string | null
  memInfo: SystemMemoryInfo | null
  installed: InstalledVersion[]
  /** 版本目录列表（默认目录在最前）。 */
  dirs: VersionDir[]
  /** 启动器版本号（暴露给脚本，用于自检 / 提示最低版本）。 */
  launcherVersion: string
  /** 当前生效的版本目录 id；'' 视为默认目录。 */
  activeDirId: string
  selectedVersionId: string
  /** 选中版本的加载器与版本号；无已安装版本时为 null。 */
  selectedVersion: SelectedVersionInfo | null
  /** 版本目录列表（含展示名），供内置选择器与 hc.versionDirs.* 共用。 */
  versionDirInfos: VersionDirInfo[]
  selectVersionDir: (next: string) => Promise<string>
  accountInfo: AccountInfo | null
  modelSkin: ModelSkin | null
}

/**
 * 装载「自定义主页」所需的全部宿主数据。
 *
 * 与旧实现逐条对应：主页条目 / 启动器版本号 / 已用内存（自适应轮询）/ 已安装版本
 * （随版本目录收敛、首次延后到空闲）/ 版本目录列表 / 选中版本回落 / 账号与皮肤信息。
 */
export function useHomepageData({
  id,
  selectedAccount,
  settings,
  updateSettings,
  reloadSettings
}: HomepageDataOptions): HomepageData {
  const [entry, setEntry] = useState<HomepageSource | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [memInfo, setMemInfo] = useState<SystemMemoryInfo | null>(null)
  const [installed, setInstalled] = useState<InstalledVersion[]>([])
  /** 版本目录列表（默认目录在最前）。 */
  const [dirs, setDirs] = useState<VersionDir[]>([])
  /** 启动器版本号（暴露给脚本，用于自检 / 提示最低版本）。 */
  const [launcherVersion, setLauncherVersion] = useState('')

  /** 当前生效的版本目录 id；'' 视为默认目录。 */
  const activeDirId = settings.selectedVersionDirId || 'default'
  /** 首次挂载标记：installed:list 全量扫描较重，首次延后到首屏空闲再跑（见下方 effect）。 */
  const installedFirstRun = useRef(true)

  /** 内存轮询的存活标记：组件卸载后不再 setState。 */
  const memAliveRef = useRef(true)
  useEffect(
    () => () => {
      memAliveRef.current = false
    },
    []
  )
  const refreshMemory = useCallback((): void => {
    void window.api.system.memory().then(
      (m) => memAliveRef.current && setMemInfo(m),
      () => memAliveRef.current && setMemInfo(null)
    )
  }, [])

  /* ---------------- 数据装载 ---------------- */

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const src = await window.api.homepage.read(id)
        if (alive) setEntry(src)
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    void (async () => {
      try {
        const v = await window.api.getVersion()
        if (alive) setLauncherVersion(v)
      } catch {
        /* 取不到版本号不影响主页运行 */
      }
    })()
    refreshMemory()
    return () => {
      alive = false
    }
  }, [id])

  // 已用内存轮询：常规 30s；超低占用模式下放宽周期并在窗口不可见时暂停。
  useAdaptivePolling(refreshMemory, 30000, settings.mode === 'lowUsage')

  // 已安装版本随「当前版本目录」收敛：切换目录后重新拉取，内置选择器与脚本接口随之更新。
  // 首次挂载延后到首屏空闲：installed:list 要全量扫描版本目录，避免与首屏渲染抢 IO。
  useEffect(() => {
    let alive = true
    let cancelIdle: (() => void) | undefined
    const run = (): void => {
      void (async () => {
        try {
          const list = await window.api.installed.list()
          if (alive) setInstalled(list)
        } catch {
          /* 已安装列表偶发失败不阻塞主页 */
        }
      })()
    }
    if (installedFirstRun.current) {
      installedFirstRun.current = false
      cancelIdle = runWhenIdle(run)
    } else {
      run()
    }
    return () => {
      alive = false
      cancelIdle?.()
    }
  }, [activeDirId])

  // 版本目录列表：供内置选择器与 hc.versionDirs.* 使用。
  useEffect(() => {
    void window.api.versionDirs.list().then(setDirs).catch(() => undefined)
  }, [])

  /* ---------------- 选中版本 ---------------- */

  // 选中版本持久化在设置里，脚本与内置页共享；首次进入时回落到第一个已安装版本。
  useEffect(() => {
    if (installed.length === 0) return
    if (installed.some((v) => v.id === settings.selectedVersionId)) return
    void updateSettings({ selectedVersionId: installed[0].id })
  }, [installed, settings.selectedVersionId, updateSettings])

  const selectedVersionId = useMemo(
    () =>
      installed.some((v) => v.id === settings.selectedVersionId)
        ? settings.selectedVersionId
        : installed[0]?.id ?? '',
    [installed, settings.selectedVersionId]
  )

  const selectedVersion = useMemo<SelectedVersionInfo | null>(() => {
    const v = installed.find((item) => item.id === selectedVersionId)
    if (!v) return null
    return {
      id: v.id,
      number: v.mcVersion || v.id,
      loader: v.loader ?? '',
      loaderName: loaderLabel(v.loader)
    }
  }, [installed, selectedVersionId])

  // 版本目录列表（含展示名），供内置选择器与 hc.versionDirs.* 共用。
  const versionDirInfos = useMemo<VersionDirInfo[]>(() => dirs.map(toVersionDirInfo), [dirs])

  // 切换版本目录：主进程持久化选中项并失效缓存，installed 副作用随之重新拉取。
  const selectVersionDir = useCallback(
    async (next: string): Promise<string> => {
      if (!dirs.some((d) => d.id === next)) throw new Error(`版本目录不可用：${next || '(空)'}`)
      if (next !== activeDirId) {
        await window.api.versionDirs.select(next)
        await reloadSettings()
      }
      return next
    },
    [dirs, activeDirId, reloadSettings]
  )

  const accountInfo = useMemo<AccountInfo | null>(
    () =>
      selectedAccount
        ? {
            name: selectedAccount.name,
            id: selectedAccount.id,
            avatarUrl: avatarUrl(selectedAccount),
            authType: selectedAccount.authType ?? (selectedAccount.offline ? 'offline' : 'microsoft'),
            // 账号「归属名」：第三方账号为自动获取的站点名称（缺失时回落到认证域名）；
            // 非第三方账号无归属站点，为空串。
            siteName: selectedAccount.authType === 'yggdrasil' ? yggdrasilSiteLabel(selectedAccount) : ''
          }
        : null,
    [selectedAccount]
  )

  /**
   * 当前账号的 3D 模型皮肤数据（供主页 hc.model3d 使用）。
   * 仅正版 / 第三方账号有皮肤；离线账号或未设置皮肤时为 null（模型显示占位）。
   */
  const modelSkin = useMemo<ModelSkin | null>(() => {
    if (!selectedAccount) return null
    if (selectedAccount.offline === true || selectedAccount.authType === 'offline') return null
    const skinUrl = (selectedAccount.skinUrl ?? '').replace(/^http:\/\//i, 'https://')
    if (!skinUrl) return null
    return {
      skinUrl,
      capeUrl: (selectedAccount.capeUrl ?? '').replace(/^http:\/\//i, 'https://'),
      skinModel: selectedAccount.skinModel ?? 'classic'
    }
  }, [selectedAccount])

  return {
    entry,
    setEntry,
    error,
    memInfo,
    installed,
    dirs,
    launcherVersion,
    activeDirId,
    selectedVersionId,
    selectedVersion,
    versionDirInfos,
    selectVersionDir,
    accountInfo,
    modelSkin
  }
}
