import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useApp } from '../store'
import { Button, Icon } from '../components/ui'
import type { FeedbackFilePayload, FeedbackListItem, ServerLimits } from '@shared/types'

/** 服务端不可达 / 尚未拉取到限制时的兜底值（与 config.php 默认值一致）。 */
const FALLBACK_MAX_FILE_BYTES = 3 * 1024 * 1024
const FALLBACK_MAX_FILES = 10

/** 页面视图：先验证邮箱，再进入反馈列表。 */
type View = 'gate' | 'list' | 'compose'

/** 已选附件（渲染层展示用；内容以 base64 暂存内存）。 */
interface PickedFile {
  name: string
  /** 原始字节大小，用于展示与校验。 */
  size: number
  contentBase64: string
}

/** 读取本地文件为 base64（去掉 data URL 前缀）。 */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/** 人性化体积。 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** 反馈状态对应的文案 key。 */
function statusKey(status: FeedbackListItem['status']): string {
  switch (status) {
    case 'new':
      return 'feedback.status.new'
    case 'replied':
      return 'feedback.status.replied'
    case 'closed':
      return 'feedback.status.closed'
    case 'withdrawn':
      return 'feedback.status.withdrawn'
    default:
      return 'feedback.status.new'
  }
}

/**
 * 「反馈」板块。
 *
 * 流程：先输入邮箱 + 验证码完成邮箱验证 → 展示该邮箱名下的全部反馈 + 「提交新反馈」按钮；
 * 未回复的反馈可由用户自行撤销（撤销=标记状态，不真删）。
 * 提交成功后按用户意愿弹出「是否允许收集日志」确认框（默认不收集）。
 */
