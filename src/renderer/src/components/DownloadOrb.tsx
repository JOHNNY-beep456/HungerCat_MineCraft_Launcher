import { AnimatePresence, motion } from 'motion/react'
import { useRuntime } from '../runtime'
import { useApp } from '../store'
import { formatSpeed } from './ui'
import type { PageId } from './Sidebar'

/**
 * 全局右下角常驻的下载浮球：对所有进行中任务（phase !== 'done'）汇总总进度与实时速度。
 * 采用与启动器一致的毛玻璃材质 + 主题色环形进度，仅在有任务时渲染，无任务即从 DOM 卸载。
 *
 * z-index 取 130：高于页面级遮罩（自定义主页安全闸门 z-120、设置弹窗 z-115 等），
 * 这样「启动游戏」页在自定义主页闸门之下时浮球依然可见；仍低于安全封锁遮罩（z-200）。
 */
export function DownloadOrb({ onNavigate }: { onNavigate: (p: PageId) => void }): JSX.Element | null {
  const { downloads } = useRuntime()
  const { t } = useApp()
  // done 的进度会被 runtime 即时移除，这里再过滤一次以兜底瞬时空窗。
  const active = downloads.filter((d) => d.phase !== 'done')
  const totalCurrent = active.reduce((s, d) => s + (d.currentBytes || 0), 0)
  const totalTotal = active.reduce((s, d) => s + (d.totalBytes || 0), 0)
  const percent = totalTotal > 0 ? Math.round((totalCurrent / totalTotal) * 100) : 0
  const speed = active.reduce((s, d) => s + (d.speed || 0), 0)

  const R = 26
  const C = 2 * Math.PI * R
  const offset = C * (1 - Math.min(100, Math.max(0, percent)) / 100)

  return (
    <AnimatePresence>
      {active.length > 0 && (
        <motion.button
          key="download-orb"
          onClick={() => onNavigate('downloads')}
          className="glass-strong no-drag fixed right-5 bottom-6 z-[130] flex h-16 w-16 cursor-pointer items-center justify-center rounded-full"
          style={{ boxShadow: '0 10px 30px -8px var(--fill-primary)' }}
          initial={{ opacity: 0, scale: 0.6, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.6, y: 16 }}
          transition={{ type: 'spring', bounce: 0.18, duration: 0.45 }}
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.95 }}
          aria-label={t('orb.viewProgress')}
          title={t('orb.viewProgress')}
        >
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full -rotate-90"
            viewBox="0 0 64 64"
            aria-hidden
          >
            <circle cx="32" cy="32" r={R} fill="none" stroke="var(--divider)" strokeWidth="3" />
            <circle
              cx="32"
              cy="32"
              r={R}
              fill="none"
              stroke="var(--fill-primary)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={offset}
            />
          </svg>
          <span className="relative flex flex-col items-center leading-none">
            <span className="text-[14px] font-bold">{percent}%</span>
            <span className="mt-1 text-[9px] opacity-75">{formatSpeed(speed)}</span>
          </span>
          {/* 多于一个并行任务时在右上角显示数量角标，提示是「多个板块」而非单任务。 */}
          {active.length > 1 && (
            <span
              className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white"
              style={{ background: 'var(--fill-danger)' }}
            >
              {active.length}
            </span>
          )}
        </motion.button>
      )}
    </AnimatePresence>
  )
}
