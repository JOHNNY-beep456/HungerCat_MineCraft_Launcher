import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { HomepageEntry, HomepageSubmitResult, MarketScript } from '@shared/types'
import { useApp } from '../store'
import { Button, Icon, LoadingState, Segmented } from '../components/ui'
import { HomepageGate } from '../components/HomepageGate'

type Tab = 'installed' | 'market' | 'submit'

/** 把脚本原文编码为 base64（UTF-8 安全）。 */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function riskBadge(level: HomepageEntry['risk']['level']): { text: string; color: string } {
  if (level === 'reject') return { text: '危险', color: 'var(--fill-danger)' }
  if (level === 'warn') return { text: '含外链', color: '#ff9f0a' }
  return { text: '安全', color: 'var(--fill-success)' }
}

function verifyBadge(v: HomepageEntry['verify']): string {
  switch (v) {
    case 'verified':
      return '已联网校验'
    case 'mismatch':
      return '校验不一致'
    case 'local':
      return '无编号 · 本地'
    default:
      return '未校验'
  }
}

function sizeText(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`
}

export function HomepagePage(): JSX.Element {
  const { settings, reloadSettings } = useApp()
  const [tab, setTab] = useState<Tab>('installed')
  const [entries, setEntries] = useState<HomepageEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [market, setMarket] = useState<MarketScript[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
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
      setNotice({ kind: 'err', text: `主页市场加载失败：${err instanceof Error ? err.message : String(err)}` })
    }
  }, [])

  useEffect(() => {
    if (tab === 'market') void loadMarket()
  }, [tab, loadMarket])

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
      setNotice({ kind: 'ok', text: `已导入脚本「${entry.meta.name || entry.id}」，点击「启用」前会先做安全检查` })
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
      setNotice({ kind: 'ok', text: `已删除「${entry.meta.name || entry.id}」` })
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
      setNotice({ kind: 'ok', text: '已切回内置「启动游戏」界面' })
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
      setNotice({ kind: 'ok', text: '已启用自定义主页，「启动游戏」界面已由该脚本接管' })
    } catch (err) {
      fail(err)
    }
  }

  // 本地模式不联网：主页市场与投稿不可用。
  const isLocal = settings.mode === 'local'
  const tabOptions: Array<{ value: Tab; label: string }> = [
    { value: 'installed', label: `已安装 (${entries.length})` },
    ...(isLocal
      ? []
      : ([
          { value: 'market', label: '主页市场' },
          { value: 'submit', label: '投稿' }
        ] as Array<{ value: Tab; label: string }>))
  ]

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="display">主页</h1>
          <p className="caption mt-1">用单文件 HTML 脚本替换「启动游戏」界面，或从主页市场安装</p>
        </div>
        <div className="flex items-center gap-2">
          <Button icon="folder" onClick={() => void window.api.homepage.openDir()}>
            脚本目录
          </Button>
          <Button icon="plus" onClick={() => void importLocal()}>
            导入脚本
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
            <button className="shrink-0 opacity-60 no-drag" onClick={() => setNotice(null)} aria-label="关闭提示">
              <Icon name="xmark" size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {tab === 'installed' && (
          loading ? (
            <LoadingState text="正在读取本地脚本…" />
          ) : entries.length === 0 ? (
            <Empty text="还没有安装任何主页脚本，可以导入本地 HTML 或到主页市场看看" />
          ) : (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {entries.map((e, i) => {
                const rb = riskBadge(e.risk.level)
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
                            <span
                              className="chip shrink-0"
                              style={{ background: 'var(--fill-secondary)', color: 'var(--fill-primary)' }}
                            >
                              使用中
                            </span>
                          )}
                        </div>
                        <div className="caption mt-0.5 truncate">
                          {e.meta.author || '未知作者'}
                          {e.meta.version ? ` · v${e.meta.version}` : ''}
                          {e.meta.id ? ` · ${e.meta.id}` : ' · 无编号'}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="chip" style={{ color: rb.color }}>
                          {rb.text}
                        </span>
                        <span className="caption">{verifyBadge(e.verify)}</span>
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
                      <div className="caption">含 {e.risk.externals.length} 个外部地址，运行前会逐条列出</div>
                    )}

                    <div className="mt-auto flex items-center justify-between gap-2">
                      <span className="caption">
                        {sizeText(e.size)} · {new Date(e.installedAt).toLocaleDateString()}
                      </span>
                      <div className="flex items-center gap-2">
                        {active ? (
                          <Button size="sm" onClick={() => void deactivate()}>
                            停用
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={e.risk.level === 'reject' || busyId === e.id}
                            onClick={() => setGateId(e.id)}
                          >
                            启用
                          </Button>
                        )}
                        <Button size="sm" variant="danger" icon="trash" disabled={busyId === e.id} onClick={() => void remove(e)}>
                          删除
                        </Button>
                      </div>
                    </div>
                  </motion.div>
                )
              })}
            </div>
          )
        )}

        {tab === 'market' && (
          market === null ? (
            <LoadingState text="正在拉取主页市场…" />
          ) : market.length === 0 ? (
            <Empty text="主页市场暂时没有可安装的脚本" />
          ) : (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {market.map((m, i) => (
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
                        {m.author || '未知作者'}
                        {m.version ? ` · v${m.version}` : ''} · {m.id}
                      </div>
                    </div>
                    <span className="chip shrink-0">{m.downloads} 次下载</span>
                  </div>
                  {m.description && <p className="caption line-clamp-2">{m.description}</p>}
                  <Button
                    size="sm"
                    variant="primary"
                    icon="download"
                    className="mt-auto self-start"
                    disabled={busyId === m.id}
                    onClick={() => void installFromMarket(m)}
                  >
                    安装
                  </Button>
                </motion.div>
              ))}
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
  const [draft, setDraft] = useState<{
    entryId: string
    filename: string
    name: string
    author: string
    description: string
    version: string
  } | null>(null)
  const [visibility, setVisibility] = useState<'public' | 'private'>('public')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<HomepageSubmitResult | null>(null)

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
        throw new Error('脚本缺少元信息块 <!--@hcpage { … } -->，服务端无法注入编号，请补全后再投稿')
      }
      const res = await window.api.homepage.submit({
        filename: draft.filename,
        contentBase64: toBase64(src.content),
        name: draft.name,
        author: draft.author,
        description: draft.description,
        version: draft.version,
        visibility
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
        <div className="headline">自助投稿</div>
        <p className="caption mt-1">
          提交后由服务端分配编号（HC-XXXXXX）并计算 SHA256，同时把编号注入脚本。公开投稿将长期保留在服务端；
          私密投稿审核通过后服务端会删除文件，脚本只保存在你的本地。
        </p>
      </div>

      {result && (
        <div className="glass-soft rounded-2xl px-3.5 py-3 text-[13px]">
          <div className="font-semibold">投稿已提交（{result.visibility === 'public' ? '公开' : '私密'}）</div>
          <div className="caption mt-1 selectable break-all">
            编号 {result.id} · SHA256 {result.sha256.slice(0, 16)}…
          </div>
          <div className="caption mt-1">
            已编号脚本已保存到本地，启用前仍会联网核对编号与哈希。
            {result.visibility === 'private' && ' 私密投稿需等待后台审核；审核后服务端会删除文件。'}
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
          选择脚本文件
        </Button>
      ) : (
        <div className="flex flex-col gap-3">
          <Field label="脚本文件">
            <span className="text-[13px] opacity-70">{draft.filename}</span>
          </Field>
          <Field label="名称">
            <input className="input w-full" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label="作者">
            <input className="input w-full" value={draft.author} onChange={(e) => setDraft({ ...draft, author: e.target.value })} />
          </Field>
          <Field label="版本">
            <input className="input w-full" value={draft.version} onChange={(e) => setDraft({ ...draft, version: e.target.value })} />
          </Field>
          <Field label="简介">
            <textarea
              className="input w-full resize-none"
              rows={3}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </Field>
          <Field label="可见性">
            <Segmented<'public' | 'private'>
              value={visibility}
              onChange={setVisibility}
              options={[
                { value: 'public', label: '公开（服务端长期保留）' },
                { value: 'private', label: '私密（审核后删除）' }
              ]}
            />
          </Field>
          <div className="flex gap-2">
            <Button onClick={() => setDraft(null)} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" disabled={busy || !draft.name.trim()} onClick={() => void submit()}>
              {busy ? '提交中…' : '提交投稿'}
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
