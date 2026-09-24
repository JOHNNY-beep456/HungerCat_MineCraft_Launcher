// ---------------------------------------------------------------------------
// 网络进程（Electron utilityProcess.fork）入口。
//
// 专职网络 IO：全部 fetch / 下载 / 刷新 token 等的「网络执行」都在本进程完成，
// 让后端/编排进程不再被网络慢/阻塞拖住事件循环，从而保证渲染层 UI 不卡。
//
// 本进程【不】touch Electron 的 ipcMain / WebContents，只做网络并回传结果/事件。
// 通信方式：直接使用 utilityProcess 的原生通道 —— 主进程经 child.postMessage 发送请求，
// 本进程从 process.parentPort 接收；本进程用 process.parentPort.postMessage 回传
// 结果/进度（主进程在 child.on('message') 收到）。协议见 shared/net-protocol.ts。
// ---------------------------------------------------------------------------

import { mirrorConfig, type MirrorKind } from '../mirror'
import { streamDownload } from './stream-download'
import type {
  LoaderKind,
  ModrinthProject,
  ModrinthSearchResult,
  ModrinthType,
  ModrinthVersion,
  VersionJson,
  VersionManifest
} from '@shared/types'
import type { NetHandler, NetHandlerCtx, NetRequestMessage, NetResponseMessage } from '@shared/net-protocol'

const UA = { 'User-Agent': 'HungerCatLauncher/0.1' }

