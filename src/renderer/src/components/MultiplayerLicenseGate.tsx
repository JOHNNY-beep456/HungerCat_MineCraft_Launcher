import { useState } from 'react'
import { motion } from 'motion/react'
import { useApp } from '../store'
import { Button, Icon } from './ui'

/** MCTier 原项目与许可协议地址（标注来源用，见许可条款第 3 条）。 */
export const MCTIER_REPO = 'https://github.com/pmh1314520/MCTier'
export const MCTIER_LICENSE = 'https://github.com/pmh1314520/MCTier?tab=License-1-ov-file'
export const MCTIER_WEBSITE = 'https://mctier.pmhs.top'
/** MCTier 官方图标（与客户端主界面一致，随其官网分发）。 */
export const MCTIER_ICON = 'https://mctier.pmhs.top/images/MCTierIcon.png'

/**
 * 「联机」板块的许可协议门禁。
 *
 * MCTier 自有代码采用「源码可得（source-available）非商业许可」，禁止商业用途、
 * 要求衍生作品以相同协议开源，与本启动器的开源协议不兼容 —— 因此这里单独设一道
 * 首次进入确认，并在界面中保留原作者与项目地址标注，避免协议冲突。
 */
export function MultiplayerLicenseGate({
  onAgree,
  onReject
}: {
  onAgree: () => void
  onReject: () => void
}): JSX.Element {
  const { t, updateSettings } = useApp()
  const [agreeing, setAgreeing] = useState(false)

  const openUrl = (url: string): void => {
    void window.api.shell.openExternal(url)
  }

  const agree = async (): Promise<void> => {
    setAgreeing(true)
    try {
      await updateSettings({ multiplayerLicenseAcceptedAt: Date.now() })
      onAgree()
    } finally {
      setAgreeing(false)
    }
  }

  const terms = [
    t('mp.license.t1'),
    t('mp.license.t2'),
    t('mp.license.t3'),
    t('mp.license.t4'),
    t('mp.license.t5')
  ]

  return (
    <motion.div
      className="fixed inset-0 z-[100] flex items-center justify-center p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} />
      <motion.div
        className="glass-strong relative z-10 flex max-h-[86vh] w-full max-w-2xl flex-col rounded-[28px] p-7"
        initial={{ scale: 0.95, opacity: 0, y: 16 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.96, opacity: 0, y: 12 }}
        transition={{ type: 'spring', bounce: 0.16, duration: 0.45 }}
      >
        <div className="mb-2 flex items-center gap-2">
          <Icon name="globe" size={20} />
          <span className="title">{t('mp.license.title')}</span>
        </div>
        <p className="caption mb-1">{t('mp.license.subtitle')}</p>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-2xl p-1 pr-2">
          <p className="selectable text-[13px] leading-relaxed opacity-85">{t('mp.license.intro')}</p>

          <div className="glass-soft rounded-2xl p-4">
            <div className="headline mb-2">{t('mp.license.termsTitle')}</div>
            <ul className="space-y-2">
              {terms.map((line) => (
                <li key={line} className="flex gap-2 text-[13px] leading-relaxed opacity-85">
                  <Icon name="check" size={15} className="mt-[3px] shrink-0" style={{ color: 'var(--fill-success)' }} />
                  <span className="selectable">{line}</span>
                </li>
              ))}
            </ul>
          </div>

          <div
            className="rounded-2xl p-4 text-[12.5px] leading-relaxed"
            style={{ background: 'var(--fill-warning-soft, rgba(240,179,74,0.12))', color: 'var(--text-warning, #f0b34a)' }}
          >
            {t('mp.license.notOpenSource')}
          </div>

          <div className="glass-soft rounded-2xl p-4">
            <div className="headline mb-2">{t('mp.license.attribution')}</div>
            <pre className="selectable whitespace-pre-wrap break-words text-[12.5px] leading-relaxed opacity-85">
              {t('mp.license.attributionBody')}
            </pre>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon="link" onClick={() => openUrl(MCTIER_LICENSE)}>
              {t('mp.license.readOriginal')}
            </Button>
            <Button size="sm" icon="link" onClick={() => openUrl(MCTIER_REPO)}>
              {t('mp.openSource')}
            </Button>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between gap-3">
          <span className="caption">{t('mp.license.rejectHint')}</span>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="lg" onClick={onReject} disabled={agreeing}>
              {t('mp.license.reject')}
            </Button>
            <Button
              variant="primary"
              size="lg"
              icon="check"
              onClick={() => void agree()}
              disabled={agreeing}
            >
              {agreeing ? t('mp.license.agreeing') : t('mp.license.agree')}
            </Button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
