import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ForgeKind, InstalledVersion, LoaderKind, VersionManifest } from '@shared/types'
import { useRuntime } from '../runtime'
import { Button, Icon, LoadingState, ProgressBar, Segmented } from '../components/ui'

type Filter = 'all' | 'release' | 'snapshot'
type AnyLoader = LoaderKind | ForgeKind
type InstallKind = 'vanilla' | AnyLoader

const LOADER_OPTIONS: Array<{ value: InstallKind; label: string }> = [
  { value: 'vanilla', label: '原版' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' }
]

function defaultName(kind: InstallKind, mc: string): string {
  return kind === 'vanilla' ? mc : `${mc}-${kind}`
}

function sanitizeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 64)
}

export function VersionsPage(): JSX.Element {
  const { download, installingId, busy, installVersion } = useRuntime()

  const [manifest, setManifest] = useState<VersionManifest | null>(null)
  const [loading, setLoading] = useState(true)
  const [installed, setInstalled] = useState<InstalledVersion[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')

  const [loaderTarget, setLoaderTarget] = useState<string | null>(null)
  const [loaderKind, setLoaderKind] = useState<InstallKind>('vanilla')
  const [loaderVersions, setLoaderVersions] = useState<string[]>([])
  const [loaderVersion, setLoaderVersion] = useState('')
  const [loaderBusy, setLoaderBusy] = useState(false)
  const [loaderError, setLoaderError] = useState<string | null>(null)
  const [loaderLog, setLoaderLog] = useState<string[]>([])
  const [customName, setCustomName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [m, i] = await Promise.all([
        window.api.versions.list().catch(() => null),
        window.api.installed.list().catch(() => [] as InstalledVersion[])
      ])
      setManifest(m)
      setInstalled(i)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    return window.api.forge.onLog((line) => setLoaderLog((prev) => [...prev.slice(-500), line]))
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [loaderLog])

  const nameTaken = customName.trim() !== '' && installed.some((v) => v.id === sanitizeName(customName))

  const list = useMemo(() => {
    if (!manifest) return []
    const q = search.trim().toLowerCase()
    return manifest.versions.filter((v) => {
      if (filter !== 'all' && v.type !== filter) return false
      if (q && !v.id.toLowerCase().includes(q)) return false
      return true
    })
  }, [manifest, filter, search])

  const fetchLoaderVersions = async (mc: string, kind: AnyLoader): Promise<void> => {
    setLoaderError(null)
    setLoaderVersions([])
    setLoaderVersion('')
    try {
      const versions =
        kind === 'forge' || kind === 'neoforge'
          ? await window.api.forge.versions(kind, mc)
          : await window.api.loaders.versions(kind, mc)
      setLoaderVersions(versions)
      setLoaderVersion(versions[0] ?? '')
    } catch (err) {
      setLoaderError(err instanceof Error ? err.message : String(err))
    }
  }

  const openLoader = async (mc: string): Promise<void> => {
    setLoaderTarget(mc)
    setLoaderKind('vanilla')
    setLoaderVersions([])
    setLoaderVersion('')
    setLoaderLog([])
    setLoaderError(null)
    setCustomName(mc)
    setNameTouched(false)
  }

  const switchLoaderKind = async (kind: InstallKind): Promise<void> => {
    setLoaderKind(kind)
    if (!nameTouched && loaderTarget) setCustomName(defaultName(kind, loaderTarget))
    if (kind === 'vanilla') {
      setLoaderVersions([])
      setLoaderVersion('')
      setLoaderError(null)
      return
    }
    if (loaderTarget) await fetchLoaderVersions(loaderTarget, kind)
  }

  const confirmLoader = async (): Promise<void> => {
    if (!loaderTarget) return
    const name = sanitizeName(customName)
    if (!name) {
      setLoaderError('请输入有效的版本名')
      return
    }
    if (installed.some((v) => v.id === name)) {
      setLoaderError(`版本名「${name}」已存在，请更换`)
      return
    }
    if (loaderKind !== 'vanilla' && !loaderVersion) return
    setLoaderBusy(true)
    setLoaderError(null)
    setLoaderLog([])
    setLoaderTarget(null)
    try {
      if (loaderKind === 'vanilla') {
        await window.api.versions.createVanilla(loaderTarget, name)
        await installVersion(name)
      } else {
        // 带加载器：先下载原版，再安装加载器
        await installVersion(loaderTarget)
        const id =
          loaderKind === 'forge' || loaderKind === 'neoforge'
            ? await window.api.forge.install(loaderKind, loaderTarget, loaderVersion, name)
            : await window.api.loaders.install(loaderKind, loaderTarget, loaderVersion, name)
        await installVersion(id)
      }
      void refresh()
    } catch (err) {
      setLoaderError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoaderBusy(false)
    }
  }

  const isForge = loaderKind === 'forge' || loaderKind === 'neoforge'
  const isVanilla = loaderKind === 'vanilla'

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="display">版本</h1>
          <p className="caption mt-1">
            {manifest
              ? `最新正式版 ${manifest.latest.release} · 最新快照 ${manifest.latest.snapshot} · 已安装 ${installed.length} 个`
              : '正在加载版本清单…'}
          </p>
        </div>
        <Button icon="refresh" onClick={() => void refresh()}>
          刷新
        </Button>
      </div>

      {loading ? (
        <LoadingState text="正在获取版本列表…" />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {/* 所有版本（可重复安装） */}
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="title">所有版本</span>
              <span className="chip">{list.length}</span>
            </div>
            <div className="relative min-w-[180px] flex-1">
              <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 opacity-50" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索版本…"
                className="input w-full pl-9"
              />
            </div>
            <div className="inline-flex gap-1 rounded-xl p-1" style={{ background: 'var(--fill-secondary)' }}>
              {(
                [
                  ['all', '全部'],
                  ['release', '正式版'],
                  ['snapshot', '快照']
                ] as Array<[Filter, string]>
              ).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setFilter(value)}
                  className="rounded-lg px-3 py-1.5 text-[13px] font-medium no-drag"
                  style={{
                    background: filter === value ? 'var(--glass-bg-soft)' : 'transparent',
                    color: filter === value ? 'var(--text-primary)' : 'var(--text-secondary)'
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2.5 pb-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((v, i) => {
              const installing = installingId === v.id
              return (
                <motion.div
                  key={v.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.008, 0.2) }}
                  className="glass flex items-center gap-3 rounded-2xl p-3.5"
                >
                  <div
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white"
                    style={{
                      background:
                        v.type === 'snapshot'
                          ? 'linear-gradient(135deg,#ff9f0a,#ff375f)'
                          : 'linear-gradient(135deg,#30d158,#0a84ff)'
                    }}
                  >
                    <Icon name="cube" size={17} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold">{v.id}</div>
                    <div className="caption">
                      {v.type === 'snapshot' ? '快照' : '正式'} · {v.releaseTime.slice(0, 10)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant={installing ? 'secondary' : 'primary'}
                      icon="download"
                      disabled={busy && !installing}
                      onClick={() => void openLoader(v.id)}
                    >
                      {installing ? '安装中' : '安装'}
                    </Button>
                  </div>
                </motion.div>
              )
            })}
          </div>

          {installingId && download && (
            <div className="glass-strong sticky bottom-2 rounded-2xl p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="headline">正在安装 {installingId}</span>
                <span className="caption">{download.percent}%</span>
              </div>
              <ProgressBar percent={download.percent} />
              <div className="caption mt-2 truncate">
                {download.task} · {download.current}/{download.total}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Loader install sheet */}
      <AnimatePresence>
        {loaderTarget && (
          <motion.div
            className="absolute inset-0 z-50 flex items-center justify-center p-6"
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
              onClick={() => setLoaderTarget(null)}
            />
            <motion.div
              className="glass-strong relative z-10 flex max-h-[80vh] w-full max-w-md flex-col rounded-[32px] p-7"
              initial={{ opacity: 0, scale: 0.92, y: 24 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 16 }}
              transition={{ type: 'spring', bounce: 0.2, duration: 0.45 }}
            >
              <div className="mb-5">
                <h2 className="title">安装 {loaderTarget}</h2>
                <p className="caption mt-1">选择安装方式（可同时安装模组加载器）</p>
              </div>

              <div className="mb-4">
                <Segmented value={loaderKind} onChange={(v) => void switchLoaderKind(v)} options={LOADER_OPTIONS} />
              </div>

              <div className="mb-4">
                <div className="caption mb-2">版本名</div>
                <input
                  value={customName}
                  onChange={(e) => {
                    setCustomName(e.target.value)
                    setNameTouched(true)
                  }}
                  placeholder="输入自定义版本名"
                  className="input w-full"
                />
                {nameTaken && (
                  <div className="mt-1 text-[12px]" style={{ color: 'var(--fill-danger)' }}>
                    版本名「{sanitizeName(customName)}」已存在，请更换
                  </div>
                )}
              </div>

              {loaderError && (
                <div
                  className="mb-4 rounded-xl p-3 text-[13px]"
                  style={{ background: 'rgba(255,69,58,0.14)', color: 'var(--fill-danger)' }}
                >
                  {loaderError}
                </div>
              )}

              {!isVanilla && (
                <div className="mb-4">
                  <div className="caption mb-2">加载器版本</div>
                  <select
                    value={loaderVersion}
                    onChange={(e) => setLoaderVersion(e.target.value)}
                    className="input w-full"
                    disabled={loaderVersions.length === 0 || loaderBusy}
                  >
                    {loaderVersions.length === 0 && <option>{loaderBusy ? '安装中…' : '加载中…'}</option>}
                    {loaderVersions.map((lv) => (
                      <option key={lv} value={lv}>
                        {lv}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {isForge && loaderLog.length > 0 && (
                <div
                  ref={logRef}
                  className="selectable mb-4 max-h-40 min-h-[80px] overflow-y-auto rounded-xl p-3 font-mono text-[11px] leading-relaxed"
                  style={{ background: 'rgba(0,0,0,0.28)', color: 'rgba(255,255,255,0.8)' }}
                >
                  {loaderLog.map((line, i) => (
                    <div key={i} className="whitespace-pre-wrap break-all">
                      {line}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <Button className="flex-1" onClick={() => setLoaderTarget(null)} disabled={loaderBusy}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  className="flex-1"
                  disabled={(isVanilla ? false : !loaderVersion) || loaderBusy || !customName.trim() || nameTaken}
                  onClick={() => void confirmLoader()}
                >
                  {loaderBusy ? '安装中…' : '安装'}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
