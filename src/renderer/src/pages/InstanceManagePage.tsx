import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react'
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
  /** 资源包 / 光影页的拖拽高亮（与模组页的 dragOver 分开，避免跨分栏串扰）。 */
  const [resDragOver, setResDragOver] = useState(false)
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
        <ResourceFilterBar
          resFilter={resFilter}
          onResFilterChange={setResFilter}
          filterOptions={filterOptions}
          checking={checking}
          checkedCount={checkedCount}
          onRecheck={() => setCheckToken((n) => n + 1)}
        />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {tab === 'version' && (
          <VersionPanel
            versionId={versionId}
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
            updates={updates}
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
            updates={updates}
            busyId={busyId}
            onApplyUpdate={applyUpdate}
            onReload={reload}
            onInstalled={handleInstalled}
            onInstallLocal={installLocalResources}
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
            updates={updates}
            busyId={busyId}
            onApplyUpdate={applyUpdate}
            onReload={reload}
            onInstalled={handleInstalled}
            onInstallLocal={installLocalResources}
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