function log(...args: unknown[]): void {
  console.log('[网络进程]', ...args)
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { headers: UA, signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/* ------------------------------------------------------------------ */
/* versions：版本清单 / 单个版本 JSON                                    */
/* ------------------------------------------------------------------ */

interface RawManifestVersion {
  id: string
  type: string
  releaseTime: string
  url: string
}

function fetchVersionManifest(mirror: MirrorKind): Promise<VersionManifest> {
  // 统一 10s 超时：避免版本清单请求挂起导致启动器卡死。
  return fetchJson(mirrorConfig(mirror).manifest, AbortSignal.timeout(10_000)).then((raw) => {
    const data = raw as { latest: { release: string; snapshot: string }; versions: RawManifestVersion[] }
    return {
      latest: data.latest,
      versions: data.versions
        .filter((v) => v.type !== 'old_alpha' && v.type !== 'old_beta')
        .map((v) => ({
          id: v.id,
          type: v.type as VersionManifest['versions'][number]['type'],
          releaseTime: v.releaseTime
        }))
    }
  })
}

/** 获取单个原版版本 JSON（不含 inheritsFrom 合并；合并仍由主进程 resolveVersionJson 承担）。 */
function fetchRawVersionJson(id: string, mirror: MirrorKind): Promise<VersionJson> {
  const fast = mirrorConfig(mirror).versionJson(id)
  if (mirror !== 'mojang' && fast) {
    return fetchJson(fast, AbortSignal.timeout(10_000)) as Promise<VersionJson>
  }
  return fetch(mirrorConfig(mirror).manifest, { signal: AbortSignal.timeout(10_000) })
    .then((res) => res.json() as Promise<{ versions: RawManifestVersion[] }>)
    .then((data) => {
      const entry = data.versions.find((v) => v.id === id)
      if (!entry) throw new Error(`未找到版本 ${id}`)
      return fetchJson(entry.url, AbortSignal.timeout(10_000)) as Promise<VersionJson>
    })
}

/* ------------------------------------------------------------------ */
/* loaders：Fabric / Quilt 元数据                                       */
/* ------------------------------------------------------------------ */

const LOADER_META: Record<
  LoaderKind,
  { versionsUrl: (mc: string) => string; profileUrl: (mc: string, loader: string) => string }
> = {
  fabric: {
    versionsUrl: (mc) => `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}`,
    profileUrl: (mc, loader) =>
      `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/profile/json`
  },
  quilt: {
    versionsUrl: (mc) => `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mc)}`,
    profileUrl: (mc, loader) =>
      `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/profile/json`
  }
}

interface LoaderVersionEntry {
  loader?: { version?: string }
  version?: string
}

function fetchLoaderVersions(kind: LoaderKind, mcVersion: string): Promise<string[]> {
  return fetchJson(LOADER_META[kind].versionsUrl(mcVersion), AbortSignal.timeout(10_000)).then((raw) => {
    const data = raw as LoaderVersionEntry[]
    return data
      .map((d) => d.loader?.version ?? d.version)
      .filter((v): v is string => typeof v === 'string')
  })
}

function fetchLoaderProfile(kind: LoaderKind, mcVersion: string, loaderVersion: string): Promise<VersionJson> {
  return fetchJson(LOADER_META[kind].profileUrl(mcVersion, loaderVersion), AbortSignal.timeout(10_000)) as Promise<VersionJson>
}

/* ------------------------------------------------------------------ */
/* forge：Forge / NeoForge 元数据（版本清单；下载器 jar 走 stream）       */
/* ------------------------------------------------------------------ */

type ForgeKind = 'forge' | 'neoforge'

const FORGE_MAVEN: Record<ForgeKind, { metadata: string }> = {
  forge: { metadata: 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml' },
  neoforge: { metadata: 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml' }
}

function naturalDesc(a: string, b: string): number {
  const pa = a.split(/(\d+)/)
  const pb = b.split(/(\d+)/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ca = pa[i] ?? ''
    const cb = pb[i] ?? ''
    if (ca === cb) continue
    const na = Number(ca)
    const nb = Number(cb)
    if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na
    return cb.localeCompare(ca)
  }
  return 0
}

function matchesMc(version: string, mcVersion: string, kind: ForgeKind): boolean {
  if (version.startsWith(`${mcVersion}-`)) return true
  if (kind === 'neoforge') {
    // NeoForge moved to standalone versioning for 1.20.5+: "1.21" -> "21.0.x".
    const parts = mcVersion.split('.')
    if (parts.length >= 2 && parts[0] === '1') {
      const prefix = parts[2] ? `${parts[1]}.${parts[2]}.` : `${parts[1]}.`
      if (version.startsWith(prefix)) return true
    }
  }
  return false
}

function fetchForgeVersions(kind: ForgeKind, mcVersion: string): Promise<string[]> {
  return fetch(FORGE_MAVEN[kind].metadata, { headers: UA, signal: AbortSignal.timeout(10_000) })
    .then(async (res) => {
      if (!res.ok) throw new Error(`获取 ${kind} 版本列表失败 (HTTP ${res.status})`)
      return res.text()
    })
    .then((xml) => {
      const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1])
      const matched = versions.filter((v) => matchesMc(v, mcVersion, kind))
      const stable = matched.filter((v) => !/-(pre|rc|beta|alpha|snapshot)/i.test(v))
      const pre = matched.filter((v) => /-(pre|rc|beta|alpha|snapshot)/i.test(v))
      return [...stable.sort(naturalDesc), ...pre.sort(naturalDesc)].slice(0, 200)
    })
}

/* ------------------------------------------------------------------ */
/* modrinth：搜索 / 项目 / 版本                                         */
/* ------------------------------------------------------------------ */

const MODRINTH_BASE = 'https://api.modrinth.com/v2'
const MODRINTH_UA = { 'User-Agent': 'HungerCatLauncher/0.1 (github: hunger-cat)' }

function searchModrinth(
  query: string,
  limit: number,
  type: ModrinthType,
  category?: string,
  gameVersion?: string,
  loader?: string,
  offset?: number
): Promise<ModrinthSearchResult> {
  const facets: string[][] = [[`project_type:${type}`]]
  if (category && category !== 'all') facets.push([`categories:${category}`])
  if (loader && loader !== 'all') facets.push([`categories:${loader}`])
  if (gameVersion) facets.push([`versions:${gameVersion}`])
  const url = `${MODRINTH_BASE}/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(
    JSON.stringify(facets)
  )}&limit=${limit}&offset=${offset ?? 0}`
  return fetchJson(url, AbortSignal.timeout(10_000)).then((raw) => {
    const data = raw as { hits: ModrinthProject[]; total_hits: number }
    return { hits: data.hits, totalHits: data.total_hits }
  })
}

function fetchModrinthVersions(slug: string, loaders: string[], gameVersions: string[]): Promise<ModrinthVersion[]> {
  const params = new URLSearchParams()
  if (loaders.length > 0) params.set('loaders', JSON.stringify(loaders))
  if (gameVersions.length > 0) params.set('game_versions', JSON.stringify(gameVersions))
  const qs = params.toString()
  const url = `${MODRINTH_BASE}/project/${encodeURIComponent(slug)}/version${qs ? `?${qs}` : ''}`
  return fetchJson(url, AbortSignal.timeout(10_000)) as Promise<ModrinthVersion[]>
}

/* ------------------------------------------------------------------ */
/* server：远程服务端 JSON API（about / agreement / update）            */
/* ------------------------------------------------------------------ */

const SERVER_BASE = 'https://adhc.johnnyblog.top'

function serverApi(path: string): Promise<unknown> {
  return fetchJson(`${SERVER_BASE}/api.php?action=${path}`, AbortSignal.timeout(10_000))
}

/* ------------------------------------------------------------------ */
/* yggdrasil：第三方认证服务器 authenticate / refresh                   */
/* ------------------------------------------------------------------ */

const YGG_TIMEOUT_MS = 10_000

async function yggdrasilFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(YGG_TIMEOUT_MS) })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error('认证服务器连接超时，请检查地址后重试')
    }
    throw new Error(`认证服务器连接失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

interface YggProfile {
  id: string
  name: string
  properties?: Array<{ name: string; value: string; signature?: string }>
}
interface YggAuthResponse {
  accessToken: string
  clientToken: string
  selectedProfile?: YggProfile
  availableProfiles?: YggProfile[]
}

async function yggdrasilError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string; errorMessage?: string; message?: string }
    if (data.error === 'ForbiddenOperationException') return data.errorMessage || '用户名或密码错误'
    if (data.errorMessage) return data.errorMessage
    if (data.message) return data.message
  } catch {
    /* fall through */
  }
  return `认证失败 (HTTP ${res.status})`
}

async function yggdrasilAuthenticate(
  server: string,
  email: string,
  password: string,
  clientToken: string | undefined
): Promise<YggAuthResponse> {
  const base = server.trim().replace(/\/+$/, '')
  const res = await yggdrasilFetch(`${base}/authserver/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent: { name: 'Minecraft', version: 1 },
      username: email,
      password,
      clientToken: clientToken || requireCryptoClientToken(),
      requestUser: false
    })
  })
  if (!res.ok) throw new Error(await yggdrasilError(res))
  return (await res.json()) as YggAuthResponse
}

