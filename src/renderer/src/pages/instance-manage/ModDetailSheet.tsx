import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import type { ModEntry, ModrinthVersion } from '@shared/types'
import { useApp } from '../../store'
import { modListTitles } from '../../mod-title'
import { Icon, Spinner } from '../../components/ui'
import { formatBytes } from './shared'

/** 已安装模组的详情弹窗：展示名称 / 描述与 Modrinth 版本列表。 */
export function ModDetailSheet({ mod, onClose }: { mod: ModEntry; onClose: () => void }): JSX.Element {
  const { t, settings } = useApp()
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

  const { title, detail } = modListTitles(mod, settings.modTitleStyle)

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
            {detail && <p className="caption mt-0.5 truncate">{detail}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {mod.slug && (
              <button
                onClick={() =>
                  void window.api.shell.openExternal(mod.pageUrl ?? `https://modrinth.com/mod/${mod.slug}`)
                }
                className="mica no-drag shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium"
              >
                {t('ins.moreInfo')}
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
            <span className="headline">{t('ins.version')}</span>
            <span className="caption">{formatBytes(mod.size)}</span>
          </div>

          {!mod.slug ? (
            <div className="caption rounded-xl px-3 py-4 text-center opacity-60" style={{ background: 'var(--fill-secondary)' }}>
              {t('ins.notOnModrinth')}
            </div>
          ) : loading ? (
            <div className="flex flex-col items-center gap-2 p-6">
              <Spinner size={22} />
              <span className="caption">{t('ins.loadingVersions')}</span>
            </div>
          ) : versions.length === 0 ? (
            <div className="caption p-4 text-center opacity-60">{t('ins.noVersionInfo')}</div>
          ) : (
            <div className="space-y-1.5">
              {versions.slice(0, 30).map((v) => (
                <div key={v.id} className="glass-soft rounded-xl px-3.5 py-2.5">
                  <div className="truncate text-[13px] font-medium">{v.version_number}</div>
                  <div className="caption">
                    {v.loaders.join(' / ') || t('ins.noLoader')} · {v.game_versions.join(', ')}
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
