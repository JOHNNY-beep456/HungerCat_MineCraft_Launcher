import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { AnimatePresence } from 'motion/react'
import type {
  ModEntry,
  ModrinthProject,
  ResourceFile,
  ResourceUpdateInfo,
  SchematicEntry
} from '@shared/types'
import { activeGameDir, useApp } from '../store'
import { useRuntimeActions } from '../runtime'
import { Segmented } from '../components/ui'
import { formatInstallError } from '../mod-install-error'
import { findMissingDependencies, type DepMissing } from './shared/mod-dependencies'
import { DependencyPromptDialog } from './shared/DependencyPromptDialog'
import { ExportPage } from './ExportPage'
import type { ResFilter, Tab } from './instance-manage/types'
import { InstanceHeader } from './instance-manage/InstanceHeader'
import { ResourceFilterBar } from './instance-manage/ResourceFilterBar'
import { VersionPanel } from './instance-manage/VersionPanel'
import { ModsPanel } from './instance-manage/ModsPanel'
import { SavesPanel } from './instance-manage/SavesPanel'
import { ResourcesPanel } from './instance-manage/ResourcesPanel'
import { SchematicsPanel } from './instance-manage/SchematicsPanel'
import { ModDetailSheet } from './instance-manage/ModDetailSheet'
import { DeleteConfirmDialog } from './instance-manage/DeleteConfirmDialog'

/** 仅用于比较后台绝对路径；不推测共享目录或实例隔离目录。 */
function resourcePathKey(path: string): string {
  let key = path
  if (window.api.platform === 'win32') {
    key = key.split(String.fromCharCode(92)).join('/')
    if (key.startsWith('//?/')) {
      key = key.slice(4)
      if (key.slice(0, 4).toLowerCase() === 'unc/') key = `//${key.slice(4)}`
    }
    key = key.toLowerCase()
  }
  while (key.endsWith('/') && key.length > 1) key = key.slice(0, -1)
  return key
}

type ResourcePaths = Record<ResourceUpdateInfo['kind'], Map<string, string>>
interface ResourceScope {
  versionId: string
  root: string
  active: boolean
}
interface ResourceSnapshot {
  scope: ResourceScope
  paths: ResourcePaths
}

/**
 * 实例管理页：组合根。
 *
 * 页面状态、副作用与业务处理都集中在这里，具体板块（模组、资源包 / 光影、存档、投影、
 * 版本设置等）拆到 ./instance-manage/ 下作为展示型子组件，通过 props 接收状态与回调。
 */
