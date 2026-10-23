import { AnimatePresence, motion } from 'motion/react'
import { useRuntime } from '../runtime'
import { useApp } from '../store'
import { formatSpeed } from './ui'
import type { PageId } from './Sidebar'

/**
 * 全局右下角常驻的下载浮球：对所有进行中任务（phase !== 'done'）汇总总进度与实时速度。
 * 仅在有任务时渲染，无任务即从 DOM 卸载。
 *
 * 材质 / 圆角 / 投影全部交给 `.glass-strong`：它本来就按皮肤走（Minecraft 是直角 +
 * 硬投影、WinUI 8px、M3 层级色、液态玻璃是玻璃珠）。之前这里写死了 `rounded-full`
 * 和一圈 `--fill-primary` 光晕，等于把皮肤的材质覆盖掉，九套皮肤下浮球长得一模一样。
 *
 * 进度环用 conic-gradient + 遮罩画在「边框那一圈」上，`border-radius: inherit` 让它
 * 跟着容器走 —— 圆角皮肤是圆环，直角皮肤就是直角环。SVG 圆环做不到这一点。
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

  return (
    <AnimatePresence>
      {active.length > 0 && (
        <motion.button
          key="download-orb"
          onClick={() => onNavigate('downloads')}
          className="glass-strong no-drag fixed right-5 bottom-6 z-[130] flex h-16 w-16 cursor-pointer items-center justify-center"
          initial={{ opacity: 0, scale: 0.6, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.6, y: 16 }}
          transition={{ type: 'spring', bounce: 0.18, duration: 0.45 }}
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.95 }}
          aria-label={t('orb.viewProgress')}
          title={t('orb.viewProgress')}
        >
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              borderRadius: 'inherit',
              background: `conic-gradient(from -90deg, var(--fill-primary) ${percent * 3.6}deg, var(--divider) 0)`,
              /* 只保留 3px 的「边框那一圈」，中间挖空露出玻璃底 */
              padding: 3,
              mask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
              maskComposite: 'exclude',
              WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
              WebkitMaskComposite: 'xor'
            }}
          />
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