export function FeedbackPage(): JSX.Element {
  const { t, settings, updateSettings } = useApp()

  const [view, setView] = useState<View>('gate')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [cooldown, setCooldown] = useState(0)
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [list, setList] = useState<FeedbackListItem[]>([])

  // 提交表单状态
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [submitCode, setSubmitCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [files, setFiles] = useState<PickedFile[]>([])
  const [submitCooldown, setSubmitCooldown] = useState(0)

  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [submittedId, setSubmittedId] = useState('')
  // 提交成功后询问是否同意收集日志
  const [askCollect, setAskCollect] = useState(false)
  // 服务端当前生效的上传限制（进入页面时拉取；拉取失败用兜底值）
  const [limits, setLimits] = useState<ServerLimits | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const maxFileBytes = limits?.feedbackMaxBytes ?? FALLBACK_MAX_FILE_BYTES
  const maxFiles = limits?.feedbackMaxFiles ?? FALLBACK_MAX_FILES

  // 进入页面时拉取服务端限制，保证客户端预校验与服务端一致
  useEffect(() => {
    void window.api.limits
      .get()
      .then(setLimits)
      .catch(() => setLimits(null))
  }, [])

  // 验证码重发冷却倒计时（验证 + 提交表单各自独立）
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setInterval(() => setCooldown((c) => (c > 0 ? c - 1 : 0)), 1000)
    return () => window.clearInterval(timer)
  }, [cooldown])
  useEffect(() => {
    if (submitCooldown <= 0) return
    const timer = window.setInterval(() => setSubmitCooldown((c) => (c > 0 ? c - 1 : 0)), 1000)
    return () => window.clearInterval(timer)
  }, [submitCooldown])

  /** 发送验证码；返回是否成功（成功用于立即继续验证/提交）。 */
  const sendCodeFor = async (setCd: (n: number) => void): Promise<boolean> => {
    const to = email.trim()
    if (!to) {
      setError(t('feedback.email.empty'))
      return false
    }
    setSending(true)
    try {
      const res = await window.api.feedback.sendCode(to)
      if (!res.ok) {
        setError(res.error || t('feedback.code.sendFail'))
        return false
      }
      setCd(res.cooldown || 60)
      setNotice(t('feedback.code.sent', { n: res.cooldown || 60 }))
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setSending(false)
    }
  }

  /** 验证邮箱并拉取该邮箱名下的全部反馈。 */
  const verifyAndLoad = async (): Promise<void> => {
    setError('')
    setNotice('')
    if (!email.trim()) {
      setError(t('feedback.email.empty'))
      return
    }
    if (!/^\d{6}$/.test(code.trim())) {
      setError(t('feedback.code.invalid'))
      return
    }
    setVerifying(true)
    try {
      const res = await window.api.feedback.list(email.trim(), code.trim())
      if (!res.ok) {
        setError(res.error || t('feedback.verify.fail'))
        return
      }
      setList(res.feedbacks)
      // 验证码一次性消费，清空避免误用于提交
      setCode('')
      setView('list')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setVerifying(false)
    }
  }

  /** 撤销某条反馈（仅未回复可撤销）。 */
  const withdraw = async (item: FeedbackListItem): Promise<void> => {
    setError('')
    setNotice('')
    if (!window.confirm(t('feedback.withdraw.confirm', { title: item.title }))) return
    // 撤销需要重新验证：先发码，再让用户填一次（保持「每次操作都要验证」的一致性）。
    const sent = await sendCodeFor(setCooldown)
    if (!sent) return
    const input = window.prompt(t('feedback.withdraw.codePrompt'))
    if (input === null) return
    const c = input.replace(/\D/g, '')
    if (!/^\d{6}$/.test(c)) {
      setError(t('feedback.code.invalid'))
      return
    }
    try {
      const res = await window.api.feedback.withdraw(email.trim(), c, item.id)
      if (!res.ok) {
        setError(res.error || t('feedback.withdraw.fail'))
        return
      }
      setNotice(t('feedback.withdraw.ok'))
      // 就地更新状态（撤销后即不可再撤销）
      setList((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, status: 'withdrawn', canWithdraw: false } : it))
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const pickFiles = async (fileList: FileList | null): Promise<void> => {
    if (!fileList) return
    setError('')
    const next: PickedFile[] = [...files]
    for (const file of Array.from(fileList)) {
      if (next.length >= maxFiles) {
        setError(t('feedback.file.tooMany', { n: maxFiles }))
        break
      }
      if (file.size > maxFileBytes) {
        setError(t('feedback.file.tooLarge', { name: file.name, size: formatSize(maxFileBytes) }))
        continue
      }
      if (file.size === 0) {
        setError(t('feedback.file.empty', { name: file.name }))
        continue
      }
      const contentBase64 = await readAsBase64(file)
      next.push({ name: file.name, size: file.size, contentBase64 })
    }
    setFiles(next)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeFile = (index: number): void => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const submit = async (): Promise<void> => {
    setError('')
    setNotice('')
    if (!title.trim()) {
      setError(t('feedback.title.empty'))
      return
    }
    if (!description.trim()) {
      setError(t('feedback.desc.empty'))
      return
    }
    if (!/^\d{6}$/.test(submitCode.trim())) {
      setError(t('feedback.code.invalid'))
      return
    }
    if (files.length > maxFiles) {
      setError(t('feedback.file.tooMany', { n: maxFiles }))
      return
    }
    setSubmitting(true)
    try {
      const payloadFiles: FeedbackFilePayload[] = files.map((f) => ({
        name: f.name,
        contentBase64: f.contentBase64
      }))
      const res = await window.api.feedback.submit({
        title: title.trim(),
        description: description.trim(),
        email: email.trim(),
        code: submitCode.trim(),
        files: payloadFiles,
        meta: {
          launcherVersion: await window.api.getVersion(),
          platform: window.api.platform,
          debugMode: settings.debugMode
        }
      })
      if (!res.ok) {
        setError(res.error || t('feedback.submitFail'))
        return
      }
      setSubmittedId(res.id)
      setTitle('')
      setDescription('')
      setSubmitCode('')
      setFiles([])
      setAskCollect(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const closeCompose = async (): Promise<void> => {
    setTitle('')
    setDescription('')
    setSubmitCode('')
    setFiles([])
    setError('')
    setNotice('')
    setView('list')
    // 回列表前刷新（此时无验证码，仅用已有的邮箱；服务端要求验证码，故保留旧列表）
  }

  return (
    <div className="flex h-full flex-col gap-5">
      <div>
        <h1 className="display">{t('feedback.title')}</h1>
        <p className="caption mt-1">{t('feedback.subtitle', { size: formatSize(maxFileBytes) })}</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {/* ① 邮箱验证门：验证通过才展示反馈列表 */}
        {view === 'gate' && (
          <div className="glass mb-4 space-y-4 rounded-[24px] p-5">
            <p className="caption">{t('feedback.gate.intro')}</p>
            <div>
              <label className="caption mb-1 block">{t('feedback.field.email')}</label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    setError('')
                  }}
                  placeholder="you@example.com"
                  className="input w-56"
                />
                <Button
                  size="sm"
                  icon="mail"
                  disabled={sending || cooldown > 0}
                  onClick={() => void sendCodeFor(setCooldown)}
                >
                  {sending ? t('feedback.code.sending') : cooldown > 0 ? `${cooldown}s` : t('feedback.code.send')}
                </Button>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value.replace(/\D/g, ''))
                    setError('')
                  }}
                  placeholder={t('feedback.code.placeholder')}
                  className="input w-28"
                />
                <Button variant="primary" icon="check" disabled={verifying} onClick={() => void verifyAndLoad()}>
                  {verifying ? t('feedback.verify.loading') : t('feedback.verify.viewMine')}
                </Button>
              </div>
              <p className="caption mt-1">{t('feedback.gate.hint')}</p>
            </div>

            {error && (
              <div className="glass-soft rounded-xl p-3 text-[13px]" style={{ color: 'var(--fill-danger)' }}>
                {error}
              </div>
            )}
            {notice && !error && (
              <div className="glass-soft rounded-xl p-3 text-[13px] opacity-80">{notice}</div>
            )}
          </div>
        )}

        {/* ② 反馈列表 + 提交新反馈 */}
        {view === 'list' && (
          <>
            <div className="glass mb-4 flex items-center justify-between gap-3 rounded-[24px] p-4">
              <div className="min-w-0">
                <div className="text-[13px] font-semibold">{email.trim()}</div>
                <div className="caption">{t('feedback.list.count', { n: list.length })}</div>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="primary" icon="plus" onClick={() => setView('compose')}>
                  {t('feedback.list.new')}
                </Button>
                <Button size="sm" variant="ghost" icon="xmark" onClick={() => setView('gate')}>
                  {t('feedback.list.exit')}
                </Button>
              </div>
            </div>

            {error && (
              <div className="glass-soft mb-3 rounded-xl p-3 text-[13px]" style={{ color: 'var(--fill-danger)' }}>
                {error}
              </div>
            )}
            {notice && !error && (
              <div className="glass-soft mb-3 rounded-xl p-3 text-[13px] opacity-80">{notice}</div>
            )}

            {list.length === 0 ? (
              <div className="glass rounded-[24px] p-8 text-center text-[13px] opacity-60">
                {t('feedback.list.empty')}
              </div>
            ) : (
              <div className="space-y-3 pb-4">
                {list.map((item) => (
                  <div key={item.id} className="glass rounded-[24px] p-4">
                    <div className="flex items-center gap-2">
                      <span className="chip">{t(statusKey(item.status))}</span>
                      <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">
                        {item.title || t('feedback.list.untitled')}
                      </span>
                      <span className="caption">#{item.id}</span>
                    </div>
                    <div className="caption mt-1">
                      {t('feedback.list.meta', {
                        time: new Date(item.createdAt).toLocaleString(),
                        n: item.fileCount
                      })}
                    </div>
                    <p className="mt-2 whitespace-pre-wrap break-words text-[13px]">{item.description}</p>
                    {item.replied && (
                      <div
                        className="mt-3 rounded-xl p-3 text-[13px]"
                        style={{ background: 'rgba(10,132,255,0.12)', border: '1px solid rgba(10,132,255,0.32)' }}
                      >
                        <div className="mb-1 font-semibold">{t('feedback.list.replyTitle')}</div>
                        <div className="whitespace-pre-wrap break-words">{item.reply}</div>
                      </div>
                    )}
                    {item.canWithdraw && (
                      <div className="mt-3 flex justify-end">
                        <Button size="sm" variant="ghost" icon="xmark" onClick={() => void withdraw(item)}>
                          {t('feedback.withdraw.action')}
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ③ 提交新反馈 */}
        {view === 'compose' && (
          <div className="glass mb-4 space-y-4 rounded-[24px] p-5">
            <div className="flex items-center justify-between">
              <span className="title">{t('feedback.list.new')}</span>
              <Button size="sm" variant="ghost" icon="chevronLeft" onClick={() => void closeCompose()}>
                {t('feedback.list.back')}
              </Button>
            </div>

            <div>
              <label className="caption mb-1 block">{t('feedback.field.title')}</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={120}
                placeholder={t('feedback.field.title.placeholder')}
                className="input w-full"
              />
            </div>

            <div>
              <label className="caption mb-1 block">{t('feedback.field.desc')}</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={5000}
                rows={6}
                placeholder={t('feedback.field.desc.placeholder')}
                className="input w-full resize-y"
              />
            </div>

            {/* 附件 */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="caption">{t('feedback.field.files')}</label>
                <Button size="sm" icon="folder" onClick={() => fileInputRef.current?.click()}>
                  {t('feedback.file.add')}
                </Button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => void pickFiles(e.target.files)}
              />
              <p className="caption">{t('feedback.file.hint', { size: formatSize(maxFileBytes), n: maxFiles })}</p>
              {files.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {files.map((f, i) => (
                    <div key={`${f.name}-${i}`} className="glass-soft flex items-center gap-2 rounded-xl px-3 py-2">
                      <Icon name="file" size={15} className="opacity-60" />
                      <span className="min-w-0 flex-1 truncate text-[13px]">{f.name}</span>
                      <span className="caption">{formatSize(f.size)}</span>
                      <button
                        onClick={() => removeFile(i)}
                        className="opacity-60 transition-opacity hover:opacity-100"
                        aria-label="remove"
                      >
                        <Icon name="xmark" size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 邮箱（已固定为验证过的邮箱）+ 提交验证码 */}
            <div>
              <label className="caption mb-1 block">{t('feedback.field.email')}</label>
              <div className="flex flex-wrap items-center gap-2">
                <span className="chip">{email.trim()}</span>
                <Button
                  size="sm"
                  icon="mail"
                  disabled={sending || submitCooldown > 0}
                  onClick={() => void sendCodeFor(setSubmitCooldown)}
                >
                  {sending
                    ? t('feedback.code.sending')
                    : submitCooldown > 0
                      ? `${submitCooldown}s`
                      : t('feedback.code.send')}
                </Button>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={submitCode}
                  onChange={(e) => setSubmitCode(e.target.value.replace(/\D/g, ''))}
                  placeholder={t('feedback.code.placeholder')}
                  className="input w-28"
                />
              </div>
              <p className="caption mt-1">{t('feedback.email.hint')}</p>
            </div>

            {error && (
              <div className="glass-soft rounded-xl p-3 text-[13px]" style={{ color: 'var(--fill-danger)' }}>
                {error}
              </div>
            )}
            {notice && !error && (
              <div className="glass-soft rounded-xl p-3 text-[13px] opacity-80">{notice}</div>
            )}

            <div className="flex items-center gap-3">
              <Button variant="primary" icon="check" disabled={submitting} onClick={() => void submit()}>
                {submitting ? t('feedback.submitting') : t('feedback.submit')}
              </Button>
              <span className="caption">{t('feedback.privacy')}</span>
            </div>

            {submittedId && !askCollect && (
              <div className="glass-soft rounded-xl p-3 text-[13px]">
                <div className="mb-1 font-semibold">{t('feedback.done.title')}</div>
                <div className="caption">{t('feedback.done.desc', { id: submittedId })}</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 提交成功 → 询问是否允许收集日志 */}
      <AnimatePresence>
        {askCollect && (
          <motion.div
            className="absolute inset-0 z-50 flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{ background: 'rgba(0,0,0,0.45)' }}
          >
            <motion.div
              className="glass-strong w-full max-w-md rounded-[24px] p-6"
              initial={{ scale: 0.94, y: 12 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.94, opacity: 0 }}
              transition={{ type: 'spring', bounce: 0.2, duration: 0.35 }}
            >
              <div className="mb-2 flex items-center gap-2">
                <Icon name="info" size={18} />
                <span className="title">{t('feedback.collect.title')}</span>
              </div>
              <p className="caption mb-4">{t('feedback.collect.desc')}</p>
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setAskCollect(false)
                    void closeCompose()
                  }}
                >
                  {t('feedback.collect.decline')}
                </Button>
                <Button
                  variant="primary"
                  icon="check"
                  onClick={async () => {
                    // 同意：打开 debugMode 并标记「已同意收集」，等待站长发放密钥后自动回传。
                    await updateSettings({ debugMode: true, feedbackLogConsent: true })
                    setAskCollect(false)
                    setNotice(t('feedback.collect.enabled'))
                    void closeCompose()
                  }}
                >
                  {t('feedback.collect.accept')}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
