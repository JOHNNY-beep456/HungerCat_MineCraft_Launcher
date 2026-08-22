import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { InstalledVersion, ModpackProbe, ModrinthProject, ModrinthType, ModrinthVersion, VersionManifest } from '@shared/types'
import { useRuntimeActions } from '../runtime'
import { Button, Icon, LoadingState, Segmented, Spinner } from '../components/ui'
import { VersionsPage } from './VersionsPage'

type Tab = 'mod' | 'resourcepack' | 'shader' | 'modpack' | 'versions'
type BrowseTab = Exclude<Tab, 'versions'>

const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'mod', label: '模组' },
  { value: 'resourcepack', label: '资源包' },
  { value: 'shader', label: '光影' },
  { value: 'modpack', label: '整合包' },
  { value: 'versions', label: '版本' }
]

const LOADERS: Record<BrowseTab, string[]> = {
  mod: ['fabric', 'quilt', 'forge', 'neoforge'],
  resourcepack: [],
  shader: ['iris', 'optifine'],
  modpack: ['fabric', 'quilt', 'forge', 'neoforge']
}

const CATEGORIES: Array<{ value: string; label: string }> = [
  { value: 'all', label: '全部类别' },
  { value: 'adventure', label: '冒险' },
  { value: 'technology', label: '科技' },
  { value: 'magic', label: '魔法' },
  { value: 'decoration', label: '装饰' },
  { value: 'optimization', label: '优化' },
  { value: 'utility', label: '工具' },
  { value: 'worldgen', label: '世界' },
  { value: 'equipment', label: '装备' },
  { value: 'library', label: '前置库' }
]

function loaderLabel(l: string | null): string {
  if (!l) return '原版'
  const map: Record<string, string> = { iris: 'Iris', optifine: 'OptiFine' }
  return map[l] ?? l.charAt(0).toUpperCase() + l.slice(1)
}

function sortMc(list: string[]): string[] {
  return [...list].sort((a, b) => {
    const pa = a.split('.').map(Number)
    const pb = b.split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] ?? 0
      const y = pb[i] ?? 0
      if (x !== y) return y - x
    }
    return 0
  })
}

export function ResourceDownloadPage(): JSX.Element {
  const [tab, setTab] = useState<Tab>('mod')

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="display">资源下载</h1>
          <p className="caption mt-1">浏览并下载模组、资源包、光影、整合包与游戏版本</p>
        </div>
        <Segmented value={tab} onChange={setTab} options={TABS} />
      </div>

      <div className="min-h-0 flex-1">
        {tab === 'versions' ? <VersionsPage /> : <Browser key={tab} type={tab} />}
      </div>
    </div>
  )
}