async function yggdrasilRefresh(
  server: string,
  accessToken: string,
  clientToken: string
): Promise<YggAuthResponse> {
  const base = server.trim().replace(/\/+$/, '')
  const res = await yggdrasilFetch(`${base}/authserver/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken, clientToken, requestUser: false })
  })
  if (!res.ok) throw new Error(await yggdrasilError(res))
  const data = (await res.json()) as YggAuthResponse
  return { ...data, clientToken: data.clientToken ?? clientToken }
}

function requireCryptoClientToken(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomUUID } = require('crypto') as typeof import('crypto')
  return randomUUID().replace(/-/g, '')
}

/* ------------------------------------------------------------------ */
/* 通用小报文 fetch：JSON + .sha1 sidecar + 重定向文件名探测              */
/* ------------------------------------------------------------------ */

interface NetJsonParams {
  url: string
  headers?: Record<string, string>
  timeoutMs?: number
}

/** 请求 JSON（合并 ctx.signal 与 10s 兜底超时；错误抛 HTTP status 文本）。 */
async function netFetchJson(p: NetJsonParams, ctx: NetHandlerCtx): Promise<unknown> {
  const ms = p.timeoutMs ?? 10_000
  const combined = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
  const res = await fetch(p.url, { headers: p.headers ?? {}, signal: combined })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function sanitizeName(n: string): string {
  const clean = n.replace(/[\\/]/g, '_').replace(/^\.+/, '').trim()
  return clean || ''
}

interface DetectFilenameParams {
  url: string
  headers?: Record<string, string>
  timeoutMs?: number
}

/** 从重定向 / Content-Disposition / 路径段探测真实文件名（对照主进程 detectFileNameFromUrl）。 */
async function netDetectFilename(p: DetectFilenameParams): Promise<string | null> {
  const ms = p.timeoutMs ?? 10_000
  for (const method of ['HEAD', 'GET'] as const) {
    const ac = new AbortController()
    try {
      const res = await fetch(p.url, {
        method,
        headers: p.headers ?? {},
        redirect: 'follow',
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(ms)])
      })
      const cd = res.headers.get('content-disposition')
      if (cd) {
        const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd)
        if (m) {
          const name = sanitizeName(decodeURIComponent(m[1].replace(/["']/g, '')))
          if (name) return name
        }
      }
      const finalUrl = res.url || p.url
      const seg = new URL(finalUrl).pathname.split('/').filter(Boolean).pop() ?? ''
      if (seg && !/\/file$/i.test(finalUrl)) {
        const name = sanitizeName(seg)
        if (name) return name
      }
    } catch {
      /* 尝试下一种方法 */
    } finally {
      ac.abort()
    }
  }
  return null
}

interface Sha1Params {
  url: string
  ua?: string
}

/** 抓取 Maven `.sha1` sidecar：成功返回 40 位十六进制小写，失败/不一致返回 undefined。 */
async function netSha1(p: Sha1Params): Promise<string | undefined> {
  try {
    const res = await fetch(`${p.url}.sha1`, {
      headers: { 'User-Agent': p.ua ?? 'HungerCatLauncher/0.1' },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) return undefined
    const text = (await res.text()).trim()
    return /^[0-9a-f]{40}$/i.test(text) ? text.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ */
/* auth：微软 device-code 流（每次 HTTP 的幂等原子调用，主进程保状态机）   */
/* ------------------------------------------------------------------ */

const MS_DEVICE = 'https://login.live.com/oauth20_connect.srf'
const MS_TOKEN = 'https://login.live.com/oauth20_token.srf'
const MS_XBL = 'https://user.auth.xboxlive.com/user/authenticate'
const MS_XSTS = 'https://xsts.auth.xboxlive.com/xsts/authorize'
const MS_MCLOGIN = 'https://api.minecraftservices.com/authentication/login_with_xbox'
const MS_PROFILE = 'https://api.minecraftservices.com/minecraft/profile'

function msCookie(res: Response): string {
  try {
    const setCookies = res.headers.getSetCookie?.() ?? []
    if (setCookies.length) return setCookies.map((v) => v.split(';')[0]).join('; ')
  } catch {
    /* fall through */
  }
  const sc = res.headers.get('set-cookie')
  return sc ? sc.split(',')[0].split(';')[0].trim() : ''
}

async function postFormNet(url: string, body: Record<string, string>, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (cookie) headers['Cookie'] = cookie
  return fetch(url, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(10_000)
  })
}

interface DeviceBeginParams {
  clientId: string
  scope: string
}

/** 发起微软设备码授权，返回 DeviceCodeInfo 所需字段 + 后续轮询必需的 cookie。 */
async function msDeviceBegin(p: DeviceBeginParams): Promise<{
  cookie: string
  userCode: string
  deviceCode: string
  verificationUri: string
  message: string
  expiresIn: number
  interval: number
}> {
  const res = await postFormNet(MS_DEVICE, {
    client_id: p.clientId,
    scope: p.scope,
    response_type: 'device_code'
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error_description?: string }
    throw new Error(`获取登录代码失败：${err.error_description || res.statusText}`)
  }
  const cookie = msCookie(res)
  const data = (await res.json()) as {
    user_code: string
    device_code: string
    verification_uri_complete?: string
    message?: string
    expires_in: number
    interval: number
  }
  return {
    cookie,
    userCode: data.user_code,
    deviceCode: data.device_code,
    verificationUri: data.verification_uri_complete ?? `https://microsoft.com/link?otc=${data.user_code}`,
    message: data.message ?? '',
    expiresIn: data.expires_in,
    interval: data.interval
  }
}

