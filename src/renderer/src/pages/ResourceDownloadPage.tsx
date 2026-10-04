import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import type { InstalledVersion, ModEntry, ModpackProbe, ModrinthProject, ModrinthProjectDetail, ModrinthType, ModrinthVersion, SourceFilter, VersionManifest } from '@shared/types'
import { useRuntimeActions } from '../runtime'
import { Button, Icon, LoadingState, Markdown, Segmented, Select, Spinner } from '../components/ui'
import { VersionsPage } from './VersionsPage'
import { useAutoTranslate } from '../translate'
import { compileMarkdown } from '../markdown-translate'
import { useApp } from '../store'
import { modTitlePair } from '../mod-title'
import type { TFunction } from '../i18n'

export type Tab = 'mod' | 'resourcepack' | 'shader' | 'modpack' | 'versions'
type BrowseTab = Exclude<Tab, 'versions'>

const TABS: Array<{ value: Tab; labelKey: string }> = [
  { value: 'mod', labelKey: 'res.tab.mod' },
  { value: 'resourcepack', labelKey: 'res.tab.resourcepack' },
  { value: 'shader', labelKey: 'res.tab.shader' },
  { value: 'modpack', labelKey: 'res.tab.modpack' },
  { value: 'versions', labelKey: 'res.tab.versions' }
]

const LOADERS: Record<BrowseTab, string[]> = {
  mod: ['fabric', 'quilt', 'forge', 'neoforge'],
  resourcepack: [],
  shader: ['iris', 'optifine'],
  modpack: ['fabric', 'quilt', 'forge', 'neoforge']
}

const CATEGORIES: Array<{ value: string; labelKey: string }> = [
  { value: 'all', labelKey: 'res.cat.all' },
  { value: 'adventure', labelKey: 'res.cat.adventure' },
  { value: 'technology', labelKey: 'res.cat.technology' },
  { value: 'magic', labelKey: 'res.cat.magic' },
  { value: 'decoration', labelKey: 'res.cat.decoration' },
  { value: 'optimization', labelKey: 'res.cat.optimization' },
  { value: 'utility', labelKey: 'res.cat.utility' },
  { value: 'worldgen', labelKey: 'res.cat.worldgen' },
  { value: 'equipment', labelKey: 'res.cat.equipment' },
  { value: 'library', labelKey: 'res.cat.library' }
]

function loaderLabel(l: string | null, t: TFunction): string {
  if (!l) return t('res.loader.vanilla')
  const map: Record<string, string> = { iris: 'Iris', optifine: 'OptiFine' }
  return map[l] ?? l.charAt(0).toUpperCase() + l.slice(1)
}

/** 光影声明的「加载器」其实是运行时模组：按实例 mods 目录里的文件名判断是否已装。 */
const RUNTIME_LOADER_PATTERNS: Record<string, RegExp> = {
  iris: /^iris[-_]/i,
  optifine: /optifine/i
}

/** 版本分组的内部 key：资源未声明 MC 版本时归入此组（不面向用户展示）。 */
const GENERIC_MC_KEY = '通用'

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

export function ResourceDownloadPage({
  initialTab,
  presetSearch
}: {
  initialTab?: Tab
  presetSearch?: string
}): JSX.Element {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'mod')
  const { t } = useApp()

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="display">{t('res.title')}</h1>
          <p className="caption mt-1">{t('res.subtitle')}</p>
        </div>
        <Segmented value={tab} onChange={setTab} options={TABS.map((x) => ({ value: x.value, label: t(x.labelKey) }))} />
      </div>

      <div className="min-h-0 flex-1">
        {/* 模组/资源包/光影/整合包 ⇄ 版本：按 key 切换做淡入 + 轻微 y/scale 入场。
            这里只做入场、不用 AnimatePresence 的 mode="wait" 退场——退场会延后新视图
            挂载，若退场期间子视图持续重渲染，内容区会长时间空白。 */}
        <motion.div
          key={tab}
          className="h-full"
          initial={{ opacity: 0, y: 10, scale: 0.995 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
        >
          {tab === 'versions' ? <VersionsPage presetSearch={presetSearch} /> : <Browser key={tab} type={tab} />}
        </motion.div>
      </div>
    </div>
  )
}

