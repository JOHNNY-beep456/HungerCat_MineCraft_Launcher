import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { DownloadProgress, UpdateCheckResult, UpdateInfo } from '@shared/types'
import { useApp } from '../../store'
import { Button, Icon, Markdown, ProgressBar } from '../../components/ui'
import { Row, Section } from './parts'
import { AutoFields } from './AutoSection'

/** 「更新」板块：当前版本、自动检查更新（注册表自动渲染）与手动检查 / 下载。 */
export function UpdateSection(): JSX.Element {
  const { settings, t } = useApp()
  const [appVersion, setAppVersion] = useState('')
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null)
  const [updateProgress, setUpdateProgress] = useState<DownloadProgress | null>(null)
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'downloading' | 'done' | 'error' | 'opened'>('idle')
  const [updatePath, setUpdatePath] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [pendingUpdate, setPendingUpdate] = useState<UpdateInfo | null>(null)

  useEffect(() => {
    void window.api.getVersion().then(setAppVersion).catch(() => setAppVersion(''))
  }, [])

  // 订阅更新下载进度
  useEffect(() => {
    return window.api.update.onProgress((p) => {
      if (p.phase === 'done') {
        setUpdateStatus('done')
        setUpdateProgress(null)
      } else {
        setUpdateStatus('downloading')
        setUpdateProgress(p)
      }
    })
  }, [])

  const doDownload = async (info: UpdateInfo, run: boolean): Promise<void> => {
    setUpdateStatus('downloading')
    setUpdateProgress(null)
    setUpdateError(null)
    try {
      const path = run ? await window.api.update.downloadAndRun(info) : await window.api.update.download(info)
      setUpdatePath(path)
      setUpdateStatus('done')
    } catch (err) {
      setUpdateStatus('error')
      setUpdateError(err instanceof Error ? err.message : String(err))
    }
  }

  /** 判断更新应执行的动作：exe 链接 → 下载并运行；有文件名 → 下载；否则 → 浏览器打开链接。 */
  const updateAction = (info: UpdateInfo): 'downloadAndRun' | 'download' | 'openLink' => {
    if (/\.exe(\?|#|$)/i.test(info.url)) return 'downloadAndRun'
    if (info.filename && info.filename.trim() !== '') return 'download'
    return 'openLink'
  }

  const ACTION_LABEL: Record<ReturnType<typeof updateAction>, string> = {
    downloadAndRun: t('settings.update.action.downloadAndRun'),
    download: t('settings.update.action.download'),
    openLink: t('settings.update.action.openLink')
  }

  /** 关闭更新日志弹窗后，按链接类型执行下载 / 运行 / 打开。 */
  const confirmPending = async (): Promise<void> => {
    const info = pendingUpdate
    if (!info) return
    setPendingUpdate(null)
    const action = updateAction(info)
    if (action === 'openLink') {
      try {
        await window.api.shell.openExternal(info.url)
        setUpdateStatus('opened')
      } catch (err) {
        setUpdateStatus('error')
        setUpdateError(err instanceof Error ? err.message : String(err))
      }
    } else {
      await doDownload(info, action === 'downloadAndRun')
    }
  }

  const checkUpdate = async (): Promise<void> => {
    setUpdateChecking(true)
    setUpdateError(null)
    try {
      const r = await window.api.update.check()
      setUpdateResult(r)
      if (r.hasUpdate && r.latest) {
        // 先展示更新日志让用户确认，再执行下载 / 运行 / 打开
        setPendingUpdate(r.latest)
        setUpdateStatus('idle')
      } else {
        setUpdateStatus('idle')
      }
    } catch (err) {
      setUpdateStatus('error')
      setUpdateError(err instanceof Error ? err.message : String(err))
    } finally {
      setUpdateChecking(false)
    }
  }

  return (
    <>
      {/* 更新 */}
      {settings.mode !== 'local' && (
        <Section title={t('settings.section.update')} icon="refresh">
          <Row label={t('settings.row.currentVersion')}>
            <span className="chip">{appVersion || '…'}</span>
          </Row>
          {/* 自动检查启动器 / 主页更新：由共享注册表自动渲染 */}
          <AutoFields section="update" />
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[13px] opacity-80">{t('settings.update.check')}</span>
              <Button size="sm" icon="refresh" onClick={() => void checkUpdate()} disabled={updateChecking || updateStatus === 'downloading'}>
                {updateChecking ? t('settings.update.checking') : updateStatus === 'downloading' ? t('settings.update.downloading') : t('settings.update.check')}
              </Button>
            </div>

            {updateStatus === 'error' && updateError && (
              <div className="glass-soft rounded-xl p-3 text-[13px]" style={{ color: 'var(--fill-danger)' }}>
                {updateError}
              </div>
            )}

            {updateResult && updateStatus === 'idle' && !updateResult.hasUpdate && (
              <div className="glass-soft rounded-xl p-3 text-[13px] opacity-70">
                {t('settings.update.upToDate', { v: updateResult.currentVersion })}
              </div>
            )}

            {updateResult?.latest && (updateStatus === 'downloading' || updateStatus === 'done') && (
              <div className="glass-soft rounded-xl p-3">
                <div className="mb-1 flex items-center justify-between text-[13px]">
                  <span className="font-medium">
                    {updateStatus === 'done'
                      ? t('settings.update.done')
                      : t('settings.update.downloadingVersion', { v: updateResult.latest.version })}
                  </span>
                  {updateProgress && <span className="chip">{updateProgress.percent}%</span>}
                </div>
                {updateStatus === 'downloading' && <ProgressBar percent={updateProgress?.percent ?? 0} />}
                {updateStatus === 'downloading' && updateProgress && updateProgress.totalBytes > 0 && (
                  <div className="caption mt-1.5">
                    {formatBytes(updateProgress.currentBytes)} / {formatBytes(updateProgress.totalBytes)}
                  </div>
                )}
                {updateStatus === 'done' && (
                  <>
                    <div className="mt-2 flex items-center gap-2">
                      <Button size="sm" variant="primary" icon="box" onClick={() => updatePath && void window.api.shell.openPath(updatePath)}>
                        {t('settings.update.install')}
                      </Button>
                    </div>
                    {updatePath && (
                      <div className="caption selectable mt-2 break-all opacity-70">{t('settings.update.savedTo', { path: updatePath })}</div>
                    )}
                  </>
                )}
                {updateResult.latest.notes && (
                  <Markdown
                    text={updateResult.latest.notes}
                    breaks
                    className="caption mt-2 border-t pt-2"
                  />
                )}
              </div>
            )}

            {updateResult?.latest && updateStatus === 'opened' && (
              <div className="glass-soft rounded-xl p-3">
                <div className="mb-1 text-[13px] font-medium">
                  {t('settings.update.opened', { v: updateResult.latest.version })}
                </div>
                <div className="caption selectable break-all opacity-70">{updateResult.latest.url}</div>
                {updateResult.latest.notes && (
                  <Markdown
                    text={updateResult.latest.notes}
                    breaks
                    className="caption mt-2 border-t pt-2"
                  />
                )}
              </div>
            )}
          </div>
        </Section>
      )}

      {/* 更新日志确认弹窗：先展示更新内容，确认后再下载 / 运行 / 打开链接 */}
      <AnimatePresence>
        {pendingUpdate && (
          <motion.div
            className="fixed inset-0 z-[115] flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="absolute inset-0" style={{ background: 'var(--scrim)' }} />
            <motion.div
              className="glass-strong relative z-10 w-full max-w-md rounded-[32px] p-7"
              initial={{ scale: 0.92, opacity: 0, y: 24 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.94, opacity: 0, y: 16 }}
              transition={{ type: 'spring', bounce: 0.2, duration: 0.45 }}
            >
              <div className="mb-2 flex items-center gap-2">
                <Icon name="download" size={20} style={{ color: 'var(--fill-primary)' }} />
                <span className="title">{t('settings.updLog.title', { v: pendingUpdate.version })}</span>
              </div>
              <div className="mb-5 mt-3">
                <div className="caption mb-2">{t('settings.updLog.notes')}</div>
                {/* 更新日志按 Markdown 渲染（标题 / 列表 / 代码块 / 链接等） */}
                <Markdown
                  text={pendingUpdate.notes}
                  breaks
                  fallback={t('settings.updLog.empty')}
                  className="glass-soft max-h-[38vh] overflow-y-auto rounded-2xl p-4 text-[13px] leading-relaxed opacity-80"
                />
              </div>
              <div className="flex items-center gap-2">
                <Button className="flex-1" onClick={() => setPendingUpdate(null)}>
                  {t('settings.common.cancel')}
                </Button>
                <Button variant="primary" className="flex-1" icon="check" onClick={() => void confirmPending()}>
                  {ACTION_LABEL[updateAction(pendingUpdate)]}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

function formatBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}