type AuthPollResult =
  | { state: 'success'; accessToken: string; refreshToken: string }
  | { state: 'error'; error: string; description?: string }

interface DevicePollParams {
  clientId: string
  deviceCode: string
  cookie: string
}

/** 单次轮询令牌：成功返回 access/refresh token，授权未就绪/被拒等以 error 态返回（主进程决定分支）。 */
async function msDevicePoll(p: DevicePollParams): Promise<AuthPollResult> {
  const res = await postFormNet(
    `${MS_TOKEN}?client_id=${p.clientId}`,
    {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: p.clientId,
      device_code: p.deviceCode
    },
    p.cookie
  )
  if (res.ok) {
    const data = (await res.json()) as { access_token: string; refresh_token: string }
    return { state: 'success', accessToken: data.access_token, refreshToken: data.refresh_token }
  }
  const err = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string }
  return { state: 'error', error: err.error ?? 'unknown', description: err.error_description }
}

interface RefreshTokenParams {
  clientId: string
  refreshToken: string
}

/** 用 refresh_token 换取新的 access/refresh token。 */
async function msRefreshToken(p: RefreshTokenParams): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await postFormNet(MS_TOKEN, {
    grant_type: 'refresh_token',
    client_id: p.clientId,
    refresh_token: p.refreshToken
  })
  if (!res.ok) throw new Error('刷新令牌失败，请重新登录')
  const data = (await res.json()) as { access_token: string; refresh_token: string }
  // 防止用旋转后空 refresh_token 覆盖有效的旧值（否则下次刷新必然失败）
  return { accessToken: data.access_token, refreshToken: data.refresh_token || p.refreshToken }
}

