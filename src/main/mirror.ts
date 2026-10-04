/**
 * 下载源策略（多源 + 自动回退）。
 *
 * 用户可在「设置 → 下载」里选两类来源策略，与 MCTier 一致：
 *   - `downloadSource`      —— **文件下载源**（libraries / assets / 客户端 jar / 版本 JSON）
 *   - `versionListSource`   —— **版本列表源**（版本清单 / 版本列表）
 * 每个策略三选一：
 *   1. `mirror-first`  尽量使用镜像源（国内最快，但镜像可能缺少刚刚更新的版本）
 *   2. `auto`          优先官方源，加载缓慢时自动换用镜像源（默认）
 *   3. `official-first` 尽量使用官方源
 *
 * 关键设计：所有来源都表示为**有序候选数组**，由下载层逐个尝试。
 * 这样「镜像源不可达 / 404」时能自动落到下一个候选（通常是官方源），
 * 既解决 BMCLAPI 偶发 404，也避免「镜像挂了就整个下载失败」。
 */

/** 来源策略（三选项）。字符串与设置项一一对应，可直接落盘。 */
export type SourceStrategy = 'mirror-first' | 'auto' | 'official-first'

/**
 * 单个来源的端点集合。
 * 注意：不同来源能提供的能力并不相同（例如官方不提供「按 id 直取版本 JSON」）。
 * 用 `capabilities` 显式标注，避免下载层对着官方源拼一个必然 404 的地址。
 */
export interface SourceEndpoints {
  /** 展示名（用于日志）。 */
  label: string
  /** 版本清单 URL。 */
  manifest: string
  /**
   * 单个原版版本 JSON 的直连地址。
   * 官方源不提供该端点（只能先取清单再按 entry.url 定位），故为 null。
   */
  versionJson: ((id: string) => string) | null
  assetUrl: (hash: string) => string
  libraryUrl: (path: string) => string
  objectUrl: (hash: string) => string
}

/** 把 Mojang 官方下载地址改写为镜像地址的**纯函数映射表**。 */
type UrlRewriter = (url: string) => string

export interface Source {
  id: 'official' | 'bmclapi'
  endpoints: SourceEndpoints
  /** 把官方 URL 改写成该来源的 URL；改不了时原样返回（表示该地址无法被此来源镜像）。 */
  rewrite: UrlRewriter
}

const OFFICIAL_PREFIX = {
  libraries: 'https://libraries.minecraft.net/',
  resources: 'https://resources.download.minecraft.net/',
  pistonData: 'https://piston-data.mojang.com/'
} as const

/** Mojang 官方源。 */
export const OFFICIAL: SourceEndpoints = {
  label: '官方源',
  manifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  versionJson: null,
  assetUrl: (hash) => `${OFFICIAL_PREFIX.resources}${hash.slice(0, 2)}/${hash}`,
  libraryUrl: (path) => `${OFFICIAL_PREFIX.libraries}${path}`,
  objectUrl: (hash) => `${OFFICIAL_PREFIX.pistonData}v1/objects/${hash}/client.jar`
}

/** BMCLAPI 国内镜像。 */
export const BMCLAPI: SourceEndpoints = {
  label: 'BMCLAPI 镜像',
  manifest: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
  versionJson: (id) => `https://bmclapi2.bangbang93.com/version/${encodeURIComponent(id)}/json`,
  assetUrl: (hash) => `https://bmclapi2.bangbang93.com/assets/${hash}`,
  libraryUrl: (path) => `https://bmclapi2.bangbang93.com/maven/${path}`,
  objectUrl: (hash) => `https://bmclapi2.bangbang93.com/objects/${hash}`
}

/** 官方 → BMCLAPI 的地址改写（只认已知的三类官方前缀，其余原样返回）。 */
function bmclapiRewrite(url: string): string {
  if (!url) return url
  if (url.startsWith(OFFICIAL_PREFIX.libraries)) {
    return BMCLAPI.libraryUrl(url.slice(OFFICIAL_PREFIX.libraries.length))
  }
  if (url.startsWith(OFFICIAL_PREFIX.resources)) {
    const hash = url.split('/').filter(Boolean).pop()
    return hash && /^[0-9a-f]{40}$/.test(hash) ? BMCLAPI.assetUrl(hash) : url
  }
  if (url.startsWith(OFFICIAL_PREFIX.pistonData)) {
    const m = url.match(/([0-9a-f]{40})/)
    return m ? BMCLAPI.objectUrl(m[1]) : url
  }
  return url
}

/** 来源表。`official` 不做改写（原样返回，等价于「无镜像」）。 */
export const SOURCES: Record<'official' | 'bmclapi', Source> = {
  official: { id: 'official', endpoints: OFFICIAL, rewrite: (u) => u },
  bmclapi: { id: 'bmclapi', endpoints: BMCLAPI, rewrite: bmclapiRewrite }
}

/** 当前生效的来源策略（由设置注入；默认 auto，与历史行为一致）。 */
let downloadSourceStrategy: SourceStrategy = 'auto'
let versionListStrategy: SourceStrategy = 'auto'
let communitySourceStrategy: SourceStrategy = 'auto'

/** 由主进程在读取 / 更新设置时调用，把用户选择同步到下载层。 */
export function setSourceStrategies(opts: {
  download?: SourceStrategy
  versionList?: SourceStrategy
  community?: SourceStrategy
}): void {
  if (opts.download) downloadSourceStrategy = opts.download
  if (opts.versionList) versionListStrategy = opts.versionList
  if (opts.community) communitySourceStrategy = opts.community
}

