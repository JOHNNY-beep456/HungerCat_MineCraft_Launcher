import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ConflictPolicy, ExternalVersion, InstalledVersion, ModpackProbe, VersionDir } from '@shared/types'
import { activeGameDir, activeVersionDir, useApp, versionDirLabel } from '../store'
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

  const dirOptions = [
    ...dirs.map((d) => ({ value: d.id, label: versionDirLabel(d) })),
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

  const renameTaken =
    renameProbe !== null && renameValue.trim() !== '' && (installed ?? []).some((v) => v.id === renameValue.trim())

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
    if ((installed ?? []).some((v) => v.id === name)) {
      setImportMsg(t('ins.nameExistsChange', { name }))
      return
    }
    const probe = renameProbe.probe
    const filePath = renameProbe.filePath
    setRenameProbe(null)
    try {
      await window.api.modpack.import(filePath, name)
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

      {/* 版本目录选择：切换 / 添加（可设别名）；实例列表与启动都以此为准 */}
      <div className="glass-soft flex items-center gap-3 rounded-2xl px-3 py-2">
        <Icon name="folder" size={15} className="shrink-0 opacity-60" />
        <span className="caption shrink-0">{t('ins.versionDir')}</span>
        <Select
          variant="seamless"
          className="w-[220px] max-w-[44vw] shrink-0"
          value={currentDirId}
          onChange={(v) => void selectDir(v)}
          options={dirOptions}
        />
        <span className="caption min-w-0 flex-1 truncate" title={activeVersionDir(settings).path}>
          {activeVersionDir(settings).path}
        </span>
        <Button size="sm" icon="settings" onClick={() => setDirsOpen(true)}>
          {t('ins.manage')}
        </Button>
      </div>

      {/* 搜索（版本名 / 存档名 / 服务器名）+ 筛选（版本号 / 加载器）；无实例时不展示 */}
      {(installed?.length ?? 0) > 0 && (
        <div className="glass-soft flex flex-wrap items-center gap-3 rounded-2xl px-3 py-2">
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
        </div>
      )}

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
                />
              </motion.div>
            ))}
          </div>
        )}
      </div>

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
                className="input mb-5 w-full"
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
  onLaunch
}: {
  v: InstalledVersion
  canLaunch: boolean
  onManage: () => void
  onLaunch: (versionId: string, opts?: { world?: string; server?: string }) => void
}): JSX.Element {
  const { openFileManager, t } = useApp()
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
            <QuickRow key={`s-${s.address}`} label={`${v.id} - ${s.name}`} icon="link" onPlay={() => onLaunch(v.id, { server: s.address })} />
          ))}
        </div>
      )}
    </div>
  )
}

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
