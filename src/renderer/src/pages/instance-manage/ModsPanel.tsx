import type { DragEvent } from 'react'
import type { ModEntry, ModrinthProject, ResourceUpdateInfo } from '@shared/types'
import { useApp } from '../../store'
import { modListTitles } from '../../mod-title'
import { Button, Icon, LoadingState, Segmented, Spinner } from '../../components/ui'
import { formatBytes } from './shared'
import type { ResFilter } from './types'

/** 模组板块：在线搜索安装 + 拖拽 / 选择本地导入 + 已安装列表（开关 / 更新 / 删除 / 详情）。 */
export function ModsPanel({
  mods,
  loadingMods,
  visibleMods,
  updates,
  busyId,
  resFilter,
  query,
  onQueryChange,
  onSearch,
  searching,
  results,
  mcSel,
  onMcSelChange,
  loaderSel,
  onLoaderSelChange,
  dragOver,
  setDragOver,
  onDrop,
  onInstallLocals,
  onInstallOnline,
  onToggleMod,
  onDeleteMod,
  onApplyUpdate,
  onOpenDetail
}: {
  mods: ModEntry[]
  loadingMods: boolean
  visibleMods: ModEntry[]
  updates: Record<string, ResourceUpdateInfo>
  busyId: string | null
  resFilter: ResFilter
  query: string
  onQueryChange: (v: string) => void
  onSearch: () => void
  searching: boolean
  results: ModrinthProject[]
  mcSel: string
  onMcSelChange: (v: string) => void
  loaderSel: string
  onLoaderSelChange: (v: string) => void
  dragOver: boolean
  setDragOver: (v: boolean) => void
  onDrop: (e: DragEvent<HTMLDivElement>) => void
  onInstallLocals: (paths: string[]) => void
  onInstallOnline: (p: ModrinthProject) => void
  onToggleMod: (m: ModEntry) => void
  onDeleteMod: (m: ModEntry) => void
  onApplyUpdate: (up: ResourceUpdateInfo, enabled: boolean) => void
  onOpenDetail: (m: ModEntry) => void
}): JSX.Element {
  const { t, settings } = useApp()
  return (
    <div className="space-y-4">
      {settings.mode !== 'local' && (
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="headline">{t('ins.onlineInstall')}</span>
            <span className="caption">{t('ins.matching', { target: `${mcSel} + ${loaderSel}` })}</span>
          </div>
          <div className="mb-2 flex gap-2">
            <div className="relative flex-1">
              <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 opacity-50" />
              <input
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void onSearch()}
                placeholder={t('ins.searchModsPlaceholder')}
                className="input w-full pl-9"
              />
            </div>
            <Button variant="primary" icon="search" disabled={searching} onClick={() => void onSearch()}>
              {t('ins.search')}
            </Button>
          </div>
          <div className="mb-2 flex items-center gap-2">
            <span className="caption">{t('ins.version')}</span>
            <input value={mcSel} onChange={(e) => onMcSelChange(e.target.value)} className="input w-28" />
            <span className="caption ml-2">{t('ins.loader')}</span>
            <Segmented
              value={loaderSel}
              onChange={onLoaderSelChange}
              options={[
                { value: 'fabric', label: 'Fabric' },
                { value: 'quilt', label: 'Quilt' },
                { value: 'forge', label: 'Forge' },
                { value: 'neoforge', label: 'NeoForge' }
              ]}
            />
          </div>
          {searching ? (
            <LoadingState text={t('ins.searching')} />
          ) : (
            results.length > 0 && (
              <div className="space-y-1.5">
                {results.map((p) => (
                  <button
                    key={p.slug}
                    onClick={() => void onInstallOnline(p)}
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
        <p className="text-[13px] opacity-80">{t('ins.dropModFiles')}</p>
        <Button
          size="sm"
          icon="folder"
          className="mt-2"
          onClick={async () => {
            const paths = await window.api.shell.pickFiles([{ name: t('ins.filterMods'), extensions: ['jar', 'zip'] }])
            if (paths.length > 0) await onInstallLocals(paths)
          }}
        >
          {t('ins.selectLocalFiles')}
        </Button>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="headline">{t('ins.installedModsCount', { n: mods.length })}</span>
          <span className="caption">{t('ins.toggleHint')}</span>
        </div>
        {loadingMods ? (
          <div className="flex items-center justify-center gap-2 py-4">
            <Spinner size={22} />
            <span className="caption opacity-60">{t('ins.loadingMods')}</span>
          </div>
        ) : mods.length === 0 ? (
          <div className="caption py-4 text-center opacity-60">{t('ins.noMods')}</div>
        ) : visibleMods.length === 0 ? (
          <div className="caption py-4 text-center opacity-60">
            {resFilter === 'updatable' ? t('ins.noUpdatable') : t('ins.noMods')}
          </div>
        ) : (
          <div className="space-y-1.5">
            {visibleMods.map((m) => {
              const up = updates[m.path]
              return (
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
                    onClick={() => onOpenDetail(m)}
                    className="min-w-0 flex-1 text-left no-drag"
                  >
                    {(() => {
                      const pair = modListTitles(m, settings.modTitleStyle)
                      return (
                        <>
                          <div className={`truncate text-[13px] font-medium leading-tight ${m.enabled ? '' : 'opacity-40 line-through'}`}>
                            {pair.title}
                          </div>
                          {pair.detail && (
                            <div className={`caption truncate leading-tight ${m.enabled ? '' : 'opacity-40'}`}>{pair.detail}</div>
                          )}
                        </>
                      )
                    })()}
                  </button>
                  {up && (
                    <span className="caption shrink-0" title={`${up.title} · ${up.slug}`}>
                      {up.currentVersion
                        ? `${up.currentVersion} → ${up.latestVersion}`
                        : t('ins.updateTo', { version: up.latestVersion })}
                    </span>
                  )}
                  <span className="caption">{formatBytes(m.size)}</span>
                  {up && (
                    <button
                      onClick={() => void onApplyUpdate(up, m.enabled)}
                      disabled={busyId === m.path}
                      className="mica no-drag shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium"
                      style={{ color: 'var(--fill-primary)' }}
                    >
                      {busyId === m.path ? t('ins.updating') : t('ins.update')}
                    </button>
                  )}
                  <button
                    onClick={() => void onToggleMod(m)}
                    disabled={busyId === m.path}
                    className="mica no-drag rounded-lg px-2 py-1 text-[12px] font-medium"
                    style={{ opacity: m.enabled ? 1 : 0.7 }}
                  >
                    {busyId === m.path ? '…' : m.enabled ? t('ins.disable') : t('ins.enable')}
                  </button>
                  <button onClick={() => void onDeleteMod(m)} className="no-drag opacity-50 hover:opacity-100">
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