export function getDownloadStrategy(): SourceStrategy {
  return downloadSourceStrategy
}
export function getVersionListStrategy(): SourceStrategy {
  return versionListStrategy
}
/** 社区资源（模组 / 资源包 / 光影）来源策略。 */
export function getCommunityStrategy(): SourceStrategy {
  return communitySourceStrategy
}

/**
 * 中文译名功能是否可用。
 *
 * 【已暂时撤销】中文译名依赖 MC百科 的搜索页（`search.mcmod.cn/s`），
 * 而该路径被站方 robots.txt 明确禁止抓取；同时 MC百科 并未提供公开 API，
 * CFPA 等替代数据源又受 CC BY-NC-SA（禁商用 + 传染性）约束，均不适合本项目。
 * 因此暂时整体关闭该功能，待取得官方授权后再启用。
 *
 * 置为 true 即可恢复（其余调用点无需改动）。
 */
const CHINESE_NAME_ENABLED = false

/**
 * 是否应查询 MC百科（中文元数据来源）。
 *
 * 「尽量使用官方源」语义上不引入任何第三方来源，因此该策略下不查 MC百科，
 * 也就不会显示中文译名；其余两种策略都会查询（mirror-first 视为优先）。
 */
export function shouldUseMcmod(): boolean {
  if (!CHINESE_NAME_ENABLED) return false
  return communitySourceStrategy !== 'official-first'
}

/**
 * 按策略把「来源」排成候选顺序。
 *
 * - `mirror-first`：镜像优先，官方兜底；
 * - `auto`：官方优先，镜像兜底（加载缓慢 / 缺失时下载层自动换下一个）；
 * - `official-first`：官方优先，**不镜像**（严格只用官方，不自动换镜像）。
 *
 * 为什么 official-first 不带镜像兜底：用户显式选择「尽量使用官方源」时，
 * 不应在他不知情的情况下从镜像取文件（镜像内容与官方可能不同步）。
 */
function orderSources(strategy: SourceStrategy): Source[] {
  switch (strategy) {
    case 'mirror-first':
      return [SOURCES.bmclapi, SOURCES.official]
    case 'official-first':
      return [SOURCES.official]
    case 'auto':
    default:
      return [SOURCES.official, SOURCES.bmclapi]
  }
}

/**
 * 为一个官方下载地址生成**有序候选 URL 列表**（按当前文件下载源策略）。
 *
 * 返回至少一项；去重且保持顺序。无法被镜像改写的地址（如第三方 Maven 仓库）
 * 只会得到原地址一项——这是正确行为，不该硬拼一个必然 404 的镜像地址。
 */
export function candidateUrls(officialUrl: string, strategy: SourceStrategy = downloadSourceStrategy): string[] {
  const out: string[] = []
  for (const s of orderSources(strategy)) {
    const u = s.rewrite(officialUrl)
    if (u && !out.includes(u)) out.push(u)
  }
  return out.length > 0 ? out : [officialUrl]
}

/** 版本清单候选（按版本列表源策略）。 */
export function manifestUrls(strategy: SourceStrategy = versionListStrategy): string[] {
  return orderSources(strategy).map((s) => s.endpoints.manifest)
}

/**
 * 版本 JSON 候选：官方不提供直连端点，因此官方候选必须由调用方用清单里的
 * `entry.url` 提供；镜像则可用 `versionJson(id)` 直取。
 * 返回顺序即尝试顺序，官方项可能为 null（调用方需自行回退到清单定位）。
 */
export function versionJsonCandidates(
  id: string,
  officialUrl: string | null,
  strategy: SourceStrategy = versionListStrategy
): string[] {
  const out: string[] = []
  for (const s of orderSources(strategy)) {
    const u = s.id === 'official' ? officialUrl : s.endpoints.versionJson?.(id) ?? null
    if (u && !out.includes(u)) out.push(u)
  }
  return out
}

/**
 * 兼容旧调用：把官方 URL 改写为「次选（镜像）」地址。
 * 保留它是因为部分历史代码只想要「一个镜像地址」；新代码请用 `candidateUrls`。
 */
export function bmclapiUrl(url: string): string {
  return bmclapiRewrite(url)
}

/** BMCLAPI 的客户端 jar 地址（官方 client.url 失败后的回退）。 */
export function bmclapiClientJarUrl(baseVersion: string): string {
  return `https://bmclapi2.bangbang93.com/version/${encodeURIComponent(baseVersion)}/client`
}

/**
 * 客户端 jar 的有序候选：官方 downloads.client.url 与镜像 client 端点。
 * 与 `candidateUrls` 分开是因为镜像的 client jar 端点并非官方 URL 的改写，
 * 而是 BMCLAPI 特有的 `/version/<id>/client`。
 */
export function clientJarCandidates(
  officialUrl: string,
  baseVersion: string,
  strategy: SourceStrategy = downloadSourceStrategy
): string[] {
  const mirror = bmclapiClientJarUrl(baseVersion)
  const out: string[] = []
  for (const s of orderSources(strategy)) {
    const u = s.id === 'official' ? officialUrl : mirror
    if (u && !out.includes(u)) out.push(u)
  }
  return out
}

/** 反转候选顺序（用于「镜像优先」策略下构造「先镜像后官方」的下载顺序）。 */
export function reverseCandidates(urls: string[]): string[] {
  return [...urls].reverse()
}
