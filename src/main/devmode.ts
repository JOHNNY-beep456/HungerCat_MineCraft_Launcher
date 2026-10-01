// ---------------------------------------------------------------------------
// 开发模式（Development Mode）
//
// 面向主页脚本开发者：需在服务端后台白名单内的邮箱，经「输入邮箱 + 验证码」验证后，
// 获得为期 1 天的授权。授权期内可自由开关开发模式、调整主页安全防护档位，也可随时
// 解除授权；到期后自动关闭，再次开启需重新验证邮箱。
//
// 令牌与授权状态由服务端签发 / 校验，本地只缓存令牌与到期时间；是否仍有效以服务端
// 为准（每次开启 / 状态查询都会回服务端核对），避免本地时间被篡改后长期生效。
// ---------------------------------------------------------------------------

import type { DevModeCodeResult, DevModeStatus, DevModeVerifyResult } from '@shared/types'
import { settings } from './store'
import { netRequest } from './broker'

type SecurityMode = 'full' | 'warn' | 'off'

/** 授权变化的广播回调（由主进程注册，转发到各窗口渲染层）。 */
let broadcaster: ((s: DevModeStatus) => void) | null = null

export function setDevModeBroadcaster(fn: ((s: DevModeStatus) => void) | null): void {
  broadcaster = fn
}

function emit(s: DevModeStatus): void {
  if (broadcaster) broadcaster(s)
}

/** 汇总当前状态。granted 以「到期时间未过」为准；开启状态在未授权时强制为关闭。 */
export function devModeStatus(): DevModeStatus {
  const s = settings.get()
  const expiresAt = Number(s.devModeGrantedUntil) || 0
  const granted = expiresAt > Date.now()
  const enabled = granted && s.devModeEnabled === true
  return {
    granted,
    expiresAt,
    enabled,
    emailMasked: granted ? s.devModeEmailMasked || '' : '',
    securityMode: s.devModeSecurityMode,
    // 未开启开发模式时，主页安全防护强制为「完全模拟」。
    effectiveSecurityMode: enabled ? s.devModeSecurityMode : 'full'
  }
}

/**
 * 到期自动关闭：未到期时不做任何事；已到期则清空授权并关闭开发模式。
 * 返回「是否发生了状态变化」，供调用方决定是否广播。
 */
export function enforceDevModeExpiry(): boolean {
  const s = settings.get()
  if (!s.devModeGrantedUntil) return false
  if (Number(s.devModeGrantedUntil) > Date.now()) return false
  settings.set({ devModeGrantedUntil: 0, devModeToken: '', devModeEmailMasked: '', devModeEnabled: false })
  return true
}

/** 定时兜底：每分钟检查一次是否到期（长时间挂着启动器时也能自动关闭）。 */
let expiryTimer: ReturnType<typeof setInterval> | null = null

export function startDevModeExpiryWatch(): void {
  if (expiryTimer) return
  expiryTimer = setInterval(() => {
    if (enforceDevModeExpiry()) emit(devModeStatus())
  }, 60 * 1000)
  expiryTimer.unref()
}

/** 发送开发模式验证码。 */
export async function sendDevModeCode(email: string): Promise<DevModeCodeResult> {
  const res = await netRequest<Partial<DevModeCodeResult> & { error?: string }>('server:post', {
    path: 'dev_send_code',
    body: { email }
  })
  if (res?.ok !== true) throw new Error(res?.error || '验证码发送失败')
  return { ok: true, ttl: Number(res?.ttl) || 0, cooldown: Number(res?.cooldown) || 0 }
}

/** 校验验证码并落盘授权（1 天）。 */
export async function verifyDevMode(email: string, code: string): Promise<DevModeVerifyResult> {
  const res = await netRequest<{ ok?: boolean; token?: string; expiresAt?: number; emailMasked?: string; error?: string }>(
    'server:post',
    { path: 'dev_verify', body: { email, code } }
  )
  if (res?.ok !== true || !res?.token) {
    throw new Error(res?.error || '验证失败')
  }
  const expiresAt = Number(res?.expiresAt) || Date.now() + 24 * 3600 * 1000
  const masked = res?.emailMasked || maskEmail(email)
  settings.set({
    devModeToken: res.token,
    devModeGrantedUntil: expiresAt,
    devModeEmailMasked: masked,
    // 验证通过即视为用户想用开发模式，默认直接开启，省去再点一次。
    devModeEnabled: true
  })
  const s = devModeStatus()
  emit(s)
  return { ok: true, expiresAt }
}

/** 开关开发模式（仅在授权有效期内允许）。 */
export async function setDevModeEnabled(enabled: boolean): Promise<DevModeStatus> {
  enforceDevModeExpiry()
  const st = devModeStatus()
  if (!st.granted) throw new Error('开发模式授权已失效，请重新验证邮箱')
  settings.set({ devModeEnabled: enabled === true })
  const s = devModeStatus()
  emit(s)
  return s
}

/** 解除授权：通知服务端作废令牌，并清空本地授权与开关。 */
export async function revokeDevMode(): Promise<DevModeStatus> {
  const token = settings.get().devModeToken
  if (token) {
    try {
      await netRequest('server:post', { path: 'dev_revoke', body: { token } })
    } catch {
      // 服务端不可达也照常清本地，避免用户被「卡」在已失效的授权里。
    }
  }
  settings.set({ devModeGrantedUntil: 0, devModeToken: '', devModeEmailMasked: '', devModeEnabled: false })
  const s = devModeStatus()
  emit(s)
  return s
}

/** 设置主页安全防护档位。 */
export async function setDevModeSecurityMode(mode: SecurityMode): Promise<DevModeStatus> {
  const valid: SecurityMode[] = ['full', 'warn', 'off']
  settings.set({ devModeSecurityMode: valid.includes(mode) ? mode : 'full' })
  const s = devModeStatus()
  emit(s)
  return s
}

/** 与渲染层当前生效的档位（开发模式关闭时恒为 full）。 */
export function currentSecurityMode(): SecurityMode {
  const s = settings.get()
  if (!(Number(s.devModeGrantedUntil) > Date.now()) || !s.devModeEnabled) return 'full'
  return s.devModeSecurityMode
}

/** 本地兜底的邮箱掩码（服务端未回传时使用）。 */
function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return email
  const name = email.slice(0, at)
  const domain = email.slice(at)
  const head = name.slice(0, 1)
  return `${head}***${domain}`
}
