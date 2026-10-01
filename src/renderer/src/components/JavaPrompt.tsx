import { AnimatePresence, motion } from 'motion/react'
import { useRuntime } from '../runtime'
import { useApp } from '../store'
import { Button, Icon, ProgressBar } from './ui'

export function JavaPrompt(): JSX.Element {
  const { t } = useApp()
  const { javaPrompt, busy, download, installJavaAndLaunch, cancelJavaPrompt } = useRuntime()

  return (
    <AnimatePresence>
      {javaPrompt && (
        <motion.div
          className="absolute inset-0 z-[60] flex items-center justify-center p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="absolute inset-0"
            style={{ background: 'var(--scrim)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={busy ? undefined : cancelJavaPrompt}
          />
          <motion.div
            className="glass-strong relative z-10 w-full max-w-md rounded-[32px] p-8"
            initial={{ opacity: 0, scale: 0.92, y: 24 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 16 }}
            transition={{ type: 'spring', bounce: 0.2, duration: 0.45 }}
          >
            <div className="mb-4 flex items-center gap-3">
              <div
                className="flex h-11 w-11 items-center justify-center rounded-2xl text-white"
                style={{ background: 'var(--fill-danger)' }}
              >
                <Icon name="settings" size={22} />
              </div>
              <div>
                <h2 className="title">{t('cmp.javaPrompt.title')}</h2>
                <p className="caption">{t('cmp.javaPrompt.subtitle', { n: javaPrompt.required })}</p>
              </div>
            </div>

            <p className="mb-5 text-[13px] opacity-80">
              {t('cmp.javaPrompt.body', { n: javaPrompt.required })}
            </p>

            {busy && download && (
              <div className="mb-5">
                <div className="mb-1.5 flex items-center justify-between text-[12px]">
                  <span className="truncate">{download.task}</span>
                  <span className="opacity-60">{download.percent}%</span>
                </div>
                <ProgressBar percent={download.percent} />
              </div>
            )}

            <div className="flex gap-2">
              <Button className="flex-1" disabled={busy} onClick={cancelJavaPrompt}>
                {t('cmp.javaPrompt.cancel')}
              </Button>
              <Button
                variant="primary"
                className="flex-1"
                disabled={busy}
                onClick={() => void installJavaAndLaunch()}
              >
                {busy ? t('cmp.javaPrompt.installing') : t('cmp.javaPrompt.install', { n: javaPrompt.required })}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
