import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../store'
import { Button, Icon, Segmented } from '../components/ui'
import type {
  FeedbackDetail,
  FeedbackFilePayload,
  FeedbackListItem,
  FeedbackLoginTtl,
  FeedbackSessionStatus,
  ServerLimits
} from '@shared/types'

/** 服务端不可达 / 尚未拉取到限制时的兜底值（与 config.php 默认值一致）。 */
const FALLBACK_MAX_FILE_BYTES = 3 * 1024 * 1024
const FALLBACK_MAX_FILES = 10

/**
 * 可选的免登录时长。
 *
 * `key` 用于界面（Segmented 只接受字符串），`ttl` 才是发给服务端的秒数。
 * 默认「本次会话」：令牌只在主进程内存里，退出反馈界面 / 重启启动器即失效；
 * 其余档位加密落盘，期间查看与发消息都不必重新收邮件。
 */
const LOGIN_TTLS: Array<{ key: string; ttl: FeedbackLoginTtl; labelKey: string }> = [
  { key: 'session', ttl: 43200, labelKey: 'feedback.ttl.session' },
  { key: 'day', ttl: 86400, labelKey: 'feedback.ttl.day' },
  { key: 'week', ttl: 604800, labelKey: 'feedback.ttl.week' },
  { key: 'month', ttl: 2592000, labelKey: 'feedback.ttl.month' },
  { key: 'forever', ttl: 0, labelKey: 'feedback.ttl.forever' }
]

/** 页面视图：验证邮箱 → 反馈列表 → 提交新反馈 / 单条反馈对话。 */
type View = 'gate' | 'list' | 'compose' | 'detail'

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
 * 流程：邮箱 + 验证码验证 → 该邮箱名下的反馈列表 → 点开任意一条进入它自己的对话界面，
 * 可无限次互发消息（消息可带附件）。未回复的反馈可由用户自行撤销。
 */
