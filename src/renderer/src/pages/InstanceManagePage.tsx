import { useCallback, useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ModEntry, ModrinthProject, ModrinthVersion, ResourceFile, SchematicEntry } from '@shared/types'
import { useApp } from '../store'
import { useRuntimeActions } from '../runtime'
import { Button, Icon, LoadingState, Segmented, Spinner } from '../components/ui'
import { ExportPage } from './ExportPage'

type Tab = 'mods' | 'saves' | 'shaders' | 'schematics' | 'version'

export function InstanceManagePage({
  versionId,
  onBack,
  onRename
}: {
  versionId: string
  onBack: () => void
  onRename: (newId: string) => void
}): JSX.Element {
  const { settings, selectedAccount, updateSettings, reloadSettings } = useApp()
  const { launch } = useRuntimeActions()

  const [tab, setTab] = useState<Tab>('mods')
  const [loader, setLoader] = useState<string | null | undefined>(undefined)
  const [mods, setMods] = useState<ModEntry[]>([])
  const [loadingMods, setLoadingMods] = useState(true)
  const [worlds, setWorlds] = useState<string[]>([])
  const [shaders, setShaders] = useState<ResourceFile[]>([])
  const [schematics, setSchematics] = useState<SchematicEntry[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(versionId)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [modDetail, setModDetail] = useState<ModEntry | null>(null)

  // online mod search
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ModrinthProject[]>([])
  const [searching, setSearching] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const [loaderSel, setLoaderSel] = useState<string>('fabric')
  const [mcSel, setMcSel] = useState<string>('')

  const isVanilla = loader === null

  const tabOptions = useMemo<Array<{ value: Tab; label: string }>>(() => {
    if (isVanilla) {
      return [
        { value: 'saves', label: '存档' },
        { value: 'version', label: '版本' }
      ]
    }
    return [
      { value: 'mods', label: '模组' },
      { value: 'saves', label: '存档' },
      { value: 'shaders', label: '光影' },
      { value: 'schematics', label: '投影' },
      { value: 'version', label: '版本' }
    ]
  }, [isVanilla])

  const disabled = settings.disabledVersions.includes(versionId)

  const reload = useCallback(async () => {
    setLoadingMods(true)
    try {
      const [modList, installed, shaderList, schematicList] = await Promise.all([
        window.api.manage.mods(versionId),
        window.api.installed.list(),
        window.api.resources.list(versionId, 'shaderpacks'),
        window.api.manage.schematics(versionId)
      ])
      setMods(modList)
      const entry = installed.find((v) => v.id === versionId)
      const entryLoader = entry?.loader ?? null
      setWorlds(entry?.worlds ?? [])
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

  useEffect(() => {
    void reload()
  }, [reload])

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
      gameDir: settings.gameDir,
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
      setNotice(`删除失败：${err instanceof Error ? err.message : String(err)}`)
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
        ? `已安装 ${ok} 个模组，${errors.length} 个失败：${errors.join('；')}`
        : `已安装 ${ok} 个模组`
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
      const versions = await window.api.mods.versions(p.slug, [loaderSel], [mcSel])
      const v = versions[0]
      if (!v) {
        setNotice(`没有匹配 ${mcSel} + ${loaderSel} 的版本`)
        return
      }
      const file = v.files.find((f) => f.primary) ?? v.files[0]
      if (!file) return
      await window.api.mods.install(file.url, file.filename, versionId, 'mod')
      setNotice(`已安装 ${p.title} ${v.version_number}`)
      setResults([])
      setQuery('')
      await reload()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-center gap-3">
        <Button size="sm" icon="chevronLeft" onClick={onBack}>
          返回
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="display truncate">实例管理</h1>
          <p className="caption mt-1 selectable truncate">
            {versionId}
            {disabled ? '（已禁用）' : ''}
            {loader ? ` · ${loaderLabel(loader)}` : ''}
          </p>
        </div>
        <Button size="sm" icon="play" disabled={!selectedAccount || disabled} onClick={() => doLaunch()}>
          启动
        </Button>
      </div>

      <div className="shrink-0">
        <Segmented value={tab} onChange={(v) => setTab(v)} options={tabOptions} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {tab === 'version' && (
          <div className="space-y-3">
            <div className="glass-soft rounded-2xl p-4">
              <div className="text-[14px] font-medium">重命名此版本</div>
              <div className="caption mt-0.5">同时更改显示名与文件夹名</div>
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
                  placeholder="新的实例名"
                  className="input flex-1"
                  disabled={renaming}
                />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={renaming || !renameValue.trim() || renameValue.trim() === versionId}
                  onClick={() => void doRename()}
                >
                  {renaming ? '重命名中…' : '重命名'}
                </Button>
              </div>
              {renameError && (
                <div className="mt-2 text-[12px]" style={{ color: 'var(--fill-danger)' }}>
                  {renameError}
                </div>
              )}
            </div>
            <Row label="禁用此版本" desc="禁用后将无法启动该版本">
              <Button size="sm" variant={disabled ? 'primary' : 'secondary'} onClick={() => void toggleDisabled()}>
                {disabled ? '启用' : '禁用'}
              </Button>
            </Row>
            <Row label="启动游戏">
              <Button size="sm" variant="primary" icon="play" disabled={!selectedAccount || disabled} onClick={() => doLaunch()}>
                启动
              </Button>
            </Row>
            <Row label="打开版本目录">
              <Button size="sm" icon="folder" onClick={() => void window.api.manage.openDir(versionId, 'version')}>
                打开
              </Button>
            </Row>
            <Row label="导出整合包" desc="将模组、配置与资源打包为可分享的整合包">
              <Button size="sm" icon="box" onClick={() => setExportOpen(true)}>
                导出整合包
              </Button>
            </Row>
            <Row label="删除此版本" desc="删除版本文件（存档与模组若未隔离将一并保留在共享目录）">
              <Button size="sm" variant="danger" icon="trash" disabled={deleting} onClick={() => void doDeleteVersion()}>
                {deleting ? '删除中…' : '删除'}
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
              <p className="text-[13px] opacity-80">拖拽一个或多个 mod 文件到此处，或</p>
              <Button
                size="sm"
                icon="folder"
                className="mt-2"
                onClick={async () => {
                  const paths = await window.api.shell.pickFiles([{ name: 'Minecraft Mods', extensions: ['jar', 'zip'] }])
                  if (paths.length > 0) await installLocals(paths)
                }}
              >
                选择本地文件
              </Button>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="headline">已安装模组（{mods.length}）</span>
                <span className="caption">点击开关可禁用/启用</span>
              </div>
              {loadingMods ? (
                <div className="flex items-center justify-center gap-2 py-4">
                  <Spinner size={22} />
                  <span className="caption opacity-60">正在读取模组…</span>
                </div>
              ) : mods.length === 0 ? (
                <div className="caption py-4 text-center opacity-60">还没有安装任何模组</div>
              ) : (
                <div className="space-y-1.5">
                  {mods.map((m) => (
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
                      <span className="caption">{formatBytes(m.size)}</span>
                      <button
                        onClick={() => void toggleMod(m)}
                        disabled={busyId === m.path}
                        className="no-drag rounded-lg px-2 py-1 text-[12px] font-medium"
                        style={{ background: m.enabled ? 'var(--fill-secondary)' : 'var(--fill-secondary-hover)' }}
                      >
                        {busyId === m.path ? '…' : m.enabled ? '禁用' : '启用'}
                      </button>
                      <button onClick={() => void deleteMod(m)} className="no-drag opacity-50 hover:opacity-100">
                        <Icon name="trash" size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {settings.mode !== 'local' && (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="headline">在线安装</span>
                <span className="caption">匹配 {mcSel} + {loaderSel}</span>
              </div>
              <div className="mb-2 flex gap-2">
                <div className="relative flex-1">
                  <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 opacity-50" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void searchMods()}
                    placeholder="搜索模组，如 sodium、jei…"
                    className="input w-full pl-9"
                  />
                </div>
                <Button variant="primary" icon="search" disabled={searching} onClick={() => void searchMods()}>
                  搜索
                </Button>
              </div>
              <div className="mb-2 flex items-center gap-2">
                <span className="caption">版本</span>
                <input value={mcSel} onChange={(e) => setMcSel(e.target.value)} className="input w-28" />
                <span className="caption ml-2">加载器</span>
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
                <LoadingState text="正在搜索…" />
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
              <span className="headline">存档（{worlds.length}）</span>
              <Button size="sm" icon="folder" onClick={() => void window.api.manage.openDir(versionId, 'saves')}>
                打开目录
              </Button>
            </div>
            {worlds.length === 0 ? (
              <div className="caption py-4 text-center opacity-60">还没有存档</div>
            ) : (
              worlds.map((w) => (
                <div key={w} className="glass-soft flex items-center gap-2 rounded-xl px-3 py-2">
                  <Icon name="home" size={15} className="opacity-60" />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{versionId} - {w}</span>
                  <Button size="sm" icon="play" disabled={!selectedAccount} onClick={() => doLaunch({ world: w })}>
                    启动
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

        {tab === 'shaders' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="headline">光影（{shaders.length}）</span>
              <Button size="sm" icon="folder" onClick={() => void window.api.manage.openDir(versionId, 'shaderpacks')}>
                打开目录
              </Button>
            </div>
            {shaders.length === 0 ? (
              <div className="caption py-4 text-center opacity-60">还没有安装光影</div>
            ) : (
              shaders.map((s) => (
                <div key={s.path} className="glass-soft flex items-center gap-2 rounded-xl px-3 py-2">
                  <Icon name="palette" size={15} className="opacity-60" />
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

        {tab === 'schematics' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="headline">投影原理图（{schematics.length}）</span>
              <Button size="sm" icon="folder" onClick={() => void window.api.manage.openDir(versionId, 'schematics')}>
                打开目录
              </Button>
            </div>
            {schematics.length === 0 ? (
              <div className="caption py-4 text-center opacity-60">
                还没有原理图（.litematic / .schem）
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
                onClick={() => void window.api.shell.openExternal(`https://modrinth.com/mod/${mod.slug}`)}
                className="no-drag shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium opacity-70 hover:opacity-100"
                style={{ background: 'var(--fill-secondary)' }}
              >
                更多信息..
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
            <span className="headline">版本</span>
            <span className="caption">{formatBytes(mod.size)}</span>
          </div>

          {!mod.slug ? (
            <div className="caption rounded-xl px-3 py-4 text-center opacity-60" style={{ background: 'var(--fill-secondary)' }}>
              未在 Modrinth 找到匹配项目，仅显示本地模组信息
            </div>
          ) : loading ? (
            <div className="flex flex-col items-center gap-2 p-6">
              <Spinner size={22} />
              <span className="caption">加载版本中…</span>
            </div>
          ) : versions.length === 0 ? (
            <div className="caption p-4 text-center opacity-60">没有可用的版本信息</div>
          ) : (
            <div className="space-y-1.5">
              {versions.slice(0, 30).map((v) => (
                <div key={v.id} className="glass-soft rounded-xl px-3.5 py-2.5">
                  <div className="truncate text-[13px] font-medium">{v.version_number}</div>
                  <div className="caption">
                    {v.loaders.join(' / ') || '无加载器'} · {v.game_versions.join(', ')}
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