interface XblNetResponse {
  Token: string
  XErr?: number
  Message?: string
}

interface MsProfileMeta {
  id: string
  name: string
  skins?: Array<{ id: string; state: string; url: string; variant?: 'classic' | 'slim' }>
  capes?: Array<{ id: string; state: string; url: string }>
}

/** XBL → XSTS → Minecraft 登录 → 档案 整条 HTTP 链在网络进程完成，返回组装账号所需数据。 */
async function msChain(msAccessToken: string): Promise<{
  accessToken: string
  expiresIn: number
  profile: MsProfileMeta
}> {
  // XBL
  const xblRes = await fetch(MS_XBL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `t=${msAccessToken}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    })
  })
  if (!xblRes.ok) throw new Error(`Xbox Live 认证失败 (HTTP ${xblRes.status})`)
  const xbl = (await xblRes.json()) as XblNetResponse & { DisplayClaims?: { xui?: Array<{ uhs: string }> } }
  if (!xbl.Token) throw new Error('Xbox Live 未返回令牌')
  const xblToken = xbl.Token
  const uhs = xbl.DisplayClaims?.xui?.[0]?.uhs ?? ''

  // XSTS
  const xstsRes = await fetch(MS_XSTS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    })
  })
  const xsts = (await xstsRes.json().catch(() => ({}))) as XblNetResponse
  if (xsts.XErr) {
    if (xsts.XErr === 2148916233) throw new Error('该微软账号没有 Xbox 档案，请先在 xbox.com 创建')
    if (xsts.XErr === 2148916238) throw new Error('该账号是儿童账号，需要家长授权')
    if (xsts.XErr === 2148916235) throw new Error('Xbox Live 在该地区不可用')
    throw new Error(`XSTS 认证失败 (XErr ${xsts.XErr})`)
  }
  if (!xsts.Token) throw new Error('XSTS 未返回令牌')
  const xstsToken = xsts.Token

  // Minecraft 服务登录
  const mcRes = await fetch(MS_MCLOGIN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xstsToken}` })
  })
  if (!mcRes.ok) throw new Error('Minecraft 服务登录失败')
  const mc = (await mcRes.json()) as { access_token: string; expires_in: number }
  const mcToken = mc.access_token
  const expiresIn = mc.expires_in ?? 86400

  // 档案
  const profRes = await fetch(MS_PROFILE, {
    headers: { Authorization: `Bearer ${mcToken}` },
    signal: AbortSignal.timeout(10_000)
  })
  if (profRes.status === 404) throw new Error('该账号未购买 Minecraft（没有正版资格）')
  if (!profRes.ok) throw new Error(`获取玩家档案失败 (HTTP ${profRes.status})`)
  const profile = (await profRes.json()) as MsProfileMeta

  return { accessToken: mcToken, expiresIn, profile }
}

/* ------------------------------------------------------------------ */
/* 方法分发表                                                          */
/* ------------------------------------------------------------------ */

interface ManifestParams {
  mirror: MirrorKind
}
interface VersionJsonParams {
  id: string
  mirror: MirrorKind
}
interface LoaderParams {
  kind: LoaderKind
  mcVersion: string
  loaderVersion?: string
}
interface ForgeParams {
  kind: ForgeKind
  mcVersion: string
}
interface ModrinthSearchParams {
  query: string
  limit: number
  type: ModrinthType
  category?: string
  gameVersion?: string
  loader?: string
  offset?: number
}
interface ModrinthVersionsParams {
  slug: string
  loaders: string[]
  gameVersions: string[]
}
interface ServerApiParams {
  path: string
}
interface StreamDownloadParams {
  url: string
  dest: string
  sizeHint?: number
  headers?: Record<string, string>
}
interface YggAuthParams {
  server: string
  email?: string
  password?: string
  accessToken?: string
  clientToken?: string
}