function Browser({ type }: { type: BrowseTab }): JSX.Element {
  const modrinthType: ModrinthType = type
  const { t, settings } = useApp()

  const [manifest, setManifest] = useState<VersionManifest | null>(null)
  const [installed, setInstalled] = useState<InstalledVersion[]>([])
  const [mcVersion, setMcVersion] = useState('')
  const [loader, setLoader] = useState('all')
  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  /** 来源筛选：全部（Modrinth + CurseForge 合并）/ 仅 Modrinth / 仅 CurseForge。 */
  const [source, setSource] = useState<SourceFilter>('all')
  const [results, setResults] = useState<ModrinthProject[]>([])
  const [totalHits, setTotalHits] = useState(0)
  const [searching, setSearching] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [detail, setDetail] = useState<ModrinthProject | null>(null)
  // 实验性：资源名 / 简介自动翻译（仅当设置开启时才联网）。
  // 关闭「翻译资源名」时把标题传空串：hook 会跳过空文本，效果即只翻译简介。
  const tr = useAutoTranslate(
    results.flatMap((p) => [settings.translateResourceNames ? p.title : '', p.description])
  )

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
    }).catch(() => { /* 拉取清单/已装失败时保持上次状态 */ })
  }, [])

  // 整合包安装完成后刷新已安装列表，避免改名导入后的实例不显示、重名判断失效。
  useEffect(() => {
    return window.api.modpack.onProgress((p) => {
      if (p.phase === 'done') void window.api.installed.list().then(setInstalled).catch(() => {})
    })
  }, [])

  const doSearch = async (q: string): Promise<void> => {
    const seq = ++requestSeq.current
    setSearching(true)
    setLoadingMore(false)
    setMessage(null)
    try {
      const cat = type === 'mod' ? category : undefined
      const r = await window.api.mods.search(q, modrinthType, cat, mcVersion || undefined, loader, 0, source)
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
      const r = await window.api.mods.search(query, modrinthType, cat, mcVersion || undefined, loader, results.length, source)
      if (seq !== requestSeq.current) return
      setTotalHits(r.totalHits)
      setResults((prev) => {
        // 按「来源 + slug」去重：两个源的 slug 空间不同，只用 slug 会误合并
        const seen = new Set(prev.map((p) => `${p.source ?? 'modrinth'}:${p.slug}`))
        return [...prev, ...r.hits.filter((p) => !seen.has(`${p.source ?? 'modrinth'}:${p.slug}`))]
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
    const timer = setTimeout(() => void doSearch(query), 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, type, category, mcVersion, loader, source])

  return (
    // 结果列表 ⇄ 项目详情：按 key 切换做淡入入场。同样只做入场、不用 mode="wait" 退场，
    // 否则退出详情时要等退场结束才挂载列表，退场期间的重渲染会让列表迟迟不出现。
    <motion.div
      key={detail ? 'detail' : 'list'}
      className="h-full"
      initial={{ opacity: 0, y: 10, scale: 0.995 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
    >
      {detail ? (
        <ProjectDetail
          project={detail}
          type={modrinthType}
          installed={installed}
          filterMcVersion={mcVersion}
          filterLoader={loader}
          onBack={() => setDetail(null)}
        />
      ) : (
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
            placeholder={query.trim() ? t('res.search.placeholder') : t('res.search.hotPlaceholder')}
            className="input w-full pl-9"
          />
        </form>

        <FilterSelect label={t('res.filter.source')} value={source} onChange={(v) => setSource(v as SourceFilter)} options={['all', 'modrinth', 'curseforge']} render={(s) => t(`res.source.${s}`)} />

        <FilterSelect label={t('res.filter.version')} value={mcVersion} onChange={setMcVersion} options={(manifest?.versions ?? []).filter((v) => v.type === 'release').slice(0, 60).map((v) => v.id)} />
        {loaders.length > 0 && (
          <FilterSelect
            label={t('res.filter.loader')}
            value={loader}
            onChange={setLoader}
            options={['all', ...loaders]}
            render={(l) => (l === 'all' ? t('res.filter.all') : loaderLabel(l, t))}
          />
        )}
        {type === 'mod' && (
          <FilterSelect
            label={t('res.filter.category')}
            value={category}
            onChange={setCategory}
            options={CATEGORIES.map((c) => c.value)}
            render={(c) => {
              const cat = CATEGORIES.find((x) => x.value === c)
              return cat ? t(cat.labelKey) : c
            }}
          />
        )}
      </div>

      {message && <div className="glass-soft rounded-2xl px-4 py-3 text-[13px]">{message}</div>}

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto pr-1">
        {searching ? (
          <LoadingState text={t('res.loading')} />
        ) : results.length === 0 ? (
          <EmptyState type={type} />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {results.map((p, i) => {
                // 标题/详情：优先用 MC百科 中文名按「Mod 管理样式」呈现；
                // 没有中文名时退回原有的「可选机器翻译」。
                const pair = p.translatedName
                  ? modTitlePair(p.title, p.translatedName, settings.modTitleStyle)
                  : { title: settings.translateResourceNames ? tr(p.title) : p.title }
                return (
                <motion.button
                  key={`${p.source ?? 'modrinth'}:${p.slug}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.02, 0.3) }}
                  onClick={() => setDetail(p)}
                  className="glass flex items-start gap-3 rounded-2xl p-4 text-left no-drag transition-transform active:scale-[0.98]"
                >
                  <ModIcon url={p.icon_url} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold">{pair.title}</div>
                    {pair.detail && <div className="caption truncate">{pair.detail}</div>}
                    <p className="caption mt-0.5 line-clamp-2">{tr(p.description)}</p>
                    <div className="mt-2 flex items-center gap-2">
                      <span className="chip">{t('res.downloadsCount', { n: formatCount(p.downloads) })}</span>
                      {source === 'all' && (
                        <span className="chip" title={p.source === 'curseforge' ? 'CurseForge' : 'Modrinth'}>
                          {t(`res.source.${p.source ?? 'modrinth'}`)}
                        </span>
                      )}
                      {p.categories.slice(0, 2).map((c) => (
                        <span key={c} className="chip">
                          {c}
                        </span>
                      ))}
                    </div>
                  </div>
                </motion.button>
                )
              })}
            </div>
            {loadingMore && (
              <div className="flex items-center justify-center gap-2 py-4">
                <Spinner size={18} />
                <span className="caption">{t('res.loadMore')}</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
      )}
    </motion.div>
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
  const { t, settings } = useApp()
  // 实验性：详情页资源名 / 简介自动翻译。
  const trDetail = useAutoTranslate([
    settings.translateResourceNames ? project.title : '',
    project.description
  ])

  useEffect(() => {
    setLoading(true)
    void window.api.mods.versions(project.slug, [], [], project.source, type).then((vs) => {
      setVersions(vs)
      // 优先选中筛选器锁定的 MC 版本
      const allGv = vs.flatMap((v) => v.game_versions)
      setMcTab(filterMcVersion && allGv.includes(filterMcVersion) ? filterMcVersion : vs[0]?.game_versions[0] ?? '')
      setLoading(false)
    })
  }, [project.slug, project.source, type, filterMcVersion])

  const mcGroups = useMemo(() => groupVersions(versions), [versions])
  const mcTabs = sortMc([...mcGroups.keys()].filter((k) => k !== GENERIC_MC_KEY))
  const activeMc = mcGroups.has(mcTab) ? mcTab : mcTabs[0] ?? GENERIC_MC_KEY
  const loaderGroups = mcGroups.get(activeMc) ?? new Map<string, ModrinthVersion[]>()
  const preferredLoader = filterLoader !== 'all' ? filterLoader : ''

  const isModpack = type === 'modpack'
  const [modpackPending, setModpackPending] = useState<{ temp: string; probe: ModpackProbe } | null>(null)
  const [modpackRename, setModpackRename] = useState('')
  const [modpackBusy, setModpackBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // 「完整介绍」弹窗开关
  const [introOpen, setIntroOpen] = useState(false)

  // 光影（及部分模组）声明的加载器 iris / optifine 是运行时模组，需要知道各实例装了哪些模组才能判断可用性
  const needsRuntimeCheck = useMemo(
    () => versions.some((v) => v.loaders.some((l) => RUNTIME_LOADER_PATTERNS[l.toLowerCase()])),
    [versions]
  )
  const [instanceMods, setInstanceMods] = useState<Record<string, string[]>>({})
  const installedIds = installed.map((ins) => ins.id).join('|')
  useEffect(() => {
    if (!needsRuntimeCheck || !installedIds) return
    let cancelled = false
    void Promise.all(
      installedIds.split('|').map(async (id) => {
        const list = await window.api.manage.mods(id).catch(() => [] as ModEntry[])
        return [id, list.map((m) => m.name)] as const
      })
    ).then((pairs) => {
      if (!cancelled) setInstanceMods(Object.fromEntries(pairs))
    })
    return () => {
      cancelled = true
    }
  }, [needsRuntimeCheck, installedIds])

  const installModpack = async (v: ModrinthVersion): Promise<void> => {
    const file = v.files.find((f) => f.primary) ?? v.files[0]
    if (!file) return
    setModpackBusy(true)
    setNotice(null)
    try {
      const temp = await window.api.modpack.download(file.url, file.filename)
      const probe = await window.api.modpack.probe(temp)
      // 先下载并解析，再弹出弹窗让用户自定义实例名（默认取不重名且不等于版本号的名称，可再手动改）
      setModpackPending({ temp, probe })
      setModpackRename(uniqueInstanceName(probe.name, probe.mcVersion))
    } catch (err) {
      setNotice(t('res.installFailed', { msg: err instanceof Error ? err.message : String(err) }))
    } finally {
      setModpackBusy(false)
    }
  }

  const modpackNameTaken =
    modpackPending !== null && modpackRename.trim() !== '' && installed.some((ins) => ins.id === modpackRename.trim())

  const uniqueInstanceName = (base: string, mcVersion?: string): string => {
    const taken = (n: string): boolean => installed.some((ins) => ins.id === n) || (!!mcVersion && mcVersion === n)
    if (!taken(base)) return base
    for (let i = 2; i < 10000; i++) {
      const cand = `${base}-${i}`
      if (!taken(cand)) return cand
    }
    return `${base}-${Date.now()}`
  }

  const confirmModpackImport = async (): Promise<void> => {
    if (!modpackPending) return
    const name = modpackRename.trim()
    if (!name) return
    if (installed.some((ins) => ins.id === name)) {
      setNotice(t('res.nameExists', { name }))
      return
    }
    const { temp } = modpackPending
    setModpackPending(null)
    setModpackBusy(true)
    setNotice(null)
    try {
      await window.api.modpack.import(temp, name)
      setNotice(t('res.modpackInstalled', { name }))
    } catch (err) {
      setNotice(t('res.installFailed', { msg: err instanceof Error ? err.message : String(err) }))
    } finally {
      setModpackBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <button onClick={onBack} className="flex items-center gap-1 text-[13px] opacity-70 hover:opacity-100 no-drag">
        <Icon name="chevronRight" size={15} className="rotate-180" />
        {t('res.back')}
      </button>

      {/* 顶部：图标 + 名称 + 简介 */}
      <div className="glass flex items-start gap-4 rounded-[24px] p-5">
        <ModIcon url={project.icon_url} size={72} />
        <div className="min-w-0 flex-1">
          <h2 className="title">
            {project.translatedName && settings.modTitleStyle === 'translated-first'
              ? project.translatedName
              : settings.translateResourceNames
                ? trDetail(project.title)
                : project.title}
          </h2>
          {project.translatedName && (
            <p className="caption selectable mt-0.5 truncate">{project.title}</p>
          )}
          <p className="caption mt-1 line-clamp-3 selectable">{trDetail(project.description)}</p>
          <div className="mt-2 flex items-center gap-2">
            <span className="chip">{t('res.downloadsCount', { n: formatCount(project.downloads) })}</span>
            {project.categories.slice(0, 3).map((c) => (
              <span key={c} className="chip">
                {c}
              </span>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => setIntroOpen(true)}
            className="mica no-drag shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium"
          >
            {t('res.moreInfo')}
          </button>
        </div>
      </div>

      {/* MC 版本分栏：与全局分栏控制同一实现（横向滚动、隐藏滚动条、文字居中） */}
      <Segmented
        scroll
        value={activeMc}
        onChange={setMcTab}
        options={mcTabs.map((mc) => ({ value: mc, label: mc }))}
      />

      {/* 加载器抽屉 / 版本列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {loading ? (
          <div className="flex flex-col items-center gap-2 p-6">
            <Spinner size={22} />
            <span className="caption">{t('res.loadingVersions')}</span>
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
                instanceMods={instanceMods}
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
              <h2 className="title mb-1">{t('res.modpack.title')}</h2>
              <p className="caption mb-4">{t('res.modpack.desc', { name: modpackPending.probe.name })}</p>
              <input
                autoFocus
                value={modpackRename}
                onChange={(e) => setModpackRename(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && modpackRename.trim() && !modpackNameTaken && void confirmModpackImport()}
                placeholder={t('res.modpack.namePlaceholder')}
                className="input mb-5 w-full"
              />
              {modpackNameTaken && (
                <p className="mb-4 -mt-3 text-[12px]" style={{ color: 'var(--fill-danger)' }}>
                  {t('res.modpack.nameTaken', { name: modpackRename.trim() })}
                </p>
              )}
              <div className="flex gap-2">
                <Button className="flex-1" onClick={() => setModpackPending(null)}>
                  {t('res.cancel')}
                </Button>
                <Button variant="primary" className="flex-1" disabled={!modpackRename.trim() || modpackNameTaken} onClick={() => void confirmModpackImport()}>
                  {t('res.install')}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 完整介绍弹窗 */}
      <AnimatePresence>
        {introOpen && <ProjectIntroModal project={project} onClose={() => setIntroOpen(false)} />}
      </AnimatePresence>
    </div>
  )
}

/** 资源「完整介绍」弹窗：打开时拉取 Modrinth 详情，按段落翻译后渲染 Markdown。 */
function ProjectIntroModal({ project, onClose }: { project: ModrinthProject; onClose: () => void }): JSX.Element {
  const { t, settings } = useApp()
  const [detail, setDetail] = useState<ModrinthProjectDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void window.api.mods
      .project(project.slug, project.source === 'curseforge' ? 'mod' : undefined)
      .then((d) => {
        if (cancelled) return
        setDetail(d)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [project.slug, attempt])

  // Markdown 感知的翻译：只翻译纯文本片段，代码块 / 行内代码 / 链接 URL / 行首标记原样保留，
  // 避免通用翻译引擎改写 Markdown 语法导致「翻译后渲染成纯文本」。
  // 标题与简介一并交给同一 hook；关闭「翻译资源名」时标题传空串（hook 会跳过）。
  const built = useMemo(() => compileMarkdown(detail?.body ?? ''), [detail?.body])
  const translatables = useMemo(
    () => [
      settings.translateResourceNames ? project.title : '',
      project.description,
      ...built.texts
    ],
    [built, project.title, project.description, settings.translateResourceNames]
  )
  const tr = useAutoTranslate(translatables)

  const body = (detail?.body ?? '').trim()
  // 回填译文后交给共享 Markdown 组件渲染：结构片段原样，只有文字被替换。
  const mdText = body ? built.rebuild((s) => tr(s)) : ''

  return (
    <motion.div
      className="absolute inset-0 z-50 flex items-center justify-center p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={onClose} />
      <motion.div
        role="dialog"
        aria-label={t('res.detail.title')}
        className="glass-strong relative z-10 flex w-full max-w-2xl flex-col rounded-[28px] p-6"
        initial={{ scale: 0.94, opacity: 0, y: 12 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.94, opacity: 0, y: 12 }}
        transition={{ type: 'spring', bounce: 0.18, duration: 0.4 }}
      >
        {/* 顶部：图标 + 标题 + 简介 */}
        <div className="mb-4 flex items-start gap-3">
          <ModIcon url={project.icon_url} size={56} />
          <div className="min-w-0 flex-1">
            <h2 className="title truncate">
              {project.translatedName && settings.modTitleStyle === 'translated-first'
                ? project.translatedName
                : settings.translateResourceNames
                  ? tr(project.title)
                  : project.title}
            </h2>
            {project.translatedName && (
              <p className="caption selectable truncate">{project.title}</p>
            )}
            <p className="caption mt-0.5 line-clamp-2">{tr(project.description)}</p>
          </div>
          <button
            onClick={onClose}
            title={t('res.detail.close')}
            aria-label={t('res.detail.close')}
            className="no-drag shrink-0 opacity-60 hover:opacity-100"
          >
            <Icon name="xmark" size={18} />
          </button>
        </div>

        {loading ? (
          <LoadingState text={t('res.detail.loading')} />
        ) : error ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <p className="caption text-center">{t('res.detail.error', { msg: error })}</p>
            <Button onClick={() => setAttempt((n) => n + 1)}>{t('res.detail.retry')}</Button>
          </div>
        ) : !body ? (
          <p className="caption py-8 text-center">{t('res.detail.empty')}</p>
        ) : (
          <Markdown
            text={mdText}
            className="max-h-[70vh] overflow-y-auto pr-2 text-[13px] leading-relaxed"
          />
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>{t('res.detail.close')}</Button>
          <Button
            variant="primary"
            onClick={() =>
              void window.api.shell.openExternal(`https://modrinth.com/${detail?.project_type || project.project_type}/${project.slug}`)
            }
          >
            {t('res.detail.openModrinth')}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  )
}

function LoaderDrawer({
  loader,
  versions,
  type,
  installed,
  instanceMods,
  preferredLoader,
  isModpack,
  onInstallModpack,
  modpackBusy
}: {
  loader: string
  versions: ModrinthVersion[]
  type: ModrinthType
  installed: InstalledVersion[]
  instanceMods: Record<string, string[]>
  preferredLoader?: string
  isModpack?: boolean
  onInstallModpack?: (v: ModrinthVersion) => void
  modpackBusy?: boolean
}): JSX.Element {
  const { t } = useApp()
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
        <span className="text-[14px] font-medium">{hasLoader ? loader.split(' / ').map((l) => loaderLabel(l, t)).join(' / ') : t('res.loader.generic')}</span>
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
              instanceMods={instanceMods}
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

/** 安装到实例时发现的缺失前置。 */
interface DepMissing {
  projectId: string
  title: string
  version: ModrinthVersion
}

/** 依赖确认弹窗要用的上下文（缺哪个前置、装到哪个实例）。 */
interface DepPrompt {
  target: InstalledVersion
  missing: DepMissing[]
}

/**
 * 找出该版本「必需、但目标实例中尚未安装」的前置模组。
 *
 * 判据（两者任一命中即视为已装，避免重复下载）：
 *   1. 实例中已装模组的 Modrinth slug 与依赖项目 slug 相同（最准，但需已富化）；
 *   2. 依赖版本的主文件名与实例 mods 目录中的文件名相同（兜底）。
 * 读不到实例模组列表时直接返回空数组——宁可放行安装，也不误报「缺前置」阻断用户。
 * 资源包 / 光影没有前置概念，直接跳过。
 */
async function findMissingDependencies(
  version: ModrinthVersion,
  target: InstalledVersion,
  type: ModrinthType
): Promise<DepMissing[]> {
  if (type !== 'mod' && type !== 'modpack') return []
  const deps = (version.dependencies ?? []).filter((d) => d.dependency_type === 'required' && d.project_id)
  if (deps.length === 0) return []

  let names = new Set<string>()
  let slugs = new Set<string>()
  try {
    const mods = await window.api.manage.mods(target.id)
    names = new Set(mods.map((m) => m.name.toLowerCase()))
    slugs = new Set(
      mods
        .map((m) => m.slug)
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .map((s) => s.toLowerCase())
    )
  } catch {
    return []
  }

  const missing: DepMissing[] = []
  for (const d of deps) {
    const pid = d.project_id
    if (!pid) continue
    let proj: ModrinthProjectDetail | null = null
    try {
      proj = await window.api.mods.project(pid)
    } catch {
      /* 取不到项目信息时用 id 兜底展示 */
    }
    const slug = proj?.slug?.toLowerCase() ?? ''
    if (slug && slugs.has(slug)) continue

    // 取适配当前实例（MC 版本 + 加载器）的依赖版本。
    let pick: ModrinthVersion | null = null
    try {
      const vs = await window.api.mods.versions(pid, target.loader ? [target.loader] : [], [target.mcVersion])
      pick = vs[0] ?? null
    } catch {
      /* 查询失败：无法判断，跳过该项而不误报 */
    }
    if (!pick) continue
    const f = pick.files.find((x) => x.primary) ?? pick.files[0]
    if (f && names.has(f.filename.toLowerCase())) continue

    missing.push({ projectId: pid, title: proj?.title || pid, version: pick })
  }
  return missing
}

function VersionEntry({
  v,
  type,
  installed,
  instanceMods,
  isModpack,
  onInstallModpack,
  modpackBusy
}: {
  v: ModrinthVersion
  type: ModrinthType
  installed: InstalledVersion[]
  instanceMods: Record<string, string[]>
  isModpack?: boolean
  onInstallModpack?: (v: ModrinthVersion) => void
  modpackBusy?: boolean
}): JSX.Element {
  const { triggerFly } = useRuntimeActions()
  const { t } = useApp()
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 安装 / 下载失败的提示（非空即展示）；成功或重试时清空。 */
  const [error, setError] = useState<string | null>(null)
  /** 非空表示：安装到实例时检测到缺失前置，正等用户确认是否一并下载。 */
  const [depPrompt, setDepPrompt] = useState<DepPrompt | null>(null)

  /** 必需前置数量（用于在版本条目上提前提示）。 */
  const requiredDeps = (v.dependencies ?? []).filter((d) => d.dependency_type === 'required').length

  const compatible = installed.filter((ins) => {
    // 资源包不限制加载器，只看游戏版本
    if (type === 'resourcepack') {
      return v.game_versions.length === 0 || v.game_versions.includes(ins.mcVersion)
    }
    // 其余类型：游戏版本与加载器必须同时匹配；资源未声明的维度一律视为不匹配，
    // 否则会把版本或加载器不同的实例也列出来。
    if (v.game_versions.length === 0 || !v.game_versions.includes(ins.mcVersion)) return false
    if (v.loaders.length === 0) return false
    const insLoader = (ins.loader ?? 'minecraft').toLowerCase()
    return v.loaders.some((l) => {
      const key = l.toLowerCase()
      // 光影声明的加载器是运行时模组：实例装了 Iris / OptiFine 才能用
      const pattern = RUNTIME_LOADER_PATTERNS[key]
      if (pattern) return (instanceMods[ins.id] ?? []).some((name) => pattern.test(name))
      return key === insLoader
    })
  })

  const fire = async (e: React.MouseEvent, target: InstalledVersion | null): Promise<void> => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    triggerFly(r.left + r.width / 2, r.top + r.height / 2)
    // CurseForge 上「禁止第三方分发」的资源拿不到下载地址：只能去官网下，
    // 这里直接把项目文件页在系统浏览器里打开。
    if (v.downloadable === false) {
      const url = v.pageUrl
      if (url) await window.api.shell.openExternal(url)
      return
    }
    const file = v.files.find((f) => f.primary) ?? v.files[0]
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      if (target) {
        // 安装到实例前先检查必需前置；缺失则弹窗征求是否一并下载。
        const missing = await findMissingDependencies(v, target, type)
        if (missing.length > 0) {
          setDepPrompt({ target, missing })
          return
        }
        await window.api.mods.install(file.url, file.filename, target.id, type, file.size)
      } else {
        const dest = await window.api.shell.saveFile(file.filename)
        if (dest) await window.api.mods.downloadTo(file.url, dest, file.size)
      }
      setExpanded(false)
    } catch (err) {
      // 以前这里静默失败：用户只看到面板收回去、以为「点了没反应」。
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /** 用户确认后：先装缺失的前置，再装本体（顺序执行，避免并发写同一 mods 目录）。 */
  const installWithDependencies = async (): Promise<void> => {
    const p = depPrompt
    const file = v.files.find((f) => f.primary) ?? v.files[0]
    setDepPrompt(null)
    if (!p || !file) return
    setBusy(true)
    setError(null)
    try {
      for (const m of p.missing) {
        const f = m.version.files.find((x) => x.primary) ?? m.version.files[0]
        if (f) await window.api.mods.install(f.url, f.filename, p.target.id, 'mod', f.size)
      }
      await window.api.mods.install(file.url, file.filename, p.target.id, type, file.size)
      setExpanded(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl px-3 py-2" style={{ background: 'var(--fill-secondary)' }}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{v.version_number}</div>
          <div className="caption">
            {t('res.downloadsDate', { n: formatCount(v.downloads), date: formatDate(v.date_published) })}
            {requiredDeps > 0 && ` · ${t('res.depCount', { n: requiredDeps })}`}
          </div>
        </div>
        <Button
          size="sm"
          variant={isModpack ? 'primary' : expanded ? 'secondary' : 'primary'}
          disabled={busy || modpackBusy}
          onClick={(e) => (v.downloadable === false && !isModpack ? void fire(e, null) : isModpack ? onInstallModpack?.(v) : setExpanded((x) => !x))}
        >
          {v.downloadable === false && !isModpack
            ? t('res.openOnCurseforge')
            : isModpack
              ? modpackBusy
                ? t('res.installing')
                : t('res.installModpack')
              : busy
                ? t('res.downloading')
                : expanded
                  ? t('res.collapse')
                  : t('res.install')}
        </Button>
      </div>

      {expanded && (
        <div className="mt-2 space-y-1.5 border-t pt-2" style={{ borderColor: 'var(--divider)' }}>
          <div className="caption">{t('res.installToMatch')}</div>
          {compatible.length === 0 && <div className="caption opacity-60">{t('res.noMatch')}</div>}
          {compatible.map((ins) => (
            <button
              key={ins.id}
              onClick={(e) => void fire(e, ins)}
              className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-[13px] no-drag hover:opacity-80"
              style={{ background: 'var(--chip-bg)' }}
            >
              <span className="truncate">{ins.id}</span>
              <span className="caption shrink-0">
                {ins.mcVersion} · {loaderLabel(ins.loader, t)}
              </span>
            </button>
          ))}
          <button
            onClick={(e) => void fire(e, null)}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] no-drag opacity-70 hover:opacity-100"
            style={{ background: 'var(--chip-bg)' }}
          >
            <Icon name="download" size={14} />
            {t('res.downloadAnywhere')}
          </button>
        </div>
      )}

      {error && (
        <div
          className="mt-2 flex items-start gap-2 rounded-lg px-3 py-2 text-[12px]"
          style={{ background: 'var(--chip-bg)', color: 'var(--fill-danger)' }}
        >
          <Icon name="info" size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{t('res.installFailed', { msg: error })}</span>
          <button className="no-drag shrink-0 opacity-60 hover:opacity-100" onClick={() => setError(null)}>
            <Icon name="xmark" size={13} />
          </button>
        </div>
      )}

      {/* 缺前置确认：列出缺失的必需前置，由用户决定是否一并下载。
          必须 portal 到 body：本组件位于带 transform 的入场动画容器内，
          那种祖先会让 fixed 定位改为相对该容器解析，遮罩会盖住整个结果区（看起来「变黑」）。 */}
      {depPrompt &&
        createPortal(
          <div className="fixed inset-0 z-[130] flex items-center justify-center p-6">
            <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={() => setDepPrompt(null)} />
            <div className="glass-strong relative z-10 w-full max-w-md rounded-[28px] p-6">
              <div className="mb-2 flex items-center gap-2">
                <Icon name="info" size={20} style={{ color: 'var(--fill-primary)' }} />
                <span className="title">{t('res.dep.title')}</span>
              </div>
              <p className="caption mt-2">{t('res.dep.desc', { target: depPrompt.target.id })}</p>
              <ul className="mt-3 max-h-56 space-y-1 overflow-y-auto">
                {depPrompt.missing.map((m) => (
                  <li
                    key={m.projectId}
                    className="truncate rounded-lg px-3 py-1.5 text-[13px]"
                    style={{ background: 'var(--chip-bg)' }}
                    title={m.title}
                  >
                    {m.title}
                  </li>
                ))}
              </ul>
              <div className="mt-5 flex gap-2">
                <Button className="flex-1" onClick={() => setDepPrompt(null)}>
                  {t('res.dep.cancel')}
                </Button>
                <Button variant="primary" className="flex-1" icon="download" onClick={() => void installWithDependencies()}>
                  {t('res.dep.confirm')}
                </Button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}

function groupVersions(versions: ModrinthVersion[]): Map<string, Map<string, ModrinthVersion[]>> {
  const mc = new Map<string, Map<string, ModrinthVersion[]>>()
  for (const v of versions) {
    const gvs = v.game_versions.length > 0 ? v.game_versions : [GENERIC_MC_KEY]
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
      <Select
        value={value}
        onChange={onChange}
        options={options.map((o) => ({ value: o, label: render ? render(o) : o }))}
      />
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
  const { t } = useApp()
  const labelKey =
    type === 'mod'
      ? 'res.tab.mod'
      : type === 'resourcepack'
        ? 'res.tab.resourcepack'
        : type === 'shader'
          ? 'res.tab.shader'
          : 'res.tab.modpack'
  return (
    <div className="glass flex flex-col items-center justify-center gap-3 rounded-[28px] p-12 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl" style={{ background: 'var(--fill-secondary)' }}>
        <Icon name="box" size={30} className="opacity-60" />
      </div>
      <div className="title">{t('res.empty.title', { label: t(labelKey) })}</div>
      <p className="caption max-w-sm">{t('res.empty.desc')}</p>
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
