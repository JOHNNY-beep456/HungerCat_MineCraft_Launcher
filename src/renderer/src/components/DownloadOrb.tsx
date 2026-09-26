import { AnimatePresence, motion } from 'motion/react'
import { useRuntime } from '../runtime'
import { formatSpeed } from './ui'
import type { PageId } from './Sidebar'

/**
 * 全局右下角常驻的下载进度光球：对所有进行中下载任务（phase !== 'done'）
 * 汇总总进度与实时速度。仅在有进行中任务时渲染，无任务即从 DOM 卸载，
 * 不产生常驻遮挡。点击跳到「进度」页。
 */
export function DownloadOrb({ onNavigate }: { onNavigate: (p: PageId) => void }): JSX.Element | null {
  const { downloads } = useRuntime()
  // done 的进度会被 runtime 即时移除，这里再过滤一次以兜底瞬时空窗。
  const active = downloads.filter((d) => d.phase !== 'done')
  const totalCurrent = active.reduce((s, d) => s + (d.currentBytes || 0), 0)
  const totalTotal = active.reduce((s, d) => s + (d.totalBytes || 0), 0)
  const percent = totalTotal > 0 ? Math.round((totalCurrent / totalTotal) * 100) : 0
  const speed = active.reduce((s, d) => s + (d.speed || 0), 0)

  return (
    <AnimatePresence>
      {active.length > 0 && (
        <motion.button
          key="download-orb"
          onClick={() => onNavigate('downloads')}
          className="glass-strong no-drag fixed right-5 bottom-6 z-[90] flex h-16 w-16 cursor-pointer flex-col items-center justify-center overflow-hidden rounded-full"
          style={{ boxShadow: '0 8px 24px -6px var(--fill-primary)' }}
          initial={{ opacity: 0, scale: 0.6, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.6, y: 16 }}
          transition={{ type: 'spring', bounce: 0.18, duration: 0.45 }}
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.95 }}
          aria-label="查看下载进度"
          title="查看下载进度"
        >
          <div
            className="pointer-events-none absolute inset-0 rounded-full"
            style={{ background: 'linear-gradient(140deg, var(--fill-primary) 0%, transparent 65%)', opacity: 0.55 }}
          />
          <span className="relative text-[15px] font-bold leading-none" style={{ color: 'var(--text-primary)' }}>
            {percent}%
          </span>
          <span className="relative mt-1 text-[9px] leading-none opacity-80">{formatSpeed(speed)}</span>
        </motion.button>
      )}
    </AnimatePresence>
  )
}
