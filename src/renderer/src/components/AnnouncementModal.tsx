import { motion } from 'motion/react'
import type { Announcement } from '@shared/types'
import { useApp } from '../store'
import { Button, Icon, Markdown } from './ui'

/**
 * 启动公告弹窗：一次性展示本次启动筛选出的全部公告（重要公告排在最前）。
 * 关闭即把已展示的公告记入 announcementSeen，避免「发布后首次开启」重复弹出。
 */
export function AnnouncementModal({
  announcements,
  onClose
}: {
  announcements: Announcement[]
  onClose: () => void
}): JSX.Element {
  const { t } = useApp()

  return (
    <motion.div
      className="fixed inset-0 z-[100] flex items-center justify-center p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} onClick={onClose} />
      <motion.div
        className="glass-strong relative z-10 flex max-h-[82vh] w-full max-w-2xl flex-col rounded-[28px] p-7"
        initial={{ scale: 0.95, opacity: 0, y: 16 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.96, opacity: 0, y: 12 }}
        transition={{ type: 'spring', bounce: 0.16, duration: 0.45 }}
      >
        <div className="mb-2 flex items-center gap-2">
          <Icon name="message" size={20} />
          <span className="title">{t('cmp.announcement.title')}</span>
        </div>
        <p className="caption mb-4">{t('cmp.announcement.intro')}</p>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-2xl p-1 pr-2">
          {announcements.map((a) => (
            <div key={a.id} className="glass-soft rounded-2xl p-4">
              <div className="mb-2 flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {a.important && (
                      <span className="chip shrink-0" style={{ color: 'var(--fill-danger)' }}>
                        {t('cmp.announcement.important')}
                      </span>
                    )}
                    <span className="headline break-words">{a.title || t('cmp.announcement.untitled')}</span>
                  </div>
                  {a.publishedAt > 0 && (
                    <div className="caption mt-1">
                      {t('cmp.announcement.publishedAt', { date: new Date(a.publishedAt).toLocaleDateString() })}
                    </div>
                  )}
                </div>
              </div>
              <Markdown
                text={a.body}
                breaks
                fallback={<p className="caption">{t('cmp.announcement.noContent')}</p>}
                className="text-[13px] leading-relaxed opacity-80"
              />
            </div>
          ))}
        </div>

        <div className="mt-5 flex items-center justify-end gap-3">
          <Button variant="primary" size="lg" icon="check" onClick={onClose}>
            {t('cmp.announcement.confirm')}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  )
}
