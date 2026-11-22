import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { DownloadEngineStatus } from '@shared/types'
import { activeGameDir, activeVersionDir, useApp } from '../store'
import { useRuntime } from '../runtime'
import { Button, Icon, ProgressBar, formatSpeed } from '../components/ui'

export function DownloadsPage(): JSX.Element {
  const { settings, openFileManager, t } = useApp()
  const { downloads, cancelDownload, cancelTask } = useRuntime()
  const active = downloads.filter((d) => d.phase !== 'done')
  /**
   * 按「是否大任务」分两档渲染：
   *   · 大任务（带 jobTitle）= 实例安装 / 整合包导入 / 加载器安装 → 大卡片；
   *   · 其余 = 单个文件、Java 运行时等细碎下载 → 紧凑小行。
   * 这样大任务不会被一串语言文件的标题淹没。
   */
  const bigTasks = active.filter((d) => !!d.jobTitle)
  const smallTasks = active.filter((d) => !d.jobTitle)
  /**
   * 当前实际使用的下载器。
   *
   * 原生内核是在网络进程启动时按平台探测加载的，运行期不会变，因此进入本页拉一次即可。
   * 取不到时保持 null，界面显示「检测中 / 不可用」而不是假装成功。
   */
  const [engine, setEngine] = useState<DownloadEngineStatus | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.download
      .engine()
      .then((s) => {
        if (alive) setEngine(s)
      })
      .catch(() => {
        /* 探测失败不阻塞界面 */
      })
    return () => {
      alive = false
    }
  }, [])

  const usesTauriRust = engine?.backend === 'tauri-rust'

  return (
    <div className="flex h-full flex-col gap-5">
      <div>
        <h1 className="display">{t('downloads.title')}</h1>
        <p className="caption mt-1">{t('downloads.subtitle')}</p>
      </div>

      <div className="glass flex flex-col gap-5 rounded-[28px] p-6">
        {active.length === 0 ? (
          <div className="flex items-center gap-3 rounded-2xl p-4" style={{ background: 'var(--fill-secondary)' }}>
            <Icon name="download" size={20} className="opacity-60" />
            <span className="text-[14px] opacity-70">{t('downloads.empty')}</span>
          </div>
        ) : (
          <div className="space-y-3">
            {/* 并行下载时每个任务渲染为独立板块，可单独取消；顶部汇总数量并提供「取消全部」。 */}
            <div className="flex items-center justify-between gap-3">
              <span className="caption">{t('downloads.activeCount', { n: active.length })}</span>
              <Button size="sm" variant="danger" icon="xmark" onClick={cancelDownload}>
                {t('downloads.cancelAll')}
              </Button>
            </div>
            <AnimatePresence initial={false}>
              {/*
               * 大任务（实例安装 / 整合包 / 加载器）用**大卡片**：标题是任务本身，
               * 当前正在下的文件降级为卡片里的「小行」—— 这就是「大的包小的」。
               * 没有 jobTitle 的是细碎单项下载，用下面的紧凑小行，视觉层级更低。
               */}
              {bigTasks.map((d) => (
                <motion.div
                  key={d.taskId ?? 'main'}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.15 } }}
                  transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
                  className="glass-soft rounded-[24px] p-5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="headline truncate">{d.jobTitle}</div>
                      {/* 小行：当前正在下载的具体文件 */}
                      {d.task && (
                        <div className="caption mt-0.5 truncate" title={d.task}>
                          {t('downloads.currentFile', { name: d.task })}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="chip">{d.percent}%</span>
                      {d.taskId && (
                        <button
                          type="button"
                          onClick={() => cancelTask(d.taskId as string)}
                          aria-label={t('downloads.cancel')}
                          title={t('downloads.cancel')}
                          className="flex h-7 w-7 items-center justify-center rounded-full opacity-60 transition-opacity hover:opacity-100"
                          style={{ background: 'var(--fill-secondary)' }}
                        >
                          <Icon name="xmark" size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="mt-3">
                    <ProgressBar percent={d.percent} />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-[12px] opacity-70">
                    <span>
                      {d.total > 0 && t('downloads.filesProgress', { done: d.current, total: d.total })}
                      {d.total > 0 && d.currentBytes > 0 ? ' · ' : ''}
                      {d.currentBytes > 0 ? formatBytes(d.currentBytes) : ''}
                      {d.totalBytes > 0 ? ` / ${formatBytes(d.totalBytes)}` : ''}
                    </span>
                    <span>{d.speed && d.speed > 0 ? formatSpeed(d.speed) : '--'}</span>
                  </div>
                </motion.div>
              ))}

              {/* 细碎单项下载：紧凑一行，不抢大任务的视觉重心 */}
              {smallTasks.length > 0 && (
                <div className="mt-1 space-y-2">
                  {bigTasks.length > 0 && <div className="caption px-1">{t('downloads.otherTasks')}</div>}
                  {smallTasks.map((d) => (
                    <motion.div
                      key={d.taskId ?? 'main-small'}
                      layout
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, transition: { duration: 0.12 } }}
                      className="glass-soft flex items-center gap-3 rounded-xl px-3 py-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-[13px]" title={d.task}>
                        {d.task}
                      </span>
                      <div className="hidden w-[120px] shrink-0 sm:block">
                        <ProgressBar percent={d.percent} />
                      </div>
                      <span className="chip shrink-0">{d.percent}%</span>
                      {d.taskId && (
                        <button
                          type="button"
                          onClick={() => cancelTask(d.taskId as string)}
                          aria-label={t('downloads.cancel')}
                          title={t('downloads.cancel')}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full opacity-60 transition-opacity hover:opacity-100"
                          style={{ background: 'var(--fill-secondary)' }}
                        >
                          <Icon name="xmark" size={12} />
                        </button>
                      )}
                    </motion.div>
                  ))}
                </div>
              )}
            </AnimatePresence>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <InfoRow label={t('downloads.versionDir')} value={activeVersionDir(settings).path} />
          <InfoRow
            label={t('downloads.concurrency')}
            value={t('downloads.concurrencyUnit', { n: settings.maxDownloadConcurrency })}
          />
          {/* Tauri 内置 Rust 后端与 Electron 的可选原生模块分别展示，保留旧版本状态兼容。 */}
          <InfoRow
            label={t('downloads.engine')}
            value={
              engine === null
                ? t('downloads.engine.detecting')
                : usesTauriRust
                  ? t('downloads.engine.tauriRust')
                  : engine.available
                    ? t('downloads.engine.native')
                    : t('downloads.engine.ts')
            }
            tone={engine === null ? 'muted' : usesTauriRust || engine.available ? 'ok' : 'warn'}
            hint={usesTauriRust ? t('downloads.engine.tauriRustHint') : engine && !engine.available ? t('downloads.engine.tsHint') : undefined}
          />
          <InfoRow
            label={t('downloads.connections')}
            value={t('downloads.connectionsUnit', { n: settings.downloadConnections })}
          />
        </div>

        <div className="flex gap-2">
          <Button icon="folder" onClick={() => openFileManager(activeGameDir(settings))}>
            {t('downloads.openGameDir')}
          </Button>
          {settings.mode !== 'local' && (
            <Button icon="settings" onClick={() => window.api.shell.openExternal('https://mcversions.net')}>
              {t('downloads.browseVersions')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/** 状态色调：ok=正常、warn=降级/需注意、muted=尚未确定。 */
type InfoTone = 'ok' | 'warn' | 'muted'

function InfoRow({
  label,
  value,
  tone,
  hint
}: {
  label: string
  value: string
  tone?: InfoTone
  hint?: string
}): JSX.Element {
  // 状态点颜色：走设计令牌，缺省时回落到语义色，避免自定义皮肤下丢色。
  const dotColor =
    tone === 'ok'
      ? 'var(--fill-success, #5fd39a)'
      : tone === 'warn'
        ? 'var(--fill-warning, #f0b34a)'
        : tone === 'muted'
          ? 'var(--text-tertiary, #999)'
          : null
  return (
    <div className="glass-soft rounded-2xl p-4">
      <div className="caption mb-1">{label}</div>
      <div className="flex items-center gap-1.5">
        {dotColor && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dotColor }} />}
        <span className="selectable truncate text-[13px] font-medium">{value}</span>
      </div>
      {hint && <div className="caption mt-1 leading-relaxed opacity-80">{hint}</div>}
    </div>
  )
}

function formatBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}
