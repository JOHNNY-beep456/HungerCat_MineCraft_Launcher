import { useState } from 'react'
import { motion } from 'motion/react'
import { useApp } from '../store'
import { Button, Icon, LoadingState } from './ui'

/**
 * 协议同意弹窗。
 *
 * 正文与版本来自启动时的协议核对（agreementStatus）：
 *   - content 为 null 表示联网失败，展示离线提示（仍可同意，按服务端已公布内容为准）；
 *   - 若此前已同意过（agreementAcceptedAt > 0）而仍弹窗，说明协议内容发生变更，
 *     此时顶部给出「协议已更新」的提醒，要求玩家重新同意。
 *
 * 同意时同时记录「同意时间」与「协议版本指纹」，此后版本不变则不再打扰。
 */
export function AgreementModal(): JSX.Element {
  const { t, settings, agreementStatus, updateSettings } = useApp()
  const [agreeing, setAgreeing] = useState(false)

  const content = agreementStatus?.content ?? null
  const changed = settings.agreementAcceptedAt > 0

  const agree = async (): Promise<void> => {
    setAgreeing(true)
    try {
      await updateSettings({
        agreementAcceptedAt: Date.now(),
        agreementAcceptedVersion: agreementStatus?.version ?? ''
      })
    } finally {
      setAgreeing(false)
    }
  }

  return (
    <motion.div
      className="fixed inset-0 z-[100] flex items-center justify-center p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} />
      <motion.div
        className="glass-strong relative z-10 flex max-h-[82vh] w-full max-w-2xl flex-col rounded-[28px] p-7"
        initial={{ scale: 0.95, opacity: 0, y: 16 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.96, opacity: 0, y: 12 }}
        transition={{ type: 'spring', bounce: 0.16, duration: 0.45 }}
      >
        <div className="mb-2 flex items-center gap-2">
          <Icon name="box" size={20} />
          <span className="title">
            {changed ? t('cmp.agreement.changedTitle') : t('cmp.agreement.welcome')}
          </span>
        </div>
        <p className="caption mb-4">
          {changed ? t('cmp.agreement.changedIntro') : t('cmp.agreement.intro')}
        </p>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-2xl p-1 pr-2">
          {agreementStatus === null ? (
            <LoadingState text={t('cmp.agreement.loading')} />
          ) : content === null ? (
            <div className="space-y-3 text-[13px] leading-relaxed opacity-80">
              <p>{t('cmp.agreement.error1')}</p>
              <p>{t('cmp.agreement.error2')}</p>
            </div>
          ) : (
            <>
              <AgreementBlock title={t('cmp.agreement.privacy')} body={content.privacy} />
              <AgreementBlock title={t('cmp.agreement.terms')} body={content.terms} />
            </>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between gap-3">
          <span className="caption">
            {content?.updatedAt
              ? t('cmp.agreement.updatedAt', { date: new Date(content.updatedAt).toLocaleDateString() })
              : t('cmp.agreement.consentHint')}
          </span>
          <Button variant="primary" size="lg" icon="check" onClick={() => void agree()} disabled={agreeing}>
            {agreeing ? t('cmp.agreement.processing') : t('cmp.agreement.agree')}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  )
}

function AgreementBlock({ title, body }: { title: string; body: string }): JSX.Element {
  const { t } = useApp()
  return (
    <div className="glass-soft rounded-2xl p-4">
      <div className="headline mb-2">{title}</div>
      <div className="selectable whitespace-pre-wrap break-words text-[13px] leading-relaxed opacity-80">
        {body || t('cmp.agreement.noContent')}
      </div>
    </div>
  )
}
