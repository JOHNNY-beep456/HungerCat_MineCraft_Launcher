import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { InstalledVersion, SystemMemoryInfo } from '@shared/types'
import { useApp } from '../store'
import { useRuntime } from '../runtime'
import { Avatar, Button, Icon, ProgressBar } from '../components/ui'

export function HomePage(): JSX.Element {
  const { settings, selectedAccount, updateSettings } = useApp()
  const { download, launchState, launchLog, busy, launch, stopLaunch } = useRuntime()

  const [installed, setInstalled] = useState<InstalledVersion[]>([])
  const [versionId, setVersionId] = useState<string>('')
  const [memory, setMemory] = useState(settings.memoryMb)
  const [memInfo, setMemInfo] = useState<SystemMemoryInfo | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [search, setSearch] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  const refreshMemory = (): void => {
    void window.api.system.memory().then(setMemInfo).catch(() => setMemInfo(null))
  }

  useEffect(() => {
    void (async () => {
      const list = await window.api.installed.list()
      setInstalled(list)
      // 默认选中第一个已下载的版本（启动页只能启动已下载版本）
      setVersionId((prev) => (prev && list.some((v) => v.id === prev) ? prev : list[0]?.id ?? ''))
    })()
    refreshMemory()
    // 已用内存每 30 秒更新一次
    const timer = setInterval(refreshMemory, 30000)
    return () => clearInterval(timer)
  }, [])

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
      gameDir: settings.gameDir,
      memoryMb: memory,
      javaPath: settings.javaPath || undefined
    })
  }

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="display">启动游戏</h1>
          <p className="caption mt-1">选择一个版本，一键进入方块世界</p>
        </div>
        <div className="flex items-center gap-2">
          {selectedAccount ? (
            <div className="glass-soft flex items-center gap-2 rounded-2xl px-3 py-1.5">
              <Avatar name={selectedAccount.name} uuid={selectedAccount.id} skinUrl={selectedAccount.skinUrl} authType={selectedAccount.authType} yggdrasilServer={selectedAccount.yggdrasilServer} size={26} />
              <span className="text-[13px] font-medium">{selectedAccount.name}</span>
            </div>
          ) : (
            <span className="chip">未登录账号</span>
          )}
        </div>
      </div>

      <div className={`grid flex-1 grid-cols-1 gap-5 overflow-hidden ${settings.debugMode ? 'lg:grid-cols-[1.1fr_1fr]' : ''}`}>
        {/* Left: controls */}
        <div className="glass flex flex-col gap-5 rounded-[28px] p-6">
          <div className="flex items-center justify-between">
            <div>
              <div className="headline">游戏版本</div>
              <div className="caption">
                {current ? `${loaderLabel(current.loader)} · MC ${current.mcVersion}` : '未选择版本'}
              </div>
            </div>
            <div className="relative">
              <Button icon="cube" onClick={() => setPickerOpen((v) => !v)}>
                {versionId || '选择版本'}
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
                        placeholder="搜索版本…"
                        className="input w-full pl-9"
                      />
                    </div>
                    <div className="max-h-80 overflow-y-auto">
                      {filtered.length === 0 ? (
                        <div className="px-3 py-4 text-center text-[13px] opacity-60">
                          还没有已下载的版本，请先到「版本」页安装
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
              <span className="headline">分配内存</span>
              <div className="flex items-center gap-2">
                <span className="chip">{gb(memory)} GB</span>
                {memInfo && (
                  <Button size="sm" onClick={autoMemory}>
                    自动
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
                    已用 {gb(memInfo.used)} GB / 共 {gb(memInfo.total)} GB
                  </span>
                  <span>预留 {gb(memory)} GB</span>
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
                  <span className="headline">{launchStage(launchState)}</span>
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
                请先在「账号」页登录微软账号
              </div>
            )}
            {running ? (
              <Button variant="danger" icon="stop" size="lg" className="w-full rounded-2xl" onClick={stopLaunch}>
                停止游戏
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
                启动 Minecraft
              </Button>
            )}
          </div>
        </div>

        {/* Right: console (仅 Debug 模式显示) */}
        {settings.debugMode && (
        <div className="glass flex min-h-0 flex-col rounded-[28px] p-5">
          <div className="mb-3 flex items-center justify-between">
            <span className="headline">运行日志</span>
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
              <span className="caption">{statusLabel(launchState)}</span>
            </div>
          </div>
          <div
            ref={logRef}
            className="selectable min-h-0 flex-1 overflow-y-auto rounded-2xl p-3 font-mono text-[12px] leading-relaxed"
            style={{ background: 'rgba(0,0,0,0.28)', color: 'rgba(255,255,255,0.82)' }}
          >
            {launchLog.length === 0 ? (
              <div className="opacity-40">启动游戏后，控制台输出将显示在这里。</div>
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
    </div>
  )
}

function statusLabel(s: string | null): string {
  switch (s) {
    case 'starting':
      return '准备中'
    case 'downloading':
      return '下载中'
    case 'launching':
      return '启动中'
    case 'running':
      return '运行中'
    case 'exited':
      return '已退出'
    case 'error':
      return '出错'
    default:
      return '空闲'
  }
}

/** PCL 风格启动进度的阶段标题。 */
function launchStage(s: string | null): string {
  switch (s) {
    case 'starting':
      return '正在准备'
    case 'downloading':
      return '正在下载资源'
    case 'launching':
      return '正在启动'
    case 'running':
      return '游戏运行中'
    case 'exited':
      return '已退出'
    case 'error':
      return '启动失败'
    default:
      return '正在启动'
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
      <span className="chip">{loaderLabel(v.loader)}</span>
    </button>
  )
}

function loaderLabel(loader: string | null): string {
  if (!loader) return '原版'
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
