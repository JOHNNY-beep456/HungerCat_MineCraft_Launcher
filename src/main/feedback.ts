// ---------------------------------------------------------------------------
// 用户反馈：向服务端提交反馈（标题 / 描述 / 邮箱验证码 / 附件）。
//
// 启动器网络层（netRequest 的 server:post）只支持 JSON POST，因此附件以 base64
// 塞进 JSON 字段传递；服务端再解码并按 3MB/个的上限落盘到 feedback/<id>/。
// 邮箱验证码复用服务端的 feedback_send_code / emailCodes 机制。
// ---------------------------------------------------------------------------

import type {
  FeedbackCodeResult,
  FeedbackListItem,
  FeedbackListResult,
  FeedbackLoginResult,
  FeedbackSubmitPayload,
  FeedbackSubmitResult,
  FeedbackWithdrawResult,
  ServerLimits
} from '@shared/types'
import { netRequest } from './broker'
import { clearFeedbackSession, getFeedbackSession, setFeedbackSession } from './secret'

/** 单个附件的体积上限（与服务端 HC_FEEDBACK_MAX_BYTES 保持一致）。 */
export const MAX_FEEDBACK_FILE_BYTES = 3 * 1024 * 1024

/** 单条反馈的附件数量上限（与服务端 HC_FEEDBACK_MAX_FILES 保持一致）。 */
export const MAX_FEEDBACK_FILES = 10

/** 主页脚本体积上限（与服务端 HC_SCRIPT_MAX_BYTES 保持一致）。 */
export const MAX_SCRIPT_BYTES = 512 * 1024

/**
 * 服务端不可达 / 返回异常时用的兜底限制（与 config.php 默认值一致）。
 * 客户端预校验只为快速失败，真正的上限始终由服务端判定，所以兜底值保守即可。
 */
const FALLBACK_LIMITS: ServerLimits = {
  feedbackMaxBytes: MAX_FEEDBACK_FILE_BYTES,
  feedbackMaxFiles: MAX_FEEDBACK_FILES,
  scriptMaxBytes: MAX_SCRIPT_BYTES,
  feedbackRetentionDays: 30,
  feedbackMaxBytesCap: MAX_FEEDBACK_FILE_BYTES,
  feedbackMaxFilesCap: MAX_FEEDBACK_FILES,
  scriptMaxBytesCap: MAX_SCRIPT_BYTES,
  feedbackRetentionDaysCap: 3650
}

/** 把字节数格式化成人类可读文本（用于本地预校验的错误提示）。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/**
 * 拉取服务端当前生效的上传限制。
 *
 * 失败（离线 / 服务端旧版没有 limits 接口）时回落到内置默认值，
 * 保证「拿不到限制也要能继续用」，此时上限由服务端提交时的校验兜底。
 */
export async function fetchServerLimits(): Promise<ServerLimits> {
  try {
    const res = await netRequest<Partial<ServerLimits>>('server:api', { path: 'limits' })
    return {
      feedbackMaxBytes: Number(res?.feedbackMaxBytes) > 0 ? Number(res.feedbackMaxBytes) : FALLBACK_LIMITS.feedbackMaxBytes,
      feedbackMaxFiles: Number(res?.feedbackMaxFiles) > 0 ? Number(res.feedbackMaxFiles) : FALLBACK_LIMITS.feedbackMaxFiles,
      scriptMaxBytes: Number(res?.scriptMaxBytes) > 0 ? Number(res.scriptMaxBytes) : FALLBACK_LIMITS.scriptMaxBytes,
      // 保留天数允许为 0（关闭即清理），因此只在无法解析（NaN）时回落
      feedbackRetentionDays: Number.isFinite(Number(res?.feedbackRetentionDays))
        ? Number(res?.feedbackRetentionDays)
        : FALLBACK_LIMITS.feedbackRetentionDays,
      feedbackMaxBytesCap: Number(res?.feedbackMaxBytesCap) > 0 ? Number(res.feedbackMaxBytesCap) : FALLBACK_LIMITS.feedbackMaxBytesCap,
      feedbackMaxFilesCap: Number(res?.feedbackMaxFilesCap) > 0 ? Number(res.feedbackMaxFilesCap) : FALLBACK_LIMITS.feedbackMaxFilesCap,
      scriptMaxBytesCap: Number(res?.scriptMaxBytesCap) > 0 ? Number(res.scriptMaxBytesCap) : FALLBACK_LIMITS.scriptMaxBytesCap,
      feedbackRetentionDaysCap: Number(res?.feedbackRetentionDaysCap) > 0
        ? Number(res.feedbackRetentionDaysCap)
        : FALLBACK_LIMITS.feedbackRetentionDaysCap
    }
  } catch {
    return { ...FALLBACK_LIMITS }
  }
}

