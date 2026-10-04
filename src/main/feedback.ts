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
  FeedbackSubmitPayload,
  FeedbackSubmitResult,
  FeedbackWithdrawResult,
  ServerLimits
} from '@shared/types'
import { netRequest } from './broker'

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
 * 查询某邮箱名下的全部反馈（需邮箱验证码）。
 *
 * 每次查看都要重新验证：验证码一次性消费，服务端不做持久登录态。
 */
export async function listFeedback(email: string, code: string): Promise<FeedbackListResult> {
  const res = await netRequest<{ ok?: boolean; feedbacks?: FeedbackListItem[]; error?: string }>(
    'server:post',
    { path: 'feedback_list', body: { email, code } }
  )
  return {
    ok: res?.ok === true,
    feedbacks: Array.isArray(res?.feedbacks) ? res.feedbacks : [],
    error: res?.error
  }
}

/** 撤销自己的反馈（仅未回复可撤销）。 */
export async function withdrawFeedback(
  email: string,
  code: string,
  id: string
): Promise<FeedbackWithdrawResult> {
  const res = await netRequest<{ ok?: boolean; error?: string }>('server:post', {
    path: 'feedback_withdraw',
    body: { email, code, id }
  })
  return { ok: res?.ok === true, error: res?.error }
}
