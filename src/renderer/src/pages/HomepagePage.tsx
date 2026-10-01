import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { HomepageEntry, HomepageSubmitResult, HomepageUpdate, MarketScript } from '@shared/types'
import type { TFunction } from '../i18n'
import { useApp } from '../store'
import { Button, Icon, LoadingState, Segmented } from '../components/ui'
import { HomepageGate } from '../components/HomepageGate'

type Tab = 'installed' | 'updates' | 'market' | 'submit'

/** 把脚本原文编码为 base64（UTF-8 安全）。 */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function riskBadge(level: HomepageEntry['risk']['level'], t: TFunction): { text: string; color: string } {
  if (level === 'reject') return { text: t('hp.risk.reject'), color: 'var(--fill-danger)' }
  if (level === 'warn') return { text: t('hp.risk.warn'), color: '#ff9f0a' }
  return { text: t('hp.risk.safe'), color: 'var(--fill-success)' }
}

function verifyBadge(v: HomepageEntry['verify'], t: TFunction): string {
  switch (v) {
    case 'verified':
      return t('hp.verify.verified')
    case 'mismatch':
      return t('hp.verify.mismatch')
    case 'local':
      return t('hp.verify.local')
    default:
      return t('hp.verify.none')
  }
}

function sizeText(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`
}

/** 由市场条目 + 本地已安装条目构造「更新」所需的 HomepageUpdate（字段含义与主进程一致）。 */
function marketUpdate(m: MarketScript, local: HomepageEntry): HomepageUpdate {
  return {
    localId: local.id,
    id: m.id,
    name: m.name || local.meta.name || m.id,
    author: m.author || local.meta.author,
    localVersion: local.meta.version,
    latestVersion: m.version,
    latestSha256: m.sha256,
    url: m.url,
    updatedAt: m.updatedAt
  }
}

export function HomepagePage(): JSX.Element {
  const { t, settings, reloadSettings, openFileManager, homepageUpdates, refreshHomepageUpdates } = useApp()
  const [tab, setTab] = useState<Tab>('installed')
  const [entries, setEntries] = useState<HomepageEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [market, setMarket] = useState<MarketScript[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  /** 待过闸门的脚本 id：通过后才设为当前主页。 */
  const [gateId, setGateId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setEntries(await window.api.homepage.list())
    } catch (err) {
      setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const loadMarket = useCallback(async () => {
    setMarket(null)
    try {
      setMarket(await window.api.homepage.market())
    } catch (err) {
      setMarket([])
      setNotice({ kind: 'err', text: t('hp.notice.marketFailed', { msg: err instanceof Error ? err.message : String(err) }) })
    }
  }, [t])

  useEffect(() => {
    if (tab === 'market') void loadMarket()
  }, [tab, loadMarket])

  // 市场脚本 ↔ 本地已安装脚本：两者以「服务端编号」（市场 m.id / 本地 meta.id）对应，
  // 本地文件标识（id）含时间戳后缀，不能直接拿来比对。
  const localByServerId = useMemo(() => {
    const map = new Map<string, HomepageEntry>()
    for (const e of entries) if (e.meta.id) map.set(e.meta.id, e)
    return map
  }, [entries])

  // 切到本地模式时，联网相关的标签页自动退回「已安装」。
  useEffect(() => {
    if (settings.mode === 'local' && tab !== 'installed') setTab('installed')
  }, [settings.mode, tab])

  const fail = (err: unknown): void =>
    setNotice({ kind: 'err', text: err instanceof Error ? err.message : String(err) })

  const importLocal = async (): Promise<void> => {
    try {
      const entry = await window.api.homepage.importFile()
      if (!entry) return
      await refresh()
      setNotice({ kind: 'ok', text: t('hp.notice.imported', { name: entry.meta.name || entry.id }) })
    } catch (err) {
      fail(err)
    }
  }

  const installFromMarket = async (item: MarketScript): Promise<void> => {
    setBusyId(item.id)
    try {
      const entry = await window.api.homepage.download(item.url, `${item.id}.html`)
      await refresh()
      setGateId(entry.id)
    } catch (err) {
      fail(err)
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (entry: HomepageEntry): Promise<void> => {
    setBusyId(entry.id)
    try {
      await window.api.homepage.remove(entry.id)
      await refresh()
      await reloadSettings()
      setNotice({ kind: 'ok', text: t('hp.notice.removed', { name: entry.meta.name || entry.id }) })
    } catch (err) {
      fail(err)
    } finally {
      setBusyId(null)
    }
  }

  const deactivate = async (): Promise<void> => {
    try {
      await window.api.homepage.setActive('')
      await refresh()
      await reloadSettings()
      setNotice({ kind: 'ok', text: t('hp.notice.deactivated') })
    } catch (err) {
      fail(err)
    }
  }

  /** 通过安全闸门后把脚本设为当前主页（接管「启动游戏」界面）。 */
  const activate = async (targetId: string): Promise<void> => {
    try {
      await window.api.homepage.setActive(targetId)
      await refresh()
      await reloadSettings()
      setGateId(null)
      setNotice({ kind: 'ok', text: t('hp.notice.activated') })
    } catch (err) {
      fail(err)
    }
  }

  // 本地模式不联网：主页市场与投稿不可用。
  const isLocal = settings.mode === 'local'

  /** 手动重新检查主页更新。 */
  const checkUpdates = async (): Promise<void> => {
    setChecking(true)
    try {
      await refreshHomepageUpdates()
    } finally {
      setChecking(false)
    }
  }

  /** 更新某个脚本：下载最新版本覆盖安装，再刷新本地列表与可更新列表。 */
  const update = async (u: HomepageUpdate): Promise<void> => {
    setBusyId(u.localId)
    try {
      await window.api.homepage.update(u)
      await refresh()
      await refreshHomepageUpdates()
      setNotice({
        kind: 'ok',
        text: t('hp.notice.updated', { name: u.name || u.id, version: u.latestVersion || t('hp.latestVersion') })
      })
    } catch (err) {
      fail(err)
    } finally {
      setBusyId(null)
    }
  }

  const tabOptions: Array<{ value: Tab; label: string }> = [
    { value: 'installed', label: t('hp.tab.installed', { n: entries.length }) },
    ...(isLocal
      ? []
      : ([
          {
            value: 'updates',
            label:
              homepageUpdates.length > 0 ? t('hp.tab.updates', { n: homepageUpdates.length }) : t('hp.tab.updatesNone')
          },
          { value: 'market', label: t('hp.tab.market') },
          { value: 'submit', label: t('hp.tab.submit') }
        ] as Array<{ value: Tab; label: string }>))
  ]

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="display">{t('hp.title')}</h1>
          <p className="caption mt-1">{t('hp.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button icon="folder" onClick={() => void window.api.homepage.openDir().then(openFileManager)}>
            {t('hp.openDir')}
          </Button>
          <Button icon="plus" onClick={() => void importLocal()}>
            {t('hp.import')}
          </Button>
        </div>
      </div>

      <Segmented<Tab> value={tab} onChange={setTab} options={tabOptions} />

      <AnimatePresence>
        {notice && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="glass-soft flex items-start gap-2 rounded-2xl px-3.5 py-2.5 text-[13px]"
            style={{ color: notice.kind === 'err' ? 'var(--fill-danger)' : 'var(--text-primary)' }}
          >
            <Icon name={notice.kind === 'err' ? 'xmark' : 'info'} size={15} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 break-all">{notice.text}</span>
            <button className="shrink-0 opacity-60 no-drag" onClick={() => setNotice(null)} aria-label={t('hp.noticeClose')}>
              <Icon name="xmark" size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {tab === 'installed' && (
          loading ? (
            <LoadingState text={t('hp.loading')} />
          ) : entries.length === 0 ? (
            <Empty text={t('hp.empty')} />
          ) : (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {entries.map((e, i) => {
                const rb = riskBadge(e.risk.level, t)
                const active = settings.homepageId === e.id
                return (
                  <motion.div
                    key={e.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i * 0.03, 0.2), type: 'spring', bounce: 0, duration: 0.35 }}
                    className="glass flex flex-col gap-3 rounded-[24px] p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[15px] font-semibold">{e.meta.name || e.id}</span>
                          {active && (
                            <span className="chip shrink-0" style={{ color: 'var(--fill-primary)' }}>
                              {t('hp.inUse')}
                            </span>
                          )}
                        </div>
                        <div className="caption mt-0.5 truncate">
                          {e.meta.author || t('hp.unknownAuthor')}
                          {e.meta.version ? ` · v${e.meta.version}` : ''}
                          {e.meta.id ? ` · ${e.meta.id}` : ` · ${t('hp.noNumber')}`}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {e.blocked && (
                          <span className="chip" style={{ color: 'var(--fill-danger)' }}>
                            {t('hp.blocked')}
                          </span>
                        )}
                        <span className="chip" style={{ color: rb.color }}>
                          {rb.text}
                        </span>
                        <span className="caption">
                          {/* 有线上新版本时优先显示「可更新」：哈希不一致多半只是本地过期，
                              不宜直接标为「不一致」吓到用户（与运行前闸门的判定保持一致）。 */}
                          {homepageUpdates.some((u) => u.localId === e.id)
                            ? t('hp.verify.outdated')
                            : verifyBadge(e.verify, t)}
                        </span>
                      </div>
                    </div>

                    {e.meta.description && <p className="caption line-clamp-2">{e.meta.description}</p>}

                    {e.risk.blocks.length > 0 && (
                      <div
                        className="rounded-xl px-3 py-2 text-[12px] leading-relaxed"
                        style={{ background: 'rgba(255,69,58,0.12)', color: 'var(--fill-danger)' }}
                      >
                        {e.risk.blocks[0]}
                      </div>
                    )}
                    {e.risk.level === 'warn' && e.risk.externals.length > 0 && (
                      <div className="caption">{t('hp.externalCount', { n: e.risk.externals.length })}</div>
                    )}

                    <div className="mt-auto flex items-center justify-between gap-2">
                      <span className="caption">
                        {sizeText(e.size)} · {new Date(e.installedAt).toLocaleDateString()}
                      </span>
                      <div className="flex items-center gap-2">
                        {active ? (
                          <Button size="sm" onClick={() => void deactivate()}>
                            {t('hp.disable')}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={e.risk.level === 'reject' || busyId === e.id}
                            onClick={() => setGateId(e.id)}
                          >
                            {t('hp.enable')}
                          </Button>
                        )}
                        <Button size="sm" variant="danger" icon="trash" disabled={busyId === e.id} onClick={() => void remove(e)}>
                          {t('hp.remove')}
                        </Button>
                      </div>
                    </div>
                  </motion.div>
                )
              })}
            </div>
          )
        )}

        {tab === 'updates' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <p className="caption">
                {t('hp.updates.hint')}
              </p>
              <Button size="sm" icon="refresh" disabled={checking} onClick={() => void checkUpdates()}>
                {checking ? t('hp.updates.checking') : t('hp.updates.check')}
              </Button>
            </div>
            {homepageUpdates.length === 0 ? (
              <Empty
                text={
                  checking
                    ? t('hp.updates.checkingList')
                    : settings.autoCheckHomepageUpdate
                      ? t('hp.updates.upToDate')
                      : t('hp.updates.autoOff')
                }
              />
            ) : (
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {homepageUpdates.map((u, i) => (
                  <motion.div
                    key={u.localId}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i * 0.03, 0.2), type: 'spring', bounce: 0, duration: 0.35 }}
                    className="glass flex flex-col gap-3 rounded-[24px] p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[15px] font-semibold">{u.name || u.id}</span>
                          <span className="chip shrink-0" style={{ color: 'var(--fill-primary)' }}>
                            {t('hp.updates.badge')}
                          </span>
                        </div>
                        <div className="caption mt-0.5 truncate">
                          {u.author || t('hp.unknownAuthor')} · {u.id}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="caption">
                          v{u.localVersion || '?'} → v{u.latestVersion || '?'}
                        </span>
                        {u.updatedAt > 0 && (
                          <span className="caption">{new Date(u.updatedAt).toLocaleDateString()}</span>
                        )}
                      </div>
                    </div>
                    <div className="mt-auto flex items-center justify-end gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        icon="download"
                        disabled={busyId === u.localId}
                        onClick={() => void update(u)}
                      >
                        {busyId === u.localId ? t('hp.updates.updating') : t('hp.updates.update')}
                      </Button>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'market' && (
          market === null ? (
            <LoadingState text={t('hp.market.loading')} />
          ) : market.length === 0 ? (
            <Empty text={t('hp.market.empty')} />
          ) : (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {market.map((m, i) => {
                // 三态：未装 → 安装；已装且非最新 → 更新；已装且最新 → 已安装。
                // 「最新」判据与主进程 checkHomepageUpdates 一致：服务端 SHA256 与本地相同。
                const local = localByServerId.get(m.id)
                const upToDate = !!local && !!m.sha256 && m.sha256.toLowerCase() === local.sha256.toLowerCase()
                const hasUpdate = !!local && !local.blocked && !upToDate
                const busy = busyId === m.id || (!!local && busyId === local.id)
                return (
                  <motion.div
                    key={m.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i * 0.03, 0.2), type: 'spring', bounce: 0, duration: 0.35 }}
                    className="glass flex flex-col gap-2 rounded-[24px] p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-[15px] font-semibold">{m.name || m.id}</div>
                        <div className="caption mt-0.5 truncate">
                          {m.author || t('hp.unknownAuthor')}
                          {m.version ? ` · v${m.version}` : ''} · {m.id}
                        </div>
                      </div>
                      <span className="chip shrink-0">{t('hp.market.downloads', { n: m.downloads })}</span>
                    </div>
                    {m.description && <p className="caption line-clamp-2">{m.description}</p>}
                    {local && !hasUpdate ? (
                      <Button size="sm" icon="check" className="mt-auto self-start" disabled>
                        {t('hp.market.installed')}
                      </Button>
                    ) : hasUpdate ? (
                      <Button
                        size="sm"
                        variant="primary"
                        icon="refresh"
                        className="mt-auto self-start"
                        disabled={busy}
                        onClick={() => local && void update(marketUpdate(m, local))}
                      >
                        {t('hp.updates.update')}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        icon="download"
                        className="mt-auto self-start"
                        disabled={busy}
                        onClick={() => void installFromMarket(m)}
                      >
                        {t('hp.market.install')}
                      </Button>
                    )}
                  </motion.div>
                )
              })}
            </div>
          )
        )}

        {tab === 'submit' && <SubmitPane onDone={() => void refresh()} />}
      </div>

      {gateId && (
        <HomepageGate
          id={gateId}
          onApproved={(approved) => void activate(approved.id)}
          onCancel={() => setGateId(null)}
        />
      )}
    </div>
  )
}

function Empty({ text }: { text: string }): JSX.Element {
  return (
    <div className="glass flex h-40 flex-col items-center justify-center gap-2 rounded-[24px] px-6 text-center">
      <Icon name="palette" size={26} className="opacity-40" />
      <span className="caption">{text}</span>
    </div>
  )
}

/** 投稿：选脚本 → 填信息 → 提交（服务端分配编号并回传已编号脚本）。 */
function SubmitPane({ onDone }: { onDone: () => void }): JSX.Element {
  const { t } = useApp()
  const [draft, setDraft] = useState<{
    entryId: string
    filename: string
    name: string
    author: string
    description: string
    version: string
  } | null>(null)
  const [visibility, setVisibility] = useState<'public' | 'private'>('public')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [cooldown, setCooldown] = useState(0)
  const [sending, setSending] = useState(false)
  const [codeHint, setCodeHint] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<HomepageSubmitResult | null>(null)

  // 验证码重发倒计时：由服务端返回的 cooldown 驱动，避免刷新页面绕过冷却。
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setTimeout(() => setCooldown((v) => (v > 0 ? v - 1 : 0)), 1000)
    return () => window.clearTimeout(timer)
  }, [cooldown])

  const sendCode = async (): Promise<void> => {
    const to = email.trim()
    if (!to) {
      setCodeHint(t('hp.submit.needEmail'))
      return
    }
    setSending(true)
    setCodeHint(null)
    try {
      const res = await window.api.homepage.sendEmailCode(to)
      setCooldown(res.cooldown > 0 ? res.cooldown : 60)
      setCodeHint(t('hp.submit.codeSent', { n: Math.round(res.ttl / 60) || 10 }))
    } catch (err) {
      setCodeHint(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  const pick = async (): Promise<void> => {
    setError(null)
    try {
      const entry = await window.api.homepage.importFile()
      if (!entry) return
      setDraft({
        entryId: entry.id,
        filename: `${entry.id}.html`,
        name: entry.meta.name || entry.id,
        author: entry.meta.author,
        description: entry.meta.description,
        version: entry.meta.version || '1.0.0'
      })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const submit = async (): Promise<void> => {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      const src = await window.api.homepage.read(draft.entryId)
      // 服务端要把编号注入元信息块，缺块无法分配编号。
      if (!/<!--\s*@hcpage/i.test(src.content)) {
        throw new Error(t('hp.submit.missingMeta'))
      }
      const res = await window.api.homepage.submit({
        filename: draft.filename,
        contentBase64: toBase64(src.content),
        name: draft.name,
        author: draft.author,
        description: draft.description,
        version: draft.version,
        visibility,
        email: email.trim(),
        code: code.trim()
      })
      // 服务端注入编号后回传最终脚本；私密投稿审核后服务端会删文件，只能靠它留存。
      await window.api.homepage.installNumbered({
        filename: draft.filename,
        contentBase64: res.contentBase64,
        replaceId: draft.entryId
      })
      setResult(res)
      setDraft(null)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="glass flex flex-col gap-4 rounded-[24px] p-5">
      <div>
        <div className="headline">{t('hp.submit.headline')}</div>
        <p className="caption mt-1">
          {t('hp.submit.intro')}
        </p>
      </div>

      {result && (
        <div className="glass-soft rounded-2xl px-3.5 py-3 text-[13px]">
          <div className="font-semibold">
            {t('hp.submit.submitted', {
              visibility: result.visibility === 'public' ? t('hp.submit.public') : t('hp.submit.private')
            })}
          </div>
          <div className="caption mt-1 selectable break-all">
            {t('hp.submit.resultMeta', { id: result.id, sha: result.sha256.slice(0, 16) })}
          </div>
          <div className="caption mt-1">
            {t('hp.submit.saved')}
            {result.visibility === 'private' && ` ${t('hp.submit.privateNote')}`}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-2xl px-3.5 py-2.5 text-[13px]" style={{ background: 'rgba(255,69,58,0.12)', color: 'var(--fill-danger)' }}>
          {error}
        </div>
      )}

      {!draft ? (
        <Button icon="plus" className="self-start" onClick={() => void pick()}>
          {t('hp.submit.pick')}
        </Button>
      ) : (
        <div className="flex flex-col gap-3">
          <Field label={t('hp.submit.fieldFile')}>
            <span className="text-[13px] opacity-70">{draft.filename}</span>
          </Field>
          <Field label={t('hp.submit.fieldName')}>
            <input className="input w-full" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label={t('hp.submit.fieldAuthor')}>
            <input className="input w-full" value={draft.author} onChange={(e) => setDraft({ ...draft, author: e.target.value })} />
          </Field>
          <Field label={t('hp.submit.fieldVersion')}>
            <input className="input w-full" value={draft.version} onChange={(e) => setDraft({ ...draft, version: e.target.value })} />
          </Field>
          <Field label={t('hp.submit.fieldDescription')}>
            <textarea
              className="input w-full resize-none"
              rows={3}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </Field>
          <Field label={t('hp.submit.fieldVisibility')}>
            <Segmented<'public' | 'private'>
              value={visibility}
              onChange={setVisibility}
              options={[
                { value: 'public', label: t('hp.submit.visPublic') },
                { value: 'private', label: t('hp.submit.visPrivate') }
              ]}
            />
          </Field>
          <Field label={t('hp.submit.fieldEmail')}>
            <div className="flex gap-2">
              <input
                className="input w-full"
                type="email"
                placeholder={t('hp.submit.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button
                className="shrink-0"
                disabled={sending || cooldown > 0 || !email.trim()}
                onClick={() => void sendCode()}
              >
                {cooldown > 0
                  ? t('hp.submit.resend', { n: cooldown })
                  : sending
                    ? t('hp.submit.sending')
                    : t('hp.submit.sendCode')}
              </Button>
            </div>
          </Field>
          <Field label={t('hp.submit.fieldCode')}>
            <input
              className="input w-full"
              inputMode="numeric"
              maxLength={6}
              placeholder={t('hp.submit.codePlaceholder')}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </Field>
          {codeHint && <div className="caption -mt-1">{codeHint}</div>}
          <div className="flex gap-2">
            <Button onClick={() => setDraft(null)} disabled={busy}>
              {t('hp.submit.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={busy || !draft.name.trim() || !email.trim() || !/^\d{6}$/.test(code.trim())}
              onClick={() => void submit()}
            >
              {busy ? t('hp.submit.submitting') : t('hp.submit.submit')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-semibold opacity-70">{label}</span>
      {children}
    </label>
  )
}
