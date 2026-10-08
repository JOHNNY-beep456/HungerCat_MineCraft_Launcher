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

/**
 * 认证基址规范化：界面上只需填域名（如 `skin.johnnyblog.top`），这里统一补全为
 * `https://{域名}/api/yggdrasil`。已带协议、或已显式含该端点的输入保持不变（幂等），
 * 因此旧账号里已存的完整地址同样适用。
 */
function normalizeServer(server: string): string {
  let s = server.trim().replace(/\/+$/, '')
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`
  if (/\/api\/yggdrasil$/i.test(s)) return s
  return `${s}/api/yggdrasil`
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

/** 供「多角色选择」弹窗展示的角色项（id 已去连字符）。 */
export interface YggdrasilProfileOption {
  id: string
  name: string
  skinUrl?: string
  skinModel?: 'classic' | 'slim'
}

/** 登录结果：单角色直接给出账号；多角色需要用户先选择。 */
export type YggdrasilLoginOutcome =
  | { kind: 'ok'; account: MinecraftAccount }
  | { kind: 'select'; profiles: YggdrasilProfileOption[] }

/** 多角色登录的暂存上下文：等用户在弹窗里选完，再据此批量建号。 */
let pendingYgg: { base: string; data: YggdrasilAuthResponse; clientToken: string; siteName?: string } | null = null

/**
 * 自动获取第三方认证站点的名称（Yggdrasil 元数据 `meta.serverName`，如「LittleSkin」）。
 * 纯增强信息：任何失败都静默返回 undefined，绝不影响登录 / 刷新主流程。
 */
export async function fetchYggdrasilSiteName(server: string): Promise<string | undefined> {
  const base = normalizeServer(server)
  if (!base) return undefined
  try {
    const name = await netRequest<string | undefined>('yggdrasil:meta', { server: base })
    return typeof name === 'string' && name.trim() ? name.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * 取第三方账号的皮肤 / 披风贴图地址：走认证站的标准 Yggdrasil 会话服
 * （`{base}/sessionserver/session/minecraft/profile/{uuid}`），**不查正版 uapis 接口**。
 * 用于没有本地 skinUrl 的第三方账号补全皮肤与披风，供头像本地合成与 3D 模型使用。
 * 任何失败返回 undefined（调用方回退到站点头像接口）。
 */
export async function fetchYggdrasilSkin(
  server: string,
  uuid: string
): Promise<{ skinUrl: string; skinModel: 'classic' | 'slim'; capeUrl: string } | undefined> {
  const base = normalizeServer(server)
  const id = String(uuid ?? '').replace(/-/g, '')
  if (!base || !id) return undefined
  try {
    return await netRequest<{ skinUrl: string; skinModel: 'classic' | 'slim'; capeUrl: string }>('yggdrasil:profile', {
      server: base,
      uuid: id
    })
  } catch {
    return undefined
  }
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
  base: string,
  /** 本次请求实际使用的 clientToken：服务端未回传时用它兜底。 */
  fallbackClientToken: string,
  /** 站点名称（自动获取，可能缺失）。 */
  siteName?: string
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
    ...(siteName ? { siteName } : {}),
    clientToken: data.clientToken || fallbackClientToken
  }
}

export async function loginYggdrasil(
  server: string,
  email: string,
  password: string
): Promise<YggdrasilLoginOutcome> {
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
    // 优先以服务端返回的 availableProfiles 为准；缺失时退化为 selectedProfile。
    const available = data.availableProfiles ?? []
    const profiles = available.length > 0 ? available : data.selectedProfile ? [data.selectedProfile] : []
    if (profiles.length === 0) throw new Error('该账号没有可用的角色档案')
    console.info(`[登录] 第三方登录成功：${base} / ${email}（可用角色 ${profiles.length} 个）`)
    // 自动获取站点名称（元数据 meta.serverName）：纯增强，失败不影响登录。
    const siteName = await fetchYggdrasilSiteName(base)
    if (profiles.length > 1) {
      // 多角色：暂存令牌上下文，交给界面弹窗选择（可多选）后再建号。
      pendingYgg = { base, data, clientToken, siteName }
      return {
        kind: 'select',
        profiles: profiles.map((p) => {
          const skin = extractSkin(p)
          return { id: withoutDashes(p.id), name: p.name, skinUrl: skin.skinUrl, skinModel: skin.skinModel }
        })
      }
    }
    const profile = data.selectedProfile ?? profiles[0]
    pendingYgg = null
    return { kind: 'ok', account: toAccount(profile, data, base, clientToken, siteName) }
  } catch (err) {
    console.error(`[登录] 第三方登录失败：${base} / ${email} ${err instanceof Error ? err.message : String(err)}`)
    throw err
  }
}

/**
 * 依据「多角色选择」弹窗的多选结果批量建号。
 * 同一账号下的各角色共用同一份 accessToken / clientToken，仅角色档案不同。
 */
export function commitYggdrasilProfiles(ids: string[]): MinecraftAccount[] {
  const ctx = pendingYgg
  pendingYgg = null
  if (!ctx) throw new Error('登录会话已失效，请重新登录')
  const wanted = new Set(ids.map((x) => withoutDashes(x)))
  const available = ctx.data.availableProfiles ?? []
  const picked = available.filter((p) => wanted.has(withoutDashes(p.id)))
  if (picked.length === 0) throw new Error('请至少选择一个角色')
  return picked.map((p) => toAccount(p, ctx.data, ctx.base, ctx.clientToken, ctx.siteName))
}

export async function refreshYggdrasil(account: MinecraftAccount): Promise<MinecraftAccount> {
  console.info(`[登录] 开始刷新第三方账号令牌：${account.name}`)
  try {
    // 账号里存的是完整认证基址；这里同样走规范化，兼容只存域名的旧数据。
    const base = normalizeServer(account.yggdrasilServer ?? '')
    // clientToken 必须与登录时使用的一致（服务端会校验）。旧实现仅用 `?? account.id` 兜底，
    // 而账号 id 是角色 UUID、与 clientToken 语义无关；一旦登录时服务端未回传 clientToken
    // 就会存成空值，刷新时便拿角色 UUID 去顶替，从而被服务端判为令牌无效、刷新必然失败。
    const clientToken = account.clientToken?.trim() || account.id
    const data = await netRequest<YggdrasilAuthResponse>('yggdrasil:refresh', {
      server: base,
      accessToken: account.accessToken,
      clientToken
    })
    // 同一账号可能包含多个角色（多角色可多选添加），且各角色共用同一份令牌；
    // refresh 请求未指定 selectedProfile，服务端会回默认角色。因此必须按账号自身的
    // 角色 id 在返回列表里精确匹配，匹配不到时再沿用本地角色信息，
    // 否则刷新会把账号「换」成服务端的默认角色。
    const matched = [data.selectedProfile, ...(data.availableProfiles ?? [])].find(
      (p) => p && withoutDashes(p.id) === account.id
    )
    const profile = matched ?? { id: account.id, name: account.name }
    console.info(`[登录] 刷新第三方账号令牌成功：${account.name}`)
    // 站点名称：沿用已存值；旧账号缺失时顺带补全（best-effort，失败不阻塞刷新）。
    const siteName = account.siteName ?? (await fetchYggdrasilSiteName(base))
    return {
      ...toAccount(profile, data, base, clientToken, siteName),
      addedAt: account.addedAt
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[登录] 刷新第三方账号令牌失败：${account.name} ${msg}`)
    // 服务端判为「令牌无效」时，accessToken 或 clientToken 已不再被认可，
    // 本地无法凭空补齐，只能重新登录——给一句可操作的提示，而不是把服务端原文抛给用户。
    if (/invalid token|forbiddenoperationexception|无效/i.test(msg)) {
      throw new Error(`第三方账号登录凭据已失效，请在「账号」页重新登录该账号（${msg}）`)
    }
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