const handlers: Record<string, NetHandler> = {
  'versions:manifest': (p: ManifestParams) => fetchVersionManifest(p.mirror),
  'versions:json': (p: VersionJsonParams) => fetchRawVersionJson(p.id, p.mirror),
  'loaders:versions': (p: LoaderParams) => fetchLoaderVersions(p.kind, p.mcVersion),
  'loaders:profile': (p: LoaderParams) => fetchLoaderProfile(p.kind, p.mcVersion, p.loaderVersion ?? ''),
  'forge:versions': (p: ForgeParams) => fetchForgeVersions(p.kind, p.mcVersion),
  'modrinth:search': (p: ModrinthSearchParams) =>
    searchModrinth(p.query, p.limit, p.type, p.category, p.gameVersion, p.loader, p.offset),
  'modrinth:versions': (p: ModrinthVersionsParams) => fetchModrinthVersions(p.slug, p.loaders, p.gameVersions),
  'server:api': (p: ServerApiParams) => serverApi(p.path),
  'yggdrasil:authenticate': (p: YggAuthParams) => yggdrasilAuthenticate(p.server, p.email ?? '', p.password ?? '', p.clientToken),
  'yggdrasil:refresh': (p: YggAuthParams) =>
    yggdrasilRefresh(p.server, p.accessToken ?? '', p.clientToken ?? ''),
  'net:fetchJson': (p: NetJsonParams, ctx: NetHandlerCtx) => netFetchJson(p, ctx),
  'net:detectFilename': (p: DetectFilenameParams) => netDetectFilename(p),
  'download:sha1': (p: Sha1Params) => netSha1(p),
  'auth:deviceBegin': (p: DeviceBeginParams) => msDeviceBegin(p),
  'auth:devicePoll': (p: DevicePollParams) => msDevicePoll(p),
  'auth:chain': (p: { msAccessToken: string }) => msChain(p.msAccessToken),
  'auth:refreshToken': (p: RefreshTokenParams) => msRefreshToken(p),
  'stream:download': async (p: StreamDownloadParams, ctx: NetHandlerCtx) => {
    await streamDownload(p.url, p.dest, {
      signal: ctx.signal,
      sizeHint: p.sizeHint,
      headers: p.headers,
      onBytes: (n) => ctx.emit({ kind: 'bytes', n }),
      onSize: (s) => ctx.emit({ kind: 'size', s })
    })
    return { ok: true }
  }
}

/* ------------------------------------------------------------------ */
/* 通用协议调度（请求/取消/结果/进度），带 id 支持并发与乱序匹配         */
/* ------------------------------------------------------------------ */

const aborts = new Map<number, AbortController>()

function post(msg: NetResponseMessage): void {
  // 通道断开时 parentPort.postMessage 可能抛错，静默忽略（broker 侧按请求超时兜底）。
  try {
    process.parentPort.postMessage(msg)
  } catch {
    /* 忽略 */
  }
}

function handleRequest(req: {
  type: 'request'
  ref: number
  method: string
  params?: unknown
  taskId?: string
}): void {
  log(`收到请求 method=${req.method} ref=${req.ref}`)
  const controller = new AbortController()
  aborts.set(req.ref, controller)
  const ctx: NetHandlerCtx = {
    signal: controller.signal,
    taskId: req.taskId,
    emit: (data) => post({ type: 'progress', ref: req.ref, taskId: req.taskId ?? '', data })
  }
  const handler = handlers[req.method]
  const working = handler
    ? Promise.resolve().then(() => handler(req.params, ctx))
    : Promise.reject(new Error(`未知网络方法: ${req.method}`))
  working
    .then(
      (data) => post({ type: 'result', ref: req.ref, ok: true, data }),
      (err) =>
        post({ type: 'result', ref: req.ref, ok: false, error: err instanceof Error ? err.message : String(err) })
    )
    .finally(() => aborts.delete(req.ref))
}

function onParentMessage(msg: NetRequestMessage): void {
  if (msg.type === 'request') handleRequest(msg)
  else if (msg.type === 'abort') aborts.get(msg.ref)?.abort()
}

// 主进程经 utilityProcess 原生 parentPort 通道下发请求/取消，无需手动转移端口。
process.parentPort.on('message', (event) => {
  onParentMessage(event.data as NetRequestMessage)
})