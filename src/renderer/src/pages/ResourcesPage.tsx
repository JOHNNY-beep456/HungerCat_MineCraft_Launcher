import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ModrinthProject, ModrinthType, ModrinthVersion, ResourceFile, ResourceKind, VersionManifest } from '@shared/types'
import { Button, Icon, LoadingState, Segmented, Spinner } from '../components/ui'

export function ResourcesPage(): JSX.Element {
  const [tab, setTab] = useState<ResourceKind>('resourcepacks')
  const [view, setView] = useState<'installed' | 'browse'>('installed')

  const [manifest, setManifest] = useState<VersionManifest | null>(null)
  const [mcVersion, setMcVersion] = useState('')

  const [installed, setInstalled] = useState<ResourceFile[]>([])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ModrinthProject[]>([])
  const [searching, setSearching] = useState(false)

  const [detail, setDetail] = useState<ModrinthProject | null>(null)
  const [versions, setVersions] = useState<ModrinthVersion[]>([])
  const [loadingVersions, setLoadingVersions] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const type: ModrinthType = tab === 'resourcepacks' ? 'resourcepack' : 'shader'

  useEffect(() => {
    void window.api.versions.list().then((m) => {
      setManifest(m)
      setMcVersion(m.latest.release || m.versions[0]?.id || '')
    })
  }, [])

  const refreshInstalled = useCallback(async () => {
    if (!mcVersion) return
    setInstalled(await window.api.resources.list(mcVersion, tab))
  }, [mcVersion, tab])

  useEffect(() => {
    void refreshInstalled()
  }, [refreshInstalled])

  const doSearch = async (q: string): Promise<void> => {
    if (!q.trim()) {
      setResults([])
      return
    }
    setSearching(true)
    try {
      setResults((await window.api.mods.search(q, type)).hits)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setSearching(false)
    }
  }

  const openDetail = async (p: ModrinthProject): Promise<void> => {
    setDetail(p)
    setVersions([])
    setMessage(null)
    setLoadingVersions(true)
    try {
      setVersions(await window.api.mods.versions(p.slug, [], [mcVersion]))
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingVersions(false)
    }
  }

  const download = async (v: ModrinthVersion): Promise<void> => {
    const file = v.files.find((f) => f.primary) ?? v.files[0]
    if (!file) return
    setInstalling(v.id)
    setMessage(null)
    try {
      await window.api.mods.install(file.url, file.filename, mcVersion, type)
      setMessage(`已安装 ${file.filename}`)
      void refreshInstalled()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(null)
    }
  }

  const remove = async (f: ResourceFile): Promise<void> => {
    await window.api.resources.remove(f.path)
    void refreshInstalled()
  }

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="display">资源</h1>
          <p className="caption mt-1">管理资源包与光影（Modrinth，暂不支持 CurseForge）</p>
        </div>
        <Segmented
          value={tab}
          onChange={(v) => setTab(v)}
          options={[
            { value: 'resourcepacks', label: '资源包' },
            { value: 'shaderpacks', label: '光影' }
          ]}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="caption">版本</span>
          <select value={mcVersion} onChange={(e) => setMcVersion(e.target.value)} className="input">
            {(manifest?.versions ?? []).filter((v) => v.type === 'release').slice(0, 60).map((v) => (
              <option key={v.id} value={v.id}>
                {v.id}
              </option>
            ))}
          </select>
        </div>
        <Segmented
          value={view}
          onChange={(v) => setView(v)}
          options={[
            { value: 'installed', label: '已安装' },
            { value: 'browse', label: '在线获取' }
          ]}
        />
        <div className="flex-1" />
        <Button
          icon="folder"
          onClick={async () => {
            const dir = await window.api.resources.open(mcVersion, tab)
            void window.api.shell.openPath(dir)
          }}
        >
          打开文件夹
        </Button>
      </div>

      {message && <div className="glass-soft rounded-2xl px-4 py-3 text-[13px]">{message}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {view === 'installed' ? (
          installed.length === 0 ? (
            <EmptyState text={`还没有已安装的${tab === 'resourcepacks' ? '资源包' : '光影'}`} />
          ) : (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
              {installed.map((f) => (
                <div key={f.path} className="glass flex items-center gap-3 rounded-2xl p-3.5">
                  <div
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white"
                    style={{ background: tab === 'resourcepacks' ? 'linear-gradient(135deg,#0a84ff,#7a5cff)' : 'linear-gradient(135deg,#30d158,#0a84ff)' }}
                  >
                    <Icon name="palette" size={17} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{f.name}</div>
                    <div className="caption">{formatBytes(f.size)}</div>
                  </div>
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => void remove(f)} title="删除" />
                </div>
              ))}
            </div>
          )
        ) : (
          <>
            <form
              className="mb-4 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void doSearch(query)
              }}
            >
              <div className="relative flex-1">
                <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 opacity-50" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={tab === 'resourcepacks' ? '搜索资源包，如 Faithful、Compliance…' : '搜索光影，如 BSL、Complementary…'}
                  className="input w-full pl-9"
                />
              </div>
              <Button variant="primary" icon="search" disabled={searching} onClick={() => void doSearch(query)}>
                搜索
              </Button>
            </form>

            {searching ? (
              <LoadingState text="正在搜索…" />
            ) : results.length === 0 ? (
              <EmptyState text="输入关键词搜索资源" />
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {results.map((p, i) => (
                  <motion.button
                    key={p.slug}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i * 0.02, 0.3) }}
                    onClick={() => void openDetail(p)}
                    className="glass flex items-start gap-3 rounded-2xl p-4 text-left no-drag transition-transform active:scale-[0.98]"
                  >
                    <ModIcon url={p.icon_url} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-semibold">{p.title}</div>
                      <p className="caption mt-0.5 line-clamp-2">{p.description}</p>
                      <div className="mt-2 flex items-center gap-2">
                        <span className="chip">{formatCount(p.downloads)} 下载</span>
                      </div>
                    </div>
                  </motion.button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Detail sheet */}
      <AnimatePresence>
        {detail && (
          <motion.div className="absolute inset-0 z-50 flex items-center justify-center p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div className="absolute inset-0" style={{ background: 'var(--scrim)' }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setDetail(null)} />
            <motion.div
              className="glass-strong relative z-10 flex max-h-[80vh] w-full max-w-lg flex-col rounded-[32px] p-7"
              initial={{ opacity: 0, scale: 0.92, y: 24 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 16 }}
              transition={{ type: 'spring', bounce: 0.2, duration: 0.45 }}
            >
              <div className="mb-4 flex items-start gap-3">
                <ModIcon url={detail.icon_url} size={52} />
                <div className="min-w-0 flex-1">
                  <h2 className="title">{detail.title}</h2>
                  <p className="caption mt-0.5 line-clamp-2">{detail.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => void window.api.shell.openExternal(`https://modrinth.com/${detail.project_type}/${detail.slug}`)}
                    className="no-drag shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium opacity-70 hover:opacity-100"
                    style={{ background: 'var(--fill-secondary)' }}
                  >
                    更多信息..
                  </button>
                  <button onClick={() => setDetail(null)} className="no-drag opacity-50 hover:opacity-100">
                    <Icon name="xmark" size={20} />
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                {loadingVersions ? (
                  <div className="flex flex-col items-center gap-2 p-6">
                    <Spinner size={22} />
                    <span className="caption">加载版本中…</span>
                  </div>
                ) : versions.length === 0 ? (
                  <div className="caption p-4 text-center">没有匹配 {mcVersion} 的版本</div>
                ) : (
                  <div className="space-y-2">
                    {versions.slice(0, 30).map((v) => (
                      <div key={v.id} className="glass-soft flex items-center justify-between rounded-xl px-3.5 py-2.5">
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium">{v.version_number}</div>
                          <div className="caption">{v.game_versions.join(', ')} · {formatCount(v.downloads)} 下载</div>
                        </div>
                        <Button size="sm" variant="primary" disabled={installing === v.id} onClick={() => void download(v)}>
                          {installing === v.id ? '下载中' : '安装'}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function EmptyState({ text }: { text: string }): JSX.Element {
  return (
    <div className="glass flex flex-col items-center justify-center gap-3 rounded-[28px] p-12 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl" style={{ background: 'var(--fill-secondary)' }}>
        <Icon name="palette" size={30} className="opacity-60" />
      </div>
      <div className="title">{text}</div>
    </div>
  )
}

function ModIcon({ url, size = 44 }: { url?: string; size?: number }): JSX.Element {
  if (url) {
    return <img src={url} width={size} height={size} alt="" draggable={false} className="shrink-0 rounded-xl object-cover" style={{ background: 'var(--fill-secondary)' }} />
  }
  return (
    <div className="flex shrink-0 items-center justify-center rounded-xl" style={{ width: size, height: size, background: 'var(--fill-secondary)' }}>
      <Icon name="palette" size={size * 0.45} className="opacity-50" />
    </div>
  )
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

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