/**
 * 发送反馈邮箱验证码。
 * 服务端的限流与冷却由服务端判定，命中时会以错误信息返回，交给渲染层展示。
 */
export async function sendFeedbackCode(email: string): Promise<FeedbackCodeResult> {
  const res = await netRequest<Partial<FeedbackCodeResult> & { error?: string }>('server:post', {
    path: 'feedback_send_code',
    body: { email }
  })
  return {
    ok: res?.ok === true,
    ttl: Number(res?.ttl) || 0,
    cooldown: Number(res?.cooldown) || 0,
    error: res?.error
  }
}

/**
 * 提交反馈。
 *
 * 在本地先按服务端最新限制做一次体积 / 数量校验（快速失败，避免白跑一趟网络），
 * 服务端仍会再校验一次（不可信客户端的兜底）。
 */
export async function submitFeedback(payload: FeedbackSubmitPayload): Promise<FeedbackSubmitResult> {
  const title = payload.title.trim()
  const description = payload.description.trim()
  if (!title) return { ok: false, id: '', error: '请填写反馈标题' }
  if (!description) return { ok: false, id: '', error: '请填写反馈描述' }
  const limits = await fetchServerLimits()
  if (payload.files.length > limits.feedbackMaxFiles) {
    return { ok: false, id: '', error: `附件数量过多（最多 ${limits.feedbackMaxFiles} 个）` }
  }
  for (const file of payload.files) {
    const bytes = Buffer.from(file.contentBase64, 'base64').byteLength
    if (bytes === 0) {
      return { ok: false, id: '', error: `附件「${file.name}」内容为空` }
    }
    if (bytes > limits.feedbackMaxBytes) {
      return { ok: false, id: '', error: `附件「${file.name}」超过 ${formatBytes(limits.feedbackMaxBytes)} 上限` }
    }
  }

  const res = await netRequest<Partial<FeedbackSubmitResult> & { error?: string }>('server:post', {
    path: 'feedback_submit',
    body: {
      title,
      description,
      email: payload.email,
      code: payload.code,
      files: payload.files.map((f) => ({ name: f.name, content_base64: f.contentBase64 })),
      meta: payload.meta ?? {}
    }
  })
  return {
    ok: res?.ok === true,
    id: res?.id ?? '',
    error: res?.error
  }
}

/**
 * 可选的免登录时长（秒），与服务端白名单 hc_feedback_token_ttls() 一一对应。
 *
 * 注意「不选时长」并不在这里表达：那种情况**根本不调用** feedback_login，
 * 直接用一次性验证码查询，验证状态只留在本次界面会话里，退出即失效。
 */
export const FEEDBACK_LOGIN_TTL = {
  /** 1 天 */
  day: 86400,
  /** 7 天 */
  week: 604800,
  /** 30 天 */
  month: 2592000,
  /** 永久（expiresAt = 0，服务端不过期） */
  forever: 0
} as const

/** 服务端只认这四个时长值（秒）。 */
const VALID_TTLS: number[] = [86400, 604800, 2592000, 0]

