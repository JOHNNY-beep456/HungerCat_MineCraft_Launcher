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

import { BMCLAPI, OFFICIAL, getVersionListStrategy, manifestUrls } from '../mirror'
import { streamDownload } from './stream-download'
import { nativeStreamDownload } from '../native-downloader'
import { translateTexts, testUapisKey } from './translate'
import type {
  LoaderKind,
  McmodHit,
  ModrinthProject,
  ModrinthProjectDetail,
  ModrinthSearchResult,
  ModrinthType,
  ModrinthVersion,
  VersionJson,
  VersionManifest
} from '@shared/types'
import type { NetErrorPayload, NetHandler, NetHandlerCtx, NetRequestMessage, NetResponseMessage } from '@shared/net-protocol'

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

/**
 * 拉取版本清单：按「版本列表源」策略给出有序候选，逐个尝试。
 *
 * `manifestUrls()` 已按策略排序（镜像优先 / 官方优先 / 自动），这里只需顺序试：
 * 任一来源不可达或返回异常就落到下一个 —— 既满足「加载缓慢时换镜像」，
 * 也满足「镜像缺少刚更新的版本时落回官方」。
 */
async function fetchVersionManifest(): Promise<VersionManifest> {
  const parse = (raw: unknown): VersionManifest => {
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
  }
  const urls = manifestUrls()
  let lastErr: unknown = null
  for (let i = 0; i < urls.length; i++) {
    try {
      // 统一 10s 超时：避免版本清单请求挂起导致启动器卡死。
      const data = parse(await fetchJson(urls[i], AbortSignal.timeout(10_000)))
      // 清单可能为空 / 缺 latest（镜像同步未完成的典型症状）：视为该来源不可用。
      if (!data.latest?.release || data.versions.length === 0) throw new Error('清单内容为空')
      return data
    } catch (err) {
      lastErr = err
      if (i + 1 < urls.length) {
        console.warn(
          `[网络] 版本清单来源不可用，切换下一个：${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('版本清单获取失败')
}

/** 通过指定源的版本清单定位并拉取版本 JSON（清单里的 entry.url 为该源的版本 JSON 地址）。 */
function fetchVersionJsonFromManifest(id: string, manifestUrl: string): Promise<VersionJson> {
  return fetch(manifestUrl, { signal: AbortSignal.timeout(10_000) })
    .then((res) => res.json() as Promise<{ versions: RawManifestVersion[] }>)
    .then((data) => {
      const entry = data.versions.find((v) => v.id === id)
      if (!entry) throw new Error(`未找到版本 ${id}`)
      return fetchJson(entry.url, AbortSignal.timeout(10_000)) as Promise<VersionJson>
    })
}

/**
 * 获取单个原版版本 JSON（不含 inheritsFrom 合并；合并仍由主进程 resolveVersionJson 承担）。
 *
 * 候选按「版本列表源」策略排序：
 *   - 官方项只能经清单定位（`versionJsonCandidates` 里官方传 null 时这里补齐）；
 *   - 镜像项有 `/version/<id>/json` 直连接口，取不到时再退回镜像清单。
 * 任一候选失败即尝试下一个，全部失败才报错。
 */
async function fetchRawVersionJson(id: string): Promise<VersionJson> {
  const strategy = getVersionListStrategy()
  // 官方候选：只有「经清单定位」这一条路，故其 URL 以清单表示；镜像候选可直接取 JSON。
  const ordered: Array<() => Promise<VersionJson>> = []
  if (strategy === 'mirror-first') {
    ordered.push(() => fetchJson(BMCLAPI.versionJson!(id), AbortSignal.timeout(10_000)) as Promise<VersionJson>)
    ordered.push(() => fetchVersionJsonFromManifest(id, BMCLAPI.manifest))
    ordered.push(() => fetchVersionJsonFromManifest(id, OFFICIAL.manifest))
  } else if (strategy === 'official-first') {
    ordered.push(() => fetchVersionJsonFromManifest(id, OFFICIAL.manifest))
  } else {
    ordered.push(() => fetchVersionJsonFromManifest(id, OFFICIAL.manifest))
    ordered.push(() => fetchJson(BMCLAPI.versionJson!(id), AbortSignal.timeout(10_000)) as Promise<VersionJson>)
    ordered.push(() => fetchVersionJsonFromManifest(id, BMCLAPI.manifest))
  }

  let lastErr: unknown = null
  for (let i = 0; i < ordered.length; i++) {
    try {
      return await ordered[i]()
    } catch (err) {
      lastErr = err
      if (i + 1 < ordered.length) {
        console.warn(`[网络] 版本 JSON 来源不可用，切换下一个：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`版本 ${id} 的 JSON 获取失败`)
}

/* ------------------------------------------------------------------ */
/* MC百科（mcmod.cn）：中文名 / 译名来源                                 */
/*                                                                     */
/* 为什么自己抓页面：MC百科没有公开 API，但搜索页 `search.mcmod.cn/s` 是  */
/* 免登录可访问的静态 HTML（实测 200），解析成本低、稳定性可接受。        */
/* 抓到的条目提供：中文名（译名）、原文名（英文名）、条目地址。          */
/* 网络 IO 一律留在网络进程，主进程只做编排。                            */
/* ------------------------------------------------------------------ */

/** 浏览器 UA：MC百科对默认 UA 可能返回不同页面，固定一个桌面 UA 更稳。 */
const MCMOD_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 解码 HTML 实体里我们可能遇到的少量字符。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
}

/**
 * 解析 MC百科搜索结果页。
 *
 * 页面结构（实测）：
 * ```html
 * <div class="result-item">
 *   <div class="head">
 *     <div class="class-category">…</div>
 *     <a target="_blank" href="https://www.mcmod.cn/class/2785.html">钠 (<em>Sodium</em>)</a>
 *   </div>
 *   <div class="body">…</div>
 *   <div class="foot">…</div>
 * </div>
 * ```
 * 中文名在 `<a>` 文本的主干，英文名在其中的 `<em>` 里。
 */
export function parseMcmodSearch(html: string): McmodHit[] {
  const out: McmodHit[] = []
  // 以 result-item 切分，逐条解析；限制条数避免异常页面产生海量结果。
  const items = html.split('<div class="result-item">').slice(1, 41)
  for (const raw of items) {
    const seg = raw.split('<div class="result-item">')[0]
    const m = /href="https:\/\/www\.mcmod\.cn\/(class|modpack)\/(\d+)\.html"[^>]*>([\s\S]*?)<\/a>/.exec(seg)
    if (!m) continue
    const kind = m[1] as 'class' | 'modpack'
    const id = m[2]
    const inner = m[3]
    // 去掉所有标签后的纯文本，形如「钠 · 扩展 ( Sodium Extra )」。
    // 用空串拼接（而非空格）：搜索页会把命中的关键词用标签包起来
    // （实测「机械动力」渲染成 `机械<em>动力</em>`），若用空格替换会得到
    // 「机械 动力」这种被插了空格的错误译名。
    const plain = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    // 中文名 = 括号前的主干；英文名 = 括号内。
    // 注意**不能**只取 <em> 内容：`钠 · 扩展 (<em>Sodium</em> Extra)` 里只有首词被 <em> 包住，
    // 取整个括号内容才能得到完整的 "Sodium Extra"。
    const zh = plain.split(/[（(]/)[0].trim()
    const paren = /[（(]([^）)]*)[）)]\s*$/.exec(plain)
    const en = (paren?.[1] ?? '').trim() || decodeEntities((/<em>([\s\S]*?)<\/em>/.exec(inner)?.[1] ?? '').replace(/<[^>]+>/g, '')).trim()
    if (!zh && !en) continue
    out.push({ id, kind, nameZh: zh || en, nameEn: en || zh, url: `https://www.mcmod.cn/${kind}/${id}.html` })
  }
  return out
}

/** 搜索 MC百科（结果页免登录）。返回空数组表示无结果；网络异常时抛错由调用方兜底。 */
async function mcmodSearch(query: string): Promise<McmodHit[]> {
  const q = query.trim()
  if (!q) return []
  const url = `https://search.mcmod.cn/s?key=${encodeURIComponent(q)}&filter=0`
  const res = await fetch(url, {
    headers: { 'User-Agent': MCMOD_UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(8000),
    redirect: 'follow'
  })
  if (!res.ok) throw new Error(`MC百科搜索失败 (HTTP ${res.status})`)
  return parseMcmodSearch(await res.text())
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

/** 获取单个 Modrinth 项目的完整信息（含 body 完整介绍）。id 可为 slug 或项目 ID。 */
function fetchModrinthProject(id: string): Promise<ModrinthProjectDetail> {
  const url = `${MODRINTH_BASE}/project/${encodeURIComponent(id)}`
  return fetchJson(url, AbortSignal.timeout(10_000)).then((raw) => {
    const d = raw as Record<string, unknown>
    return {
      slug: String(d.slug ?? ''),
      title: String(d.title ?? ''),
      description: String(d.description ?? ''),
      body: typeof d.body === 'string' ? d.body : '',
      icon_url: typeof d.icon_url === 'string' ? d.icon_url : undefined,
      downloads: Number(d.downloads ?? 0),
      categories: Array.isArray(d.categories) ? (d.categories as string[]) : [],
      project_type: String(d.project_type ?? '')
    }
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

/**
 * 服务端写入类接口（JSON body）。服务端以 `{ ok:false, error:"中文原因" }` + 4xx 表达
 * 业务失败，这里把 error 还原成异常抛给上层，避免前端只能看到 HTTP 状态码。
 */
async function serverApiPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${SERVER_BASE}/api.php?action=${path}`, {
    method: 'POST',
    headers: { ...UA, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(10_000)
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error
    throw new Error(msg || `HTTP ${res.status}`)
  }
  return data
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
  /** 部分第三方服务端不返回 clientToken，故为可选。 */
  clientToken?: string
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

/**
 * 读取 Yggdrasil 元数据中的站点名称（`meta.serverName`），用于界面标注第三方账号所属站点。
 * 认证基址本身就是元数据端点（GET {base}），如 LittleSkin 返回「LittleSkin」。
 * 服务端未实现 / 字段缺失时返回 undefined（调用方按域名兜底）。
 */
async function yggdrasilMeta(server: string): Promise<string | undefined> {
  const base = server.trim().replace(/\/+$/, '')
  const res = await yggdrasilFetch(base)
  if (!res.ok) throw new Error(await yggdrasilError(res))
  const data = (await res.json()) as { meta?: { serverName?: unknown } }
  const name = data.meta?.serverName
  return typeof name === 'string' && name.trim() ? name.trim() : undefined
}

/* ------------------------------------------------------------------ */
/* 全局连接预算                                                        */
/*                                                                     */
/* 问题：installVersion / modpack / java / modrinth 等队列各自为政，    */
/* 每个文件又各开 connections 条连接，8 文件 × 64 连接 = 512 并发 TCP，  */
/* 对 CDN 是打爆（触发 429），对本机是端口/内存浪费。                    */
/* 做法：在网络进程（唯一的网络出口）用一个全局信号量统一发放连接预算，   */
/* 所有下载任务共享同一上限，跨队列协调。                               */
/* ------------------------------------------------------------------ */

/** 进程内总连接预算：所有并发下载共享。128 是「够快但不会打爆 CDN」的折中。 */
const GLOBAL_CONNECTION_BUDGET = 128
let budgetUsed = 0
const budgetWaiters: Array<() => void> = []

/** 申请 n 条连接预算，返回实际获批数量（至少 1，避免饿死）。 */
async function acquireConnections(n: number): Promise<number> {
  const want = Math.max(1, Math.floor(n) || 1)
  for (;;) {
    if (budgetUsed >= GLOBAL_CONNECTION_BUDGET) {
      await new Promise<void>((resolve) => budgetWaiters.push(resolve))
      continue
    }
    const granted = Math.min(want, GLOBAL_CONNECTION_BUDGET - budgetUsed)
    budgetUsed += granted
    return granted
  }
}

/** 归还连接预算并唤醒等待者。 */
function releaseConnections(n: number): void {
  budgetUsed = Math.max(0, budgetUsed - n)
  // 唤醒当前所有等待者，让它们重新竞争（简单且不会漏唤醒）。
  const waiters = budgetWaiters.splice(0, budgetWaiters.length)
  for (const w of waiters) w()
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

interface FetchTextParams {
  url: string
  /** 体积上限，超出即中止（默认 256KB）。 */
  maxBytes?: number
  timeoutMs?: number
}

/** 取回外部脚本文本（流式读取并限制体积；10s 兜底超时，防止核对外链时卡死）。 */
async function netFetchText(p: FetchTextParams, ctx: NetHandlerCtx): Promise<string> {
  const ms = Math.min(p.timeoutMs ?? 10_000, 10_000)
  const max = p.maxBytes ?? 256 * 1024
  const combined = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
  const res = await fetch(p.url, { signal: combined, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      throw new Error(`内容体积超过核对上限（${Math.round(max / 1024)}KB）`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf-8')
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
/* 在线翻译（实验性：资源名 / 简介自动翻译）                              */
/*                                                                     */
/* 具体实现在 ./translate.ts：使用免费在线翻译接口（多接口自动回退）。     */
/* 下面仅把它接进本进程的方法分发表。                                     */
/* ------------------------------------------------------------------ */

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

interface VersionJsonParams {
  id: string
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
interface ServerPostParams {
  path: string
  body?: unknown
}
interface StreamDownloadParams {
  url: string
  dest: string
  sizeHint?: number
  headers?: Record<string, string>
  /** 单文件并发连接数（原生内核与 TS 回退共用）。 */
  connections?: number
}
interface YggAuthParams {
  server: string
  email?: string
  password?: string
  accessToken?: string
  clientToken?: string
}

const handlers: Record<string, NetHandler> = {
  'versions:manifest': () => fetchVersionManifest(),
  'versions:json': (p: VersionJsonParams) => fetchRawVersionJson(p.id),
  'loaders:versions': (p: LoaderParams) => fetchLoaderVersions(p.kind, p.mcVersion),
  'loaders:profile': (p: LoaderParams) => fetchLoaderProfile(p.kind, p.mcVersion, p.loaderVersion ?? ''),
  'forge:versions': (p: ForgeParams) => fetchForgeVersions(p.kind, p.mcVersion),
  'modrinth:search': (p: ModrinthSearchParams) =>
    searchModrinth(p.query, p.limit, p.type, p.category, p.gameVersion, p.loader, p.offset),
  'modrinth:versions': (p: ModrinthVersionsParams) => fetchModrinthVersions(p.slug, p.loaders, p.gameVersions),
  'modrinth:project': (p: { id: string }) => fetchModrinthProject(p.id),
  'server:api': (p: ServerApiParams) => serverApi(p.path),
  'server:post': (p: ServerPostParams) => serverApiPost(p.path, p.body),
  'yggdrasil:authenticate': (p: YggAuthParams) => yggdrasilAuthenticate(p.server, p.email ?? '', p.password ?? '', p.clientToken),
  'yggdrasil:refresh': (p: YggAuthParams) =>
    yggdrasilRefresh(p.server, p.accessToken ?? '', p.clientToken ?? ''),
  'yggdrasil:meta': (p: { server: string }) => yggdrasilMeta(p.server),
  'net:fetchJson': (p: NetJsonParams, ctx: NetHandlerCtx) => netFetchJson(p, ctx),
  'net:fetchText': (p: FetchTextParams, ctx: NetHandlerCtx) => netFetchText(p, ctx),
  'net:detectFilename': (p: DetectFilenameParams) => netDetectFilename(p),
  'download:sha1': (p: Sha1Params) => netSha1(p),
  // MC百科：中文名 / 译名来源（免登录抓搜索页）。
  'mcmod:search': (p: { query: string }) => mcmodSearch(p.query),
  'translate:texts': (p: { texts: string[]; target: string; apiKey?: string }) => translateTexts(p),
  'translate:testKey': (p: { apiKey: string }) => testUapisKey(p.apiKey),
  'auth:deviceBegin': (p: DeviceBeginParams) => msDeviceBegin(p),
  'auth:devicePoll': (p: DevicePollParams) => msDevicePoll(p),
  'auth:chain': (p: { msAccessToken: string }) => msChain(p.msAccessToken),
  'auth:refreshToken': (p: RefreshTokenParams) => msRefreshToken(p),
  'stream:download': async (p: StreamDownloadParams, ctx: NetHandlerCtx) => {
    // 进度就地节流：TS 回退路径此前**每个网络 chunk 一次 ctx.emit**，64 连接下把
    // 高频 IPC 反序列化直接打进主进程。这里在唯一的出口处合并到 ~100ms 一次。
    // （原生路径自身已有 120ms 节流，两条路径口径一致，主进程无需再补偿。）
    const PROGRESS_INTERVAL = 100
    let lastEmitAt = 0
    let pendingBytes = 0
    let pendingSize: number | undefined
    const flush = (force: boolean): void => {
      const now = Date.now()
      if (!force && now - lastEmitAt < PROGRESS_INTERVAL) return
      if (pendingSize !== undefined) {
        ctx.emit({ kind: 'size', s: pendingSize })
        pendingSize = undefined
      }
      if (pendingBytes > 0) {
        ctx.emit({ kind: 'bytes', n: pendingBytes })
        pendingBytes = 0
      }
      lastEmitAt = now
    }
    const onBytes = (n: number): void => {
      pendingBytes += n
      flush(false)
    }
    const onSize = (s: number): void => {
      pendingSize = s
      flush(false)
    }

    // 全局连接预算：把本次下载的连接数纳入进程级统一上限，跨队列协调。
    // 小文件本来也只走单连接，这里按请求并发数申请即可；获批数可能小于请求值。
    const granted = await acquireConnections(p.connections ?? 64)
    try {
      // 优先走原生（Rust）下载内核：多连接 + 原生 TLS，比 JS 侧更省 CPU/内存。
      // 返回 null 表示当前平台没有编译好的原生库 —— 这不是错误，自动回退到 TS 实现。
      // 若原生路径抛错（HTTP/网络错误），直接上抛给上层 downloader.ts 走既有镜像回退与重试。
      const native = await nativeStreamDownload(p.url, p.dest, {
        signal: ctx.signal,
        sizeHint: p.sizeHint,
        headers: p.headers,
        connections: granted,
        onBytes,
        onSize
      })

      if (native) {
        flush(true)
        return { ok: true, native: true, bytes: native.bytes, parallel: native.parallel }
      }

      await streamDownload(p.url, p.dest, {
        signal: ctx.signal,
        sizeHint: p.sizeHint,
        headers: p.headers,
        connections: granted,
        onBytes,
        onSize
      })
      flush(true)
      return { ok: true }
    } finally {
      releaseConnections(granted)
    }
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
      (err) => {
        // 结构化错误：code/status/retryAfter 显式跨进程，主进程不再靠正则猜语义。
        const e = err as { status?: number; retryAfter?: string; code?: string }
        post({
          type: 'result',
          ref: req.ref,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: normalizeErrorCode(e),
          status: typeof e.status === 'number' ? e.status : undefined,
          retryAfter: typeof e.retryAfter === 'string' ? e.retryAfter : undefined
        })
      }
    )
    .finally(() => aborts.delete(req.ref))
}

/** 把传输层抛出的错误归一成稳定 code（供 broker/主进程做镜像回退等决策）。 */
function normalizeErrorCode(e: { status?: number; code?: string }): NetErrorPayload['code'] {
  if (e.code === 'cancelled' || e.code === 'timeout' || e.code === 'network' || e.code === 'http') {
    return e.code
  }
  if (typeof e.status === 'number') return 'http'
  return 'unknown'
}

function onParentMessage(msg: NetRequestMessage): void {
  if (msg.type === 'request') handleRequest(msg)
  else if (msg.type === 'abort') aborts.get(msg.ref)?.abort()
}

// 主进程经 utilityProcess 原生 parentPort 通道下发请求/取消，无需手动转移端口。
process.parentPort.on('message', (event) => {
  onParentMessage(event.data as NetRequestMessage)
})