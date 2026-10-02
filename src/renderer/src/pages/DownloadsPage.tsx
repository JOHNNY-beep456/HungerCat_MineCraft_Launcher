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
              {active.map((d) => (
                <motion.div
                  key={d.taskId ?? 'main'}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.15 } }}
                  transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
                  className="glass-soft rounded-2xl p-4"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="headline truncate">{d.task}</span>
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
                  <ProgressBar percent={d.percent} />
                  <div className="mt-2 flex items-center justify-between text-[12px] opacity-70">
                    <span>{d.currentBytes > 0 ? formatBytes(d.currentBytes) : ''}{d.totalBytes > 0 ? ` / ${formatBytes(d.totalBytes)}` : ''}</span>
                    <span>{d.speed && d.speed > 0 ? formatSpeed(d.speed) : '--'}</span>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <InfoRow label={t('downloads.versionDir')} value={activeVersionDir(settings).path} />
          <InfoRow
            label={t('downloads.concurrency')}
            value={t('downloads.concurrencyUnit', { n: settings.maxDownloadConcurrency })}
          />
          {/* 下载器内核：原生（Rust）或内置 TS。用状态点 + 文案区分，便于排查速度问题。 */}
          <InfoRow
            label={t('downloads.engine')}
            value={
              engine === null
                ? t('downloads.engine.detecting')
                : engine.available
                  ? t('downloads.engine.native')
                  : t('downloads.engine.ts')
            }
            tone={engine === null ? 'muted' : engine.available ? 'ok' : 'warn'}
            hint={engine?.available ? undefined : t('downloads.engine.tsHint')}
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
