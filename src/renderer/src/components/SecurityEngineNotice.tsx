// ---------------------------------------------------------------------------
// 主页安全检测「未使用原生（Rust）内核」时的顶部非侵入式提示。
//
// 主页脚本的静态安全检测优先由原生内核承担；当本机没有编译该平台产物、或使用的是
// 不含该导出的旧版原生库、或加载失败时，会自动回退到 TS 实现 —— 功能仍然可用，
// 但性能与「与规则表同源」的程度都不如原生。这类降级不应被静默隐藏，因此用一条
// 顶部细横幅告知：不遮挡内容、不阻断操作，可手动关闭（本次会话内不再出现）。
// ---------------------------------------------------------------------------

import { useState } from 'react'
import { motion } from 'motion/react'
import { useApp } from '../store'
import { Icon } from './ui'

export function SecurityEngineNotice(): JSX.Element | null {
  const { t, homepageSecurityNative } = useApp()
  const [dismissed, setDismissed] = useState(false)

  // 仅在「已探测且确为未使用原生」时展示；未探测（null）/ 使用原生（true）都不显示。
  if (dismissed || homepageSecurityNative !== false) return null

  return (
    <motion.div
      className="no-drag fixed top-12 left-1/2 z-[95] -translate-x-1/2"
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', bounce: 0.16, duration: 0.4 }}
      role="status"
    >
      <div
        className="glass-strong flex max-w-[calc(100vw-32px)] items-center gap-2 rounded-full py-1.5 pr-1.5 pl-3 text-[12.5px] shadow-lg"
        style={{ border: '1px solid var(--divider)' }}
      >
        <Icon name="info" size={15} className="shrink-0" style={{ color: '#ff9f0a' }} />
        <span className="min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>
          {t('hp.engine.tsFallback')}
        </span>
        <button
          type="button"
          aria-label={t('hp.engine.dismiss')}
          title={t('hp.engine.dismiss')}
          onClick={() => setDismissed(true)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors"
          style={{ color: 'var(--text-secondary)' }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--fill-secondary)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <Icon name="xmark" size={13} />
        </button>
      </div>
    </motion.div>
  )
}
