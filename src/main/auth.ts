// Microsoft OAuth 设备代码流（login.live.com 旧版流程），用于 Minecraft Java 版。
//
// 本模块保留**状态机**（DeviceCodeSession.pollLoop 的轮询间隔/分支/取消）与 `auth.onStatus`
// 事件编排；每次 HTTP 的【网络执行】都委托给网络进程：
//   auth:deviceBegin / auth:devicePoll / auth:chain / auth:refreshToken
// 令牌链：MS access -> XBL -> XSTS -> Minecraft。取消会 abort 网络侧在途轮询请求。
import type { AuthStatus, DeviceCodeInfo, MinecraftAccount } from '@shared/types'
import { netRequest } from './broker'

const CLIENT_ID = '00000000441cc96b'
const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 一次 auth:devicePoll 的返回：与网络进程签名保持一致。 */
type AuthPollEntry =
  | { state: 'success'; accessToken: string; refreshToken: string }
  | { state: 'error'; error: string; description?: string }

interface MsProfileMeta {
  id: string
  name: string
  skins?: Array<{ id: string; state: string; url: string; variant?: 'classic' | 'slim' }>
  capes?: Array<{ id: string; state: string; url: string }>
}

/** 用微软 access/refresh token 打通整条链，组装成 Minecraft 账号对象。网络执行由 auth:chain 承担。 */
async function completeChain(
  msAccessToken: string,
  refreshToken: string,
  addedAt?: number
): Promise<MinecraftAccount> {
  const { accessToken, expiresIn, profile } = await netRequest<{
    accessToken: string
    expiresIn: number
    profile: MsProfileMeta
  }>('auth:chain', { msAccessToken })
  const skin = profile.skins?.find((s) => s.state === 'ACTIVE')
  const cape = profile.capes?.find((c) => c.state === 'ACTIVE')
  return {
    id: profile.id,
    name: profile.name,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    skinUrl: skin?.url,
    capeUrl: cape?.url,
    // Mojang 返回的 variant 是大写（CLASSIC / SLIM），统一归一化为小写，避免判断失效。
    skinModel: skin?.variant ? (skin.variant.toLowerCase() === 'slim' ? 'slim' : 'classic') : undefined,
    addedAt: addedAt ?? Date.now()
  }
}

/** 刷新微软令牌，返回新的 access/refresh token（网络执行由 auth:refreshToken 承担）。 */
async function refreshMsToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
  return netRequest<{ accessToken: string; refreshToken: string }>('auth:refreshToken', {
    clientId: CLIENT_ID,
    refreshToken,
    // 必须把授权时的 scope 原样带回：MSA 的 refresh token 与 scope 绑定，
    // 缺 scope 会被微软判 invalid_grant（历史上的「刷新令牌失败」根因）。
    scope: SCOPE
  })
}

/**
 * 按账号 id 串行化的在途刷新。
 *
 * MSA 的 refresh token 是**轮换式**的：每次刷新成功都会让旧 token 立即失效。
 * 而刷新有两个互不感知的入口 —— 启动时（App.tsx 的令牌检查）与启动前
 * （launch:start 的过期检查）。两者若并发，后到的一方拿着已被轮换掉的旧 token
 * 去刷新，必然拿到 invalid_grant。因此同一账号只发一次刷新，其余调用复用在途结果。
 */
const inFlightRefresh = new Map<string, Promise<MinecraftAccount>>()

/** Refresh an existing account's tokens and return the updated account. */
export function refreshAccount(account: MinecraftAccount): Promise<MinecraftAccount> {
  // 防止向微软发送缺失/空 refresh token：老账号或异常数据会在首步就被清晰拒绝，
  // 而不是发无效 token 空跑一轮再抛晦涩错误。
  if (!account.refreshToken) return Promise.reject(new Error('该账号缺少刷新令牌，请重新登录微软账号'))
  const key = account.id
  const existing = inFlightRefresh.get(key)
  if (existing) return existing
  const run = (async (): Promise<MinecraftAccount> => {
    const tokens = await refreshMsToken(account.refreshToken)
    return completeChain(tokens.accessToken, tokens.refreshToken, account.addedAt)
  })().finally(() => {
    // 只清理自己这一次，避免误删后来者的记录
    if (inFlightRefresh.get(key) === run) inFlightRefresh.delete(key)
  })
  inFlightRefresh.set(key, run)
  return run
}

/** A single in-flight device-code login session. */
export class DeviceCodeSession {
  private aborted = false
  private controller: AbortController | null = null
  private deviceCode: string | null = null
  private deviceCookie = ''

  async begin(emit: (status: AuthStatus) => void): Promise<DeviceCodeInfo> {
    const { cookie, userCode, deviceCode, verificationUri, message, expiresIn, interval } =
      await netRequest<{
        cookie: string
        userCode: string
        deviceCode: string
        verificationUri: string
        message: string
        expiresIn: number
        interval: number
      }>('auth:deviceBegin', { clientId: CLIENT_ID, scope: SCOPE })
    this.deviceCookie = cookie
    this.deviceCode = deviceCode
    this.aborted = false
    const info: DeviceCodeInfo = {
      userCode,
      deviceCode,
      verificationUri,
      message,
      expiresIn,
      interval
    }
    void this.pollLoop(info, emit)
    return info
  }

  cancel(): void {
    this.aborted = true
    this.controller?.abort()
  }

  private async pollLoop(info: DeviceCodeInfo, emit: (s: AuthStatus) => void): Promise<void> {
    let interval = info.interval
    const started = Date.now()
    this.controller = new AbortController()
    try {
      await sleep(interval * 1000)
      while (!this.aborted) {
        // 单次轮询委托网络进程；取消经 AbortController 中止网络侧在途请求。
        const result = await netRequest<AuthPollEntry>(
          'auth:devicePoll',
          { clientId: CLIENT_ID, deviceCode: info.deviceCode, cookie: this.deviceCookie },
          { signal: this.controller.signal }
        )
        if (result.state === 'success') {
          const account = await completeChain(result.accessToken, result.refreshToken)
          emit({ state: 'success', account })
          return
        }
        const err = result.error
        switch (err) {
          case 'authorization_pending':
            emit({ state: 'waiting', elapsed: Math.floor((Date.now() - started) / 1000), expiresIn: info.expiresIn })
            await sleep(interval * 1000)
            continue
          case 'slow_down':
            interval += 5
            await sleep(interval * 1000)
            continue
          case 'authorization_declined':
            emit({ state: 'error', error: '你取消了本次登录授权' })
            return
          case 'expired_token':
            emit({ state: 'error', error: '登录代码已过期，请重新发起' })
            return
          case 'bad_verification_code':
            emit({ state: 'error', error: '登录代码无效' })
            return
          default:
            emit({ state: 'error', error: result.description || err || '未知登录错误' })
            return
        }
      }
    } catch (ex) {
      emit({ state: 'error', error: ex instanceof Error ? ex.message : String(ex) })
    } finally {
      this.controller = null
    }
  }
}