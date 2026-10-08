import { useState } from 'react'
import type { ModrinthProject } from '@shared/types'
import { useApp } from '../../store'
import { Button, Icon, LoadingState, Segmented, Spinner } from '../../components/ui'

/**
 * 在线安装面板：光影 / 资源包共用。
 *
 * 模组页保留它原有的内联实现（那套还带拖拽导入和详情弹窗），这里只做「搜索 → 选最新匹配版本 →
 * 下载到当前实例」：目标目录由主进程按 type 决定（shaderpacks / resourcepacks），隔离设置也在主进程处理。
 * 本地模式下调用方根本不渲染本面板，所以这里不再单独做联网判断。
 */
export function OnlineInstaller({
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