export function InstanceManagePage({
  versionId,
  onBack,
  onRename
}: {
  versionId: string
  onBack: () => void
  onRename: (newId: string) => void
}): JSX.Element {
  const { settings, selectedAccount, updateSettings, reloadSettings, t } = useApp()
  const { launch } = useRuntimeActions()

  const [tab, setTab] = useState<Tab>('mods')
  const [loader, setLoader] = useState<string | null | undefined>(undefined)
  /** 实例的基础原版版本：加载器要装在它之上，由已安装列表解析得到。 */
  const [mcVersion, setMcVersion] = useState<string>('')
  const [mods, setMods] = useState<ModEntry[]>([])
  const [loadingMods, setLoadingMods] = useState(true)
  const [worlds, setWorlds] = useState<string[]>([])
  const [resourcePacks, setResourcePacks] = useState<ResourceFile[]>([])
  const [shaders, setShaders] = useState<ResourceFile[]>([])
  const [schematics, setSchematics] = useState<SchematicEntry[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  /** 删除实例的二次确认弹窗：删除不可恢复，先确认再执行。 */
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(versionId)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [modDetail, setModDetail] = useState<ModEntry | null>(null)

  // 资源更新检测（只接收当前目录快照、本次扫描的完整结果）
  const [resFilter, setResFilter] = useState<ResFilter>('all')
  /** path → 可更新信息；只放「确认可更新」的条目，界面据此显示更新按钮。 */
  const [updates, setUpdates] = useState<Record<string, ResourceUpdateInfo>>({})
  /** 已处理的路径（null 也可能表示无法判断），只用于展示检测进度。 */
  const [checkedCount, setCheckedCount] = useState(0)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<{ scope: ResourceScope; message: string } | null>(null)
  const [resourceSnapshot, setResourceSnapshot] = useState<ResourceSnapshot | null>(null)
  /** 自增即可重跑一次检测 */
  const [checkToken, setCheckToken] = useState(0)
  /** 「可更新」分栏的多选集合（按绝对路径）；刷新列表或换实例后清空。 */
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  /** 批量更新进度；null 表示当前没有在跑批量更新。 */
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)

  // online mod search
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ModrinthProject[]>([])
  const [searching, setSearching] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  /** 资源包 / 光影页的拖拽高亮（与模组页的 dragOver 分开，避免跨分栏串扰）。 */
  const [resDragOver, setResDragOver] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [loaderSel, setLoaderSel] = useState<string>('fabric')
  const [mcSel, setMcSel] = useState<string>('')
  /** 非空表示：在线安装检测到缺失必需前置，正等用户确认是否一并下载。 */
  const [depPrompt, setDepPrompt] = useState<DepMissing[] | null>(null)
  /** 依赖确认弹窗的下载中状态（禁用按钮防重复提交）。 */
  const [depBusy, setDepBusy] = useState(false)
  /** 待安装的本体文件（依赖确认后与其一并下载）。 */
  const pendingInstallRef = useRef<{ url: string; filename: string; title: string; version: string } | null>(null)
  /** 光影在线搜索用的运行时筛选（Iris / OptiFine），与模组页的 loaderSel 相互独立 */
  const [shaderLoader, setShaderLoader] = useState<string>('iris')

  const isVanilla = loader === null
  /**
   * 实例所属版本目录。加载器 profile 必须写进**同一个目录**，
   * 否则新实例会出现在别的版本目录里，用户在当前列表里找不到它。
   */
  const targetDirId = settings.selectedVersionDirId || 'default'
  const resourceRoot = resourcePathKey(activeGameDir(settings))
  const resourceIsolation = settings.versionIsolation || settings.isolatedVersions.includes(versionId)
  const resourceMode = settings.mode
  const metadataOnlyMods = settings.metadataOnlyMods
  const communitySource = settings.communitySource
  const downloadSource = settings.downloadSource
  const resourceScope = useMemo<ResourceScope>(
    () => ({ versionId, root: resourceRoot, active: true }),
    [versionId, targetDirId, resourceRoot, resourceIsolation, resourceMode, metadataOnlyMods, communitySource, downloadSource]
  )
  const currentResourceScope = useRef(resourceScope)
  const currentResourceSnapshot = useRef<ResourceSnapshot | null>(null)
  const resourceReloadRequest = useRef(0)
  const resourceCheckRequest = useRef(0)
  // 提交新目录后先停用旧快照，早于普通 effect 的订阅清理和 Promise 回调。
  useLayoutEffect(() => {
    resourceScope.active = true
    currentResourceScope.current = resourceScope
    currentResourceSnapshot.current = null
    return () => {
      resourceScope.active = false
      if (currentResourceSnapshot.current?.scope === resourceScope) currentResourceSnapshot.current = null
    }
  }, [resourceScope])

  const tabOptions = useMemo<Array<{ value: Tab; label: string }>>(() => {
    // 资源包原版就能用，所以原版实例也保留这一页；光影 / 投影 / 模组只有装了加载器才有意义
    if (isVanilla) {
      return [
        { value: 'saves', label: t('ins.tabSaves') },
        { value: 'resourcepacks', label: t('ins.resourcepacks') },
        { value: 'version', label: t('ins.version') }
      ]
    }
    return [
      { value: 'mods', label: t('ins.tabMods') },
      { value: 'saves', label: t('ins.tabSaves') },
      { value: 'resourcepacks', label: t('ins.resourcepacks') },
      { value: 'shaders', label: t('ins.tabShaders') },
      { value: 'schematics', label: t('ins.tabSchematics') },
      { value: 'version', label: t('ins.version') }
    ]
  }, [isVanilla, t])

  const disabled = settings.disabledVersions.includes(versionId)

  const reload = useCallback(async () => {
    if (currentResourceScope.current !== resourceScope || !resourceScope.active) return
    const request = ++resourceReloadRequest.current
    const isCurrent = (): boolean =>
      currentResourceScope.current === resourceScope && resourceScope.active && resourceReloadRequest.current === request
    currentResourceSnapshot.current = null
    setResourceSnapshot(null)
    setUpdates({})
    setSelected(new Set())
    setBatch(null)
    setCheckedCount(0)
    setChecking(false)
    setCheckError(null)
    setLoadingMods(true)
    try {
      const [modList, installed, packList, shaderList, schematicList] = await Promise.all([
        window.api.manage.mods(resourceScope.versionId),
        window.api.installed.list(),
        window.api.resources.list(resourceScope.versionId, 'resourcepacks'),
        window.api.resources.list(resourceScope.versionId, 'shaderpacks'),
        window.api.manage.schematics(resourceScope.versionId)
      ])
      if (!isCurrent()) return
      const paths: ResourcePaths = {
        mod: new Map(modList.map((m) => [resourcePathKey(m.path), m.path])),
        resourcepack: new Map(packList.map((p) => [resourcePathKey(p.path), p.path])),
        shader: new Map(shaderList.map((s) => [resourcePathKey(s.path), s.path]))
      }
      const snapshot = { scope: resourceScope, paths }
      currentResourceSnapshot.current = snapshot
      setResourceSnapshot(snapshot)
      setMods(modList)
      const entry = installed.find((v) => v.id === resourceScope.versionId)
      const entryLoader = entry?.loader ?? null
      setWorlds(entry?.worlds ?? [])
      setResourcePacks(packList)
      setShaders(shaderList)
      setSchematics(schematicList)
      setLoader(entryLoader)
      // 加载器安装在 mcVersion 之上；vanilla 实例的 mcVersion 就是其自身版本号。
      setMcVersion(entry?.mcVersion || resourceScope.versionId)
      // 换实例时必须无条件重置筛选：旧逻辑只在「仍为初始值」时覆盖，切过实例后会把
      // 上一个实例的版本 / 加载器带给新实例，在线安装取到的文件与实例不符（装时 Compatibility 拒绝）。
      setLoaderSel(entryLoader ?? 'fabric')
      setMcSel(entry?.mcVersion ?? '')
      // 后台联网补齐图标 / 名称 / slug（Electron enrich 的替代，逐项 manage:mods-updated /
      // resources:updated 推回后按路径合并）；本地模式或「仅识别资源元数据」时主进程自动拒绝。
      void window.api.manage.enrichMods(resourceScope.versionId).catch(() => undefined)
      void window.api.manage.enrichResources(resourceScope.versionId, 'resourcepacks').catch(() => undefined)
      void window.api.manage.enrichResources(resourceScope.versionId, 'shaderpacks').catch(() => undefined)
    } catch (err: unknown) {
      if (isCurrent()) setCheckError({ scope: resourceScope, message: err instanceof Error ? err.message : String(err) })
    } finally {
      if (isCurrent()) setLoadingMods(false)
    }
  }, [resourceScope])

  // 补全事件只能替换当前已加载集合中的文件，不能带入上一目录的同名实例数据。
  useEffect(() => {
    return window.api.manage.onModsUpdated(({ versionId: v, mod }) => {
      const snapshot = currentResourceSnapshot.current
      if (!resourceScope.active || currentResourceScope.current !== resourceScope ||
        snapshot?.scope !== resourceScope || v !== resourceScope.versionId) return
      const path = snapshot.paths.mod.get(resourcePathKey(mod.path))
      if (!path) return
      setMods((prev) => currentResourceSnapshot.current === snapshot
        ? prev.map((m) => (m.path === path ? { ...mod, path } : m)) : prev)
    })
  }, [resourceScope])

  // 光影 / 资源包的异步名称补全不改变检测所绑定的文件集合。
  useEffect(() => {
    return window.api.resources.onUpdated(({ versionId: v, kind, file }) => {
      const snapshot = currentResourceSnapshot.current
      if (!resourceScope.active || currentResourceScope.current !== resourceScope ||
        snapshot?.scope !== resourceScope || v !== resourceScope.versionId) return
      const updateKind = kind === 'resourcepacks' ? 'resourcepack' : kind === 'shaderpacks' ? 'shader' : null
      const path = updateKind && snapshot.paths[updateKind].get(resourcePathKey(file.path))
      if (!path) return
      const patch = (prev: ResourceFile[]): ResourceFile[] => currentResourceSnapshot.current === snapshot
        ? prev.map((p) => (p.path === path ? { ...file, path } : p)) : prev
      if (kind === 'resourcepacks') setResourcePacks(patch)
      else setShaders(patch)
    })
  }, [resourceScope])

  useEffect(() => {
    setMods([])
    setResourcePacks([])
    setShaders([])
    setSchematics([])
    setWorlds([])
    setLoader(undefined)
    setMcVersion('')
    setModDetail(null)
    setBusyId(null)
    void reload()
  }, [reload])

  // 等当前目录的列表成功加载后再检测；数组和名称补全变化不会再次扫描。
  useEffect(() => {
    setUpdates({})
    setCheckedCount(0)
    setChecking(false)
    if (resourceMode === 'local' || metadataOnlyMods || resourceSnapshot?.scope !== resourceScope ||
      currentResourceSnapshot.current !== resourceSnapshot || !resourceScope.active) return
    let alive = true
    const request = ++resourceCheckRequest.current
    const isCurrent = (): boolean => alive && resourceScope.active && currentResourceScope.current === resourceScope &&
      currentResourceSnapshot.current === resourceSnapshot && resourceCheckRequest.current === request
    const currentPath = (kind: ResourceUpdateInfo['kind'], path: string): string | undefined =>
      resourceSnapshot.paths[kind]?.get(resourcePathKey(path))
    const acceptedUpdate = (update: ResourceUpdateInfo): ResourceUpdateInfo | null => {
      const path = currentPath(update.kind, update.path)
      return path ? { ...update, path } : null
    }
    setCheckError(null)
    setChecking(true)
    // 事件不携带扫描代次，同 root/id/path 的旧扫描无法可靠区分；只采信本次完整返回。
    void window.api.resources.checkUpdates(resourceScope.versionId)
      .then((list) => {
        if (!isCurrent()) return
        const map: Record<string, ResourceUpdateInfo> = {}
        for (const item of list) {
          const update = acceptedUpdate(item)
          if (update) map[update.path] = update
        }
        setUpdates(map)
      })
      .catch((err: unknown) => {
        if (!isCurrent()) return
        setUpdates({})
        setCheckError({ scope: resourceScope, message: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        if (isCurrent()) setChecking(false)
      })
    return () => {
      alive = false
    }
  }, [resourceScope, resourceSnapshot, checkToken, resourceMode, metadataOnlyMods])

  // scope 刚切换的首帧也不能把旧更新按钮交给新实例。
  const scopedUpdates: Record<string, ResourceUpdateInfo> = resourceSnapshot?.scope === resourceScope &&
    currentResourceSnapshot.current === resourceSnapshot ? updates : {}
  /**
   * 当前分栏对应的资源类型：一次检测会把模组 / 资源包 / 光影一起判定，
   * 而「全部更新」只能动当前分栏这一类，否则在模组页会把光影也顺手换掉。
   */
  const tabKind: ResourceUpdateInfo['kind'] | null =
    tab === 'mods' ? 'mod' : tab === 'resourcepacks' ? 'resourcepack' : tab === 'shaders' ? 'shader' : null
  const tabUpdates = tabKind ? Object.values(scopedUpdates).filter((up) => up.kind === tabKind) : []
  const updatableCount = tabUpdates.length
  /** 只有仍属于当前快照的勾选才有效：换实例后旧路径自动失效。 */
  const selectedUpdates = tabUpdates.filter((up) => selected.has(up.path))
  const selectedCount = selectedUpdates.length
  const allSelected = updatableCount > 0 && selectedCount === updatableCount

  // 分栏：模组多「已启用 / 已禁用」两项；资源包 / 光影只有「全部 / 可更新」。
  const filterOptions = useMemo<Array<{ value: ResFilter; label: string }>>(() => {
    const list: Array<{ value: ResFilter; label: string }> = [{ value: 'all', label: t('ins.filterAll') }]
    if (tab === 'mods') {
      list.push({ value: 'enabled', label: t('ins.resEnabled') })
      list.push({ value: 'disabled', label: t('ins.resDisabled') })
    }
    list.push({
      value: 'updatable',
      label: updatableCount > 0 ? t('ins.resUpdatableCount', { n: updatableCount }) : t('ins.resUpdatable')
    })
    return list
  }, [tab, t, updatableCount])

  // 切到没有「已启用 / 已禁用」语义的页时把筛选拉回「全部」，避免显示空列表却看不出原因。
  useEffect(() => {
    if (tab !== 'mods' && (resFilter === 'enabled' || resFilter === 'disabled')) setResFilter('all')
  }, [tab, resFilter])

  const matchFilter = useCallback(
    (path: string, enabled: boolean): boolean => {
      if (resFilter === 'updatable') return !!scopedUpdates[path]
      if (resFilter === 'enabled') return enabled
      if (resFilter === 'disabled') return !enabled
      return true
    },
    [resFilter, scopedUpdates]
  )

  const visibleMods = useMemo(() => mods.filter((m) => matchFilter(m.path, m.enabled)), [mods, matchFilter])
  // 资源包 / 光影没有启用 / 禁用语义，一律按「已启用」参与筛选。
  const visiblePacks = useMemo(
    () => resourcePacks.filter((p) => matchFilter(p.path, true)),
    [resourcePacks, matchFilter]
  )
  const visibleShaders = useMemo(
    () => shaders.filter((s) => matchFilter(s.path, true)),
    [shaders, matchFilter]
  )

  /** 应用宿主重新核验的资源计划；错误也刷新列表，以真实文件状态为准。 */
  const applyUpdate = async (up: ResourceUpdateInfo, enabled: boolean): Promise<void> => {
    const snapshot = currentResourceSnapshot.current
    const isCurrent = (): boolean => resourceScope.active && currentResourceScope.current === resourceScope &&
      currentResourceSnapshot.current === snapshot
    if (!snapshot || snapshot.scope !== resourceScope || !isCurrent() || scopedUpdates[up.path] !== up ||
      snapshot.paths[up.kind]?.get(resourcePathKey(up.path)) !== up.path) return
    setBusyId(up.path)
    setNotice(null)
    try {
      await window.api.resources.applyUpdate(versionId, up, enabled)
      if (!isCurrent()) return
      setNotice(t('ins.updateDone', { name: up.title || up.filename, version: up.latestVersion }))
      await reload()
    } catch (err) {
      if (isCurrent()) {
        const message = t('ins.updateFailed', { msg: err instanceof Error ? err.message : String(err) })
        await reload()
        if (currentResourceScope.current === resourceScope && resourceScope.active) setNotice(message)
      }
    } finally {
      if (currentResourceScope.current === resourceScope && resourceScope.active) setBusyId(null)
    }
  }

  /** 把「可更新」条目配上它当前的启用状态：模组按实际开关，资源包 / 光影恒为启用。 */
  const updateTarget = (update: ResourceUpdateInfo): { update: ResourceUpdateInfo; enabled: boolean } => ({
    update,
    enabled: update.kind === 'mod' ? mods.find((m) => m.path === update.path)?.enabled ?? true : true
  })

  /**
   * 批量更新：**串行**逐项应用。
   *
   * 后端每应用一项都要拿根目录的跨进程写锁并重扫目录，并发提交只会互相等待，
   * 反而让第一项迟迟完不成；串行也保证中途失败时已完成的项仍是完整状态。
   * 中途不刷新列表（刷新会作废后续项绑定的快照），全部结束后统一 reload。
   */
  const applyUpdates = async (
    targets: Array<{ update: ResourceUpdateInfo; enabled: boolean }>
  ): Promise<void> => {
    if (batch || targets.length === 0) return
    const snapshot = currentResourceSnapshot.current
    const isCurrent = (): boolean => resourceScope.active && currentResourceScope.current === resourceScope &&
      currentResourceSnapshot.current === snapshot
    if (!snapshot || snapshot.scope !== resourceScope || !isCurrent()) return
    // 只接受本次渲染确认过、且仍属于当前目录快照的条目。
    const jobs = targets.filter(({ update }) => scopedUpdates[update.path] === update &&
      snapshot.paths[update.kind]?.get(resourcePathKey(update.path)) === update.path)
    if (jobs.length === 0) return
    setNotice(null)
    setBatch({ done: 0, total: jobs.length })
    const failures: string[] = []
    let ok = 0
    try {
      for (const job of jobs) {
        if (!isCurrent()) return
        setBusyId(job.update.path)
        try {
          await window.api.resources.applyUpdate(versionId, job.update, job.enabled)
          ok++
        } catch (err) {
          failures.push(`${job.update.title || job.update.filename}：${err instanceof Error ? err.message : String(err)}`)
        }
        setBatch({ done: ok + failures.length, total: jobs.length })
      }
    } finally {
      if (currentResourceScope.current === resourceScope && resourceScope.active) {
        setBusyId(null)
        setBatch(null)
      }
    }
    if (!isCurrent()) return
    setNotice(
      failures.length === 0
        ? t('ins.batchUpdateDone', { ok })
        : t('ins.batchUpdatePartial', { ok, fail: failures.length, errors: failures.join('；') })
    )
    await reload()
  }

  const toggleSelect = (path: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const toggleSelectAll = (next: boolean): void => {
    setSelected(next ? new Set(tabUpdates.map((up) => up.path)) : new Set())
  }

  useEffect(() => {
    if (isVanilla && (tab === 'mods' || tab === 'shaders' || tab === 'schematics')) {
      setTab('saves')
    }
  }, [isVanilla, tab])
  // 实例名变更（重命名成功后由父级更新）后，同步输入框
  useEffect(() => {
    setRenameValue(versionId)
  }, [versionId])

  const doLaunch = (opts?: { world?: string; server?: string }): void => {
    if (!selectedAccount) return
    // 不传 javaPath：由主进程按「Java 管理 → 自动检测」开关决定用哪个 Java。
    void launch({
      versionId,
      accountId: selectedAccount.id,
      gameDir: activeGameDir(settings),
      memoryMb: settings.memoryMb,
      quickPlaySingleplayer: opts?.world,
      quickPlayMultiplayer: opts?.server
    })
  }

  const toggleDisabled = async (): Promise<void> => {
    const next = disabled ? settings.disabledVersions.filter((v) => v !== versionId) : [...settings.disabledVersions, versionId]
    await updateSettings({ disabledVersions: next })
  }

  const doDeleteVersion = async (): Promise<void> => {
    if (deleting) return
    setDeleteConfirm(false)
    setDeleting(true)
    setNotice(null)
    try {
      await window.api.manage.deleteVersion(versionId)
      if (settings.disabledVersions.includes(versionId)) {
        await updateSettings({ disabledVersions: settings.disabledVersions.filter((v) => v !== versionId) })
      }
      await reloadSettings()
      onBack()
    } catch (err) {
      setNotice(t('ins.deleteFailed', { msg: err instanceof Error ? err.message : String(err) }))
      setDeleting(false)
    }
  }

  const doRename = async (): Promise<void> => {
    if (renaming) return
    const name = renameValue.trim()
    if (!name || name === versionId) {
      setRenameError(null)
      return
    }
    setRenaming(true)
    setRenameError(null)
    try {
      await window.api.manage.renameVersion(versionId, name)
      await reloadSettings()
      setRenaming(false)
      onRename(name)
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : String(err))
      setRenaming(false)
    }
  }

  const toggleMod = async (m: ModEntry): Promise<void> => {
    setBusyId(m.path)
    try {
      await window.api.manage.toggleMod(m.path)
      await reload()
    } finally {
      setBusyId(null)
    }
  }

  const deleteMod = async (m: ModEntry): Promise<void> => {
    await window.api.manage.deleteMod(m.path)
    await reload()
  }

  const installLocals = async (paths: string[]): Promise<void> => {
    const list = paths.filter(Boolean)
    if (list.length === 0) return
    setNotice(null)
    let ok = 0
    const errors: string[] = []
    for (const p of list) {
      try {
        await window.api.manage.installLocalMod(versionId, p)
        ok++
      } catch (err) {
        const name = p.split(/[\\/]/).pop() ?? p
        errors.push(`${name}：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    await reload()
    setNotice(
      errors.length > 0
        ? t('ins.installedModsPartial', { ok, fail: errors.length, errors: errors.join('；') })
        : t('ins.installedMods', { n: ok })
    )
  }

  const onDrop = async (e: DragEvent<HTMLDivElement>): Promise<void> => {
    e.preventDefault()
    setDragOver(false)
    const paths = Array.from(e.dataTransfer.files ?? [])
      .map((f) => window.api.shell.getPathForFile(f))
      .filter(Boolean)
    if (paths.length > 0) await installLocals(paths)
  }

  /**
   * 资源包 / 光影的本地导入：与模组同一个「逐个导入 + 汇总结果」的编排，
   * 只是目标目录按 kind 区分（resourcepacks / shaderpacks）。
   */
  const installLocalResources = async (
    paths: string[],
    kind: 'resourcepacks' | 'shaderpacks'
  ): Promise<void> => {
    const list = paths.filter(Boolean)
    if (list.length === 0) return
    setNotice(null)
    let ok = 0
    const errors: string[] = []
    for (const p of list) {
      try {
        await window.api.manage.installLocalResource(versionId, kind, p)
        ok++
      } catch (err) {
        const name = p.split(/[\\/]/).pop() ?? p
        errors.push(`${name}：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    await reload()
    setNotice(
      errors.length > 0
        ? t('ins.installedModsPartial', { ok, fail: errors.length, errors: errors.join('；') })
        : t('ins.installedMods', { n: ok })
    )
  }

  const onResDrop = async (e: DragEvent<HTMLDivElement>, kind: 'resourcepacks' | 'shaderpacks'): Promise<void> => {
    e.preventDefault()
    setResDragOver(false)
    const paths = Array.from(e.dataTransfer.files ?? [])
      .map((f) => window.api.shell.getPathForFile(f))
      .filter(Boolean)
    if (paths.length > 0) await installLocalResources(paths, kind)
  }

  const searchMods = async (): Promise<void> => {
    if (!query.trim()) return
    setSearching(true)
    setNotice(null)
    try {
      setResults((await window.api.mods.search(query, 'mod', undefined, mcSel.trim() || undefined, loaderSel)).hits)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setSearching(false)
    }
  }

  const installOnline = async (p: ModrinthProject): Promise<void> => {
    setNotice(null)
    setBusyId(p.slug)
    try {
      const versions = await window.api.mods.versions(p.slug, [loaderSel], [mcSel], p.source, 'mod')
      const v = versions[0]
      if (!v) {
        setNotice(t('ins.noMatchingVersion', { target: `${mcSel} + ${loaderSel}` }))
        return
      }
      const file = v.files.find((f) => f.primary) ?? v.files[0]
      if (!file) return
      // 与资源下载页一致：装到实例前先检查必需前置，缺失则弹窗征求是否一并下载。
      const missing = await findMissingDependencies(v, { id: versionId, mcVersion, loader: loader ?? null }, 'mod')
      if (missing.length > 0) {
        pendingInstallRef.current = { url: file.url, filename: file.filename, title: p.title, version: v.version_number }
        setDepPrompt(missing)
        return
      }
      await window.api.mods.install(file.url, file.filename, versionId, 'mod')
      setNotice(t('ins.installed', { name: p.title, version: v.version_number }))
      setResults([])
      setQuery('')
      await reload()
    } catch (err) {
      setNotice(formatInstallError(err instanceof Error ? err.message : String(err), t))
    } finally {
      setBusyId(null)
    }
  }

  /** 用户确认后：并发安装所有缺失前置与本体（各写各自独立的文件，无写冲突）。 */
  const installPendingWithDependencies = async (): Promise<void> => {
    const main = pendingInstallRef.current
    const missing = depPrompt
    setDepPrompt(null)
    if (!main || !missing) return
    setDepBusy(true)
    try {
      const jobs: Array<Promise<unknown>> = []
      for (const m of missing) {
        const f = m.version.files.find((x) => x.primary) ?? m.version.files[0]
        if (f) jobs.push(window.api.mods.install(f.url, f.filename, versionId, 'mod'))
      }
      jobs.push(window.api.mods.install(main.url, main.filename, versionId, 'mod'))
      await Promise.all(jobs)
      setNotice(t('ins.installed', { name: main.title, version: main.version }))
      setResults([])
      setQuery('')
      await reload()
    } catch (err) {
      setNotice(formatInstallError(err instanceof Error ? err.message : String(err), t))
    } finally {
      setDepBusy(false)
      pendingInstallRef.current = null
    }
  }

  /** 光影 / 资源包在线安装面板的收尾：失败只提示，成功再刷新列表 */
  const handleInstalled = (message: string, ok: boolean): void => {
    setNotice(message)
    if (ok) void reload()
  }

  return (
    <div className="flex h-full flex-col gap-5">
      <InstanceHeader
        versionId={versionId}
        disabled={disabled}
        loader={loader}
        onBack={onBack}
        onLaunch={() => doLaunch()}
      />

      <div className="shrink-0">
        <Segmented value={tab} onChange={(v) => setTab(v)} options={tabOptions} />
      </div>

      {/* 资源分栏：全部 / 已启用 / 已禁用 / 可更新（已启用、已禁用仅对模组有意义） */}
      {(tab === 'mods' || tab === 'resourcepacks' || tab === 'shaders') && (
        <>
          <ResourceFilterBar
            resFilter={resFilter}
            onResFilterChange={setResFilter}
            filterOptions={filterOptions}
            checking={resourceSnapshot?.scope === resourceScope && checking}
            checkedCount={resourceSnapshot?.scope === resourceScope ? checkedCount : 0}
            onRecheck={() => {
              // 批量更新期间重扫会清空可更新列表，正在跑的项就失去了进度与目标。
              if (batch) return
              if (currentResourceSnapshot.current?.scope !== resourceScope) void reload()
              else {
                ++resourceCheckRequest.current
                setUpdates({})
                setCheckToken((n) => n + 1)
              }
            }}
            updatableCount={updatableCount}
            selectedCount={selectedCount}
            allSelected={allSelected}
            batch={batch}
            onToggleAll={toggleSelectAll}
            onUpdateSelected={() => void applyUpdates(selectedUpdates.map(updateTarget))}
            onUpdateAll={() => void applyUpdates(tabUpdates.map(updateTarget))}
          />
          {checkError?.scope === resourceScope && (
            <div role="alert" className="caption rounded-xl px-3 py-2" style={{ background: 'var(--fill-secondary)' }}>
              {t('ins.checkUpdatesFailed', { msg: checkError.message })}
            </div>
          )}
        </>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {tab === 'version' && (
          <VersionPanel
            versionId={versionId}
            mcVersion={mcVersion}
            loader={loader}
            dirId={targetDirId}
            onLoaderInstalled={() => {
              /*
               * 就地安装：实例本身没变（id / 目录 / 存档都不动），
               * 只要重新读一次元数据 —— loader 从 null 变为非 null，
               * 装配入口自动消失，模组 / 光影等页签随之出现。
               */
              setNotice(t('ins.loader.done', { name: versionId }))
              void reload()
            }}
            disabled={disabled}
            deleting={deleting}
            renaming={renaming}
            renameValue={renameValue}
            renameError={renameError}
            onRenameValueChange={setRenameValue}
            onRename={doRename}
            onToggleDisabled={toggleDisabled}
            onLaunch={() => doLaunch()}
            onExport={() => setExportOpen(true)}
            onDeleteRequest={() => setDeleteConfirm(true)}
          />
        )}

        {tab === 'mods' && (
          <ModsPanel
            mods={mods}
            loadingMods={loadingMods}
            visibleMods={visibleMods}
            updates={scopedUpdates}
            busyId={busyId}
            resFilter={resFilter}
            query={query}
            onQueryChange={setQuery}
            onSearch={searchMods}
            searching={searching}
            results={results}
            mcSel={mcSel}
            onMcSelChange={setMcSel}
            loaderSel={loaderSel}
            onLoaderSelChange={setLoaderSel}
            dragOver={dragOver}
            setDragOver={setDragOver}
            onDrop={onDrop}
            onInstallLocals={installLocals}
            onInstallOnline={installOnline}
            onToggleMod={toggleMod}
            onDeleteMod={deleteMod}
            onApplyUpdate={applyUpdate}
            onOpenDetail={setModDetail}
            selectable={resFilter === 'updatable'}
            selected={selected}
            batchBusy={batch !== null}
            onToggleSelect={toggleSelect}
          />
        )}

        {tab === 'saves' && (
          <SavesPanel
            versionId={versionId}
            worlds={worlds}
            onLaunchWorld={(w) => doLaunch({ world: w })}
            onReload={reload}
          />
        )}

        {tab === 'resourcepacks' && (
          <ResourcesPanel
            variant="resourcepack"
            versionId={versionId}
            mcVersion={mcSel}
            onMcVersionChange={setMcSel}
            shaderLoader={shaderLoader}
            onShaderLoaderChange={setShaderLoader}
            dragOver={resDragOver}
            setDragOver={setResDragOver}
            onResDrop={onResDrop}
            items={resourcePacks}
            visibleItems={visiblePacks}
            updates={scopedUpdates}
            busyId={busyId}
            onApplyUpdate={applyUpdate}
            onReload={reload}
            onInstalled={handleInstalled}
            onInstallLocal={installLocalResources}
            selectable={resFilter === 'updatable'}
            selected={selected}
            batchBusy={batch !== null}
            onToggleSelect={toggleSelect}
          />
        )}

        {tab === 'shaders' && (
          <ResourcesPanel
            variant="shader"
            versionId={versionId}
            mcVersion={mcSel}
            onMcVersionChange={setMcSel}
            shaderLoader={shaderLoader}
            onShaderLoaderChange={setShaderLoader}
            dragOver={resDragOver}
            setDragOver={setResDragOver}
            onResDrop={onResDrop}
            items={shaders}
            visibleItems={visibleShaders}
            updates={scopedUpdates}
            busyId={busyId}
            onApplyUpdate={applyUpdate}
            onReload={reload}
            onInstalled={handleInstalled}
            onInstallLocal={installLocalResources}
            selectable={resFilter === 'updatable'}
            selected={selected}
            batchBusy={batch !== null}
            onToggleSelect={toggleSelect}
          />
        )}

        {tab === 'schematics' && (
          <SchematicsPanel versionId={versionId} schematics={schematics} onReload={reload} />
        )}
      </div>

      {notice && (
        <div className="shrink-0 rounded-xl px-3 py-2 text-[13px]" style={{ background: 'var(--fill-secondary)' }}>
          {notice}
        </div>
      )}

      {/* 在线安装缺前置确认：列出缺失的必需前置，由用户决定是否一并下载。 */}
      {depPrompt && (
        <DependencyPromptDialog
          targetLabel={versionId}
          missing={depPrompt}
          busy={depBusy}
          onCancel={() => {
            if (depBusy) return
            setDepPrompt(null)
            pendingInstallRef.current = null
          }}
          onConfirm={() => void installPendingWithDependencies()}
        />
      )}

      {/* 删除实例的二次确认：删除后不可恢复 */}
      <DeleteConfirmDialog
        open={deleteConfirm}
        versionId={versionId}
        onCancel={() => setDeleteConfirm(false)}
        onConfirm={() => void doDeleteVersion()}
      />

      {/* 导出弹窗与模组详情各自独立一个 AnimatePresence。
          注意：AnimatePresence 要求每个「直接子节点」有唯一 key；把多个条件子节点塞进
          同一个 AnimatePresence 时，退场元素可能无法被正确识别 / 卸载，于是残留一层
          已经淡出（opacity: 0）却仍铺满全屏的遮罩，挡住所有点击 —— 表现就是「关掉
          导出弹窗后界面卡死」。拆开并显式补 key 即可稳定卸载。 */}
      <AnimatePresence>
        {exportOpen && <ExportPage key="modpack-export" versionId={versionId} onClose={() => setExportOpen(false)} />}
      </AnimatePresence>

      <AnimatePresence>
        {modDetail && (
          <ModDetailSheet
            key="mod-detail"
            mod={mods.find((m) => m.path === modDetail.path) ?? modDetail}
            onClose={() => setModDetail(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