function Browser({ type }: { type: BrowseTab }): JSX.Element {
  const modrinthType: ModrinthType = type

  const [manifest, setManifest] = useState<VersionManifest | null>(null)
  const [installed, setInstalled] = useState<InstalledVersion[]>([])
  const [mcVersion, setMcVersion] = useState('')
  const [loader, setLoader] = useState('all')
  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ModrinthProject[]>([])
  const [totalHits, setTotalHits] = useState(0)
  const [searching, setSearching] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [detail, setDetail] = useState<ModrinthProject | null>(null)

  const loaders = LOADERS[type]
  // 分页与请求竞态守卫：requestSeq 在每次重新搜索时递增，使过期页结果失效；
  // loadingToken 用于防止「加载更多」并发或过期请求误清标记。
  const requestSeq = useRef(0)
  const loadingToken = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void Promise.all([window.api.versions.list(), window.api.installed.list()]).then(([m, i]) => {
      setManifest(m)
      setInstalled(i)
      setMcVersion(m.latest.release || m.versions[0]?.id || '')
    })
  }, [])

  const doSearch = async (q: string): Promise<void> => {
    const seq = ++requestSeq.current
    setSearching(true)
    setLoadingMore(false)
    setMessage(null)
    try {
      const cat = type === 'mod' ? category : undefined
      const r = await window.api.mods.search(q, modrinthType, cat, mcVersion || undefined, loader, 0)
      if (seq !== requestSeq.current) return
      setResults(r.hits)
      setTotalHits(r.totalHits)
    } catch (err) {
      if (seq !== requestSeq.current) return
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      if (seq === requestSeq.current) setSearching(false)
    }
  }

  const loadMore = async (): Promise<void> => {
    if (searching || loadingToken.current !== 0 || results.length >= totalHits) return
    const token = ++loadingToken.current
    const seq = requestSeq.current
    setLoadingMore(true)
    try {
      const cat = type === 'mod' ? category : undefined
      const r = await window.api.mods.search(query, modrinthType, cat, mcVersion || undefined, loader, results.length)
      if (seq !== requestSeq.current) return
      setTotalHits(r.totalHits)
      setResults((prev) => {
        const seen = new Set(prev.map((p) => p.slug))
        return [...prev, ...r.hits.filter((p) => !seen.has(p.slug))]
      })
    } catch (err) {
      if (seq !== requestSeq.current) return
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      if (token === loadingToken.current) loadingToken.current = 0
      setLoadingMore(false)
    }
  }

  const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) void loadMore()
  }

  // 自动加载推荐（未搜索时）与筛选结果
  useEffect(() => {
    const t = setTimeout(() => void doSearch(query), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, type, category, mcVersion, loader])

  if (detail) {
    return (
      <ProjectDetail
        project={detail}
        type={modrinthType}
        installed={installed}
        filterMcVersion={mcVersion}
        filterLoader={loader}
        onBack={() => setDetail(null)}
      />
    )
  }

  return (
    <div className="flex h-full flex-col gap-4">
      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-3">
        <form
          className="relative min-w-[200px] flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            void doSearch(query)
          }}
        >
          <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 opacity-50" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={query.trim() ? '搜索…' : '热门推荐（输入关键词搜索）'}
            className="input w-full pl-9"
          />
        </form>

        <FilterSelect label="版本" value={mcVersion} onChange={setMcVersion} options={(manifest?.versions ?? []).filter((v) => v.type === 'release').slice(0, 60).map((v) => v.id)} />
        {loaders.length > 0 && (
          <FilterSelect
            label="加载器"
            value={loader}
            onChange={setLoader}
            options={['all', ...loaders]}
            render={(l) => (l === 'all' ? '全部' : loaderLabel(l))}
          />
        )}
        {type === 'mod' && (
          <FilterSelect
            label="类别"
            value={category}
            onChange={setCategory}
            options={CATEGORIES.map((c) => c.value)}
            render={(c) => CATEGORIES.find((x) => x.value === c)?.label ?? c}
          />
        )}
      </div>

      {message && <div className="glass-soft rounded-2xl px-4 py-3 text-[13px]">{message}</div>}

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto pr-1">
        {searching ? (
          <LoadingState text="正在加载…" />
        ) : results.length === 0 ? (
          <EmptyState type={type} />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {results.map((p, i) => (
                <motion.button
                  key={p.slug}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.02, 0.3) }}
                  onClick={() => setDetail(p)}
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
            {loadingMore && (
              <div className="flex items-center justify-center gap-2 py-4">
                <Spinner size={18} />
                <span className="caption">加载更多…</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function ProjectDetail({
  project,
  type,
  installed,
  filterMcVersion,
  filterLoader,
  onBack
}: {
  project: ModrinthProject
  type: ModrinthType
  installed: InstalledVersion[]
  filterMcVersion: string
  filterLoader: string
  onBack: () => void
}): JSX.Element {
  const [versions, setVersions] = useState<ModrinthVersion[]>([])
  const [loading, setLoading] = useState(true)
  const [mcTab, setMcTab] = useState('')

  useEffect(() => {
    setLoading(true)
    void window.api.mods.versions(project.slug, [], []).then((vs) => {
      setVersions(vs)
      // 优先选中筛选器锁定的 MC 版本
      const allGv = vs.flatMap((v) => v.game_versions)
      setMcTab(filterMcVersion && allGv.includes(filterMcVersion) ? filterMcVersion : vs[0]?.game_versions[0] ?? '')
      setLoading(false)
    })
  }, [project.slug, filterMcVersion])

  const mcGroups = useMemo(() => groupVersions(versions), [versions])
  const mcTabs = sortMc([...mcGroups.keys()].filter((k) => k !== '通用'))
  const activeMc = mcGroups.has(mcTab) ? mcTab : mcTabs[0] ?? '通用'
  const loaderGroups = mcGroups.get(activeMc) ?? new Map<string, ModrinthVersion[]>()
  const preferredLoader = filterLoader !== 'all' ? filterLoader : ''

  const isModpack = type === 'modpack'
  const [modpackPending, setModpackPending] = useState<{ temp: string; probe: ModpackProbe } | null>(null)
  const [modpackRename, setModpackRename] = useState('')
  const [modpackBusy, setModpackBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const installModpack = async (v: ModrinthVersion): Promise<void> => {
    const file = v.files.find((f) => f.primary) ?? v.files[0]
    if (!file) return
    setModpackBusy(true)
    setNotice(null)
    try {
      const temp = await window.api.modpack.download(file.url, file.filename)
      const probe = await window.api.modpack.probe(temp)
      const taken = installed.some((ins) => ins.id === probe.name)
      if (taken) {
        setModpackPending({ temp, probe })
        setModpackRename(`${probe.name}-副本`)
      } else {
        await window.api.modpack.import(temp, probe.name)
        setNotice(`已安装整合包「${probe.name}」，请到「实例」页查看`)
      }
    } catch (err) {
      setNotice(`安装失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setModpackBusy(false)
    }
  }

  const confirmModpackImport = async (): Promise<void> => {
    if (!modpackPending) return
    const name = modpackRename.trim()
    if (!name) return
    const { temp } = modpackPending
    setModpackPending(null)
    setModpackBusy(true)
    setNotice(null)
    try {
      await window.api.modpack.import(temp, name)
      setNotice(`已安装整合包「${name}」，请到「实例」页查看`)
    } catch (err) {
      setNotice(`安装失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setModpackBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <button onClick={onBack} className="flex items-center gap-1 text-[13px] opacity-70 hover:opacity-100 no-drag">
        <Icon name="chevronRight" size={15} className="rotate-180" />
        返回
      </button>

      {/* 顶部：图标 + 名称 + 简介 */}
      <div className="glass flex items-start gap-4 rounded-[24px] p-5">
        <ModIcon url={project.icon_url} size={72} />
        <div className="min-w-0 flex-1">
          <h2 className="title">{project.title}</h2>
          <p className="caption mt-1 line-clamp-3 selectable">{project.description}</p>
          <div className="mt-2 flex items-center gap-2">
            <span className="chip">{formatCount(project.downloads)} 下载</span>
            {project.categories.slice(0, 3).map((c) => (
              <span key={c} className="chip">
                {c}
              </span>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => void window.api.shell.openExternal(`https://modrinth.com/${project.project_type}/${project.slug}`)}
            className="no-drag shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium opacity-70 hover:opacity-100"
            style={{ background: 'var(--fill-secondary)' }}
          >
            更多信息..
          </button>
        </div>
      </div>

      {/* MC 版本分栏 */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {mcTabs.map((mc) => (
          <button
            key={mc}
            onClick={() => setMcTab(mc)}
            className="shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium no-drag transition-colors"
            style={{
              background: activeMc === mc ? 'var(--fill-primary)' : 'var(--fill-secondary)',
              color: activeMc === mc ? '#fff' : 'var(--text-secondary)'
            }}
          >
            {mc}
          </button>
        ))}
      </div>

      {/* 加载器抽屉 / 版本列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {loading ? (
          <div className="flex flex-col items-center gap-2 p-6">
            <Spinner size={22} />
            <span className="caption">加载版本中…</span>
          </div>
        ) : (
          <div className="space-y-2">
            {[...loaderGroups.entries()].map(([loaderKey, vs]) => (
              <LoaderDrawer
                key={loaderKey || 'none'}
                loader={loaderKey}
                versions={vs}
                type={type}
                installed={installed}
                preferredLoader={preferredLoader}
                isModpack={isModpack}
                onInstallModpack={installModpack}
                modpackBusy={modpackBusy}
              />
            ))}
          </div>
        )}
      </div>

      {notice && (
        <div className="glass-soft flex items-center justify-between gap-3 rounded-2xl px-4 py-3 text-[13px]">
          <span className="truncate">{notice}</span>
          <button className="no-drag opacity-60 hover:opacity-100" onClick={() => setNotice(null)}>
            <Icon name="xmark" size={15} />
          </button>
        </div>
      )}

      {/* 整合包重命名弹窗 */}
      <AnimatePresence>
        {modpackPending && (
          <motion.div
            className="absolute inset-0 z-50 flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={() => setModpackPending(null)} />
            <motion.div
              className="glass-strong relative z-10 w-full max-w-sm rounded-[28px] p-6"
              initial={{ scale: 0.94, opacity: 0, y: 12 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.94, opacity: 0, y: 12 }}
              transition={{ type: 'spring', bounce: 0.18, duration: 0.4 }}
            >
              <h2 className="title mb-1">实例名已存在</h2>
              <p className="caption mb-4">整合包「{modpackPending.probe.name}」的名称已被占用，请输入新的实例名：</p>
              <input
                autoFocus
                value={modpackRename}
                onChange={(e) => setModpackRename(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && modpackRename.trim() && void confirmModpackImport()}
                placeholder="新的实例名"
                className="input mb-5 w-full"
              />
              <div className="flex gap-2">
                <Button className="flex-1" onClick={() => setModpackPending(null)}>
                  取消
                </Button>
                <Button variant="primary" className="flex-1" disabled={!modpackRename.trim()} onClick={() => void confirmModpackImport()}>
                  安装
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function LoaderDrawer({
  loader,
  versions,
  type,
  installed,
  preferredLoader,
  isModpack,
  onInstallModpack,
  modpackBusy
}: {
  loader: string
  versions: ModrinthVersion[]
  type: ModrinthType
  installed: InstalledVersion[]
  preferredLoader?: string
  isModpack?: boolean
  onInstallModpack?: (v: ModrinthVersion) => void
  modpackBusy?: boolean
}): JSX.Element {
  const hasLoader = loader !== ''
  // 优先展开筛选器锁定的加载器
  const isPreferred = hasLoader && !!preferredLoader && loader.split(' / ').some((l) => l.toLowerCase() === preferredLoader.toLowerCase())
  const [open, setOpen] = useState(isPreferred || loader === '' || versions.length === 1)

  return (
    <div className="glass-soft rounded-2xl">
      <button
        onClick={() => setOpen((x) => !x)}
        className="flex w-full items-center gap-2 px-4 py-3 no-drag"
      >
        <span className="text-[14px] font-medium">{hasLoader ? loader.split(' / ').map(loaderLabel).join(' / ') : '通用（无需加载器）'}</span>
        <span className="chip">{versions.length}</span>
        <span className="ml-auto opacity-50">
          <Icon name="chevronRight" size={16} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        </span>
      </button>
      {open && (
        <div className="space-y-1.5 border-t px-4 py-3" style={{ borderColor: 'var(--divider)' }}>
          {versions.map((v) => (
            <VersionEntry
              key={v.id}
              v={v}
              type={type}
              installed={installed}
              isModpack={isModpack}
              onInstallModpack={onInstallModpack}
              modpackBusy={modpackBusy}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function VersionEntry({
  v,
  type,
  installed,
  isModpack,
  onInstallModpack,
  modpackBusy
}: {
  v: ModrinthVersion
  type: ModrinthType
  installed: InstalledVersion[]
  isModpack?: boolean
  onInstallModpack?: (v: ModrinthVersion) => void
  modpackBusy?: boolean
}): JSX.Element {
  const { triggerFly } = useRuntimeActions()
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)

  const compatible = installed.filter((ins) => {
    const mcOk = v.game_versions.length === 0 || v.game_versions.includes(ins.mcVersion)
    if (!mcOk) return false
    // 资源包 / 数据包与加载器无关，任意加载器（含原版）实例都能安装
    if (type === 'resourcepack') return true
    // 其余类型需匹配加载器；'minecraft' 视为原版（无加载器）实例
    const loaderOk =
      v.loaders.length === 0 ||
      v.loaders.some((l) =>
        l.toLowerCase() === 'minecraft' ? !ins.loader : (ins.loader ?? '').toLowerCase() === l.toLowerCase()
      )
    return loaderOk
  })

  const fire = async (e: React.MouseEvent, target: InstalledVersion | null): Promise<void> => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    triggerFly(r.left + r.width / 2, r.top + r.height / 2)
    const file = v.files.find((f) => f.primary) ?? v.files[0]
    if (!file) return
    setBusy(true)
    try {
      if (target) {
        await window.api.mods.install(file.url, file.filename, target.id, type)
      } else {
        const dest = await window.api.shell.saveFile(file.filename)
        if (dest) await window.api.mods.downloadTo(file.url, dest)
      }
      setExpanded(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl px-3 py-2" style={{ background: 'var(--fill-secondary)' }}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{v.version_number}</div>
          <div className="caption">{formatCount(v.downloads)} 下载 · {formatDate(v.date_published)}</div>
        </div>
        <Button
          size="sm"
          variant={isModpack ? 'primary' : expanded ? 'secondary' : 'primary'}
          disabled={busy || modpackBusy}
          onClick={() => (isModpack ? onInstallModpack?.(v) : setExpanded((x) => !x))}
        >
          {isModpack ? (modpackBusy ? '安装中…' : '安装整合包') : busy ? '下载中' : expanded ? '收起' : '安装'}
        </Button>
      </div>

      {expanded && (
        <div className="mt-2 space-y-1.5 border-t pt-2" style={{ borderColor: 'var(--divider)' }}>
          <div className="caption">安装到可匹配实例：</div>
          {compatible.length === 0 && <div className="caption opacity-60">没有匹配的实例（版本与加载器需匹配）</div>}
          {compatible.map((ins) => (
            <button
              key={ins.id}
              onClick={(e) => void fire(e, ins)}
              className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-[13px] no-drag hover:opacity-80"
              style={{ background: 'var(--chip-bg)' }}
            >
              <span className="truncate">{ins.id}</span>
              <span className="caption shrink-0">
                {ins.mcVersion} · {loaderLabel(ins.loader)}
              </span>
            </button>
          ))}
          <button
            onClick={(e) => void fire(e, null)}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] no-drag opacity-70 hover:opacity-100"
            style={{ background: 'var(--chip-bg)' }}
          >
            <Icon name="download" size={14} />
            下载至任意位置
          </button>
        </div>
      )}
    </div>
  )
}

function groupVersions(versions: ModrinthVersion[]): Map<string, Map<string, ModrinthVersion[]>> {
  const mc = new Map<string, Map<string, ModrinthVersion[]>>()
  for (const v of versions) {
    const gvs = v.game_versions.length > 0 ? v.game_versions : ['通用']
    for (const gv of gvs) {
      if (!mc.has(gv)) mc.set(gv, new Map())
      const loaderKey = v.loaders.length > 0 ? v.loaders.join(' / ') : ''
      const lg = mc.get(gv)!
      if (!lg.has(loaderKey)) lg.set(loaderKey, [])
      lg.get(loaderKey)!.push(v)
    }
  }
  return mc
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  render
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: string[]
  render?: (v: string) => string
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="caption">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="input">
        {options.map((o) => (
          <option key={o} value={o}>
            {render ? render(o) : o}
          </option>
        ))}
      </select>
    </div>
  )
}

function ModIcon({ url, size = 44 }: { url?: string; size?: number }): JSX.Element {
  if (url) {
    return <img src={url} width={size} height={size} alt="" draggable={false} className="shrink-0 rounded-xl object-cover" style={{ background: 'var(--fill-secondary)' }} />
  }
  return (
    <div className="flex shrink-0 items-center justify-center rounded-xl" style={{ width: size, height: size, background: 'var(--fill-secondary)' }}>
      <Icon name="box" size={size * 0.45} className="opacity-50" />
    </div>
  )
}

function EmptyState({ type }: { type: string }): JSX.Element {
  const label =
    type === 'mod'
      ? '模组'
      : type === 'resourcepack'
        ? '资源包'
        : type === 'shader'
          ? '光影'
          : '整合包'
  return (
    <div className="glass flex flex-col items-center justify-center gap-3 rounded-[28px] p-12 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl" style={{ background: 'var(--fill-secondary)' }}>
        <Icon name="box" size={30} className="opacity-60" />
      </div>
      <div className="title">没有找到相关{label}</div>
      <p className="caption max-w-sm">可尝试更换关键词、版本或加载器筛选条件</p>
    </div>
  )
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatDate(d?: string): string {
  if (!d) return ''
  return d.slice(0, 10)
}
