import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ModrinthProject, ModrinthVersion, VersionManifest } from '@shared/types'
import { Button, Icon, LoadingState, Segmented, Spinner } from '../components/ui'

type Loader = 'fabric' | 'quilt' | 'forge' | 'neoforge'

export function ModsPage(): JSX.Element {
  const [manifest, setManifest] = useState<VersionManifest | null>(null)
  const [mcVersion, setMcVersion] = useState('')
  const [loader, setLoader] = useState<Loader>('fabric')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ModrinthProject[]>([])
  const [searching, setSearching] = useState(false)

  // Detail sheet
  const [detail, setDetail] = useState<ModrinthProject | null>(null)
  const [versions, setVersions] = useState<ModrinthVersion[]>([])
  const [loadingVersions, setLoadingVersions] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    void window.api.versions.list().then((m) => {
      setManifest(m)
      setMcVersion(m.latest.release || m.versions[0]?.id || '')
    }).catch(() => { /* versions:list 失败时保持上次清单 */ })
  }, [])

  const doSearch = async (q: string): Promise<void> => {
    if (!q.trim()) {
      setResults([])
      return
    }
    setSearching(true)
    try {
      // 加载器在 Modrinth 搜索中归入 categories 维度，随 MC 版本一并筛选
      setResults((await window.api.mods.search(q, undefined, undefined, mcVersion || undefined, loader)).hits)
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
      setVersions(await window.api.mods.versions(p.slug, [loader], [mcVersion]))
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
      await window.api.mods.install(file.url, file.filename, mcVersion)
      setMessage(`已安装 ${file.filename} 到 ${mcVersion} 的 mods 目录`)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(null)
    }
  }

  const releaseVersions = useMemo(
    () => (manifest ? manifest.versions.filter((v) => v.type === 'release').slice(0, 60) : []),
    [manifest]
  )

  return (
    <div className="flex h-full flex-col gap-5">
      <div>
        <h1 className="display">模组</h1>
        <p className="caption mt-1">从 Modrinth 浏览并安装模组（暂不支持 CurseForge）</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="caption">版本</span>
          <select value={mcVersion} onChange={(e) => setMcVersion(e.target.value)} className="input">
            {releaseVersions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.id}
              </option>
            ))}
          </select>
        </div>
        <Segmented
          value={loader}
          onChange={(v) => setLoader(v)}
          options={[
            { value: 'fabric', label: 'Fabric' },
            { value: 'quilt', label: 'Quilt' },
            { value: 'forge', label: 'Forge' },
            { value: 'neoforge', label: 'NeoForge' }
          ]}
        />
        <form
          className="relative flex-1 min-w-[220px]"
          onSubmit={(e) => {
            e.preventDefault()
            void doSearch(query)
          }}
        >
          <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 opacity-50" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模组，如 sodium、jei、optifine…"
            className="input w-full pl-9"
          />
        </form>
        <Button variant="primary" icon="search" disabled={searching} onClick={() => void doSearch(query)}>
          {searching ? '搜索中' : '搜索'}
        </Button>
      </div>

      {message && (
        <div className="glass-soft rounded-2xl px-4 py-3 text-[13px]">{message}</div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {searching ? (
          <LoadingState text="正在搜索模组…" />
        ) : results.length === 0 ? (
          <div className="glass flex flex-col items-center justify-center gap-3 rounded-[28px] p-12 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl" style={{ background: 'var(--fill-secondary)' }}>
              <Icon name="box" size={30} className="opacity-60" />
            </div>
            <div className="title">搜索并安装模组</div>
            <p className="caption max-w-sm">
              输入模组名称关键词开始搜索，结果将匹配你所选的 Minecraft 版本与加载器
            </p>
          </div>
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
                    {p.categories.slice(0, 2).map((c) => (
                      <span key={c} className="chip">
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              </motion.button>
            ))}
          </div>
        )}
      </div>

      {/* Detail sheet */}
      <AnimatePresence>
        {detail && (
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
              onClick={() => setDetail(null)}
            />
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
                  <div className="caption p-4 text-center">
                    没有匹配 {mcVersion} + {loader} 的版本
                  </div>
                ) : (
                  <div className="space-y-2">
                    {versions.slice(0, 30).map((v) => (
                      <div
                        key={v.id}
                        className="glass-soft flex items-center justify-between rounded-xl px-3.5 py-2.5"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium">{v.version_number}</div>
                          <div className="caption">
                            {v.loaders.join(' / ')} · {v.game_versions.join(', ')} · {formatCount(v.downloads)} 下载
                          </div>
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

function ModIcon({ url, size = 44 }: { url?: string; size?: number }): JSX.Element {
  if (url) {
    return (
      <img
        src={url}
        width={size}
        height={size}
        alt=""
        draggable={false}
        className="shrink-0 rounded-xl object-cover"
        style={{ background: 'var(--fill-secondary)' }}
      />
    )
  }
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-xl"
      style={{ width: size, height: size, background: 'var(--fill-secondary)' }}
    >
      <Icon name="box" size={size * 0.45} className="opacity-50" />
    </div>
  )
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
