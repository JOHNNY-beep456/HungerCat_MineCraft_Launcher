import { AnimatePresence, motion } from 'motion/react'
import { useApp } from '../store'
import { useRuntime } from '../runtime'
import { Button, Icon, ProgressBar, formatSpeed } from '../components/ui'

export function DownloadsPage(): JSX.Element {
  const { settings } = useApp()
  const { downloads, cancelDownload } = useRuntime()

  return (
    <div className="flex h-full flex-col gap-5">
      <div>
        <h1 className="display">进度</h1>
        <p className="caption mt-1">查看下载与安装进度，管理游戏目录</p>
      </div>

      <div className="glass flex flex-col gap-5 rounded-[28px] p-6">
        {downloads.length === 0 ? (
          <div className="flex items-center gap-3 rounded-2xl p-4" style={{ background: 'var(--fill-secondary)' }}>
            <Icon name="download" size={20} className="opacity-60" />
            <span className="text-[14px] opacity-70">当前没有正在进行的下载任务</span>
          </div>
        ) : (
          <div className="space-y-3">
            {/* 任务行增删用 layout 平滑过渡，进出场做淡入 + 轻微 y */}
            <AnimatePresence initial={false}>
              {downloads.map((d) => (
                <motion.div
                  key={d.taskId ?? 'main'}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.15 } }}
                  transition={{ type: 'spring', bounce: 0, duration: 0.3 }}
                  className="glass-soft rounded-2xl p-4"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="headline truncate">{d.task}</span>
                    <span className="chip">{d.percent}%</span>
                  </div>
                  <ProgressBar percent={d.percent} />
                  <div className="mt-2 flex items-center justify-between text-[12px] opacity-70">
                    <span>{d.currentBytes > 0 ? formatBytes(d.currentBytes) : ''}{d.totalBytes > 0 ? ` / ${formatBytes(d.totalBytes)}` : ''}</span>
                    <span>{d.speed && d.speed > 0 ? formatSpeed(d.speed) : '--'}</span>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
            <Button size="sm" variant="danger" icon="xmark" onClick={cancelDownload}>
              取消全部
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <InfoRow label="游戏目录" value={settings.gameDir} />
          <InfoRow label="下载镜像" value={settings.mirror === 'mojang' ? 'Mojang 官方' : 'BMCLAPI（国内镜像）'} />
          <InfoRow label="并发连接" value={`${settings.maxDownloadConcurrency} 个`} />
        </div>

        <div className="flex gap-2">
          <Button icon="folder" onClick={() => void window.api.shell.openPath(settings.gameDir)}>
            打开游戏目录
          </Button>
          {settings.mode !== 'local' && (
            <Button icon="settings" onClick={() => window.api.shell.openExternal('https://mcversions.net')}>
              浏览版本
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="glass-soft rounded-2xl p-4">
      <div className="caption mb-1">{label}</div>
      <div className="selectable truncate text-[13px] font-medium">{value}</div>
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
