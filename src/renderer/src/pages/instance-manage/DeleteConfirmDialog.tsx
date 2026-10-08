import { AnimatePresence, motion } from 'motion/react'
import { useApp } from '../../store'
import { Button, Icon } from '../../components/ui'

/** 删除实例的二次确认弹窗：删除不可恢复，先确认再执行。 */
export function DeleteConfirmDialog({
  open,
  versionId,
  onCancel,
  onConfirm
}: {
  open: boolean
  versionId: string
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  const { t } = useApp()
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[115] flex items-center justify-center p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={onCancel} />
          <motion.div
            className="glass-strong relative z-10 w-full max-w-md rounded-[32px] p-7"
            initial={{ scale: 0.92, opacity: 0, y: 24 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 16 }}
            transition={{ type: 'spring', bounce: 0.2, duration: 0.45 }}
          >
            <div className="mb-2 flex items-center gap-2">
              <Icon name="info" size={20} style={{ color: 'var(--fill-danger)' }} />
              <span className="title">{t('ins.deleteConfirm.title')}</span>
            </div>
            <p className="caption mt-3">{t('ins.deleteConfirm.desc', { name: versionId })}</p>
            <div className="mt-6 flex items-center gap-2">
              <Button className="flex-1" onClick={onCancel}>
                {t('ins.deleteConfirm.cancel')}
              </Button>
              <Button variant="danger" className="flex-1" icon="trash" onClick={onConfirm}>
                {t('ins.deleteConfirm.confirm')}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