export function FeedbackPage(): JSX.Element {
  const { t, settings } = useApp()

  const [view, setView] = useState<View>('gate')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [cooldown, setCooldown] = useState(0)
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [list, setList] = useState<FeedbackListItem[]>([])
  /** 免登录时长选择；默认「本次会话」。 */
  const [loginTtlKey, setLoginTtlKey] = useState('session')
  const loginTtl = LOGIN_TTLS.find((o) => o.key === loginTtlKey)?.ttl ?? 43200
  /** 本机已有的免登录会话（不含令牌）；null = 没有。 */
  const [session, setSession] = useState<FeedbackSessionStatus | null>(null)

  // 提交表单状态
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [submitCode, setSubmitCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [files, setFiles] = useState<PickedFile[]>([])
  const [submitCooldown, setSubmitCooldown] = useState(0)

  // 单条反馈对话状态
  const [detailId, setDetailId] = useState('')
  const [detail, setDetail] = useState<FeedbackDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [msgBody, setMsgBody] = useState('')
  const [msgFiles, setMsgFiles] = useState<PickedFile[]>([])
  const [sendingMsg, setSendingMsg] = useState(false)

  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [submittedId, setSubmittedId] = useState('')
  // 服务端当前生效的上传限制（进入页面时拉取；拉取失败用兜底值）
  const [limits, setLimits] = useState<ServerLimits | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const msgFileInputRef = useRef<HTMLInputElement | null>(null)

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

  /** 读取单条反馈的完整对话（silent = 轮询刷新，不闪加载态）。 */
  const loadDetail = useCallback(
    async (id: string, silent = false): Promise<void> => {
      if (!silent) setDetailLoading(true)
      try {
        const res = await window.api.feedback.detail(id, email, code)
        if (!res.ok) {
          if (!silent) {
            setError(res.error || t('feedback.verify.fail'))
            setView('gate')
          }
          return
        }
        setDetail(res.feedback ?? null)
        if (!silent) setError('')
      } catch (err) {
        if (!silent) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!silent) setDetailLoading(false)
      }
    },
    [email, code, t]
  )

  /**
   * 验证邮箱并拉取该邮箱名下的全部反馈。
   *
   * 验证成功后**总会**换发令牌：默认「本次会话」只留在主进程内存，
   * 其余档位加密落盘。令牌是后续查看对话、发消息、撤回的共同凭据，
   * 因此不会再出现「验证码一次性消费后续操作全失效」的情况。
   */
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
      const login = await window.api.feedback.login(email.trim(), code.trim(), loginTtl)
      if (!login.ok) {
        setError(login.error || t('feedback.verify.fail'))
        return
      }
      setSession({ email: email.trim().toLowerCase(), expiresAt: login.expiresAt })
      const label = t(LOGIN_TTLS.find((o) => o.key === loginTtlKey)?.labelKey ?? 'feedback.ttl.session')
      setNotice(t('feedback.ttl.saved', { n: label }))

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

  /** 退出免登录：删除本机会话（内存 + 落盘），回到验证码门。 */
  const logout = async (): Promise<void> => {
    await window.api.feedback.logout()
    setSession(null)
    setLoginTtlKey('session')
    setList([])
    setDetail(null)
    setDetailId('')
    setError('')
    setNotice('')
    setView('gate')
  }

  /**
   * 进入页面时若有有效免登录会话，直接取列表并跳过验证码门。
   *
   * 会话在主进程保存（令牌不落到渲染层），这里只拿状态；令牌失效时
   * 主进程会自动清掉会话，这里收到 ok=false 就退回验证码门。
   */
  useEffect(() => {
    let alive = true
    void window.api.feedback
      .session()
      .then(async (s) => {
        if (!alive || !s) return
        setSession(s)
        setEmail(s.email)
        const res = await window.api.feedback.list('', '')
        if (!alive) return
        if (res.ok) {
          setList(res.feedbacks)
          setView('list')
        } else {
          setSession(null)
        }
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  // 打开着的对话每 15 秒静默刷新一次（窗口不可见时跳过），接近聊天的体验
  useEffect(() => {
    if (view !== 'detail' || !detailId) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadDetail(detailId, true)
    }, 15000)
    return () => window.clearInterval(timer)
  }, [view, detailId, loadDetail])

  /** 打开某条反馈的独立对话界面。 */
  const openDetail = (item: FeedbackListItem): void => {
    setDetailId(item.id)
    setDetail(null)
    setMsgBody('')
    setMsgFiles([])
    setError('')
    setNotice('')
    setView('detail')
    void loadDetail(item.id)
  }

  /** 撤销某条反馈（仅未回复可撤销）。令牌在建，无需再收一次验证码。 */
  const withdraw = async (item: FeedbackListItem): Promise<void> => {
    setError('')
    setNotice('')
    if (!window.confirm(t('feedback.withdraw.confirm', { title: item.title }))) return
    try {
      const res = await window.api.feedback.withdraw(email.trim(), '', item.id)
      if (!res.ok) {
        setError(res.error || t('feedback.withdraw.fail'))
        return
      }
      setNotice(t('feedback.withdraw.ok'))
      // 就地更新状态（撤销后即不可再撤销）
      setList((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, status: 'withdrawn', canWithdraw: false } : it))
      )
      if (detail?.id === item.id) void loadDetail(item.id, true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** 追加选择的附件（不带文件时返回 null）。 */
  const appendFiles = async (
    fileList: FileList | null,
    current: PickedFile[]
  ): Promise<PickedFile[] | null> => {
    if (!fileList) return null
    setError('')
    const next: PickedFile[] = [...current]
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
    return next
  }

  const pickFiles = async (fileList: FileList | null): Promise<void> => {
    const next = await appendFiles(fileList, files)
    if (next) setFiles(next)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const pickMsgFiles = async (fileList: FileList | null): Promise<void> => {
    const next = await appendFiles(fileList, msgFiles)
    if (next) setMsgFiles(next)
    if (msgFileInputRef.current) msgFileInputRef.current.value = ''
  }

  const removeFile = (index: number): void => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const removeMsgFile = (index: number): void => {
    setMsgFiles((prev) => prev.filter((_, i) => i !== index))
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const closeCompose = (): void => {
    setTitle('')
    setDescription('')
    setSubmitCode('')
    setFiles([])
    setError('')
    setNotice('')
    setView('list')
  }

  /** 在当前反馈里追加一条消息。 */
  const sendMessage = async (): Promise<void> => {
    if (!detail) return
    const body = msgBody.trim()
    if (!body && msgFiles.length === 0) {
      setError(t('feedback.detail.msgEmpty'))
      return
    }
    setSendingMsg(true)
    setError('')
    setNotice('')
    try {
      const res = await window.api.feedback.message({
        id: detail.id,
        email: email.trim(),
        code: code.trim(),
        body,
        files: msgFiles.map((f) => ({ name: f.name, contentBase64: f.contentBase64 }))
      })
      if (!res.ok) {
        setError(res.error || t('feedback.detail.sendFail'))
        return
      }
      setMsgBody('')
      setMsgFiles([])
      // 先就地追加，界面立刻可见；再静默刷新校准状态与排序
      if (res.message) {
        const sent = res.message
        setDetail((prev) =>
          prev ? { ...prev, messages: [...prev.messages, sent], lastMessageAt: sent.at, lastFrom: 'user' } : prev
        )
      }
      void loadDetail(detail.id, true)
      void window.api.feedback.list('', '').then((r) => {
        if (r.ok) setList(r.feedbacks)
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSendingMsg(false)
    }
  }

  /** 打开管理员发回的附件（主进程带令牌下载）。 */
  const openFile = async (name: string): Promise<void> => {
    const res = await window.api.feedback.openFile(detailId, name)
    if (!res.ok) setError(res.error || t('feedback.detail.downloadFail'))
  }

  return (
    <div className="flex h-full flex-col gap-5">
      <div>
        <h1 className="display">{t('feedback.title')}</h1>
        <p className="caption mt-1">{t('feedback.subtitle', { size: formatSize(maxFileBytes) })}</p>
      </div>

      {view === 'detail' ? (
        /* 单条反馈的独立界面：对话 + 发送区 */
        <div className="glass flex min-h-0 flex-1 flex-col rounded-[24px] p-5">
          <div className="flex items-center gap-3">
            <Button size="sm" variant="ghost" icon="chevronLeft" onClick={() => setView('list')}>
              {t('feedback.list.back')}
            </Button>
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
              {detail?.title || t('feedback.list.untitled')}
            </span>
            {detail && <span className="chip">{t(statusKey(detail.status))}</span>}
            <span className="caption">#{detailId}</span>
          </div>
          {detail && (
            <div className="caption mt-1">
              {t('feedback.list.meta', {
                time: new Date(detail.createdAt).toLocaleString(),
                n: detail.fileCount
              })}
            </div>
          )}

          <div className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            {detailLoading && <div className="caption">{t('feedback.detail.loading')}</div>}
            {!detailLoading && detail && detail.messages.length === 0 && (
              <div className="caption">{t('feedback.detail.empty')}</div>
            )}
            {detail?.messages.map((m) => {
              const mine = m.from !== 'admin'
              return (
                <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className="max-w-[78%] rounded-2xl px-4 py-3 text-[13px]"
                    style={
                      mine
                        ? {
                            background: 'rgba(10,132,255,0.16)',
                            border: '1px solid rgba(10,132,255,0.36)'
                          }
                        : { background: 'var(--glass-bg-soft)', border: '1px solid var(--divider)' }
                    }
                  >
                    <div className="caption mb-1 flex items-center gap-2">
                      <span>
                        {mine ? t('feedback.detail.fromUser') : t('feedback.detail.fromAdmin')}
                      </span>
                      <span>{new Date(m.at).toLocaleString()}</span>
                    </div>
                    {m.body && <div className="whitespace-pre-wrap break-words">{m.body}</div>}
                    {m.files.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {m.files.map((f) => (
                          <div key={f.name} className="flex items-center gap-2 text-[12px]">
                            <Icon name="file" size={13} className="opacity-60" />
                            <span className="min-w-0 flex-1 truncate">{f.display || f.name}</span>
                            <span className="caption">{formatSize(f.size)}</span>
                            {!mine && (
                              <button
                                className="opacity-70 transition-opacity hover:opacity-100"
                                onClick={() => void openFile(f.name)}
                              >
                                {t('feedback.detail.download')}
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {!detail ? null : detail.status === 'closed' || detail.status === 'withdrawn' ? (
            <div className="caption mt-3">{t(`feedback.detail.${detail.status}`)}</div>
          ) : (
            <div className="mt-3 space-y-2">
              <textarea
                value={msgBody}
                onChange={(e) => setMsgBody(e.target.value)}
                maxLength={5000}
                rows={3}
                placeholder={t('feedback.detail.placeholder')}
                className="input w-full resize-y"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" icon="folder" onClick={() => msgFileInputRef.current?.click()}>
                  {t('feedback.file.add')}
                </Button>
                <input
                  ref={msgFileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => void pickMsgFiles(e.target.files)}
                />
                <span className="caption">
                  {t('feedback.detail.filesHint', { size: formatSize(maxFileBytes), n: maxFiles })}
                </span>
                <span className="flex-1" />
                <Button variant="primary" icon="check" disabled={sendingMsg} onClick={() => void sendMessage()}>
                  {sendingMsg ? t('feedback.detail.sending') : t('feedback.detail.send')}
                </Button>
              </div>
              {msgFiles.length > 0 && (
                <div className="space-y-1.5">
                  {msgFiles.map((f, i) => (
                    <div key={`${f.name}-${i}`} className="glass-soft flex items-center gap-2 rounded-xl px-3 py-2">
                      <Icon name="file" size={15} className="opacity-60" />
                      <span className="min-w-0 flex-1 truncate text-[13px]">{f.name}</span>
                      <span className="caption">{formatSize(f.size)}</span>
                      <button
                        onClick={() => removeMsgFile(i)}
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
          )}

          {error && (
            <div className="glass-soft mt-3 rounded-xl p-3 text-[13px]" style={{ color: 'var(--fill-danger)' }}>
              {error}
            </div>
          )}
          {notice && !error && (
            <div className="glass-soft mt-3 rounded-xl p-3 text-[13px] opacity-80">{notice}</div>
          )}
        </div>
      ) : (
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

              {/* 免登录时长：默认仅本次会话有效 */}
              <div>
                <label className="caption mb-1 block">{t('feedback.ttl.label')}</label>
                <Segmented
                  value={loginTtlKey}
                  onChange={(v) => setLoginTtlKey(v)}
                  options={LOGIN_TTLS.map((o) => ({ value: o.key, label: t(o.labelKey) }))}
                  scroll
                />
                <p className="caption mt-1">{t('feedback.ttl.desc')}</p>
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
                  {/* 免登录生效中：说明还剩多久，并给出「退出免登录」入口 */}
                  {session && (
                    <div className="caption mt-0.5 flex items-center gap-2">
                      <span style={{ color: 'var(--fill-success)' }}>
                        {session.expiresAt === 0
                          ? t('feedback.ttl.activeForever')
                          : session.expiresAt - Date.now() < 86_400_000
                            ? t('feedback.ttl.activeHours', {
                                h: Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 3_600_000))
                              })
                            : t('feedback.ttl.activeUntil', {
                                d: Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 86_400_000))
                              })}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="primary" icon="plus" onClick={() => setView('compose')}>
                    {t('feedback.list.new')}
                  </Button>
                  <Button size="sm" variant="ghost" icon="xmark" onClick={() => (session ? void logout() : setView('gate'))}>
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
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      className="glass w-full cursor-pointer rounded-[24px] p-4 text-left transition-opacity hover:opacity-90"
                      onClick={() => openDetail(item)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          openDetail(item)
                        }
                      }}
                    >
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
                        {' · '}
                        {t('feedback.list.messages', { n: item.messageCount ?? 0 })}
                      </div>
                      {item.lastMessage && (
                        <p className="mt-2 truncate text-[13px] opacity-75">
                          {t(item.lastFrom === 'admin' ? 'feedback.list.lastAdmin' : 'feedback.list.lastUser')}
                          {item.lastMessage}
                        </p>
                      )}
                      <div className="mt-3 flex items-center justify-between">
                        <span className="caption">{t('feedback.list.open')}</span>
                        {item.canWithdraw && (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="xmark"
                            onClick={(e) => {
                              e.stopPropagation()
                              void withdraw(item)
                            }}
                          >
                            {t('feedback.withdraw.action')}
                          </Button>
                        )}
                      </div>
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
                <Button size="sm" variant="ghost" icon="chevronLeft" onClick={closeCompose}>
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

              {submittedId && (
                <div className="glass-soft rounded-xl p-3 text-[13px]">
                  <div className="mb-1 font-semibold">{t('feedback.done.title')}</div>
                  <div className="caption">{t('feedback.done.desc', { id: submittedId })}</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
