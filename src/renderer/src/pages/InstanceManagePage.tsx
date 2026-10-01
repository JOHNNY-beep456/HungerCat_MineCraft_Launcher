import { useCallback, useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type {
  ModEntry,
  ModrinthProject,
  ModrinthVersion,
  ResourceFile,
  ResourceUpdateInfo,
  SchematicEntry
} from '@shared/types'
import { activeGameDir, useApp } from '../store'
import { useRuntimeActions } from '../runtime'
import { Button, Icon, LoadingState, Segmented, Spinner } from '../components/ui'
import { ExportPage } from './ExportPage'

type Tab = 'mods' | 'saves' | 'resourcepacks' | 'shaders' | 'schematics' | 'version'

/**
 * 资源列表的分栏筛选。
 * 「已启用 / 已禁用」只有模组有这种语义（靠 .disabled 改名实现），资源包 / 光影只有「全部 / 可更新」。
 */
type ResFilter = 'all' | 'enabled' | 'disabled' | 'updatable'

/**
 * 在线安装面板：光影 / 资源包共用。
 *
 * 模组页保留它原有的内联实现（那套还带拖拽导入和详情弹窗），这里只做「搜索 → 选最新匹配版本 →
 * 下载到当前实例」：目标目录由主进程按 type 决定（shaderpacks / resourcepacks），隔离设置也在主进程处理。
 * 本地模式下调用方根本不渲染本面板，所以这里不再单独做联网判断。
 */
function OnlineInstaller({
  type,
  versionId,
  mcVersion,
  onMcVersionChange,
  loaders = [],
  loader = '',
  onLoaderChange,
  onDone
}: {
  type: 'shader' | 'resourcepack'
  versionId: string
  mcVersion: string
  onMcVersionChange: (v: string) => void
  /** 可选的运行时筛选：光影是 iris / optifine；资源包没有加载器，留空 */
  loaders?: Array<{ value: string; label: string }>
  loader?: string
  onLoaderChange?: (v: string) => void
  /** 收尾回调：ok 为真表示装好了，调用方应刷新列表 */
  onDone: (message: string, ok: boolean) => void
}): JSX.Element {
  const { t } = useApp()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ModrinthProject[]>([])
  const [searching, setSearching] = useState(false)
  const [busySlug, setBusySlug] = useState<string | null>(null)

  const doSearch = async (): Promise<void> => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    try {
      const r = await window.api.mods.search(
        q,
        type,
        undefined,
        mcVersion.trim() || undefined,
        loaders.length > 0 ? loader : undefined
      )
      setResults(r.hits)
    } catch (err) {
      setResults([])
      onDone(err instanceof Error ? err.message : String(err), false)
    } finally {
      setSearching(false)
    }
  }

  const install = async (p: ModrinthProject): Promise<void> => {
    setBusySlug(p.slug)
    try {
      const mc = mcVersion.trim()
      const versions = await window.api.mods.versions(
        p.slug,
        loaders.length > 0 ? [loader] : [],
        mc ? [mc] : [],
        p.source,
        type
      )
      const v = versions[0]
      if (!v) {
        const target = `${mc || t('ins.currentVersion')}${loaders.length > 0 ? ` + ${loader}` : ''}`
        onDone(t('ins.noMatchingVersion', { target }), false)
        return
      }
      const file = v.files.find((f) => f.primary) ?? v.files[0]
      if (!file) {
        onDone(t('ins.noDownloadableFile'), false)
        return
      }
      await window.api.mods.install(file.url, file.filename, versionId, type)
      setResults([])
      setQuery('')
      onDone(t('ins.installed', { name: p.title, version: v.version_number }), true)
    } catch (err) {
      onDone(err instanceof Error ? err.message : String(err), false)
    } finally {
      setBusySlug(null)
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="headline">{t('ins.onlineInstall')}</span>
        <span className="caption">
          {t('ins.matching', {
            target: `${mcVersion || t('ins.currentVersion')}${loaders.length > 0 ? ` + ${loader}` : ''}`
          })}
        </span>
      </div>
      <div className="mb-2 flex gap-2">
        <div className="relative flex-1">
          <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 opacity-50" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void doSearch()}
            placeholder={type === 'shader' ? t('ins.searchShadersPlaceholder') : t('ins.searchResourcepacksPlaceholder')}
            className="input w-full pl-9"
          />
        </div>
        <Button variant="primary" icon="search" disabled={searching} onClick={() => void doSearch()}>
          {t('ins.search')}
        </Button>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="caption">{t('ins.version')}</span>
        <input value={mcVersion} onChange={(e) => onMcVersionChange(e.target.value)} className="input w-28" />
        {loaders.length > 0 && (
          <>
            <span className="caption ml-2">{t('ins.loader')}</span>
            <Segmented value={loader} onChange={(v) => onLoaderChange?.(v)} options={loaders} />
          </>
        )}
      </div>
      {searching ? (
        <LoadingState text={t('ins.searching')} />
      ) : (
        results.length > 0 && (
          <div className="space-y-1.5">
            {results.map((p) => (
              <button
                key={p.slug}
                onClick={() => void install(p)}
                disabled={busySlug === p.slug}
                className="glass-soft flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left no-drag"
              >
                {p.icon_url ? (
                  <img src={p.icon_url} width={28} height={28} alt="" className="rounded-lg" />
                ) : (
                  <Icon name="image" size={18} className="opacity-50" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{p.title}</span>
                  <span className="caption block truncate">{p.description}</span>
                </span>
                {busySlug === p.slug && <Spinner size={16} />}
              </button>
            ))}
          </div>
        )
      )}
    </div>
  )
}

export function InstanceManagePage({
  versionId,
  onBack,
  onRename
}: {
  versionId: string
  onBack: () => void
  onRename: (newId: string) => void
}): JSX.Element {
  const { settings, selectedAccount, updateSettings, reloadSettings, openFileManager, t } = useApp()
  const { launch } = useRuntimeActions()

  const [tab, setTab] = useState<Tab>('mods')
  const [loader, setLoader] = useState<string | null | undefined>(undefined)
  const [mods, setMods] = useState<ModEntry[]>([])
  const [loadingMods, setLoadingMods] = useState(true)
  const [worlds, setWorlds] = useState<string[]>([])
  const [resourcePacks, setResourcePacks] = useState<ResourceFile[]>([])
  const [shaders, setShaders] = useState<ResourceFile[]>([])
  const [schematics, setSchematics] = useState<SchematicEntry[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(versionId)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [modDetail, setModDetail] = useState<ModEntry | null>(null)

  // 资源更新检测（进入实例管理时后台进行，逐个推送结果）
  const [resFilter, setResFilter] = useState<ResFilter>('all')
  /** path → 可更新信息；只放「确认可更新」的条目，界面据此显示更新按钮。 */
  const [updates, setUpdates] = useState<Record<string, ResourceUpdateInfo>>({})
  /** 已判定完的 path（含判定为无更新的），用于展示检测进度。 */
  const [checkedCount, setCheckedCount] = useState(0)
  const [checking, setChecking] = useState(false)
  /** 自增即可重跑一次检测 */
  const [checkToken, setCheckToken] = useState(0)

  // online mod search
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ModrinthProject[]>([])
  const [searching, setSearching] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [loaderSel, setLoaderSel] = useState<string>('fabric')
  const [mcSel, setMcSel] = useState<string>('')
  /** 光影在线搜索用的运行时筛选（Iris / OptiFine），与模组页的 loaderSel 相互独立 */
  const [shaderLoader, setShaderLoader] = useState<string>('iris')

  const isVanilla = loader === null

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
    setLoadingMods(true)
    try {
      const [modList, installed, packList, shaderList, schematicList] = await Promise.all([
        window.api.manage.mods(versionId),
        window.api.installed.list(),
        window.api.resources.list(versionId, 'resourcepacks'),
        window.api.resources.list(versionId, 'shaderpacks'),
        window.api.manage.schematics(versionId)
      ])
      setMods(modList)
      const entry = installed.find((v) => v.id === versionId)
      const entryLoader = entry?.loader ?? null
      setWorlds(entry?.worlds ?? [])
      setResourcePacks(packList)
      setShaders(shaderList)
      setSchematics(schematicList)
      setLoader(entryLoader)
      if (entryLoader) setLoaderSel((prev) => (prev === 'fabric' ? entryLoader : prev))
      if (entry?.mcVersion) setMcSel((prev) => prev || entry.mcVersion)
    } finally {
      setLoadingMods(false)
    }
  }, [versionId])

  // 订阅后台 Modrinth 补全结果：命中后以完整信息替换对应模组项
  useEffect(() => {
    return window.api.manage.onModsUpdated(({ versionId: v, mod }) => {
      if (v !== versionId) return
      setMods((prev) => prev.map((m) => (m.path === mod.path ? mod : m)))
    })
  }, [versionId])

  // 光影 / 资源包同理：主进程按文件名去 Modrinth 补齐名称 / 图标后逐个推送。
  // 本地模式与「仅获取元数据」下主进程不联网，因此不会有推送，界面继续显示本地文件名。
  useEffect(() => {
    return window.api.resources.onUpdated(({ versionId: v, kind, file }) => {
      if (v !== versionId) return
      const patch = (prev: ResourceFile[]): ResourceFile[] =>
        prev.map((p) => (p.path === file.path ? file : p))
      if (kind === 'resourcepacks') setResourcePacks(patch)
      else setShaders(patch)
    })
  }, [versionId])

  useEffect(() => {
    void reload()
  }, [reload])

  // 进入实例管理时异步检测资源更新：先清空旧结果，随后逐项推送。
  // 「仅识别元数据」/ 本地模式下不联网，主进程直接返回空数组，界面也就不显示检测条。
  useEffect(() => {
    if (settings.mode === 'local' || settings.metadataOnlyMods) {
      setUpdates({})
      setCheckedCount(0)
      setChecking(false)
      return
    }
    let alive = true
    setUpdates({})
    setCheckedCount(0)
    setChecking(true)
    const off = window.api.resources.onUpdateChecked((e) => {
      if (!alive || e.versionId !== versionId) return
      setCheckedCount((n) => n + 1)
      if (e.update) setUpdates((prev) => (prev[e.path] ? prev : { ...prev, [e.path]: e.update as ResourceUpdateInfo }))
    })
    void window.api.resources
      .checkUpdates(versionId)
      .then((list) => {
        if (!alive) return
        const map: Record<string, ResourceUpdateInfo> = {}
        for (const u of list) map[u.path] = u
        setUpdates(map)
      })
      .catch(() => {
        /* 检测失败（离线等）不打扰用户，只是没有更新提示 */
      })
      .finally(() => {
        if (alive) setChecking(false)
      })
    return () => {
      alive = false
      off()
    }
  }, [versionId, checkToken, settings.mode, settings.metadataOnlyMods])

  const updatableCount = Object.keys(updates).length

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
      if (resFilter === 'updatable') return !!updates[path]
      if (resFilter === 'enabled') return enabled
      if (resFilter === 'disabled') return !enabled
      return true
    },
    [resFilter, updates]
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

  /** 直接把某个资源更新到最新版：下载新版 → 删除旧文件，随后刷新列表。 */
  const applyUpdate = async (up: ResourceUpdateInfo, enabled: boolean): Promise<void> => {
    setBusyId(up.path)
    setNotice(null)
    try {
      await window.api.resources.applyUpdate(versionId, up, enabled)
      setNotice(t('ins.updateDone', { name: up.title || up.filename, version: up.latestVersion }))
      setUpdates((prev) => {
        if (!prev[up.path]) return prev
        const next = { ...prev }
        delete next[up.path]
        return next
      })
      await reload()
    } catch (err) {
      setNotice(t('ins.updateFailed', { msg: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusyId(null)
    }
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
    void launch({
      versionId,
      accountId: selectedAccount.id,
      gameDir: activeGameDir(settings),
      memoryMb: settings.memoryMb,
      javaPath: settings.javaPath || undefined,
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
      await window.api.mods.install(file.url, file.filename, versionId, 'mod')
      setNotice(t('ins.installed', { name: p.title, version: v.version_number }))
      setResults([])
      setQuery('')
      await reload()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  /** 光影 / 资源包在线安装面板的收尾：失败只提示，成功再刷新列表 */
  const handleInstalled = (message: string, ok: boolean): void => {
    setNotice(message)
    if (ok) void reload()
  }

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-center gap-3">
        <Button size="sm" icon="chevronLeft" onClick={onBack}>
          {t('ins.back')}
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="display truncate">{t('ins.manageTitle')}</h1>
          <p className="caption mt-1 selectable truncate">
            {versionId}
            {disabled ? t('ins.disabledSuffix') : ''}
            {loader ? ` · ${loaderLabel(loader)}` : ''}
          </p>
        </div>
        <Button size="sm" icon="play" disabled={!selectedAccount || disabled} onClick={() => doLaunch()}>
          {t('ins.launch')}
        </Button>
      </div>

      <div className="shrink-0">
        <Segmented value={tab} onChange={(v) => setTab(v)} options={tabOptions} />
      </div>

      {/* 资源分栏：全部 / 已启用 / 已禁用 / 可更新（已启用、已禁用仅对模组有意义） */}
      {(tab === 'mods' || tab === 'resourcepacks' || tab === 'shaders') && (
        <div className="glass-soft flex flex-wrap items-center gap-2 rounded-2xl px-3 py-2">
          <Segmented value={resFilter} onChange={setResFilter} options={filterOptions} />
          <span className="ml-auto flex items-center gap-2">
            {checking ? (
              <>
                <Spinner size={14} />
                <span className="caption">{t('ins.checkingUpdates', { n: checkedCount })}</span>
              </>
            ) : (
              <Button size="sm" icon="refresh" onClick={() => setCheckToken((n) => n + 1)}>
                {t('ins.checkUpdates')}
              </Button>
            )}
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {tab === 'version' && (
          <div className="space-y-3">
            <div className="glass-soft rounded-2xl p-4">
              <div className="text-[14px] font-medium">{t('ins.renameVersion')}</div>
              <div className="caption mt-0.5">{t('ins.renameVersionDesc')}</div>
              <div className="mt-3 flex gap-2">
                <input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === 'Enter' &&
                    !renaming &&
                    renameValue.trim() &&
                    renameValue.trim() !== versionId &&
                    void doRename()
                  }
                  placeholder={t('ins.newInstanceNamePlaceholder')}
                  className="input flex-1"
                  disabled={renaming}
                />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={renaming || !renameValue.trim() || renameValue.trim() === versionId}
                  onClick={() => void doRename()}
                >
                  {renaming ? t('ins.renaming') : t('ins.rename')}
                </Button>
              </div>
              {renameError && (
                <div className="mt-2 text-[12px]" style={{ color: 'var(--fill-danger)' }}>
                  {renameError}
                </div>
              )}
            </div>
            <Row label={t('ins.disableVersion')} desc={t('ins.disableVersionDesc')}>
              <Button size="sm" variant={disabled ? 'primary' : 'secondary'} onClick={() => void toggleDisabled()}>
                {disabled ? t('ins.enable') : t('ins.disable')}
              </Button>
            </Row>
            <Row label={t('ins.launchGame')}>
              <Button size="sm" variant="primary" icon="play" disabled={!selectedAccount || disabled} onClick={() => doLaunch()}>
                {t('ins.launch')}
              </Button>
            </Row>
            <Row label={t('ins.openVersionDir')}>
              <Button
                size="sm"
                icon="folder"
                onClick={() => void window.api.manage.openDir(versionId, 'version').then(openFileManager)}
              >
                {t('ins.open')}
              </Button>
            </Row>
            <Row label={t('ins.exportModpack')} desc={t('ins.exportModpackDesc')}>
              <Button size="sm" icon="box" onClick={() => setExportOpen(true)}>
                {t('ins.exportModpack')}
              </Button>
            </Row>
            <Row label={t('ins.deleteVersion')} desc={t('ins.deleteVersionDesc')}>
              <Button size="sm" variant="danger" icon="trash" disabled={deleting} onClick={() => void doDeleteVersion()}>
                {deleting ? t('ins.deleting') : t('ins.delete')}
              </Button>
            </Row>
          </div>
        )}

        {tab === 'mods' && (
          <div className="space-y-4">
            <div
              className={`rounded-2xl border-2 border-dashed p-5 text-center transition-colors ${dragOver ? 'opacity-80' : ''}`}
              style={{ borderColor: dragOver ? 'var(--fill-primary)' : 'var(--divider)' }}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => void onDrop(e)}
            >
              <Icon name="download" size={22} className="mx-auto mb-1 opacity-60" />
              <p className="text-[13px] opacity-80">{t('ins.dropModFiles')}</p>
              <Button
                size="sm"
                icon="folder"
                className="mt-2"
                onClick={async () => {
                  const paths = await window.api.shell.pickFiles([{ name: t('ins.filterMods'), extensions: ['jar', 'zip'] }])
                  if (paths.length > 0) await installLocals(paths)
                }}
              >
                {t('ins.selectLocalFiles')}
              </Button>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="headline">{t('ins.installedModsCount', { n: mods.length })}</span>
                <span className="caption">{t('ins.toggleHint')}</span>
              </div>
              {loadingMods ? (
                <div className="flex items-center justify-center gap-2 py-4">
                  <Spinner size={22} />
                  <span className="caption opacity-60">{t('ins.loadingMods')}</span>
                </div>
              ) : mods.length === 0 ? (
                <div className="caption py-4 text-center opacity-60">{t('ins.noMods')}</div>
              ) : visibleMods.length === 0 ? (
                <div className="caption py-4 text-center opacity-60">
                  {resFilter === 'updatable' ? t('ins.noUpdatable') : t('ins.noMods')}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {visibleMods.map((m) => {
                    const up = updates[m.path]
                    return (
                      <div key={m.path} className="glass-soft flex items-center gap-2 rounded-xl px-3 py-2">
                        {m.iconUrl ? (
                          <img
                            src={m.iconUrl}
                            width={28}
                            height={28}
                            alt=""
                            draggable={false}
                            className={`shrink-0 rounded-lg object-cover ${m.enabled ? '' : 'opacity-30'}`}
                          />
                        ) : (
                          <Icon name="box" size={15} className={m.enabled ? '' : 'opacity-30'} />
                        )}
                        <button
                          type="button"
                          onClick={() => setModDetail(m)}
                          className="min-w-0 flex-1 text-left no-drag"
                        >
                          {m.displayName ? (
                            <>
                              <div className={`truncate text-[13px] font-medium leading-tight ${m.enabled ? '' : 'opacity-40 line-through'}`}>
                                {m.displayName}
                              </div>
                              <div className={`caption truncate leading-tight ${m.enabled ? '' : 'opacity-40'}`}>{m.name}</div>
                            </>
                          ) : (
                            <div className={`truncate text-[13px] leading-tight ${m.enabled ? '' : 'opacity-40 line-through'}`}>{m.name}</div>
                          )}
                        </button>
                        {up && (
                          <span className="caption shrink-0" title={`${up.title} · ${up.slug}`}>
                            {up.currentVersion
                              ? `${up.currentVersion} → ${up.latestVersion}`
                              : t('ins.updateTo', { version: up.latestVersion })}
                          </span>
                        )}
                        <span className="caption">{formatBytes(m.size)}</span>
                        {up && (
                          <button
                            onClick={() => void applyUpdate(up, m.enabled)}
                            disabled={busyId === m.path}
                            className="mica no-drag shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium"
                            style={{ color: 'var(--fill-primary)' }}
                          >
                            {busyId === m.path ? t('ins.updating') : t('ins.update')}
                          </button>
                        )}
                        <button
                          onClick={() => void toggleMod(m)}
                          disabled={busyId === m.path}
                          className="mica no-drag rounded-lg px-2 py-1 text-[12px] font-medium"
                          style={{ opacity: m.enabled ? 1 : 0.7 }}
                        >
                          {busyId === m.path ? '…' : m.enabled ? t('ins.disable') : t('ins.enable')}
                        </button>
                        <button onClick={() => void deleteMod(m)} className="no-drag opacity-50 hover:opacity-100">
                          <Icon name="trash" size={15} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {settings.mode !== 'local' && (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="headline">{t('ins.onlineInstall')}</span>
                <span className="caption">{t('ins.matching', { target: `${mcSel} + ${loaderSel}` })}</span>
              </div>
              <div className="mb-2 flex gap-2">
                <div className="relative flex-1">
                  <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 opacity-50" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void searchMods()}
                    placeholder={t('ins.searchModsPlaceholder')}
                    className="input w-full pl-9"
                  />
                </div>
                <Button variant="primary" icon="search" disabled={searching} onClick={() => void searchMods()}>
                  {t('ins.search')}
                </Button>
              </div>
              <div className="mb-2 flex items-center gap-2">
                <span className="caption">{t('ins.version')}</span>
                <input value={mcSel} onChange={(e) => setMcSel(e.target.value)} className="input w-28" />
                <span className="caption ml-2">{t('ins.loader')}</span>
                <Segmented
                  value={loaderSel}
                  onChange={setLoaderSel}
                  options={[
                    { value: 'fabric', label: 'Fabric' },
                    { value: 'quilt', label: 'Quilt' },
                    { value: 'forge', label: 'Forge' },
                    { value: 'neoforge', label: 'NeoForge' }
                  ]}
                />
              </div>
              {searching ? (
                <LoadingState text={t('ins.searching')} />
              ) : (
                results.length > 0 && (
                  <div className="space-y-1.5">
                    {results.map((p) => (
                      <button
                        key={p.slug}
                        onClick={() => void installOnline(p)}
                        disabled={busyId === p.slug}
                        className="glass-soft flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left no-drag"
                      >
                        {p.icon_url ? (
                          <img src={p.icon_url} width={28} height={28} alt="" className="rounded-lg" />
                        ) : (
                          <Icon name="box" size={18} className="opacity-50" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{p.title}</span>
                        {busyId === p.slug && <Spinner size={16} />}
                      </button>
                    ))}
                  </div>
                )
              )}
            </div>
            )}
          </div>
        )}

        {tab === 'saves' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="headline">{t('ins.savesCount', { n: worlds.length })}</span>
              <Button size="sm" icon="folder" onClick={() => void window.api.manage.openDir(versionId, 'saves').then(openFileManager)}>
                {t('ins.openDir')}
              </Button>
            </div>
            {worlds.length === 0 ? (
              <div className="caption py-4 text-center opacity-60">{t('ins.noSaves')}</div>
            ) : (
              worlds.map((w) => (
                <div key={w} className="glass-soft flex items-center gap-2 rounded-xl px-3 py-2">
                  <Icon name="home" size={15} className="opacity-60" />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{versionId} - {w}</span>
                  <Button size="sm" icon="play" disabled={!selectedAccount} onClick={() => doLaunch({ world: w })}>
                    {t('ins.launch')}
                  </Button>
                  <button
                    onClick={async () => {
                      await window.api.manage.deleteWorld(versionId, w)
                      void reload()
                    }}
                    className="no-drag opacity-50 hover:opacity-100"
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'resourcepacks' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="headline">{t('ins.resourcepacksCount', { n: resourcePacks.length })}</span>
              <Button
                size="sm"
                icon="folder"
                onClick={() => void window.api.resources.open(versionId, 'resourcepacks').then(openFileManager)}
              >
                {t('ins.openDir')}
              </Button>
            </div>
            {resourcePacks.length === 0 ? (
              <div className="caption py-4 text-center opacity-60">{t('ins.noResourcepacks')}</div>
            ) : visiblePacks.length === 0 ? (
              <div className="caption py-4 text-center opacity-60">{t('ins.noUpdatable')}</div>
            ) : (
              visiblePacks.map((p) => {
                const up = updates[p.path]
                return (
                  <div key={p.path} className="glass-soft flex items-center gap-2 rounded-xl px-3 py-2">
                    {p.iconUrl ? (
                      <img
                        src={p.iconUrl}
                        width={28}
                        height={28}
                        alt=""
                        draggable={false}
                        className="shrink-0 rounded-lg object-cover"
                      />
                    ) : (
                      <Icon name="image" size={15} className="shrink-0 opacity-60" />
                    )}
                    <div className="min-w-0 flex-1" title={p.description ?? p.name}>
                      <div className="truncate text-[13px] font-medium leading-tight">{p.displayName ?? p.name}</div>
                      {p.displayName && <div className="caption truncate leading-tight">{p.name}</div>}
                    </div>
                    {up && (
                      <span className="caption shrink-0" title={`${up.title} · ${up.slug}`}>
                        {up.currentVersion
                          ? `${up.currentVersion} → ${up.latestVersion}`
                          : t('ins.updateTo', { version: up.latestVersion })}
                      </span>
                    )}
                    <span className="caption">{formatBytes(p.size)}</span>
                    {up && (
                      <button
                        onClick={() => void applyUpdate(up, true)}
                        disabled={busyId === p.path}
                        className="mica no-drag shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium"
                        style={{ color: 'var(--fill-primary)' }}
                      >
                        {busyId === p.path ? t('ins.updating') : t('ins.update')}
                      </button>
                    )}
                    {p.slug && (
                      <button
                        type="button"
                        title={t('ins.openModrinthTitle')}
                        onClick={() =>
                          void window.api.shell.openExternal(
                            p.pageUrl ?? `https://modrinth.com/resourcepack/${p.slug}`
                          )
                        }
                        className="no-drag opacity-50 hover:opacity-100"
                      >
                        <Icon name="link" size={15} />
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        await window.api.resources.remove(p.path)
                        void reload()
                      }}
                      className="no-drag opacity-50 hover:opacity-100"
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                )
              })
            )}

            {settings.mode !== 'local' && (
              <OnlineInstaller
                type="resourcepack"
                versionId={versionId}
                mcVersion={mcSel}
                onMcVersionChange={setMcSel}
                onDone={handleInstalled}
              />
            )}
          </div>
        )}

        {tab === 'shaders' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="headline">{t('ins.shadersCount', { n: shaders.length })}</span>
              <Button size="sm" icon="folder" onClick={() => void window.api.manage.openDir(versionId, 'shaderpacks').then(openFileManager)}>
                {t('ins.openDir')}
              </Button>
            </div>
            {shaders.length === 0 ? (
              <div className="caption py-4 text-center opacity-60">{t('ins.noShaders')}</div>
            ) : visibleShaders.length === 0 ? (
              <div className="caption py-4 text-center opacity-60">{t('ins.noUpdatable')}</div>
            ) : (
              visibleShaders.map((s) => {
                const up = updates[s.path]
                return (
                  <div key={s.path} className="glass-soft flex items-center gap-2 rounded-xl px-3 py-2">
                    {s.iconUrl ? (
                      <img
                        src={s.iconUrl}
                        width={28}
                        height={28}
                        alt=""
                        draggable={false}
                        className="shrink-0 rounded-lg object-cover"
                      />
                    ) : (
                      <Icon name="palette" size={15} className="shrink-0 opacity-60" />
                    )}
                    <div className="min-w-0 flex-1" title={s.description ?? s.name}>
                      <div className="truncate text-[13px] font-medium leading-tight">{s.displayName ?? s.name}</div>
                      {s.displayName && <div className="caption truncate leading-tight">{s.name}</div>}
                    </div>
                    {up && (
                      <span className="caption shrink-0" title={`${up.title} · ${up.slug}`}>
                        {up.currentVersion
                          ? `${up.currentVersion} → ${up.latestVersion}`
                          : t('ins.updateTo', { version: up.latestVersion })}
                      </span>
                    )}
                    <span className="caption">{formatBytes(s.size)}</span>
                    {up && (
                      <button
                        onClick={() => void applyUpdate(up, true)}
                        disabled={busyId === s.path}
                        className="mica no-drag shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium"
                        style={{ color: 'var(--fill-primary)' }}
                      >
                        {busyId === s.path ? t('ins.updating') : t('ins.update')}
                      </button>
                    )}
                    {s.slug && (
                      <button
                        type="button"
                        title={t('ins.openModrinthTitle')}
                        onClick={() =>
                          void window.api.shell.openExternal(
                            s.pageUrl ?? `https://modrinth.com/shader/${s.slug}`
                          )
                        }
                        className="no-drag opacity-50 hover:opacity-100"
                      >
                        <Icon name="link" size={15} />
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        await window.api.manage.deleteFile(s.path)
                        void reload()
                      }}
                      className="no-drag opacity-50 hover:opacity-100"
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                )
              })
            )}

            {settings.mode !== 'local' && (
              <OnlineInstaller
                type="shader"
                versionId={versionId}
                mcVersion={mcSel}
                onMcVersionChange={setMcSel}
                loaders={[
                  { value: 'iris', label: 'Iris' },
                  { value: 'optifine', label: 'OptiFine' }
                ]}
                loader={shaderLoader}
                onLoaderChange={setShaderLoader}
                onDone={handleInstalled}
              />
            )}
          </div>
        )}

        {tab === 'schematics' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="headline">{t('ins.schematicsCount', { n: schematics.length })}</span>
              <Button size="sm" icon="folder" onClick={() => void window.api.manage.openDir(versionId, 'schematics').then(openFileManager)}>
                {t('ins.openDir')}
              </Button>
            </div>
            {schematics.length === 0 ? (
              <div className="caption py-4 text-center opacity-60">
                {t('ins.noSchematics')}
              </div>
            ) : (
              schematics.map((s) => (
                <div key={s.path} className="glass-soft flex items-center gap-2 rounded-xl px-3 py-2">
                  <Icon name="box" size={15} className="opacity-60" />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{s.name}</span>
                  <span className="caption">{formatBytes(s.size)}</span>
                  <button
                    onClick={async () => {
                      await window.api.manage.deleteFile(s.path)
                      void reload()
                    }}
                    className="no-drag opacity-50 hover:opacity-100"
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {notice && (
        <div className="shrink-0 rounded-xl px-3 py-2 text-[13px]" style={{ background: 'var(--fill-secondary)' }}>
          {notice}
        </div>
      )}

      <AnimatePresence>
        {exportOpen && <ExportPage versionId={versionId} onClose={() => setExportOpen(false)} />}
        {modDetail && (
          <ModDetailSheet
            mod={mods.find((m) => m.path === modDetail.path) ?? modDetail}
            onClose={() => setModDetail(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

function ModDetailSheet({ mod, onClose }: { mod: ModEntry; onClose: () => void }): JSX.Element {
  const { t } = useApp()
  const [versions, setVersions] = useState<ModrinthVersion[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!mod.slug) {
      setVersions([])
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    void window.api.mods
      .versions(mod.slug, [], [])
      .then((vs) => {
        if (alive) setVersions(vs)
      })
      .catch(() => {
        if (alive) setVersions([])
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [mod.slug])

  const title = mod.displayName ?? mod.name

  return (
    <motion.div
      className="fixed inset-0 z-[100] flex items-center justify-center p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        className="absolute inset-0"
        style={{ background: 'var(--scrim)' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <motion.div
        className="glass-strong relative z-10 flex max-h-[80vh] w-full max-w-lg flex-col rounded-[32px] p-7"
        initial={{ opacity: 0, scale: 0.92, y: 24 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.94, y: 16 }}
        transition={{ type: 'spring', bounce: 0.2, duration: 0.45 }}
      >
        <div className="mb-4 flex items-start gap-3">
          {mod.iconUrl ? (
            <img
              src={mod.iconUrl}
              width={52}
              height={52}
              alt=""
              draggable={false}
              className="shrink-0 rounded-xl object-cover"
              style={{ background: 'var(--fill-secondary)' }}
            />
          ) : (
            <div
              className="flex shrink-0 items-center justify-center rounded-xl"
              style={{ width: 52, height: 52, background: 'var(--fill-secondary)' }}
            >
              <Icon name="box" size={24} className="opacity-50" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="title selectable">{title}</h2>
            {mod.displayName && <p className="caption mt-0.5 truncate">{mod.name}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {mod.slug && (
              <button
                onClick={() =>
                  void window.api.shell.openExternal(mod.pageUrl ?? `https://modrinth.com/mod/${mod.slug}`)
                }
                className="mica no-drag shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium"
              >
                {t('ins.moreInfo')}
              </button>
            )}
            <button onClick={onClose} className="no-drag opacity-50 hover:opacity-100">
              <Icon name="xmark" size={20} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {mod.description && <p className="caption selectable line-clamp-4">{mod.description}</p>}

          <div className="mt-4 mb-2 flex items-center justify-between">
            <span className="headline">{t('ins.version')}</span>
            <span className="caption">{formatBytes(mod.size)}</span>
          </div>

          {!mod.slug ? (
            <div className="caption rounded-xl px-3 py-4 text-center opacity-60" style={{ background: 'var(--fill-secondary)' }}>
              {t('ins.notOnModrinth')}
            </div>
          ) : loading ? (
            <div className="flex flex-col items-center gap-2 p-6">
              <Spinner size={22} />
              <span className="caption">{t('ins.loadingVersions')}</span>
            </div>
          ) : versions.length === 0 ? (
            <div className="caption p-4 text-center opacity-60">{t('ins.noVersionInfo')}</div>
          ) : (
            <div className="space-y-1.5">
              {versions.slice(0, 30).map((v) => (
                <div key={v.id} className="glass-soft rounded-xl px-3.5 py-2.5">
                  <div className="truncate text-[13px] font-medium">{v.version_number}</div>
                  <div className="caption">
                    {v.loaders.join(' / ') || t('ins.noLoader')} · {v.game_versions.join(', ')}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}

function Row({ label, desc, children }: { label: string; desc?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="glass-soft flex items-center justify-between gap-4 rounded-2xl p-4">
      <div>
        <div className="text-[14px] font-medium">{label}</div>
        {desc && <div className="caption mt-0.5">{desc}</div>}
      </div>
      {children}
    </div>
  )
}

function loaderLabel(loader: string): string {
  return loader.charAt(0).toUpperCase() + loader.slice(1)
}

function formatBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}
