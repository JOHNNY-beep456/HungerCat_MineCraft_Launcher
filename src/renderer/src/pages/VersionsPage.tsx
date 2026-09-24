import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ForgeKind, InstalledVersion, LoaderKind, VersionManifest } from '@shared/types'
import { useRuntime } from '../runtime'
import { Button, Checkbox, GlassCard, Icon, LoadingState, ProgressBar, Segmented } from '../components/ui'

type Filter = 'all' | 'release' | 'snapshot'
type AnyLoader = LoaderKind | ForgeKind
type InstallKind = 'vanilla' | AnyLoader

const LOADER_OPTIONS: Array<{ value: InstallKind; label: string }> = [
  { value: 'vanilla', label: '原版' },
  { value: 'fabric', label: 'Fabric' },
  { value: 'quilt', label: 'Quilt' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' }
]

function defaultName(kind: InstallKind, mc: string): string {
  return kind === 'vanilla' ? mc : `${mc}-${kind}`
}

function sanitizeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 64)
}

// 渲染端兜底超时：即便主进程源（forge/neoforge 的 maven 等）特别慢，也给出明确时限，
// 超时视为该加载器此版本不可用并提示，避免弹窗无限等待“卡死”。
function withTimeout<T>(p: Promise<T>, ms: number, tip: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(tip)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

export function VersionsPage({ presetSearch }: { presetSearch?: string }): JSX.Element {
  const { download, installingId, busy, installVersion } = useRuntime()

  const [manifest, setManifest] = useState<VersionManifest | null>(null)
  const [loading, setLoading] = useState(true)
  const [installed, setInstalled] = useState<InstalledVersion[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState(presetSearch ?? '')
  // 过滤分段滑块的 layoutId：用 useId 保证同页多组分段互不冲突
  const filterLayoutId = useId()

  const [loaderTarget, setLoaderTarget] = useState<string | null>(null)
  const [loaderKind, setLoaderKind] = useState<InstallKind>('vanilla')
  const [loaderVersions, setLoaderVersions] = useState<string[]>([])
  const [loaderVersion, setLoaderVersion] = useState('')
  const [loaderBusy, setLoaderBusy] = useState(false)
  // 加载器版本是否正在从远端拉取（forge/neoforge 的 maven 源可能较慢）：用于区分
  // “加载中”与“已加载但无可用版本”，避免误导性半加载状态。
  const [loaderLoading, setLoaderLoading] = useState(false)
  const [loaderError, setLoaderError] = useState<string | null>(null)
  const [loaderLog, setLoaderLog] = useState<string[]>([])
  const [customName, setCustomName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [installFabricApi, setInstallFabricApi] = useState(true)
  const logRef = useRef<HTMLDivElement>(null)
  // 加载器版本查询的请求序号：快速切换加载器分段时用于作废“过期的旧响应”，
  // 防止乱序返回的旧响应把当前选择的加载器版本覆盖掉。
  const loaderReqSeq = useRef(0)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [m, i] = await Promise.all([
        window.api.versions.list().catch(() => null),
        window.api.installed.list().catch(() => [] as InstalledVersion[])
      ])
      setManifest(m)
      setInstalled(i)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!loaderTarget) return
    const unsub = window.api.forge.onLog((line) => setLoaderLog((prev) => [...prev.slice(-500), line]))
    return () => {
      unsub()
      // 弹窗关闭 / 切换目标时作废所有在途加载器版本查询，避免其回写已卸载弹窗状态。
      loaderReqSeq.current += 1
    }
  }, [loaderTarget])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [loaderLog])

  const nameTaken = customName.trim() !== '' && installed.some((v) => v.id === sanitizeName(customName))

  const list = useMemo(() => {
    if (!manifest) return []
    const q = search.trim().toLowerCase()
    return manifest.versions.filter((v) => {
      if (filter !== 'all' && v.type !== filter) return false
      if (q && !v.id.toLowerCase().includes(q)) return false
      return true
    })
  }, [manifest, filter, search])

  const fetchLoaderVersions = async (mc: string, kind: AnyLoader): Promise<void> => {
    const seq = ++loaderReqSeq.current
    setLoaderError(null)
    setLoaderLoading(true)
    setLoaderVersions([])
    setLoaderVersion('')
    try {
      const versions = await withTimeout(
        kind === 'forge' || kind === 'neoforge'
          ? window.api.forge.versions(kind, mc)
          : window.api.loaders.versions(kind, mc),
        10_000,
        `获取 ${kind} 加载器版本超时（超过 10 秒）`
      )
      // 陈旧响应作废：仅在本次请求仍是“最新一次”时才回写状态，
      // 避免快速切换分段时乱序返回的旧响应覆盖当前选择的加载器版本。
      if (seq !== loaderReqSeq.current) return
      setLoaderLoading(false)
      setLoaderVersions(versions)
      if (versions.length === 0) {
        // 取到空列表（非错误）也应复位到“待选择”并给出提示，避免留下“加载中…”误导态。
        setLoaderVersion('')
        setLoaderError(`当前 MC 版本 ${mc} 未发现可用 ${kind} 加载器版本`)
      } else {
        setLoaderVersion(versions[0])
      }
    } catch (err) {
      if (seq !== loaderReqSeq.current) return
      // 失败/超时：安全复位到“待选择”而非留下半加载状态。
      setLoaderLoading(false)
      setLoaderVersions([])
      setLoaderVersion('')
      const msg = err instanceof Error ? err.message : String(err)
      // fabric/quilt 与 forge 主源均以 “HTTP 404” 表示该 MC 版本不支持，友好提示而不是抛未处理异常。
      setLoaderError(/HTTP 404/.test(msg) ? `当前 MC 版本 ${mc} 暂不支持 ${kind} 加载器` : msg)
    }
  }

  const openLoader = async (mc: string): Promise<void> => {
    // 作废上一次弹窗可能残留的在途加载器版本查询。
    loaderReqSeq.current += 1
    setLoaderTarget(mc)
    setLoaderKind('vanilla')
    setLoaderVersions([])
    setLoaderVersion('')
    setLoaderLoading(false)
    setLoaderLog([])
    setLoaderError(null)
    setCustomName(mc)
    setNameTouched(false)
    setInstallFabricApi(true)
  }

  const switchLoaderKind = async (kind: InstallKind): Promise<void> => {
    setLoaderKind(kind)
    if (!nameTouched && loaderTarget) setCustomName(defaultName(kind, loaderTarget))
    if (kind === 'vanilla') {
      // 作废前面加载器仍在途的版本查询，避免其回写被清空的状态。
      loaderReqSeq.current += 1
      setLoaderLoading(false)
      setLoaderVersions([])
      setLoaderVersion('')
      setLoaderError(null)
      return
    }
    if (loaderTarget) await fetchLoaderVersions(loaderTarget, kind)
  }

  const confirmLoader = async (): Promise<void> => {
    if (!loaderTarget) return
    const name = sanitizeName(customName)
    if (!name) {
      setLoaderError('请输入有效的版本名')
      return
    }
    if (installed.some((v) => v.id === name)) {
      setLoaderError(`版本名「${name}」已存在，请更换`)
      return
    }
    if (loaderKind !== 'vanilla' && !loaderVersion) return
    setLoaderBusy(true)
    setLoaderError(null)
    setLoaderLog([])
    setLoaderTarget(null)
    try {
      if (loaderKind === 'vanilla') {
        await window.api.versions.createVanilla(loaderTarget, name)
        await installVersion(name)
      } else {
        // 带加载器：先下载原版，再安装加载器
        await installVersion(loaderTarget)
        const id =
          loaderKind === 'forge' || loaderKind === 'neoforge'
            ? await window.api.forge.install(loaderKind, loaderTarget, loaderVersion, name)
            : await window.api.loaders.install(loaderKind, loaderTarget, loaderVersion, name)
        await installVersion(id)
        if (loaderKind === 'fabric' && installFabricApi) {
          try {
            await window.api.mods.installFabricApi(loaderTarget, id)
          } catch (err) {
            setLoaderError(`Fabric API 安装失败：${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
      void refresh()
    } catch (err) {
      setLoaderError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoaderBusy(false)
    }
  }

  const isForge = loaderKind === 'forge' || loaderKind === 'neoforge'
  const isVanilla = loaderKind === 'vanilla'
  const targetSummary = manifest?.versions.find((v) => v.id === loaderTarget)

  return (
    <div className="flex h-full flex-col gap-5">
      {/* 版本列表 ⇄ 安装整页：两态视图切换，按 key 区分并做淡入 + 轻微 y/scale 过渡 */}
      <AnimatePresence mode="wait" initial={false}>
      {!loaderTarget && (
        <motion.div
          key="list"
          className="flex min-h-0 flex-1 flex-col gap-5"
          initial={{ opacity: 0, y: 10, scale: 0.995 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.995, transition: { duration: 0.15 } }}
          transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
        >
          <div className="flex items-end justify-between">
          <div>
            <h1 className="display">版本</h1>
          <p className="caption mt-1">
            {manifest
              ? `最新正式版 ${manifest.latest.release} · 最新快照 ${manifest.latest.snapshot} · 已安装 ${installed.length} 个`
              : '正在加载版本清单…'}
          </p>
        </div>
        <Button icon="refresh" onClick={() => void refresh()}>
          刷新
        </Button>
      </div>

      {loading ? (
        <LoadingState text="正在获取版本列表…" />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {/* 所有版本（可重复安装） */}
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="title">所有版本</span>
              <span className="chip">{list.length}</span>
            </div>
            <div className="relative min-w-[180px] flex-1">
              <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 opacity-50" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索版本…"
                className="input w-full pl-9"
              />
            </div>
            <div className="inline-flex gap-1 rounded-xl p-1" style={{ background: 'var(--fill-secondary)' }}>
              {(
                [
                  ['all', '全部'],
                  ['release', '正式版'],
                  ['snapshot', '快照']
                ] as Array<[Filter, string]>
              ).map(([value, label]) => {
                const active = filter === value
                return (
                  <button
                    key={value}
                    onClick={() => setFilter(value)}
                    className="relative rounded-lg px-3 py-1.5 text-[13px] font-medium no-drag"
                    style={{ color: active ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                  >
                    {active && (
                      <motion.span
                        layoutId={filterLayoutId}
                        className="absolute inset-0 rounded-lg"
                        style={{ background: 'var(--glass-bg-soft)' }}
                        transition={{ type: 'spring', bounce: 0.2, duration: 0.4 }}
                      />
                    )}
                    <span className="relative z-10">{label}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2.5 pb-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((v, i) => {
              const installing = installingId === v.id
              return (
                <motion.div
                  key={v.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.008, 0.2) }}
                  className="glass flex items-center gap-3 rounded-2xl p-3.5"
                >
                  <div
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white"
                    style={{
                      background:
                        v.type === 'snapshot'
                          ? 'linear-gradient(135deg,#ff9f0a,#ff375f)'
                          : 'linear-gradient(135deg,#30d158,#0a84ff)'
                    }}
                  >
                    <Icon name="cube" size={17} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold">{v.id}</div>
                    <div className="caption">
                      {v.type === 'snapshot' ? '快照' : '正式'} · {v.releaseTime.slice(0, 10)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant={installing ? 'secondary' : 'primary'}
                      icon="download"
                      disabled={busy && !installing}
                      onClick={() => void openLoader(v.id)}
                    >
                      {installing ? '安装中' : '安装'}
                    </Button>
                  </div>
                </motion.div>
              )
            })}
          </div>

          {installingId && download && (
            <div className="glass-strong sticky bottom-2 rounded-2xl p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="headline">正在安装 {installingId}</span>
                <span className="caption">{download.percent}%</span>
              </div>
              <ProgressBar percent={download.percent} />
              <div className="caption mt-2 truncate">
                {download.task} · {download.current}/{download.total}
              </div>
            </div>
          )}
        </div>
      )}

        </motion.div>
      )}

      {loaderTarget && (
        <motion.div
          key="install"
          className="flex min-h-0 flex-1 flex-col gap-5"
          initial={{ opacity: 0, y: 10, scale: 0.995 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.995, transition: { duration: 0.15 } }}
          transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
        >
          {/* 页头 */}
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="display">安装版本 {loaderTarget}</h2>
              <p className="caption mt-1">选择安装方式（可同时安装模组加载器）</p>
            </div>
            <Button icon="chevronLeft" onClick={() => setLoaderTarget(null)} disabled={loaderBusy}>
              返回
            </Button>
          </div>

          {/* 主内容区（可滚动） */}
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="flex max-w-3xl flex-col gap-5 pb-6">
              {/* ① MC 版本详情 + 版本名 */}
              <GlassCard className="p-6">
                <div className="mb-5 flex items-center justify-between gap-4">
                  <div>
                    <h3 className="headline">MC 版本</h3>
                    <p className="caption mt-0.5">要安装的基础版本与版本名</p>
                  </div>
                  <span
                    className="rounded-full px-3 py-1 text-[12px] font-semibold"
                    style={
                      targetSummary?.type === 'snapshot'
                        ? { background: 'rgba(255,159,10,0.16)', color: 'rgb(255,159,10)' }
                        : { background: 'rgba(10,132,255,0.16)', color: 'rgb(10,132,255)' }
                    }
                  >
                    {targetSummary?.type === 'snapshot' ? '快照' : '正式版'}
                  </span>
                </div>

                <div
                  className="flex flex-wrap items-center gap-x-10 gap-y-4 rounded-2xl p-4"
                  style={{ background: 'var(--fill-secondary)' }}
                >
                  <div>
                    <div className="caption">MC 版本</div>
                    <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {loaderTarget}
                    </div>
                  </div>
                  <div>
                    <div className="caption">发布时间</div>
                    <div className="text-[15px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      {targetSummary?.releaseTime.slice(0, 10) ?? '—'}
                    </div>
                  </div>
                  <div>
                    <div className="caption">当前加载器</div>
                    <div className="text-[15px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      {isVanilla ? '原版' : loaderKind}
                    </div>
                  </div>
                </div>

                <div className="mt-5">
                  <div className="caption mb-2">安装版本名</div>
                  <input
                    value={customName}
                    onChange={(e) => {
                      setCustomName(e.target.value)
                      setNameTouched(true)
                    }}
                    placeholder="输入自定义版本名"
                    className="input w-full"
                  />
                  {nameTaken && (
                    <div className="mt-1.5 text-[12px]" style={{ color: 'var(--fill-danger)' }}>
                      版本名「{sanitizeName(customName)}」已存在，请更换
                    </div>
                  )}
                </div>
              </GlassCard>

              {/* ② 加载方式 */}
              <GlassCard className="p-6">
                <div className="mb-5">
                  <h3 className="headline">加载方式</h3>
                  <p className="caption mt-0.5">选择要安装的模组加载器</p>
                </div>

                <Segmented value={loaderKind} onChange={(v) => void switchLoaderKind(v)} options={LOADER_OPTIONS} />

                {loaderError && (
                  <div
                    className="mt-5 rounded-xl p-3 text-[13px]"
                    style={{ background: 'rgba(255,69,58,0.14)', color: 'var(--fill-danger)' }}
                  >
                    {loaderError}
                  </div>
                )}

                {!isVanilla && (
                  <div className="mt-5">
                    <div className="caption mb-2">加载器版本</div>
                    <select
                      value={loaderVersion}
                      onChange={(e) => setLoaderVersion(e.target.value)}
                      className="input custom-select w-full"
                      disabled={loaderVersions.length === 0 || loaderBusy}
                    >
                      {loaderVersions.length === 0 && (
                        <option>{loaderBusy ? '安装中…' : loaderLoading ? '加载中…' : '无可用加载器版本'}</option>
                      )}
                      {loaderVersions.map((lv) => (
                        <option key={lv} value={lv}>
                          {lv}
                        </option>
                      ))}
                    </select>

                    <div className="caption mt-1.5">
                      {loaderBusy
                        ? '正在安装…'
                        : loaderLoading
                          ? `正在获取 ${loaderKind} 加载器版本…`
                          : loaderVersions.length === 0
                            ? '该 MC 版本暂无可选的加载器版本'
                            : `已自动选择最新可用版本：${loaderVersion}`}
                    </div>
                  </div>
                )}

                {loaderKind === 'fabric' && (
                  <div
                    className="mt-5 flex items-center justify-between gap-4 rounded-2xl p-4"
                    style={{ background: 'var(--fill-secondary)' }}
                  >
                    <div>
                      <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                        同时安装 Fabric API
                      </div>
                      <div className="caption mt-0.5">安装该加载器时一并安装对应版本的 Fabric API</div>
                    </div>
                    <Checkbox checked={installFabricApi} onChange={setInstallFabricApi} />
                  </div>
                )}

                {isForge && loaderLog.length > 0 && (
                  <div className="mt-5">
                    <div className="caption mb-2">安装日志</div>
                    <div
                      ref={logRef}
                      className="selectable max-h-40 min-h-[80px] overflow-y-auto rounded-xl p-3 font-mono text-[11px] leading-relaxed"
                      style={{ background: 'rgba(0,0,0,0.28)', color: 'rgba(255,255,255,0.8)' }}
                    >
                      {loaderLog.map((line, i) => (
                        <div key={i} className="whitespace-pre-wrap break-all">
                          {line}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </GlassCard>
            </div>
          </div>

          {/* ③ 底部操作栏 */}
          <div className="glass-strong shrink-0 rounded-3xl p-4">
            {(loaderBusy || (installingId && download)) && (
              <div className="mb-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="headline">{loaderBusy ? '正在安装…' : `正在安装 ${installingId}`}</span>
                  {download && <span className="caption">{download.percent}%</span>}
                </div>
                {download && <ProgressBar percent={download.percent} />}
                {download && (
                  <div className="caption mt-2 truncate">
                    {download.task} · {download.current}/{download.total}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-3">
              <Button size="lg" className="min-w-[112px]" onClick={() => setLoaderTarget(null)} disabled={loaderBusy}>
                取消
              </Button>
              <Button
                variant="primary"
                size="lg"
                className="min-w-[176px]"
                disabled={
                  (isVanilla ? false : !loaderVersion || loaderLoading) ||
                  loaderBusy ||
                  !customName.trim() ||
                  nameTaken
                }
                onClick={() => void confirmLoader()}
              >
                {loaderBusy ? '安装中…' : loaderLoading ? '获取版本中…' : '立即安装'}
              </Button>
            </div>
          </div>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  )
}
