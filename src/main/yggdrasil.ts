// authenticate / refresh 的【网络执行】已迁至网络进程（yggdrasil:authenticate / :refresh），
// 本模块保留认证流程编排与解析：生成 clientToken、把网络进程返回的原始响应组装成账号对象。
// authlib-injector 的 jar 下载走 streamDownload（broker 代理网络进程）；
// latest.json 元数据获取走网络进程（net:fetchJson）。
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { MinecraftAccount } from '@shared/types'
import { netRequest } from './broker'
import { streamDownload } from './stream-download'

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

function withoutDashes(uuid: string): string {
  return uuid.replace(/-/g, '')
}

interface YggdrasilProfile {
  id: string
  name: string
  properties?: Array<{ name: string; value: string; signature?: string }>
}

/** 与 shared/net-protocol 网络进程 `yggdrasil:*` 返回结构的原始响应对应。 */
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
  // 只记认证服务器与邮箱，绝不打印密码。
  console.info(`[登录] 开始第三方登录：${base} / ${email}`)
  try {
    const clientToken = randomUUID().replace(/-/g, '')
    // authenticate 的网络执行由网络进程承担；邮箱/密码经 IPC 内部通道传递。
    const data = await netRequest<YggdrasilAuthResponse>('yggdrasil:authenticate', {
      server: base,
      email,
      password,
      clientToken
    })
    const profile = data.selectedProfile ?? data.availableProfiles?.[0]
    if (!profile) throw new Error('该账号没有可用的角色档案')
    console.info(`[登录] 第三方登录成功：${base} / ${email}`)
    return toAccount(profile, data, base)
  } catch (err) {
    console.error(`[登录] 第三方登录失败：${base} / ${email} ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

export async function refreshYggdrasil(account: MinecraftAccount): Promise<MinecraftAccount> {
  console.info(`[登录] 开始刷新第三方账号令牌：${account.name}`)
  try {
    const base = account.yggdrasilServer ?? ''
    const clientToken = account.clientToken ?? account.id
    const data = await netRequest<YggdrasilAuthResponse>('yggdrasil:refresh', {
      server: base,
      accessToken: account.accessToken,
      clientToken
    })
    const profile = data.selectedProfile ?? data.availableProfiles?.[0] ?? {
      id: account.id,
      name: account.name
    }
    console.info(`[登录] 刷新第三方账号令牌成功：${account.name}`)
    return {
      ...toAccount(profile, { ...data, clientToken: data.clientToken ?? clientToken }, base),
      addedAt: account.addedAt
    }
  } catch (err) {
    console.error(`[登录] 刷新第三方账号令牌失败：${account.name} ${err instanceof Error ? err.message : String(err)}`)
    throw err
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
      // 元数据获取委托给网络进程（net:fetchJson，统一 10s 超时在其内部）。
      const meta = await netRequest<{ download_url?: string; downloadUrl?: string }>('net:fetchJson', {
        url: metaUrl
      })
      const dl = meta.download_url ?? meta.downloadUrl
      if (!dl) throw new Error('元数据缺少下载地址')
      // jar 文件下载委托给网络进程（stream:download）。
      await streamDownload(dl, jar)
      return jar
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`下载 authlib-injector 失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
}