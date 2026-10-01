import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import type { ExportItem, ModpackExportInventory, ModpackFormat } from '@shared/types'
import { Button, Checkbox, Icon, Segmented } from '../components/ui'
import { useApp } from '../store'

function formatSize(n: number): string {
  if (n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** 文件树选择区：标题行带“全选”复选框，下方以树形呈现子项。 */
function FileTreeSection({
  title,
  folder,
  items,
  selected,
  onChange
}: {
  title: string
  folder: string
  items: ExportItem[]
  selected: string[]
  onChange: (next: string[]) => void
}): JSX.Element {
  const { t } = useApp()
  const all = items.length > 0 && selected.length === items.length
  const some = selected.length > 0 && !all
  const toggleAll = (): void => onChange(all ? [] : items.map((i) => i.name))
  const toggle = (name: string): void =>
    onChange(selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name])

  return (
    <div className="rounded-2xl p-3" style={{ border: '1px solid var(--divider)' }}>
      <div className="flex items-center gap-2">
        <Checkbox checked={all} indeterminate={some} onChange={toggleAll} />
        <span className="text-[14px] font-semibold">{title}</span>
        <span className="text-[12px] opacity-50">{t('ins.itemsCount', { n: items.length })}</span>
        <span className="ml-auto text-[12px] opacity-40">{t('ins.selectAll')}</span>
      </div>
      <div className="mt-2 border-l pl-3" style={{ borderColor: 'var(--divider)' }}>
        <div className="flex items-center gap-1.5 py-1 text-[12px] opacity-60">
          <Icon name="folder" size={14} />
          <span className="font-mono">{folder}</span>
        </div>
        {items.length === 0 ? (
          <div className="py-1.5 text-[13px] opacity-45">{t('ins.none')}</div>
        ) : (
          items.map((it) => (
            <div key={it.name} className="flex items-center gap-2 py-1">
              <Checkbox checked={selected.includes(it.name)} onChange={() => toggle(it.name)} />
              <span className="truncate text-[13px]">{it.name}</span>
              {it.size > 0 && <span className="ml-auto shrink-0 text-[12px] opacity-45">{formatSize(it.size)}</span>}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function CheckRow({
  checked,
  onChange,
  disabled,
  label,
  hint
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label: string
  hint?: string
}): JSX.Element {
  return (
    <div
      className="flex items-center gap-2 rounded-2xl px-3 py-2.5"
      style={{ border: '1px solid var(--divider)', opacity: disabled ? 0.5 : 1 }}
    >
      <Checkbox checked={checked} onChange={onChange} disabled={disabled} />
      <span className="text-[14px]">{label}</span>
      {hint && <span className="ml-auto text-[12px] opacity-45">{hint}</span>}
    </div>
  )
}

export function ExportPage({ versionId, onClose }: { versionId: string; onClose: () => void }): JSX.Element {
  const { t } = useApp()
  const [inventory, setInventory] = useState<ModpackExportInventory | null>(null)
  const [loading, setLoading] = useState(true)

  const [format, setFormat] = useState<ModpackFormat>('modrinth')
  const [gameSettings, setGameSettings] = useState(true)
  const [modConfigs, setModConfigs] = useState(true)
  const [serversList, setServersList] = useState(true)
  const [worlds, setWorlds] = useState<string[]>([])
  const [resourcePacks, setResourcePacks] = useState<string[]>([])
  const [jei, setJei] = useState(true)
  const [gunPacks, setGunPacks] = useState<string[]>([])
  const [disabledMods, setDisabledMods] = useState(false)
  const [schematics, setSchematics] = useState<string[]>([])

  const [exporting, setExporting] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void window.api.modpack
      .exportInventory(versionId)
      .then((inv) => {
        if (alive) setInventory(inv)
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [versionId])

  const doExport = async (): Promise<void> => {
    if (!inventory) return
    setExporting(true)
    setError(null)
    setDone(null)
    try {
      const out = await window.api.modpack.export(versionId, {
        format,
        includeGameSettings: gameSettings,
        includeModConfigs: modConfigs,
        includeServersList: serversList,
        worlds,
        resourcePacks,
        includeJei: jei && (inventory.hasJei || false),
        gunPacks,
        includeDisabledMods: disabledMods,
        schematics
      })
      setDone(t('ins.exported', { path: out }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }

  const formats: Array<{ value: ModpackFormat; label: string }> = [
    { value: 'modrinth', label: 'Modrinth' },
    { value: 'mcbbs', label: 'BBSMC' },
    { value: 'native', label: t('ins.formatNative') }
  ]

  return (
    <motion.div
      className="fixed inset-0 z-[120] flex flex-col"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      style={{ background: 'var(--scrim)' }}
    >
      <motion.div
        className="mx-auto my-6 flex w-full max-w-2xl flex-1 flex-col overflow-hidden rounded-3xl"
        style={{ background: 'var(--surface-flat)', boxShadow: 'var(--glass-shadow)' }}
        initial={{ opacity: 0, scale: 0.97, y: 18 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 12 }}
        transition={{ type: 'spring', bounce: 0.15, duration: 0.4 }}
      >
        <div className="flex items-center gap-3 border-b px-5 py-4" style={{ borderColor: 'var(--divider)' }}>
          <div>
            <div className="text-[16px] font-semibold">{t('ins.exportModpack')}</div>
            <div className="text-[12px] opacity-55">{t('ins.exportFor', { name: versionId })}</div>
          </div>
          <button className="no-drag ml-auto rounded-lg p-1.5 hover:bg-black/5" onClick={onClose}>
            <Icon name="xmark" size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="py-10 text-center text-[13px] opacity-55">{t('ins.scanning')}</div>
          ) : inventory ? (
            <>
              <div className="text-[13px] font-semibold opacity-75">{t('ins.basicSettings')}</div>
              <CheckRow
                checked={gameSettings}
                onChange={setGameSettings}
                disabled={!inventory.hasGameSettings}
                label={t('ins.gameSettings')}
                hint={inventory.hasGameSettings ? '' : t('ins.noOptions')}
              />
              <CheckRow
                checked={modConfigs}
                onChange={setModConfigs}
                disabled={!inventory.hasModConfigs}
                label={t('ins.modConfigs')}
                hint={inventory.hasModConfigs ? '' : t('ins.noConfigDir')}
              />
              <CheckRow
                checked={serversList}
                onChange={setServersList}
                disabled={!inventory.hasServersList}
                label={t('ins.serversList')}
                hint={inventory.hasServersList ? '' : t('ins.noServersDat')}
              />

              <FileTreeSection
                title={t('ins.worlds')}
                folder="saves/"
                items={inventory.worlds}
                selected={worlds}
                onChange={setWorlds}
              />

              <FileTreeSection
                title={t('ins.resourcepacks')}
                folder="resourcepacks/"
                items={inventory.resourcePacks}
                selected={resourcePacks}
                onChange={setResourcePacks}
              />

              {inventory.hasJei && (
                <CheckRow checked={jei} onChange={setJei} label={t('ins.jeiInfo')} hint={t('ins.jeiHint')} />
              )}

              {inventory.gunPacks.length > 0 && (
                <FileTreeSection
                  title={t('ins.gunPacks')}
                  folder="tacz/"
                  items={inventory.gunPacks}
                  selected={gunPacks}
                  onChange={setGunPacks}
                />
              )}

              {inventory.disabledMods.length > 0 && (
                <CheckRow
                  checked={disabledMods}
                  onChange={setDisabledMods}
                  label={t('ins.exportDisabledMods')}
                  hint={t('ins.disabledModsHint', { n: inventory.disabledMods.length })}
                />
              )}

              {inventory.schematics.length > 0 && (
                <FileTreeSection
                  title={t('ins.schematics')}
                  folder="schematics/"
                  items={inventory.schematics}
                  selected={schematics}
                  onChange={setSchematics}
                />
              )}

              <div className="text-[13px] font-semibold opacity-75">{t('ins.exportFormat')}</div>
              <Segmented options={formats} value={format} onChange={setFormat} />

              <p className="text-[12px] leading-relaxed opacity-50">{t('ins.exportNotice')}</p>
            </>
          ) : null}

          {(done || error) && (
            <div
              className="flex items-start gap-2 rounded-xl px-3 py-2.5 text-[13px]"
              style={{ background: 'var(--fill-secondary)' }}
            >
              <span className="selectable break-all">{error ?? done}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t px-5 py-4" style={{ borderColor: 'var(--divider)' }}>
          {error ? (
            <Button onClick={() => setError(null)}>{t('ins.backToEdit')}</Button>
          ) : done ? (
            <Button variant="primary" onClick={onClose}>
              {t('ins.done')}
            </Button>
          ) : (
            <>
              <Button onClick={onClose}>{t('ins.cancel')}</Button>
              <Button variant="primary" icon="box" disabled={exporting || loading || !inventory} onClick={() => void doExport()}>
                {exporting ? t('ins.exporting') : t('ins.export')}
              </Button>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}