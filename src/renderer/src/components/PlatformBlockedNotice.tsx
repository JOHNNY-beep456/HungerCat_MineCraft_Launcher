import { AnimatePresence, motion } from 'motion/react'
import { useRuntime } from '../runtime'
import { useApp } from '../store'
import { Button, Icon } from './ui'

/**
 * 移动端（Android/iOS）点击启动时的说明弹窗。
 *
 * 为什么要单独一个弹窗：移动端没有可执行的桌面 JRE（Temurin 是 glibc 二进制，Android 只有
 * bionic，且 `targetSdk ≥ 29` 禁止 exec/dlopen 私有目录内的可执行文件），因此游戏启动与
 * 桌面 Java 安装都不可能在移动端完成。以前这里会一路走到后端再抛出「尚未适配」的
 * 技术性错误，用户只看到一句无法行动的报错；现在在点击这一层就说明清楚，
 * 并让用户知道移动端仍可正常做版本、模组、整合包与服务器的管理。
 */
export function PlatformBlockedNotice(): JSX.Element {
  const { t } = useApp()
  const { platformBlocked, dismissPlatformBlocked } = useRuntime()

  return (
    <AnimatePresence>
      {platformBlocked && (
        <motion.div className="absolute inset-0 z-[70] flex items-center justify-center p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div
            className="absolute inset-0"
            style={{ background: 'var(--scrim)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={dismissPlatformBlocked}
          />
          <motion.div
            className="glass-strong relative z-10 w-full max-w-md rounded-[32px] p-8"
            initial={{ opacity: 0, scale: 0.92, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 16 }}
            transition={{ type: 'spring', bounce: 0.2, duration: 0.45 }}
          >
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl text-white" style={{ background: 'var(--accent, #3b82f6)' }}>
                <Icon name="info" size={22} />
              </div>
              <div>
                <h2 className="title">{t('cmp.platformBlocked.title')}</h2>
                <p className="caption">{t('cmp.platformBlocked.subtitle')}</p>
              </div>
            </div>

            <p className="mb-3 text-[13px] opacity-80">{t('cmp.platformBlocked.body')}</p>
            <p className="mb-5 text-[12px] opacity-60">{t('cmp.platformBlocked.hint')}</p>

            <Button variant="primary" className="w-full" onClick={dismissPlatformBlocked}>
              {t('cmp.platformBlocked.close')}
            </Button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
