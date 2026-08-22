import type { AuthStatus, DeviceCodeInfo, MinecraftAccount } from '@shared/types'

/**
 * Microsoft OAuth 设备代码流（login.live.com 旧版流程），用于 Minecraft Java 版。
 *
 * 使用 Nintendo Switch 版 Minecraft 的公共 client id（免申请），配合
 * `service::user.auth.xboxlive.com::MBI_SSL` scope。令牌链：
 * MS 访问令牌 -> Xbox Live (XBL) -> XSTS -> Minecraft。
 */

const CLIENT_ID = '00000000441cc96b'
const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL'

const DEVICE_CODE_URL = 'https://login.live.com/oauth20_connect.srf'
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf'
const XBL_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate'
const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize'
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox'
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface XblResponse {
  Token: string
  DisplayClaims?: { xui?: Array<{ uhs: string }> }
  XErr?: number
  Message?: string
  Redirect?: string
}

/** login.live.com 设备码流程要求在后续轮询中携带首次响应返回的 Cookie。 */
function extractCookie(res: Response): string {
  try {
    const setCookies = res.headers.getSetCookie?.() ?? []
    if (setCookies.length) return setCookies.map((v) => v.split(';')[0]).join('; ')
  } catch {
    /* fall through */
  }
  const sc = res.headers.get('set-cookie')
  return sc ? sc.split(',')[0].split(';')[0].trim() : ''
}

async function postForm(url: string, body: Record<string, string>, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (cookie) headers['Cookie'] = cookie
  return fetch(url, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body)
  })
}

async function xblAuthenticate(msAccessToken: string): Promise<{ token: string; uhs: string }> {
  const res = await fetch(XBL_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `t=${msAccessToken}`
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    })
  })
  if (!res.ok) throw new Error(`Xbox Live 认证失败 (HTTP ${res.status})`)
  const data = (await res.json()) as XblResponse
  if (!data.Token) throw new Error('Xbox Live 未返回令牌')
  return { token: data.Token, uhs: data.DisplayClaims?.xui?.[0]?.uhs ?? '' }
}

async function xstsAuthorize(xblToken: string): Promise<{ token: string; uhs: string }> {
  const res = await fetch(XSTS_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    })
  })
  const data = (await res.json().catch(() => ({}))) as XblResponse
  if (data.XErr) {
    if (data.XErr === 2148916233) throw new Error('该微软账号没有 Xbox 档案，请先在 xbox.com 创建')
    if (data.XErr === 2148916238) throw new Error('该账号是儿童账号，需要家长授权')
    if (data.XErr === 2148916235) throw new Error('Xbox Live 在该地区不可用')
    throw new Error(`XSTS 认证失败 (XErr ${data.XErr})`)
  }
  if (!data.Token) throw new Error('XSTS 未返回令牌')
  return { token: data.Token, uhs: data.DisplayClaims?.xui?.[0]?.uhs ?? '' }
}

async function minecraftLogin(
  uhs: string,
  xstsToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await fetch(MC_LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xstsToken}` })
  })
  if (!res.ok) throw new Error('Minecraft 服务登录失败')
  const data = (await res.json()) as { access_token: string; expires_in: number }
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? 86400 }
}

interface McProfile {
  id: string
  name: string
  skins?: Array<{ id: string; state: string; url: string; variant?: 'classic' | 'slim' }>
  capes?: Array<{ id: string; state: string; url: string }>
}

async function getProfile(mcAccessToken: string): Promise<McProfile> {
  const res = await fetch(MC_PROFILE_URL, {
    headers: { Authorization: `Bearer ${mcAccessToken}` }
  })
  if (res.status === 404) throw new Error('该账号未购买 Minecraft（没有正版资格）')
  if (!res.ok) throw new Error(`获取玩家档案失败 (HTTP ${res.status})`)
  return (await res.json()) as McProfile
}

async function completeChain(
  msAccessToken: string,
  refreshToken: string,
  addedAt?: number
): Promise<MinecraftAccount> {
  const xbl = await xblAuthenticate(msAccessToken)
  const xsts = await xstsAuthorize(xbl.token)
  const mc = await minecraftLogin(xsts.uhs, xsts.token)
  const profile = await getProfile(mc.accessToken)
  const skin = profile.skins?.find((s) => s.state === 'ACTIVE')
  const cape = profile.capes?.find((c) => c.state === 'ACTIVE')
  return {
    id: profile.id,
    name: profile.name,
    accessToken: mc.accessToken,
    refreshToken,
    expiresAt: Date.now() + mc.expiresIn * 1000,
    skinUrl: skin?.url,
    capeUrl: cape?.url,
    skinModel: skin?.variant,
    addedAt: addedAt ?? Date.now()
  }
}

async function refreshMsToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await postForm(TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken
  })
  if (!res.ok) throw new Error('刷新令牌失败，请重新登录')
  const data = (await res.json()) as { access_token: string; refresh_token: string }
  return { accessToken: data.access_token, refreshToken: data.refresh_token }
}

/** Refresh an existing account's tokens and return the updated account. */
export async function refreshAccount(account: MinecraftAccount): Promise<MinecraftAccount> {
  const tokens = await refreshMsToken(account.refreshToken)
  return completeChain(tokens.accessToken, tokens.refreshToken, account.addedAt)
}

/** A single in-flight device-code login session. */
export class DeviceCodeSession {
  private aborted = false
  private deviceCode: string | null = null
  private deviceCookie = ''

  async begin(emit: (status: AuthStatus) => void): Promise<DeviceCodeInfo> {
    const res = await postForm(DEVICE_CODE_URL, {
      client_id: CLIENT_ID,
      scope: SCOPE,
      response_type: 'device_code'
    })
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error_description?: string }
      throw new Error(`获取登录代码失败：${err.error_description || res.statusText}`)
    }
    this.deviceCookie = extractCookie(res)
    const data = (await res.json()) as {
      user_code: string
      device_code: string
      verification_uri?: string
      verification_uri_complete?: string
      message?: string
      expires_in: number
      interval: number
    }
    this.deviceCode = data.device_code
    this.aborted = false
    const info: DeviceCodeInfo = {
      userCode: data.user_code,
      deviceCode: data.device_code,
      verificationUri: data.verification_uri_complete ?? `https://microsoft.com/link?otc=${data.user_code}`,
      message: data.message ?? '',
      expiresIn: data.expires_in,
      interval: data.interval
    }
    void this.pollLoop(info, emit)
    return info
  }

  cancel(): void {
    this.aborted = true
  }

  private async pollLoop(info: DeviceCodeInfo, emit: (s: AuthStatus) => void): Promise<void> {
    let interval = info.interval
    const started = Date.now()
    try {
      await sleep(interval * 1000)
      while (!this.aborted) {
        const res = await postForm(
          `${TOKEN_URL}?client_id=${CLIENT_ID}`,
          {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            client_id: CLIENT_ID,
            device_code: info.deviceCode
          },
          this.deviceCookie
        )
        if (res.ok) {
          const data = (await res.json()) as { access_token: string; refresh_token: string }
          const account = await completeChain(data.access_token, data.refresh_token)
          emit({ state: 'success', account })
          return
        }
        const err = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string }
        switch (err.error) {
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
            emit({ state: 'error', error: err.error_description || err.error || '未知登录错误' })
            return
        }
      }
    } catch (ex) {
      emit({ state: 'error', error: ex instanceof Error ? ex.message : String(ex) })
    }
  }
}
