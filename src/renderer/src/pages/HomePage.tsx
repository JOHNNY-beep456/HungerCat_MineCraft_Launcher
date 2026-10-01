import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { InstalledVersion, SystemMemoryInfo, VersionDir } from '@shared/types'
import type { TFunction } from '../i18n'
import { activeGameDir, useAdaptivePolling, useApp, versionDirLabel } from '../store'
import { useRuntime } from '../runtime'
import { Avatar, Button, Icon, ProgressBar, Select } from '../components/ui'

export function HomePage(): JSX.Element {
  const { settings, selectedAccount, updateSettings, reloadSettings, t } = useApp()
  const { download, launchState, launchLog, launchReport, dismissLaunchReport, busy, launch, stopLaunch } =
    useRuntime()

  const [installed, setInstalled] = useState<InstalledVersion[]>([])
  const [dirs, setDirs] = useState<VersionDir[]>([])
  const [memory, setMemory] = useState(settings.memoryMb)
  const [memInfo, setMemInfo] = useState<SystemMemoryInfo | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [search, setSearch] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  const activeDirId = settings.selectedVersionDirId || 'default'

  const refreshMemory = (): void => {
    void window.api.system.memory().then(setMemInfo).catch(() => setMemInfo(null))
  }

  // 已安装版本随「当前版本目录」收敛：切换目录后重新拉取。
  //
  // 首次挂载刻意延后到首帧之后：installed:list 要全量扫描版本目录（几十个版本 ×
  // 存档 / 服务器 / 版本 JSON），若在挂载时立即发起，会和首屏渲染抢主进程 IO 与主线程，
  // 表现为「启动后界面要点一下才动 / 首屏卡顿」。延后到空闲时执行，首屏先出骨架。
  const installedFirstRun = useRef(true)
  useEffect(() => {
    let cancelled = false
    let idleId: number | undefined
    let timerId: ReturnType<typeof setTimeout> | undefined
    const run = (): void => {
      void (async () => {
        try {
          const list = await window.api.installed.list()
          if (!cancelled) setInstalled(list)
        } catch {
          /* installed:list 偶发失败时保持上次状态，不做阻塞 */
        }
      })()
    }
    if (installedFirstRun.current) {
      installedFirstRun.current = false
      // 优先 requestIdleCallback（浏览器空闲）；不支持时退化为 setTimeout 宏任务，
      // 两者都在首帧提交之后执行，不再阻塞启动。
      const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback
      if (typeof ric === 'function') idleId = ric(run)
      else timerId = setTimeout(run, 0)
    } else {
      run()
    }
    return () => {
      cancelled = true
      const cic = (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback
      if (idleId !== undefined && typeof cic === 'function') cic(idleId)
      if (timerId !== undefined) clearTimeout(timerId)
    }
  }, [activeDirId])

  /**
   * 选中的游戏版本由设置持久化（与自定义主页共用同一个 selectedVersionId 字段）：
   * 关闭启动器后再打开仍保留上次选择。若该版本已被删除、或不在当前版本目录，
   * 则回落到首个已装版本。
   */
  const versionId = useMemo(() => {
    const saved = settings.selectedVersionId
    if (saved && installed.some((v) => v.id === saved)) return saved
    return installed[0]?.id ?? ''
  }, [settings.selectedVersionId, installed])

  // 回落后把结果写回设置，避免每次都重新计算（也保持两处界面选择一致）。
  useEffect(() => {
    if (versionId && versionId !== settings.selectedVersionId) {
      void updateSettings({ selectedVersionId: versionId })
    }
  }, [versionId, settings.selectedVersionId, updateSettings])

  const setVersionId = (id: string): void => {
    void updateSettings({ selectedVersionId: id })
  }

  useEffect(() => {
    void window.api.versionDirs.list().then(setDirs).catch(() => undefined)
  }, [])

  useEffect(() => {
    refreshMemory()
  }, [])
  // 已用内存轮询：常规 30s；超低占用模式下放宽周期并在窗口不可见时暂停。
  useAdaptivePolling(refreshMemory, 30000, settings.lowUsageMode)

  // 切换版本目录：主进程持久化选中项并失效缓存，installed 副作用随之重新拉取。
  const selectDir = async (id: string): Promise<void> => {
    if (id === activeDirId) return
    await window.api.versionDirs.select(id)
    await reloadSettings()
  }

  useEffect(() => setMemory(settings.memoryMb), [settings.memoryMb])

  // 预留内存不得超过剩余可用内存：内存信息变化时自动收敛
  useEffect(() => {
    if (!memInfo || memInfo.free < 1024) return
    const cap = Math.floor(memInfo.free / 512) * 512
    setMemory((m) => Math.min(m, cap))
  }, [memInfo])
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [launchLog])

  const running = busy && (launchState === 'running' || launchState === 'launching' || launchState === 'downloading')

  // PCL 风格启动进度：下载阶段取真实下载百分比，其余阶段用分阶段近似值。
  const progressPercent =
    launchState === 'downloading'
      ? download?.percent ?? 0
      : launchState === 'launching'
        ? 90
        : launchState === 'running'
          ? 100
          : 0

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return installed.filter((v) => !q || v.id.toLowerCase().includes(q)).slice(0, 400)
  }, [installed, search])

  const current = installed.find((v) => v.id === versionId)

  // 自动内存：占用剩余内存的至多 30%，最少 4096MB（按 512MB 对齐）
  const autoMemory = (): void => {
    if (!memInfo) return
    const auto = Math.max(4096, Math.floor((memInfo.free * 0.3) / 512) * 512)
    setMemory(Math.min(auto, memInfo.free))
  }

  const handleLaunch = (): void => {
    if (!selectedAccount) return
    if (!versionId) return
    void updateSettings({ memoryMb: memory })
    void launch({
      versionId,
      accountId: selectedAccount.id,
      gameDir: activeGameDir(settings),
      memoryMb: memory,
      javaPath: settings.javaPath || undefined
    })
  }

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="display">{t('home.title')}</h1>
          <p className="caption mt-1">{t('home.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {selectedAccount ? (
            <div className="glass-soft flex items-center gap-2 rounded-2xl px-3 py-1.5">
              <Avatar name={selectedAccount.name} uuid={selectedAccount.id} skinUrl={selectedAccount.skinUrl} authType={selectedAccount.authType} yggdrasilServer={selectedAccount.yggdrasilServer} offline={selectedAccount.offline} size={26} />
              <span className="text-[13px] font-medium">{selectedAccount.name}</span>
            </div>
          ) : (
            <span className="chip">{t('home.notLoggedIn')}</span>
          )}
        </div>
      </div>

      <div className={`grid flex-1 grid-cols-1 gap-5 overflow-hidden ${settings.debugMode ? 'lg:grid-cols-[1.1fr_1fr]' : ''}`}>
        {/* Left: controls */}
        <div className="glass flex flex-col gap-5 rounded-[28px] p-6">
          {/* 版本目录：版本列表与启动落点都以当前选中的版本目录为准 */}
          <div className="glass-soft flex items-center gap-3 rounded-2xl px-3 py-2">
            <Icon name="folder" size={15} className="shrink-0 opacity-60" />
            <span className="caption shrink-0">{t('home.versionDir')}</span>
            <Select
              className="min-w-0 flex-1"
              value={activeDirId}
              onChange={(v) => void selectDir(v)}
              options={dirs.map((d) => ({ value: d.id, label: versionDirLabel(d) }))}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <div className="headline">{t('home.gameVersion')}</div>
              <div className="caption">
                {current
                  ? t('home.versionSummary', { loader: loaderLabel(current.loader, t), mc: current.mcVersion })
                  : t('home.noVersion')}
              </div>
            </div>
            <div className="relative">
              <Button icon="cube" onClick={() => setPickerOpen((v) => !v)}>
                {versionId || t('home.selectVersion')}
                <Icon name="chevronRight" size={15} className="rotate-90" />
              </Button>
              <AnimatePresence>
                {pickerOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -8, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.98 }}
                    transition={{ type: 'spring', bounce: 0.15, duration: 0.32 }}
                    className="glass-strong absolute right-0 z-50 mt-2 w-72 overflow-hidden rounded-2xl p-2"
                  >
                    <div className="relative mb-1">
                      <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 opacity-50" />
                      <input
                        autoFocus
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={t('home.searchPlaceholder')}
                        className="input w-full pl-9"
                      />
                    </div>
                    <div className="max-h-80 overflow-y-auto">
                      {filtered.length === 0 ? (
                        <div className="px-3 py-4 text-center text-[13px] opacity-60">
                          {t('home.emptyInstalled')}
                        </div>
                      ) : (
                        filtered.map((v) => (
                          <VersionOption
                            key={v.id}
                            v={v}
                            active={v.id === versionId}
                            onSelect={() => {
                              setVersionId(v.id)
                              setPickerOpen(false)
                              setSearch('')
                            }}
                          />
                        ))
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="headline">{t('home.memoryAlloc')}</span>
              <div className="flex items-center gap-2">
                <span className="chip">{gb(memory)} GB</span>
                {memInfo && (
                  <Button size="sm" onClick={autoMemory}>
                    {t('home.auto')}
                  </Button>
                )}
              </div>
            </div>

            {/* 内存显示条：极淡主题色打底=总内存，深主题色=已用，浅主题色=游戏预留 */}
            {memInfo && (
              <div className="mb-3">
                <div
                  className="relative h-3 overflow-hidden rounded-full"
                  style={{ background: hexToRgba(settings.accentColor, 0.12) }}
                >
                  <div
                    className="absolute left-0 top-0 h-full transition-all"
                    style={{ width: `${pct(memInfo.used, memInfo.total)}%`, background: hexToRgba(settings.accentColor, 0.85) }}
                  />
                  <div
                    className="absolute top-0 h-full transition-all"
                    style={{
                      left: `${pct(memInfo.used, memInfo.total)}%`,
                      width: `${pct(memory, memInfo.total)}%`,
                      background: hexToRgba(settings.accentColor, 0.42)
                    }}
                  />
                </div>
                <div className="mt-1 flex justify-between text-[11px] opacity-50">
                  <span>
                    {t('home.memUsedTotal', { used: gb(memInfo.used), total: gb(memInfo.total) })}
                  </span>
                  <span>{t('home.memReserved', { n: gb(memory) })}</span>
                </div>
              </div>
            )}

            <input
              type="range"
              min={1024}
              max={Math.max(1024, memInfo?.free ?? 16384)}
              step={512}
              value={memory}
              onChange={(e) => setMemory(Number(e.target.value))}
              className="w-full"
              style={{ accentColor: 'var(--fill-primary)' }}
            />
          </div>

          <div className="mt-auto">
            {busy && (
              <div className="mb-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="headline">{launchStage(t, launchState)}</span>
                  <span className="chip">{launchState === 'starting' ? '…' : `${progressPercent}%`}</span>
                </div>
                <ProgressBar percent={progressPercent} />
                {launchState === 'downloading' && download && (
                  <div className="caption mt-1.5 truncate">{download.task}</div>
                )}
              </div>
            )}
            {!selectedAccount && (
              <div className="glass-soft mb-3 flex items-center gap-2 rounded-2xl px-3 py-2.5 text-[13px]">
                <Icon name="user" size={16} />
                {t('home.loginFirst')}
              </div>
            )}
            {running ? (
              <Button variant="danger" icon="stop" size="lg" className="w-full rounded-2xl" onClick={stopLaunch}>
                {t('home.stopGame')}
              </Button>
            ) : (
              <Button
                variant="primary"
                icon="play"
                size="lg"
                className="w-full rounded-2xl text-[16px]"
                disabled={!selectedAccount || !versionId}
                onClick={handleLaunch}
              >
                {t('home.launchMinecraft')}
              </Button>
            )}
          </div>
        </div>

        {/* Right: console (仅 Debug 模式显示) */}
        {settings.debugMode && (
        <div className="glass flex min-h-0 flex-col rounded-[28px] p-5">
          <div className="mb-3 flex items-center justify-between">
            <span className="headline">{t('home.launchLog')}</span>
            <div className="flex items-center gap-2">
              <span
                className="inline-flex h-2 w-2 rounded-full"
                style={{
                  background:
                    launchState === 'running'
                      ? 'var(--fill-success)'
                      : launchState === 'error'
                        ? 'var(--fill-danger)'
                        : 'var(--text-tertiary)'
                }}
              />
              <span className="caption">{statusLabel(t, launchState)}</span>
            </div>
          </div>
          <div
            ref={logRef}
            className="selectable min-h-0 flex-1 overflow-y-auto rounded-2xl p-3 font-mono text-[12px] leading-relaxed"
            style={{ background: 'rgba(0,0,0,0.28)', color: 'rgba(255,255,255,0.82)' }}
          >
            {launchLog.length === 0 ? (
              <div className="opacity-40">{t('home.consoleEmpty')}</div>
            ) : (
              launchLog.map((line, i) => <div key={i} className="whitespace-pre-wrap break-all">{line}</div>)
            )}
          </div>
          {download && (
            <div className="mt-3 shrink-0">
              <div className="mb-1.5 flex items-center justify-between text-[12px]">
                <span className="truncate">{download.task}</span>
                <span className="opacity-60">{download.percent}%</span>
              </div>
              <ProgressBar percent={download.percent} />
            </div>
          )}
        </div>
        )}
      </div>

      {/* 启动异常报告：按关键词给出结论与建议；识别不出时原样展示错误内容。 */}
      {launchReport && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center p-6">
          <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={dismissLaunchReport} />
          <div className="glass-strong relative z-10 flex max-h-[80vh] w-full max-w-lg flex-col rounded-[28px] p-6">
            <div className="mb-3 flex items-center gap-3">
              <div
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-white"
                style={{ background: 'var(--fill-danger)' }}
              >
                <Icon name="xmark" size={22} />
              </div>
              <div className="min-w-0">
                <h2 className="title">{t('home.report.title')}</h2>
                <p className="caption">{launchReport.summary}</p>
              </div>
            </div>
            {launchReport.advice && (
              <p className="caption mb-3 rounded-xl px-3 py-2" style={{ background: 'var(--chip-bg)' }}>
                {launchReport.advice}
              </p>
            )}
            <div className="mb-1.5 text-[13px] font-semibold">{t('home.report.detail')}</div>
            <pre
              className="selectable min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-2xl p-3 font-mono text-[12px] leading-relaxed"
              style={{ background: 'rgba(0,0,0,0.28)', color: 'rgba(255,255,255,0.82)' }}
            >
              {launchReport.raw}
            </pre>
            <div className="mt-4 flex gap-2">
              <Button className="flex-1" onClick={dismissLaunchReport}>
                {t('home.report.close')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function statusLabel(t: TFunction, s: string | null): string {
  switch (s) {
    case 'starting':
      return t('home.status.starting')
    case 'downloading':
      return t('home.status.downloading')
    case 'launching':
      return t('home.status.launching')
    case 'running':
      return t('home.status.running')
    case 'exited':
      return t('home.status.exited')
    case 'error':
      return t('home.status.error')
    default:
      return t('home.status.idle')
  }
}

/** PCL 风格启动进度的阶段标题。 */
function launchStage(t: TFunction, s: string | null): string {
  switch (s) {
    case 'starting':
      return t('home.stage.starting')
    case 'downloading':
      return t('home.stage.downloading')
    case 'launching':
      return t('home.stage.launching')
    case 'running':
      return t('home.stage.running')
    case 'exited':
      return t('home.stage.exited')
    case 'error':
      return t('home.stage.error')
    default:
      return t('home.stage.default')
  }
}

function VersionOption({
  v,
  active,
  onSelect
}: {
  v: InstalledVersion
  active: boolean
  onSelect: () => void
}): JSX.Element {
  const { t } = useApp()
  return (
    <button
      onClick={onSelect}
      className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left no-drag"
      style={{ background: active ? 'var(--fill-secondary)' : 'transparent' }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = 'var(--fill-secondary)'
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent'
      }}
    >
      <span className="truncate text-[13px] font-medium">{v.id}</span>
      <span className="chip">{loaderLabel(v.loader, t)}</span>
    </button>
  )
}

function loaderLabel(loader: string | null, t: TFunction): string {
  if (!loader) return t('home.vanilla')
  return loader.charAt(0).toUpperCase() + loader.slice(1)
}

/** MB -> GB，保留一位小数。 */
function gb(mb: number): string {
  return (Math.round((mb / 1024) * 10) / 10).toFixed(1)
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, (part / total) * 100))
}

function hexToRgba(hex: string, alpha: number): string {
  const m = hex.replace('#', '')
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  if ([r, g, b].some(Number.isNaN)) return `rgba(10,132,255,${alpha})`
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
