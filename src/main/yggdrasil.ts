import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { MinecraftAccount } from '@shared/types'

/**
 * Yggdrasil 认证（authlib-injector 兼容），用于 LittleSkin 等第三方正版认证服务器。
 *
 * 认证流程遵循标准 Yggdrasil API：
 *   POST {server}/authserver/authenticate  登录并取得 accessToken/clientToken
 *   POST {server}/authserver/refresh       刷新 accessToken
 * 游戏启动时通过 `-javaagent:authlib-injector.jar={server}` 注入，从而让
 * 皮肤、头颅与服务器鉴权都打到第三方认证服务器。
 */

/** 认证服务器地址：去掉末尾斜杠，保证拼接子路径时格式一致。 */
function normalizeServer(server: string): string {
  return server.trim().replace(/\/+$/, '')
}

/** 请求超时时间（毫秒）。第三方认证服务器良莠不齐，超时避免登录/刷新永久挂起。 */
const REQUEST_TIMEOUT_MS = 15_000

/** 带超时的 fetch：超时或网络错误时抛出带友好文案的异常，避免界面永久「卡在登录中」。 */
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error('认证服务器连接超时，请检查地址后重试')
    }
    throw new Error(`认证服务器连接失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

function withoutDashes(uuid: string): string {
  return uuid.replace(/-/g, '')
}

interface YggdrasilProfile {
  id: string
  name: string
  properties?: Array<{ name: string; value: string; signature?: string }>
}

interface YggdrasilAuthResponse {
  accessToken: string
  clientToken: string
  selectedProfile?: YggdrasilProfile
  availableProfiles?: YggdrasilProfile[]
}

/** 从 textures 属性（base64 JSON）解析皮肤 / 披风 / 模型。 */
function extractSkin(profile?: YggdrasilProfile): {
  skinUrl?: string
  capeUrl?: string
  skinModel?: 'classic' | 'slim'
} {
  const tex = profile?.properties?.find((p) => p.name === 'textures')
  if (!tex) return {}
  try {
    const obj = JSON.parse(Buffer.from(tex.value, 'base64').toString('utf-8')) as {
      textures?: {
        SKIN?: { url?: string; metadata?: { model?: string } }
        CAPE?: { url?: string }
      }
    }
    const skin = obj.textures?.SKIN
    return {
      skinUrl: skin?.url,
      capeUrl: obj.textures?.CAPE?.url,
      skinModel: skin?.metadata?.model === 'slim' ? 'slim' : 'classic'
    }
  } catch {
    return {}
  }
}

async function yggdrasilError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string; errorMessage?: string; message?: string }
    if (data.error === 'ForbiddenOperationException') {
      return data.errorMessage || '用户名或密码错误'
    }
    if (data.errorMessage) return data.errorMessage
    if (data.message) return data.message
  } catch {
    /* fall through */
  }
  return `认证失败 (HTTP ${res.status})`
}

function toAccount(
  profile: YggdrasilProfile | undefined,
  data: YggdrasilAuthResponse,
  base: string
): MinecraftAccount {
  const skin = extractSkin(profile)
  return {
    id: withoutDashes(profile?.id ?? ''),
    name: profile?.name ?? '?',
    accessToken: data.accessToken,
    refreshToken: '',
    expiresAt: Date.now() + 23 * 3600 * 1000,
    skinUrl: skin.skinUrl,
    capeUrl: skin.capeUrl,
    skinModel: skin.skinModel,
    addedAt: Date.now(),
    authType: 'yggdrasil',
    yggdrasilServer: base,
    clientToken: data.clientToken
  }
}

export async function loginYggdrasil(
  server: string,
  email: string,
  password: string
): Promise<MinecraftAccount> {
  const base = normalizeServer(server)
  const clientToken = randomUUID().replace(/-/g, '')
  const res = await fetchWithTimeout(`${base}/authserver/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent: { name: 'Minecraft', version: 1 },
      username: email,
      password,
      clientToken,
      requestUser: false
    })
  })
  if (!res.ok) throw new Error(await yggdrasilError(res))
  const data = (await res.json()) as YggdrasilAuthResponse
  const profile = data.selectedProfile ?? data.availableProfiles?.[0]
  if (!profile) throw new Error('该账号没有可用的角色档案')
  return toAccount(profile, data, base)
}

export async function refreshYggdrasil(account: MinecraftAccount): Promise<MinecraftAccount> {
  const base = account.yggdrasilServer ?? ''
  const clientToken = account.clientToken ?? account.id
  const res = await fetchWithTimeout(`${base}/authserver/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accessToken: account.accessToken,
      clientToken,
      requestUser: false
    })
  })
  if (!res.ok) throw new Error(await yggdrasilError(res))
  const data = (await res.json()) as YggdrasilAuthResponse
  const profile = data.selectedProfile ?? data.availableProfiles?.[0] ?? {
    id: account.id,
    name: account.name
  }
  return {
    ...toAccount(profile, { ...data, clientToken: data.clientToken ?? clientToken }, base),
    addedAt: account.addedAt
  }
}

const INJECTOR_META_URLS = [
  'https://authlib-injector.yushi.moe/artifact/latest.json',
  'https://bmclapi2.bangbang93.com/mirrors/authlib-injector/artifact/latest.json'
]

/** 确保 authlib-injector.jar 已就绪，返回其绝对路径。 */
export async function ensureAuthlibInjector(destDir: string): Promise<string> {
  const libDir = join(destDir, 'libraries')
  const jar = join(libDir, 'authlib-injector.jar')
  if (existsSync(jar)) return jar
  mkdirSync(libDir, { recursive: true })

  let lastErr: unknown = null
  for (const metaUrl of INJECTOR_META_URLS) {
    try {
      const metaRes = await fetchWithTimeout(metaUrl)
      if (!metaRes.ok) throw new Error(`HTTP ${metaRes.status}`)
      const meta = (await metaRes.json()) as { download_url?: string; downloadUrl?: string }
      const dl = meta.download_url ?? meta.downloadUrl
      if (!dl) throw new Error('元数据缺少下载地址')
      const fileRes = await fetchWithTimeout(dl)
      if (!fileRes.ok) throw new Error(`HTTP ${fileRes.status}`)
      const buf = Buffer.from(await fileRes.arrayBuffer())
      writeFileSync(jar, buf)
      return jar
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`下载 authlib-injector 失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
}