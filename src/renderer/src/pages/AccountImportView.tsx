import { useEffect, useId, useRef, useState } from 'react'
import type { AccountImportEntry, AccountImportPreview, AccountImportSource, AccountImportStatus, AccountImportResult } from '@shared/types'
import type { TFunction } from '../i18n'
import { Button, GlassCard, Icon, Spinner } from '../components/ui'

type Props = {
  t: TFunction
  platform: string
  onBack: () => void
  onImported: () => void
}

const SOURCES: AccountImportSource[] = ['pcl2', 'hmcl', 'official']
const SELECTABLE_STATUSES: AccountImportStatus[] = ['ready', 'refresh', 'temporary']

export function AccountImportView({ t, platform, onBack, onImported }: Props): JSX.Element {
  const [source, setSource] = useState<AccountImportSource>('pcl2')
  const [preview, setPreview] = useState<AccountImportPreview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState(false)
  const [result, setResult] = useState<AccountImportResult | null>(null)
  const alive = useRef(false)
  const requestId = useRef(0)
  const sessionId = useRef<string | null>(null)
  // React 更新前也要阻止重复读取、提交或退出。
  const operation = useRef<'loading' | 'committing' | 'leaving' | null>(null)
  const fileButton = useRef<HTMLButtonElement | null>(null)
  const previewHeading = useRef<HTMLHeadingElement | null>(null)
  const resultHeading = useRef<HTMLHeadingElement | null>(null)
  const sourceGroupId = useId()
  const busy = loading || committing
  const isWindows = platform === 'win32'

  const cancelSession = (): void => {
    const current = sessionId.current
    sessionId.current = null
    if (current) void window.api.accounts.cancelImport(current).catch(() => undefined)
  }

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      operation.current = null
      requestId.current += 1
      cancelSession()
    }
  }, [])

  useEffect(() => {
    if (preview) previewHeading.current?.focus()
    else if (result) resultHeading.current?.focus()
    else if (error) fileButton.current?.focus()
  }, [preview, result, error])

  const clearPreview = (): void => {
    requestId.current += 1
    cancelSession()
    setPreview(null)
    setSelected(new Set())
    setLoading(false)
    setCommitting(false)
    setResult(null)
    setError(false)
  }

  const chooseSource = (next: AccountImportSource): void => {
    if (operation.current || next === source) return
    clearPreview()
    setSource(next)
  }

  const cancelPreview = (): void => {
    if (operation.current) return
    clearPreview()
    fileButton.current?.focus()
  }

  const openPreview = async (local = false): Promise<void> => {
    if (!alive.current || operation.current || (local && (source !== 'pcl2' || !isWindows))) return
    operation.current = 'loading'
    clearPreview()
    const id = requestId.current
    setLoading(true)
    try {
      const next = await window.api.accounts.previewImport(source, local)
      if (!alive.current || id !== requestId.current) {
        if (next) void window.api.accounts.cancelImport(next.sessionId).catch(() => undefined)
        return
      }
      if (!next) return
      sessionId.current = next.sessionId
      setPreview(next)
      setSelected(new Set(next.entries.filter((entry) => SELECTABLE_STATUSES.includes(entry.status)).map((entry) => entry.key)))
    } catch {
      if (alive.current && id === requestId.current) setError(true)
    } finally {
      if (alive.current && id === requestId.current) {
        operation.current = null
        setLoading(false)
      }
    }
  }

  const toggleEntry = (entry: AccountImportEntry): void => {
    if (operation.current || !SELECTABLE_STATUSES.includes(entry.status)) return
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(entry.key)) next.delete(entry.key)
      else next.add(entry.key)
      return next
    })
  }

  const commit = async (): Promise<void> => {
    const currentSession = sessionId.current
    if (!alive.current || operation.current || !currentSession || !preview || selected.size === 0) return
    operation.current = 'committing'
    const id = requestId.current
    setCommitting(true)
    setError(false)
    try {
      const outcome = await window.api.accounts.commitImport(currentSession, [...selected])
      if (!alive.current || id !== requestId.current) return
      sessionId.current = null
      setResult(outcome)
      setPreview(null)
      setSelected(new Set())
      onImported()
    } catch {
      if (alive.current && id === requestId.current) {
        // 提交可能已消耗会话；失败后必须重新读取，且不展示 IPC 原始错误。
        cancelSession()
        setPreview(null)
        setSelected(new Set())
        setResult(null)
        setError(true)
      }
    } finally {
      if (alive.current && id === requestId.current) {
        operation.current = null
        setCommitting(false)
      }
    }
  }

  const back = (): void => {
    if (!alive.current || operation.current === 'committing' || operation.current === 'leaving') return
    operation.current = 'leaving'
    clearPreview()
    onBack()
  }

  const sourceDescription = t(`acc.import.${source}Description`)
  const sourceFile = t(`acc.import.${source}File`)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="display">{t('acc.importTitle')}</h2>
          <p className="caption mt-1">{t('acc.importSubtitle')}</p>
        </div>
        <Button icon="chevronLeft" onClick={back} disabled={committing}>
          {t('acc.back')}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="flex max-w-3xl flex-col gap-5 pb-6">
          <GlassCard className="p-6">
            <fieldset disabled={busy} aria-describedby={`${sourceGroupId}-description ${sourceGroupId}-file`}>
              <legend className="headline mb-4">{t('acc.importSource')}</legend>
              <div className="mica-well inline-flex flex-wrap items-center gap-1 rounded-xl p-1">
                {SOURCES.map((value) => (
                  <label key={value} className={`relative cursor-pointer rounded-lg ${busy ? 'opacity-50' : ''}`}>
                    <input
                      type="radio"
                      name={sourceGroupId}
                      value={value}
                      checked={source === value}
                      onChange={() => chooseSource(value)}
                      className="peer sr-only"
                    />
                    <span
                      className={`block rounded-lg px-3 py-1.5 text-[13px] font-medium peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 ${source === value ? 'mica' : ''}`}
                      style={{ color: source === value ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                    >
                      {t(`acc.import.${value}`)}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <p id={`${sourceGroupId}-description`} className="caption mt-4">{sourceDescription}</p>
            <p id={`${sourceGroupId}-file`} className="caption mt-2 flex items-start gap-2">
              <Icon name="folder" size={16} className="mt-0.5 shrink-0" />
              <span>{t('acc.importFileHint', { file: sourceFile })}</span>
            </p>
            {source === 'pcl2' && isWindows && (
              <div className="mt-5 border-t pt-4" style={{ borderColor: 'var(--divider)' }}>
                <p className="caption mb-3">{t('acc.importRegistryHint')}</p>
                <Button onClick={() => void openPreview(true)} disabled={loading || committing}>
                  {t('acc.importRegistry')}
                </Button>
              </div>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button ref={fileButton} variant="primary" icon="folder" onClick={() => void openPreview(false)} disabled={busy} aria-describedby={error ? `${sourceGroupId}-error` : undefined}>
                {loading ? <><Spinner size={16} /> {t('acc.importReading')}</> : t('acc.importChooseFile')}
              </Button>
              <span role="status" aria-atomic="true" className="caption">{loading ? t('acc.importWaiting') : committing ? t('acc.importing') : ''}</span>
            </div>
          </GlassCard>

          {preview && (
            <GlassCard className="p-6" aria-busy={committing}>
              <div className="mb-4 flex items-baseline justify-between gap-3">
                <h3 ref={previewHeading} tabIndex={-1} className="headline">{t('acc.importPreviewTitle')}</h3>
                <span className="caption">{t('acc.importCount', { count: preview.entries.length })}</span>
              </div>
              {preview.warnings.length > 0 && (
                <div className="mb-4 space-y-2 rounded-xl p-3 text-[13px]" style={{ background: 'var(--fill-secondary)' }}>
                  {preview.warnings.map((warning) => (
                    <div key={warning} className="flex items-start gap-2">
                      <Icon name="info" size={16} className="mt-0.5 shrink-0" />
                      <span>{t(`acc.import.warning.${warning}`)}</span>
                    </div>
                  ))}
                </div>
              )}
              {preview.entries.length === 0 ? (
                <p className="caption">{t('acc.importNoEntries')}</p>
              ) : (
                <div className="space-y-2">
                  {preview.entries.map((entry, index) => {
                    const selectable = SELECTABLE_STATUSES.includes(entry.status)
                    const detailId = `${sourceGroupId}-entry-${index}`
                    return (
                      <label
                        key={entry.key}
                        className={`flex items-center gap-3 rounded-xl p-3 ${selectable ? 'cursor-pointer' : 'opacity-60'}`}
                        style={{ background: 'var(--fill-secondary)' }}
                      >
                        <input
                          type="checkbox"
                          aria-label={t('acc.importSelectAccount', { name: entry.name })}
                          aria-describedby={detailId}
                          checked={selected.has(entry.key)}
                          disabled={!selectable || busy}
                          onChange={() => toggleEntry(entry)}
                          className="h-4 w-4 shrink-0 accent-[var(--fill-primary)]"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14px] font-semibold">{entry.name}</span>
                          <span id={detailId} className="caption block">
                            {t(`acc.import.type.${entry.type}`)} · {t(`acc.import.status.${entry.status}`)}
                            {entry.status === 'temporary' && <span className="mt-1 block">{t('acc.import.temporaryNote')}</span>}
                            {entry.status === 'refresh' && <span className="mt-1 block">{t('acc.import.refreshNote')}</span>}
                          </span>
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                <span role="status" aria-atomic="true" className="caption">{t('acc.importSelectedCount', { count: selected.size })}</span>
                <div className="flex items-center gap-3">
                  <Button onClick={cancelPreview} disabled={busy}>{t('acc.cancel')}</Button>
                  <Button variant="primary" disabled={busy || selected.size === 0} onClick={() => void commit()}>
                    {committing ? <><Spinner size={16} /> {t('acc.importing')}</> : t('acc.importConfirm')}
                  </Button>
                </div>
              </div>
            </GlassCard>
          )}

          {result && (
            <GlassCard className="p-6">
              <h3 ref={resultHeading} tabIndex={-1} className="headline mb-4">{t('acc.importComplete')}</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <ImportStat label={t('acc.imported')} count={result.imported} />
                <ImportStat label={t('acc.importSkipped')} count={result.skipped} />
                <ImportStat label={t('acc.importFailed')} count={result.failed} />
              </div>
              <div className="mt-5 flex justify-end">
                <Button variant="primary" onClick={back}>{t('acc.back')}</Button>
              </div>
            </GlassCard>
          )}

          {error && (
            <div id={`${sourceGroupId}-error`} role="alert" className="flex items-start gap-3 rounded-xl p-3 text-[13px]" style={{ background: 'rgba(255,69,58,0.14)', color: 'var(--fill-danger)' }}>
              <Icon name="xmark" size={18} />
              <span>{t('acc.importError')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ImportStat({ label, count }: { label: string; count: number }): JSX.Element {
  return (
    <div className="glass-soft rounded-xl p-4">
      <div className="caption">{label}</div>
      <div className="title mt-1">{count}</div>
    </div>
  )
}
