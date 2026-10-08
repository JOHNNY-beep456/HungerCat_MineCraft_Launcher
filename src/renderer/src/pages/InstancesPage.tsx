import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ConflictPolicy, ExternalVersion, InstalledVersion, MinecraftServerStatus, ModpackProbe, VersionDir } from '@shared/types'
import { activeGameDir, allVersionDirs, useApp, versionDirLabel } from '../store'
import { useAutoTranslate } from '../translate'
import type { TFunction } from '../i18n'
import { useRuntimeActions } from '../runtime'
import { Button, Icon, LoadingState, Segmented, Select, Spinner } from '../components/ui'

export function InstancesPage({ onManage }: { onManage: (versionId: string) => void }): JSX.Element {
  const { settings, selectedAccount, reloadSettings, t } = useApp()
  const { launch } = useRuntimeActions()
  const [installed, setInstalled] = useState<InstalledVersion[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [renameProbe, setRenameProbe] = useState<{ probe: ModpackProbe; filePath: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [dragOver, setDragOver] = useState(false)

  // 搜索（版本名 / 存档名 / 服务器名）与筛选（版本号 / 加载器）。
  const [query, setQuery] = useState('')
  const [filterMc, setFilterMc] = useState('all')
  const [filterLoader, setFilterLoader] = useState('all')

  // 从外部 .minecraft 导入版本：扫描状态 / 结果 / 重名策略 / 逐个导入进度
  const [extScanning, setExtScanning] = useState(false)
  const [extMsg, setExtMsg] = useState<string | null>(null)
  const [extTarget, setExtTarget] = useState<{ mcDir: string; versions: ExternalVersion[] } | null>(null)
  const [extPolicy, setExtPolicy] = useState<ConflictPolicy>('rename')
  const [extProgress, setExtProgress] = useState<{ done: number; total: number } | null>(null)

  // 版本目录（多版本列表根目录）：当前生效项决定实例列表与启动落点，可切换 / 添加 / 设别名。
  const [dirs, setDirs] = useState<VersionDir[]>([])
  const [dirsOpen, setDirsOpen] = useState(false)
  const [aliasPrompt, setAliasPrompt] = useState<{ mode: 'add' | 'edit'; id: string; path: string } | null>(null)
  const [aliasValue, setAliasValue] = useState('')

  // 直接为某个实例添加服务器（名称 + 地址）：写入该实例的 servers.dat。
  const [serverPrompt, setServerPrompt] = useState<{ versionId: string } | null>(null)
  const [serverName, setServerName] = useState('')
  const [serverAddress, setServerAddress] = useState('')
  const [serverBusy, setServerBusy] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  // 导入整合包时的目标版本目录：空串表示跟随当前生效目录。
  const [importDirId, setImportDirId] = useState('')

  const currentDirId = settings.selectedVersionDirId || 'default'

  const refresh = useCallback(async () => {
    try {
      setInstalled(await window.api.installed.list())
    } catch {
      /* installed:list 失败时保持上次列表 */
    }
  }, [])

  const refreshDirs = useCallback(async () => {
    try {
      setDirs(await window.api.versionDirs.list())
    } catch {
      /* versionDirs:list 失败时保持上次列表 */
    }
  }, [])

  /** 打开「添加服务器」弹窗：清空上次输入与错误。 */
  const openAddServer = (versionId: string): void => {
    setServerName('')
    setServerAddress('')
    setServerError(null)
    setServerBusy(false)
    setServerPrompt({ versionId })
  }

  /** 提交添加服务器：写入该实例的 servers.dat，成功后刷新列表；失败把原因留在弹窗里。 */
  const submitAddServer = (): void => {
    if (!serverPrompt) return
    const address = serverAddress.trim()
    if (!address) return
    setServerBusy(true)
    setServerError(null)
    void window.api.installed
      .addServer(serverPrompt.versionId, serverName.trim(), address)
      .then(() => {
        setServerPrompt(null)
        return refresh()
      })
      .catch((err: unknown) => setServerError(err instanceof Error ? err.message : String(err)))
      .finally(() => setServerBusy(false))
  }

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    void refreshDirs()
  }, [refreshDirs])

  // 切换版本目录：主进程持久化选中项并失效缓存，随后刷新设置与实例列表。
  // 传入 '__add__' 时走「选目录 → 输别名」的添加流程（下拉里直接可加）。
  const selectDir = async (id: string): Promise<void> => {
    if (id === '__add__') {
      const path = await window.api.shell.chooseDirectory()
      if (!path) return
      setAliasPrompt({ mode: 'add', id: '', path })
      setAliasValue('')
      return
    }
    if (id === currentDirId) return
    await window.api.versionDirs.select(id)
    await reloadSettings()
    setInstalled(null)
    await refresh()
  }

  const confirmAliasPrompt = async (): Promise<void> => {
    if (!aliasPrompt) return
    const alias = aliasValue.trim()
    if (aliasPrompt.mode === 'add') {
      const next = await window.api.versionDirs.add({ path: aliasPrompt.path, alias })
      setDirs(next)
      // 新增后自动切到该目录，省去用户再选一次
      const added = next.find((d) => d.path === aliasPrompt.path)
      if (added) {
        await window.api.versionDirs.select(added.id)
        await reloadSettings()
        setInstalled(null)
        await refresh()
      }
    } else {
      setDirs(await window.api.versionDirs.update(aliasPrompt.id, { alias }))
    }
    setAliasPrompt(null)
  }

  const removeDir = async (id: string): Promise<void> => {
    setDirs(await window.api.versionDirs.remove(id))
    await reloadSettings()
    setInstalled(null)
    await refresh()
  }

  // 下拉选项：目录路径只作为「备注」显示在名称下方（无别名时直接显示路径）。
  // 这样目录名与路径合并进同一个下拉，界面不再单独占一行显示路径。
  const dirOptions = [
    ...allVersionDirs(settings).map((d) => ({
      value: d.id,
      label: d.alias ? d.alias : d.path,
      note: d.alias ? d.path : undefined
    })),
    { value: '__add__', label: t('ins.dirAddOption') }
  ]

  useEffect(() => {
    return window.api.modpack.onProgress((p) => {
      if (p.phase === 'done') {
        setImportMsg(null)
        setImporting(false)
        void refresh()
      } else {
        setImporting(true)
        setImportMsg(p.task)
      }
    })
  }, [refresh])

  const doLaunch = (versionId: string, opts?: { world?: string; server?: string }): void => {
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

  // 导入弹窗打开时，拉取「目标版本目录」里的实例名（重名判断按目标目录，而非当前生效目录）。
  const [importDirNames, setImportDirNames] = useState<string[]>([])
  useEffect(() => {
    if (!renameProbe) return
    let alive = true
    const targetDirId = importDirId || settings.selectedVersionDirId || 'default'
    void window.api.installed
      .listAll()
      .then((all) => {
        if (alive) setImportDirNames(all.filter((i) => i.dirId === targetDirId).map((i) => i.id))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [renameProbe, importDirId, settings.selectedVersionDirId])

  const renameTaken = renameProbe !== null && renameValue.trim() !== '' && importDirNames.includes(renameValue.trim())

  // 在既有实例中取一个不重名、且不等于其 MC 版本号的实例名
  // （避免打开弹窗时默认值被占用、导入按钮置灰，或与版本号同名时静默合并进原版）。
  const uniqueInstanceName = (base: string, mcVersion?: string): string => {
    const list = installed ?? []
    const taken = (n: string): boolean => list.some((v) => v.id === n) || (!!mcVersion && mcVersion === n)
    if (!taken(base)) return base
    for (let i = 2; i < 10000; i++) {
      const cand = `${base}-${i}`
      if (!taken(cand)) return cand
    }
    return `${base}-${Date.now()}`
  }

  const beginImport = async (filePath: string): Promise<void> => {
    if (!filePath) return
    setImportMsg(null)
    try {
      const probe = await window.api.modpack.probe(filePath)
      // 总是弹出弹窗，让用户自定义实例名（默认取不重名的实例名，可再手动修改）
      setRenameProbe({ probe, filePath })
      setRenameValue(uniqueInstanceName(probe.name, probe.mcVersion))
    } catch (err) {
      setImportMsg(t('ins.importFailed', { msg: err instanceof Error ? err.message : String(err) }))
    }
  }

  const confirmImport = async (): Promise<void> => {
    if (!renameProbe) return
    const name = renameValue.trim()
    if (!name) return
    // 按目标版本目录判重（与弹窗里的提示一致）。
    if (importDirNames.includes(name)) {
      setImportMsg(t('ins.nameExistsChange', { name }))
      return
    }
    const probe = renameProbe.probe
    const filePath = renameProbe.filePath
    const targetDirId = importDirId || settings.selectedVersionDirId || 'default'
    setRenameProbe(null)
    try {
      await window.api.modpack.import(filePath, name, targetDirId)
    } catch (err) {
      setImportMsg(t('ins.importFailed', { msg: err instanceof Error ? err.message : String(err) }))
    }
  }

  const pickImport = async (): Promise<void> => {
    const p = await window.api.shell.pickFile([{ name: t('ins.filterModpack'), extensions: ['mrpack', 'zip'] }])
    if (p) await beginImport(p)
  }

  // 选择外部 .minecraft 目录并扫描可导入版本；失败 / 空目录用顶部提示条反馈。
  const beginExternalImport = async (): Promise<void> => {
    const mcDir = await window.api.shell.chooseDirectory()
    if (!mcDir) return
    setExtMsg(null)
    setExtScanning(true)
    try {
      const versions = await window.api.versions.scanExternal(mcDir)
      if (versions.length === 0) {
        setExtMsg(t('ins.external.noVersions'))
        return
      }
      setExtPolicy('rename')
      setExtTarget({ mcDir, versions })
    } catch (err) {
      setExtMsg(t('ins.external.scanFailed', { msg: err instanceof Error ? err.message : String(err) }))
    } finally {
      setExtScanning(false)
    }
  }

  const closeExternalImport = (): void => {
    // 导入进行中禁止关闭，避免写入未完成
    if (extProgress) return
    setExtTarget(null)
  }

  // 逐个顺序导入（避免并发写同一目录）；单个失败只记录，不中断其余版本。
  const confirmExternalImport = async (): Promise<void> => {
    if (!extTarget) return
    const { mcDir, versions } = extTarget
    const failures: string[] = []
    setExtProgress({ done: 0, total: versions.length })
    for (let i = 0; i < versions.length; i++) {
      try {
        await window.api.versions.importExternal(mcDir, versions[i].id, extPolicy)
      } catch (err) {
        failures.push(`${versions[i].id}: ${err instanceof Error ? err.message : String(err)}`)
      }
      setExtProgress({ done: i + 1, total: versions.length })
    }
    setExtProgress(null)
    setExtTarget(null)
    await refresh()
    if (failures.length > 0) {
      setExtMsg(t('ins.external.importPartial', { fail: failures.length, errors: failures.join('; ') }))
    } else {
      setExtMsg(t('ins.external.importDone', { n: versions.length }))
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    const path = window.api.shell.getPathForFile(file)
    if (path) void beginImport(path)
  }

  // 「原版」在加载器筛选里的取值（loader 为 null 时用它，避免与真实加载器名冲突）。
  const VANILLA = '__vanilla__'

  // 版本号筛选项：从已安装实例里收集，按版本号从新到旧排序。
  const mcOptions = useMemo(() => {
    const set = new Set<string>()
    for (const v of installed ?? []) if (v.mcVersion) set.add(v.mcVersion)
    return [
      { value: 'all', label: t('ins.filterAll') },
      ...Array.from(set)
        .sort(compareMcVersion)
        .map((m) => ({ value: m, label: m }))
    ]
  }, [installed, t])

  // 加载器筛选项：原版 + 出现过的各加载器。
  const loaderOptions = useMemo(() => {
    const set = new Set<string>()
    for (const v of installed ?? []) set.add(v.loader ?? VANILLA)
    const ordered = [VANILLA, ...Array.from(set).filter((l) => l !== VANILLA).sort()]
    return [
      { value: 'all', label: t('ins.filterAll') },
      ...ordered.map((l) => ({ value: l, label: l === VANILLA ? t('ins.vanilla') : loaderLabel(l, t) }))
    ]
  }, [installed, t])

  const filtersActive = query.trim() !== '' || filterMc !== 'all' || filterLoader !== 'all'

  const clearFilters = (): void => {
    setQuery('')
    setFilterMc('all')
    setFilterLoader('all')
  }

  // 应用搜索与筛选：版本名 / 存档名 / 服务器名（名称与地址）任一命中即可。
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (installed ?? []).filter((v) => {
      if (filterMc !== 'all' && v.mcVersion !== filterMc) return false
      if (filterLoader !== 'all' && (v.loader ?? VANILLA) !== filterLoader) return false
      if (!q) return true
      if (v.id.toLowerCase().includes(q)) return true
      if (v.worlds.some((w) => w.toLowerCase().includes(q))) return true
      return v.servers.some((s) => s.name.toLowerCase().includes(q) || s.address.toLowerCase().includes(q))
    })
    // VANILLA 为常量，无需列入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installed, filterMc, filterLoader, query])

  return (
    <div
      className="flex h-full flex-col gap-5"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="flex items-end justify-between">
        <div>
          <h1 className="display">{t('ins.title')}</h1>
          <p className="caption mt-1">{t('ins.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Button icon="refresh" onClick={() => void refresh()}>
            {t('ins.refresh')}
          </Button>
          <Button icon="folder" onClick={() => void beginExternalImport()} disabled={extScanning || importing}>
            {t('ins.external.button')}
          </Button>
          <Button variant="primary" icon="download" onClick={() => void pickImport()} disabled={importing}>
            {importing ? t('ins.importing') : t('ins.import')}
          </Button>
        </div>
      </div>

      {/* 单框工具栏：左侧搜索 + 版本号 / 加载器筛选，右侧版本目录选择（切换 / 添加 / 管理）。
          版本目录路径作为备注显示在下拉框内（名称下方）。 */}
      <div className="glass-soft flex flex-wrap items-center gap-3 rounded-2xl px-3 py-2">
        {(installed?.length ?? 0) > 0 && (
          <>
            <div className="relative min-w-[200px] flex-1">
              <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 opacity-50" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('ins.searchPlaceholder')}
                className="input w-full pl-9"
              />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="caption">{t('ins.filterVersion')}</span>
              <Select className="w-[132px]" value={filterMc} onChange={setFilterMc} options={mcOptions} />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="caption">{t('ins.filterLoader')}</span>
              <Select className="w-[128px]" value={filterLoader} onChange={setFilterLoader} options={loaderOptions} />
            </div>
            {filtersActive && (
              <Button size="sm" icon="xmark" onClick={clearFilters}>
                {t('ins.filterClear')}
              </Button>
            )}
          </>
        )}

        {/* 版本目录选择器：整体置于行尾 */}
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <Icon name="folder" size={15} className="shrink-0 opacity-60" />
          <span className="caption shrink-0">{t('ins.versionDir')}</span>
          <Select
            variant="seamless"
            className="min-w-0 w-[240px] max-w-[40vw]"
            value={currentDirId}
            onChange={(v) => void selectDir(v)}
            options={dirOptions}
          />
          <Button size="sm" icon="settings" onClick={() => setDirsOpen(true)}>
            {t('ins.manage')}
          </Button>
        </div>
      </div>

      {importMsg && (
        <div className="glass-soft flex items-center gap-2 rounded-2xl px-4 py-3 text-[13px]">
          <Spinner size={15} />
          <span className="truncate">{importMsg}</span>
        </div>
      )}

      {/* 外部版本扫描 / 导入结果提示条 */}
      {(extScanning || extMsg) && (
        <div className="glass-soft flex items-center gap-2 rounded-2xl px-4 py-3 text-[13px]">
          {extScanning && <Spinner size={15} />}
          <span className="min-w-0 flex-1 truncate" title={extMsg ?? undefined}>
            {extScanning ? t('ins.external.scanning') : extMsg}
          </span>
        </div>
      )}

      <div
        className={`min-h-0 flex-1 overflow-y-auto rounded-[24px] pr-1 transition-opacity ${dragOver ? 'opacity-70' : ''}`}
      >
        {installed === null ? (
          <LoadingState text={t('ins.loadingInstalled')} />
        ) : installed.length === 0 ? (
          <div className="glass flex items-center gap-3 rounded-[24px] p-5">
            <Icon name="cube" size={20} className="opacity-50" />
            <div>
              <div className="headline">{t('ins.emptyTitle')}</div>
              <div className="caption">{t('ins.emptyHint')}</div>
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div className="glass flex items-center gap-3 rounded-[24px] p-5">
            <Icon name="search" size={20} className="opacity-50" />
            <div>
              <div className="headline">{t('ins.noMatchTitle')}</div>
              <div className="caption">{t('ins.noMatchHint')}</div>
            </div>
          </div>
        ) : (
          <div className="space-y-3 pb-4">
            {visible.map((v, i) => (
              <motion.div
                key={v.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: 'spring', bounce: 0, duration: 0.3, delay: Math.min(i * 0.03, 0.2) }}
              >
                <InstanceCard
                  v={v}
                  canLaunch={!!selectedAccount}
                  onManage={() => onManage(v.id)}
                  onLaunch={doLaunch}
                  onAddServer={() => openAddServer(v.id)}
                />
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {/* 添加服务器弹窗：输入名称 + 地址，写入该实例的 servers.dat */}
      <AnimatePresence>
        {serverPrompt && (
          <motion.div
            className="absolute inset-0 z-50 flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              className="absolute inset-0"
              style={{ background: 'var(--scrim)' }}
              onClick={() => !serverBusy && setServerPrompt(null)}
            />
            <motion.div
              className="glass-strong relative z-10 w-full max-w-sm rounded-[28px] p-6"
              initial={{ scale: 0.94, opacity: 0, y: 12 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.94, opacity: 0, y: 12 }}
              transition={{ type: 'spring', bounce: 0.18, duration: 0.4 }}
            >
              <h2 className="title mb-1">{t('ins.addServerTitle')}</h2>
              <p className="caption mb-4 truncate" title={serverPrompt.versionId}>
                {t('ins.addServerFor', { name: serverPrompt.versionId })}
              </p>
              <label className="caption mb-1 block">{t('ins.serverName')}</label>
              <input
                autoFocus
                value={serverName}
                onChange={(e) => setServerName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitAddServer()}
                placeholder={t('ins.serverNamePlaceholder')}
                className="input mb-3 w-full"
              />
              <label className="caption mb-1 block">{t('ins.serverAddress')}</label>
              <input
                value={serverAddress}
                onChange={(e) => setServerAddress(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitAddServer()}
                placeholder={t('ins.serverAddressPlaceholder')}
                spellCheck={false}
                className="input mb-4 w-full"
              />
              <p className="caption mb-4 -mt-2 opacity-70">{t('ins.addServerHint')}</p>
              {serverError && (
                <p className="mb-4 text-[12px]" style={{ color: 'var(--fill-danger)' }}>
                  {serverError}
                </p>
              )}
              <div className="flex gap-2">
                <Button className="flex-1" disabled={serverBusy} onClick={() => setServerPrompt(null)}>
                  {t('ins.cancel')}
                </Button>
                <Button
                  variant="primary"
                  className="flex-1"
                  disabled={serverBusy || !serverAddress.trim()}
                  onClick={submitAddServer}
                >
                  {serverBusy ? t('ins.addServerBusy') : t('ins.addServerConfirm')}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 重命名弹窗（文件夹名冲突） */}
      <AnimatePresence>
        {renameProbe && (
          <motion.div
            className="absolute inset-0 z-50 flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={() => setRenameProbe(null)} />
            <motion.div
              className="glass-strong relative z-10 w-full max-w-sm rounded-[28px] p-6"
              initial={{ scale: 0.94, opacity: 0, y: 12 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.94, opacity: 0, y: 12 }}
              transition={{ type: 'spring', bounce: 0.18, duration: 0.4 }}
            >
              <h2 className="title mb-1">{t('ins.renameTitle')}</h2>
              <p className="caption mb-4">
                {t('ins.renameLabel', { name: renameProbe.probe.name })}
              </p>
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && renameValue.trim() && !renameTaken && void confirmImport()}
                placeholder={t('ins.instanceNamePlaceholder')}
                className="input mb-3 w-full"
              />
              <div className="caption mb-2">{t('ins.installDir')}</div>
              <Select
                value={importDirId || settings.selectedVersionDirId || 'default'}
                onChange={setImportDirId}
                className="mb-5 w-full"
                options={dirOptions}
              />
              {renameTaken && (
                <p className="mb-4 -mt-3 text-[12px]" style={{ color: 'var(--fill-danger)' }}>
                  {t('ins.nameExists', { name: renameValue.trim() })}
                </p>
              )}
              <div className="flex gap-2">
                <Button className="flex-1" onClick={() => setRenameProbe(null)}>
                  {t('ins.cancel')}
                </Button>
                <Button variant="primary" className="flex-1" disabled={!renameValue.trim() || renameTaken} onClick={() => void confirmImport()}>
                  {t('ins.importAction')}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 从外部 .minecraft 导入版本弹窗：列出可导入版本、选择重名策略并逐个导入 */}
      <AnimatePresence>
        {extTarget && (
          <motion.div
            className="absolute inset-0 z-50 flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={closeExternalImport} />
            <motion.div
              className="glass-strong relative z-10 w-full max-w-md rounded-[28px] p-6"
              initial={{ scale: 0.94, opacity: 0, y: 12 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.94, opacity: 0, y: 12 }}
              transition={{ type: 'spring', bounce: 0.18, duration: 0.4 }}
            >
              <div className="mb-1 flex items-start justify-between gap-2">
                <h2 className="title">{t('ins.external.title')}</h2>
                <Button
                  size="sm"
                  icon="xmark"
                  title={t('ins.external.close')}
                  disabled={!!extProgress}
                  onClick={closeExternalImport}
                />
              </div>
              <p className="caption mb-4 break-all">{extTarget.mcDir}</p>

              <div className="mb-4 max-h-[40vh] space-y-2 overflow-y-auto pr-1">
                {extTarget.versions.map((ver) => (
                  <div key={ver.id} className="glass-soft flex items-center gap-2 rounded-xl px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-semibold">{ver.id}</div>
                      <div className="caption truncate">
                        {ver.mcVersion}
                        {ver.loader ? ` · ${loaderLabel(ver.loader, t)}` : ''}
                        {` · ${formatSize(ver.size)}`}
                      </div>
                    </div>
                    {ver.conflict && (
                      <span
                        className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-white"
                        style={{ background: 'var(--fill-danger)' }}
                      >
                        {t('ins.external.conflict')}
                      </span>
                    )}
                  </div>
                ))}
              </div>

              <div className="caption mb-2">{t('ins.external.policy')}</div>
              <Segmented
                options={[
                  { value: 'rename', label: t('ins.external.policyRename') },
                  { value: 'overwrite', label: t('ins.external.policyOverwrite') },
                  { value: 'skip', label: t('ins.external.policySkip') }
                ]}
                value={extPolicy}
                onChange={setExtPolicy}
                disabled={!!extProgress}
              />

              <div className="mt-5 flex gap-2">
                <Button className="flex-1" disabled={!!extProgress} onClick={closeExternalImport}>
                  {t('ins.cancel')}
                </Button>
                <Button
                  variant="primary"
                  className="flex-1"
                  disabled={!!extProgress}
                  onClick={() => void confirmExternalImport()}
                >
                  {extProgress
                    ? t('ins.external.importing', { done: extProgress.done, total: extProgress.total })
                    : t('ins.external.confirm')}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 版本目录管理：切换、设别名、移除（默认目录不可移除） */}
      <AnimatePresence>
        {dirsOpen && (
          <motion.div
            className="absolute inset-0 z-50 flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={() => setDirsOpen(false)} />
            <motion.div
              className="glass-strong relative z-10 w-full max-w-md rounded-[28px] p-6"
              initial={{ scale: 0.94, opacity: 0, y: 12 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.94, opacity: 0, y: 12 }}
              transition={{ type: 'spring', bounce: 0.18, duration: 0.4 }}
            >
              <h2 className="title mb-1">{t('ins.versionDir')}</h2>
              <p className="caption mb-4">{t('ins.dirsHint')}</p>
              <div className="max-h-[46vh] space-y-2 overflow-y-auto pr-1">
                {dirs.map((d) => {
                  const active = d.id === currentDirId
                  return (
                    <div key={d.id} className="glass-soft flex items-center gap-2 rounded-xl px-3 py-2">
                      <button className="group min-w-0 flex-1 text-left no-drag" onClick={() => void selectDir(d.id)}>
                        <div className="flex items-center gap-1">
                          <span className="truncate text-[14px] font-semibold group-hover:underline">{versionDirLabel(d)}</span>
                          {active && <Icon name="check" size={13} style={{ color: 'var(--fill-primary)' }} />}
                        </div>
                        <div className="caption truncate">{d.path}</div>
                      </button>
                      <Button
                        size="sm"
                        icon="settings"
                        title={t('ins.setAliasTitle')}
                        onClick={() => {
                          setAliasPrompt({ mode: 'edit', id: d.id, path: d.path })
                          setAliasValue(d.alias)
                        }}
                      >
                        {t('ins.alias')}
                      </Button>
                      {!d.isDefault && (
                        <Button size="sm" icon="trash" title={t('ins.removeDirTitle')} onClick={() => void removeDir(d.id)}>
                          {t('ins.remove')}
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="mt-5 flex gap-2">
                <Button className="flex-1" icon="plus" onClick={() => void selectDir('__add__')}>
                  {t('ins.addDir')}
                </Button>
                <Button variant="primary" className="flex-1" onClick={() => setDirsOpen(false)}>
                  {t('ins.done')}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 别名输入：添加时命名、或给已有目录改名（留空则显示目录名） */}
      <AnimatePresence>
        {aliasPrompt && (
          <motion.div
            className="absolute inset-0 z-[60] flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={() => setAliasPrompt(null)} />
            <motion.div
              className="glass-strong relative z-10 w-full max-w-sm rounded-[28px] p-6"
              initial={{ scale: 0.94, opacity: 0, y: 12 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.94, opacity: 0, y: 12 }}
              transition={{ type: 'spring', bounce: 0.18, duration: 0.4 }}
            >
              <h2 className="title mb-1">{aliasPrompt.mode === 'add' ? t('ins.addDir') : t('ins.setAliasTitle')}</h2>
              <p className="caption mb-4 break-all">{aliasPrompt.path}</p>
              <input
                autoFocus
                value={aliasValue}
                onChange={(e) => setAliasValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void confirmAliasPrompt()}
                placeholder={t('ins.aliasPlaceholder')}
                className="input mb-5 w-full"
              />
              <div className="flex gap-2">
                <Button className="flex-1" onClick={() => setAliasPrompt(null)}>
                  {t('ins.cancel')}
                </Button>
                <Button variant="primary" className="flex-1" onClick={() => void confirmAliasPrompt()}>
                  {aliasPrompt.mode === 'add' ? t('ins.add') : t('ins.save')}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}



function InstanceCard({
  v,
  canLaunch,
  onManage,
  onLaunch,
  onAddServer
}: {
  v: InstalledVersion
  canLaunch: boolean
  onManage: () => void
  onLaunch: (versionId: string, opts?: { world?: string; server?: string }) => void
  onAddServer: () => void
}): JSX.Element {
  const { openFileManager, settings, t } = useApp()
  return (
    <div className="glass rounded-[24px] p-4">
      <div className="flex items-center gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white"
          style={{ background: 'linear-gradient(135deg,#30d158,#0a84ff)' }}
        >
          <Icon name="cube" size={19} />
        </div>
        <button className="group min-w-0 flex-1 text-left no-drag" onClick={onManage} title={t('ins.enterManage')}>
          <div className="truncate text-[15px] font-semibold group-hover:underline">{v.id}</div>
          <div className="caption">
            {v.mcVersion}
            {v.loader ? ` · ${loaderLabel(v.loader, t)}` : ''}
            {t('ins.cardMeta', { worlds: v.worlds.length, servers: v.servers.length })}
          </div>
        </button>
        <Button size="sm" icon="settings" onClick={onManage} title={t('ins.enterManage')}>
          {t('ins.manage')}
        </Button>
        {/* 打开该实例的游戏目录：走 run 语义按隔离设置解析——隔离时为
            versions/<实例>，未隔离时才是共享的 .minecraft */}
        <Button
          size="sm"
          icon="folder"
          onClick={() => void window.api.manage.openDir(v.id, 'run').then(openFileManager)}
          title={t('ins.openInstanceDirTitle')}
        >
          {t('ins.dir')}
        </Button>
        {/* 直接为该实例添加服务器：写入其 servers.dat，保存后卡片里即可一键进入 */}
        <Button size="sm" className="shrink-0" icon="server" onClick={onAddServer} title={t('ins.addServer')} />
        <Button size="sm" variant="primary" icon="play" disabled={!canLaunch} onClick={() => onLaunch(v.id)}>
          {t('ins.launch')}
        </Button>
      </div>

      {(v.worlds.length > 0 || v.servers.length > 0) && (
        <div className="mt-3 space-y-2 border-t pt-3" style={{ borderColor: 'var(--divider)' }}>
          {v.worlds.map((w) => (
            <QuickRow key={`w-${w}`} label={`${v.id} - ${w}`} icon="home" onPlay={() => onLaunch(v.id, { world: w })} />
          ))}
          {v.servers.map((s) => (
            <ServerRow
              key={`s-${s.address}`}
              versionId={v.id}
              name={s.name}
              address={s.address}
              enabled={settings.showServerStatus}
              onPlay={() => onLaunch(v.id, { server: s.address })}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 服务器条目：展示「实例名 - 服务器名」、MOTD（彩色）与在线人数 / 总人数。
 *
 * 开启「显示服务器状态」后经 uapis.cn 查询：优先使用接口返回的 motd_html
 * （白名单净化后渲染），若仅有纯文本则本地解析 § 颜色代码着色。查询失败 / 关闭
 * 开关时退回仅显示名称与地址，不阻塞启动按钮。
 */
function ServerRow({
  versionId,
  name,
  address,
  enabled,
  onPlay
}: {
  versionId: string
  name: string
  address: string
  enabled: boolean
  onPlay: () => void
}): JSX.Element {
  const { t } = useApp()
  const [status, setStatus] = useState<MinecraftServerStatus | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setStatus(null)
      setFailed(false)
      return
    }
    let alive = true
    setFailed(false)
    void window.api.minecraft
      .serverStatus(address)
      .then((s) => {
        if (alive) setStatus(s)
      })
      .catch(() => {
        if (alive) {
          setStatus(null)
          setFailed(true)
        }
      })
    return () => {
      alive = false
    }
  }, [enabled, address])

  // MOTD 自动翻译：跟随「自动翻译」总开关（useAutoTranslate 内部已含语言检测，
  // MOTD 已是设置语言时不会翻译）。仅对纯文本 motd_clean 取译文。
  const trMotd = useAutoTranslate([status?.motdClean])
  const motdTranslated = status ? trMotd(status.motdClean) : ''

  const motdHtml = useMemo(() => {
    if (!status) return ''
    if (status.motdHtml.trim()) return sanitizeMotdHtml(status.motdHtml)
    // 无 HTML 时退回本地解析纯文本 MOTD 的 § 颜色代码。
    return motdToHtml(status.motdClean)
  }, [status])

  return (
    <div className="glass-soft flex items-start gap-2 rounded-xl px-3 py-2">
      {status?.faviconUrl ? (
        <img
          src={status.faviconUrl}
          alt=""
          aria-hidden
          className="mt-0.5 h-4 w-4 shrink-0 rounded-[3px]"
          style={{ imageRendering: 'pixelated' }}
        />
      ) : (
        <Icon name="link" size={15} className="mt-0.5 shrink-0 opacity-60" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">
          {versionId} - {name}
        </div>
        {(() => {
          // MOTD 展示与「自动翻译」开关无关：只要接口返回了 MOTD 就展示（等宽/换行保留）。
          // 三档优先级：① 语言检测判定需翻译且已翻好 → 显示译文（纯文本）；
          //             ② 有彩色 motd_html → 净化后渲染；③ 仅有纯文本 → § 代码着色。
          if (!enabled || !status) {
            return <div className="caption mt-0.5 truncate">{address}</div>
          }
          const needTranslate = motdTranslated.trim() && motdTranslated.trim() !== status.motdClean.trim()
          if (needTranslate) {
            return (
              <div className="ins-motd mt-0.5 whitespace-pre-wrap break-all text-[12px] leading-snug">
                {motdTranslated}
              </div>
            )
          }
          if (motdHtml) {
            return (
              <div
                className="ins-motd mt-0.5 whitespace-pre-wrap break-all text-[12px] leading-snug"
                dangerouslySetInnerHTML={{ __html: motdHtml }}
              />
            )
          }
          // MOTD 为空（部分服务器不返回且直连也拿不到）：退回显示「地址 · 版本」，避免该行空白。
          return (
            <div className="caption mt-0.5 truncate">
              {address}
              {status.version ? ` · ${status.version}` : ''}
            </div>
          )
        })()}
      </div>
      {enabled && status && (
        <span
          className="mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
          style={{
            color: status.online ? 'var(--fill-success)' : 'var(--fill-danger)',
            background: 'var(--fill-tertiary, rgba(120,120,128,0.12))'
          }}
          title={status.version || undefined}
        >
          {status.online
            ? t('ins.server.players', { online: status.players, max: status.maxPlayers })
            : t('ins.server.offline')}
        </span>
      )}
      {enabled && failed && !status && (
        <span className="caption mt-0.5 shrink-0">{t('ins.server.failed')}</span>
      )}
      <button
        onClick={onPlay}
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white transition-transform active:scale-90 no-drag"
        style={{ background: 'var(--fill-primary)' }}
        title={t('ins.quickLaunch')}
      >
        <Icon name="play" size={14} />
      </button>
    </div>
  )
}

/** Minecraft § 颜色代码 → 十六进制颜色（与游戏内 16 色对应）。 */
const MC_COLORS: Record<string, string> = {
  '0': '#000000',
  '1': '#0000AA',
  '2': '#00AA00',
  '3': '#00AAAA',
  '4': '#AA0000',
  '5': '#AA00AA',
  '6': '#FFAA00',
  '7': '#AAAAAA',
  '8': '#555555',
  '9': '#5555FF',
  a: '#55FF55',
  b: '#55FFFF',
  c: '#FF5555',
  d: '#FF55FF',
  e: '#FFFF55',
  f: '#FFFFFF'
}

/** 转义 HTML 文本中的特殊字符，避免纯文本 MOTD 注入。 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 本地解析纯文本 MOTD：按 § 代码着色（§l 加粗 / §o 斜体 / §r 复位），换行保留。 */
function motdToHtml(clean: string): string {
  if (!clean) return ''
  const segs: string[] = []
  let bold = false
  let italic = false
  let color = ''
  const open = (): string => {
    const style = `${color ? `color:${color};` : ''}${bold ? 'font-weight:700;' : ''}${italic ? 'font-style:italic;' : ''}`
    return style ? `<span style="${style}">` : '<span>'
  }
  // 逐字符扫描 § 代码，颜色/样式变化时切分并闭合上一段。
  let i = 0
  let text = ''
  let seg = open()
  const chars = Array.from(clean)
  while (i < chars.length) {
    const ch = chars[i]
    if ((ch === '§' || ch === '&') && i + 1 < chars.length) {
      const code = chars[i + 1].toLowerCase()
      if (code in MC_COLORS) {
        if (text) seg += escapeHtml(text) + '</span>'
        if (seg) segs.push(seg)
        color = MC_COLORS[code]
        bold = false
        italic = false
        text = ''
        seg = open()
        i += 2
        continue
      }
      if (code === 'l') {
        if (text) seg += escapeHtml(text) + '</span>'
        if (seg) segs.push(seg)
        bold = true
        text = ''
        seg = open()
        i += 2
        continue
      }
      if (code === 'o') {
        if (text) seg += escapeHtml(text) + '</span>'
        if (seg) segs.push(seg)
        italic = true
        text = ''
        seg = open()
        i += 2
        continue
      }
      if (code === 'r') {
        if (text) seg += escapeHtml(text) + '</span>'
        if (seg) segs.push(seg)
        color = ''
        bold = false
        italic = false
        text = ''
        seg = open()
        i += 2
        continue
      }
      // 其它格式代码（§k 乱码 / §m 删除线 / §n 下划线）直接丢弃。
      i += 2
      continue
    }
    text += ch
    i++
  }
  if (text) seg += escapeHtml(text) + '</span>'
  if (seg) segs.push(seg)
  return segs.join('')
}

/**
 * 白名单净化接口返回的 motd_html：仅保留 span / b / i / br，仅保留 color 与
 * font-weight / font-style / text-decoration 等样式，剔除 script / 事件属性 / 图片
 * 等一切可能注入的内容（dangerouslySetInnerHTML 前必须执行）。
 */
function sanitizeMotdHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const allowedTags = new Set(['SPAN', 'B', 'I', 'U', 'BR', 'STRONG', 'EM'])
  const allowedProps = new Set(['color', 'font-weight', 'font-style', 'text-decoration'])
  const walk = (node: Node): void => {
    const children = Array.from(node.childNodes)
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) continue
      if (child.nodeType !== Node.ELEMENT_NODE) {
        child.remove()
        continue
      }
      const el = child as Element
      if (!allowedTags.has(el.tagName)) {
        // 不在白名单：用其子节点替换该元素（保留文字、丢弃标签本身）。
        const fragment = doc.createDocumentFragment()
        while (el.firstChild) fragment.appendChild(el.firstChild)
        el.replaceWith(fragment)
        walk(node)
        continue
      }
      for (const attr of Array.from(el.attributes)) {
        const attrName = attr.name.toLowerCase()
        if (attrName === 'style') {
          const kept: string[] = []
          for (const decl of attr.value.split(';')) {
            const [prop, ...rest] = decl.split(':')
            if (!prop || rest.length === 0) continue
            const p = prop.trim().toLowerCase()
            if (!allowedProps.has(p)) continue
            // 仅允许安全的颜色/粗细/样式取值，拒绝 url( / expression 之类。
            const value = rest.join(':').trim()
            if (/url\s*\(|expression|javascript:/i.test(value)) continue
            kept.push(`${p}:${value}`)
          }
          if (kept.length > 0) el.setAttribute('style', kept.join(';'))
          else el.removeAttribute('style')
        } else {
          el.removeAttribute(attr.name)
        }
      }
      walk(el)
    }
  }
  walk(doc.body)
  return doc.body.innerHTML
}

/** 存档条目：展示「实例名 - 存档名」并提供一键进入世界的播放按钮。 */
function QuickRow({ label, icon, onPlay }: { label: string; icon: string; onPlay: () => void }): JSX.Element {
  const { t } = useApp()
  return (
    <div className="glass-soft flex items-center gap-2 rounded-xl px-3 py-2">
      <Icon name={icon} size={15} className="shrink-0 opacity-60" />
      <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
      <button
        onClick={onPlay}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white transition-transform active:scale-90 no-drag"
        style={{ background: 'var(--fill-primary)' }}
        title={t('ins.quickLaunch')}
      >
        <Icon name="play" size={14} />
      </button>
    </div>
  )
}

function loaderLabel(loader: string | null, t: TFunction): string {
  if (!loader) return t('ins.vanilla')
  return loader.charAt(0).toUpperCase() + loader.slice(1)
}

/**
 * 版本号排序比较器（用于 Array#sort）：按数字段逐段比较，并返回「新版本在前」的降序。
 * 直接按字符串比会把 1.10 排到 1.9 前面，故需要数值化分段比较。
 */
function compareMcVersion(a: string, b: string): number {
  const segments = (s: string): number[] => s.split(/[^0-9]+/).map((x) => parseInt(x, 10) || 0)
  const pa = segments(a)
  const pb = segments(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return y - x
  }
  return b.localeCompare(a)
}

// 把字节数格式化为人类可读体积（如 128.4 MB）
function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`
}