/**
 * 用邮箱验证码换发免登录令牌，并把令牌加密保存在本机。
 *
 * 验证码是一次性消费的：验证成功后不再能重复使用，因此必须在这一步换出令牌，
 * 否则用户每次查看反馈都要重新收邮件。ttl 决定令牌有效期（0 = 永久）。
 *
 * 返回 { ok, expiresAt, error }；渲染层据此提示「已免登录 N 天 / 永久」。
 */
export async function loginFeedback(
  email: string,
  code: string,
  ttl: number
): Promise<FeedbackLoginResult> {
  const to = email.trim().toLowerCase()
  const c = code.trim()
  if (!VALID_TTLS.includes(ttl)) {
    return { ok: false, expiresAt: 0, error: '免登录时长不合法' }
  }
  try {
    // 服务端会连同令牌一起返回；令牌**不写入** FeedbackLoginResult，
    // 只在主进程内转存到加密存储，渲染层永远拿不到它。
    const res = await netRequest<{ ok?: boolean; token?: string; expiresAt?: number; error?: string }>(
      'server:post',
      { path: 'feedback_login', body: { email: to, code: c, ttl } }
    )
    if (res?.ok !== true || !res?.token) {
      return { ok: false, expiresAt: 0, error: res?.error }
    }
    const expiresAt = Number(res.expiresAt) || 0
    const err = setFeedbackSession({ token: String(res.token), email: to, expiresAt })
    if (err) return { ok: false, expiresAt: 0, error: err }
    return { ok: true, expiresAt }
  } catch (err) {
    return { ok: false, expiresAt: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 当前免登录会话状态（供渲染层决定是否跳过验证码界面）。 */
export function feedbackSessionStatus(): { email: string; expiresAt: number } | null {
  const s = getFeedbackSession()
  return s ? { email: s.email, expiresAt: s.expiresAt } : null
}

/** 退出免登录（删除本机会话）。 */
export function logoutFeedback(): void {
  clearFeedbackSession()
}

/**
 * 查询某邮箱名下的全部反馈。
 *
 * 优先用本机的免登录令牌（无需再次输验证码）；没有令牌时回落到邮箱 + 验证码。
 * 两者都不会在服务端保留会话，未免登录的用户每次查看仍需重新验证。
 */
export async function listFeedback(email: string, code: string): Promise<FeedbackListResult> {
  const session = getFeedbackSession()
  // 有免登录会话时优先用它；email 以会话里的为准（避免被渲染层传错邮箱读到别人的）
  const body = session
    ? { token: session.token }
    : { email: email.trim().toLowerCase(), code: code.trim() }
  try {
    const res = await netRequest<{
      ok?: boolean
      feedbacks?: FeedbackListItem[]
      error?: string
    }>('server:post', { path: 'feedback_list', body })
    if (res?.ok !== true) {
      // 令牌失效 / 被撤销：清掉本机会话，渲染层下次会回到验证码界面
      if (session) clearFeedbackSession()
      return { ok: false, feedbacks: [], error: res?.error }
    }
    return { ok: true, feedbacks: Array.isArray(res.feedbacks) ? res.feedbacks : [] }
  } catch (err) {
    return { ok: false, feedbacks: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/** 撤销自己的反馈（仅未回复可撤销）；同样优先走免登录令牌。 */
export async function withdrawFeedback(
  email: string,
  code: string,
  id: string
): Promise<FeedbackWithdrawResult> {
  const session = getFeedbackSession()
  const body = session ? { token: session.token, id } : { email: email.trim().toLowerCase(), code: code.trim(), id }
  try {
    const res = await netRequest<{ ok?: boolean; error?: string }>('server:post', {
      path: 'feedback_withdraw',
      body
    })
    if (res?.ok !== true && session) clearFeedbackSession()
    return { ok: res?.ok === true, error: res?.error }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
