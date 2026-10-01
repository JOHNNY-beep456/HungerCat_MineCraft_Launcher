// ---------------------------------------------------------------------------
// CurseForge Core API 客户端。
//
// 为什么放在主进程而不是网络进程：
//   * API 需要 `x-api-key`，密钥只应留在主进程，不能随 IPC 载荷跨进程传递；
//   * 批量查询用 POST（POST /v1/mods、POST /v1/mods/files），而网络进程的通用通道
//     是 GET 语义（net:fetchJson），扩协议的成本高于收益。
//   返回的 JSON 都很小，异步 fetch 不会阻塞主进程；真正的大文件下载仍走
//   streamDownload → 网络进程，与原来一致。
//
// 关键实现细节（均已用真实 KEY 实测）：
//   * 官方 `/mods/{id}/files/{fileId}/downloadUrl` 端点对普通第三方 KEY **一律 404**，
//     不可用。下载地址必须从文件对象的 `downloadUrl` 字段取；禁止第三方分发的
//     资源该字段为 null，此时只能在启动器外下载。
//   * 搜索走 GET /mods/search：classId 区分类别、modLoaderType 区分加载器、
//     gameVersion 过滤游戏版本、index/pageSize 分页。
//   * 文件的 `gameVersions` 把游戏版本与加载器混在一起（如 ["1.20.1","Fabric"]），
//     需要拆开分别映射。
// ---------------------------------------------------------------------------

import type {
  ModrinthProject,
  ModrinthProjectDetail,
  ModrinthSearchResult,
  ModrinthType,
  ModrinthVersion
} from '@shared/types'

const CF_BASE = 'https://api.curseforge.com/v1'
/** CurseForge 的 Minecraft gameId。 */
const CF_GAME = 432
const CF_UA = { 'User-Agent': 'HungerCatLauncher/0.5 (github: hunger-cat)' }

/** 本启动器的资源类型 → CurseForge classId。 */
const CLASS_ID: Record<ModrinthType, number> = {
  mod: 6,
  resourcepack: 12,
  shader: 6552,
  modpack: 4471
}

/** 加载器名 → CurseForge modLoaderType。 */
const LOADER_ID: Record<string, number> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 }

/** classId → 游戏目录名（整合包安装时决定文件落点）。 */
export const CLASS_DIR: Record<number, 'mods' | 'resourcepacks' | 'shaderpacks'> = {
  6: 'mods',
  12: 'resourcepacks',
  6552: 'shaderpacks'
}

/**
 * 本启动器（Modrinth 语义）的类别名 → CurseForge 的 categoryId。
 *
 * 两个站点的类别体系并不一一对应：Modrinth 的类别是「主题标签」，CurseForge 是「分类树」，
 * 且**同一套名字在 mod / 资源包 / 光影下对应不同的 id**。因此这里按 classId 分开维护，
 * 并遵循「宁可少筛、不可错筛」：只映射语义明确等价的项，拿不准的映射到最贴近的父类；
 * 没有合适对应的（如 Modrinth 的 library / equipment）就不映射——此时该类别下
 * CurseForge 一侧不额外过滤，而不是硬塞一个会滤掉正确结果的 id。
 *
 * id 全部取自 GET /v1/categories?gameId=432 的真实返回（已核对）。
 */
const CATEGORY_ID: Record<number, Record<string, number>> = {
  // 模组
  6: {
    adventure: 422, // Adventure and RPG
    technology: 412, // Technology
    magic: 419, // Magic
    decoration: 424, // Cosmetic（CurseForge 无「装饰」类，Cosmetic 最贴近）
    optimization: 6814, // Performance
    utility: 5191, // Utility & QoL
    worldgen: 406, // World Gen
    equipment: 434 // Armor, Tools, and Weapons
    // library 无对应（CurseForge 把 API 库混在 Addons/API 里），不筛
  },
  // 资源包
  12: {
    decoration: 405, // Miscellaneous（资源包按分辨率/风格分类，没有主题类）
    adventure: 402, // Medieval
    modern: 401,
    realistic: 400 // Photo Realistic
  },
  // 光影
  6552: {}
}

/** 把本启动器的类别名翻译成 CurseForge 的 categoryId（无对应时返回 undefined）。 */
function categoryIdFor(type: ModrinthType, category?: string): number | undefined {
  if (!category || category === 'all') return undefined
  const table = CATEGORY_ID[CLASS_ID[type]]
  return table?.[category.toLowerCase()]
}

/** 项目页路径段（按 classId）。 */
const CLASS_PATH: Record<number, string> = {
  6: 'mc-mods',
  12: 'texture-packs',
  6552: 'shaders',
  4471: 'modpacks'
}

/* ------------------------------ 原始响应形状 ------------------------------ */

export interface CfFile {
  id: number
  modId: number
  displayName: string
  fileName: string
  fileLength: number
  fileDate: string
  /** 禁止第三方分发时为 null。 */
  downloadUrl: string | null
  gameVersions: string[]
  hashes?: Array<{ value: string; algo: number }>
  isAvailable?: boolean
  releaseType?: number
}

export interface CfMod {
  id: number
  name: string
  slug: string
  summary?: string
  downloadCount?: number
  classId?: number
  logo?: { thumbnailUrl?: string; url?: string }
  /** false = 作者禁止第三方渠道分发，启动器内无法下载。 */
  allowModDistribution?: boolean
  latestFiles?: CfFile[]
  links?: { websiteUrl?: string }
}

/* ------------------------------ 请求核心 ------------------------------ */

/** 把 HTTP 状态映射成能直接展示给用户的中文原因。 */
function describeStatus(status: number): string {
  if (status === 403 || status === 401) return 'CurseForge API KEY 无效、已过期或缺少权限'
  if (status === 404) return 'CurseForge 未找到该资源'
  if (status === 429) return 'CurseForge 接口请求过于频繁，请稍后重试'
  return `CurseForge 接口返回 HTTP ${status}`
}

async function cfFetch(key: string, path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  if (!key) throw new Error('尚未配置 CurseForge API KEY（可在「设置 → 外观 → 资源来源」中填写）')
  const res = await fetch(`${CF_BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      'x-api-key': key,
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...CF_UA
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) throw new Error(describeStatus(res.status))
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/* ------------------------------ 映射 ------------------------------ */

/** 从 CurseForge 的 gameVersions 里挑出 Minecraft 版本号（其余是加载器 / Client / Server）。 */
function mcVersionsOf(gameVersions: string[]): string[] {
  return gameVersions.filter((v) => /^\d/.test(v))
}

/** 从 CurseForge 的 gameVersions 里挑出加载器名，映射回本启动器使用的小写名。 */
function loadersOf(gameVersions: string[]): string[] {
  const out: string[] = []
  for (const v of gameVersions) {
    const s = v.toLowerCase()
    if (s === 'fabric' || s === 'quilt' || s === 'neoforge') out.push(s)
    else if (s.includes('forge')) out.push(s.includes('neo') ? 'neoforge' : 'forge')
  }
  return [...new Set(out)]
}

function iconOf(mod: CfMod): string | undefined {
  return mod.logo?.thumbnailUrl || mod.logo?.url || undefined
}

/** 项目主页地址（启动器里点击「打开项目页」用）。 */
function pageUrlOf(mod: CfMod): string {
  const path = CLASS_PATH[mod.classId ?? 6] ?? 'mc-mods'
  return `https://www.curseforge.com/minecraft/${path}/${mod.slug}`
}

function toProject(mod: CfMod, type: ModrinthType): ModrinthProject {
  return {
    slug: mod.slug || String(mod.id),
    title: mod.name || mod.slug || String(mod.id),
    description: mod.summary ?? '',
    icon_url: iconOf(mod),
    downloads: mod.downloadCount ?? 0,
    categories: [],
    project_type: type,
    source: 'curseforge',
    pageUrl: pageUrlOf({ ...mod, classId: mod.classId ?? CLASS_ID[type] }),
    downloadable: mod.allowModDistribution !== false
  }
}

function toVersion(file: CfFile, mod: CfMod, type: ModrinthType): ModrinthVersion {
  const mc = mcVersionsOf(file.gameVersions ?? [])
  const loaders = loadersOf(file.gameVersions ?? [])
  const url = file.downloadUrl ?? ''
  return {
    id: String(file.id),
    name: file.displayName || file.fileName,
    version_number: file.displayName || file.fileName,
    game_versions: mc,
    loaders,
    downloads: 0,
    date_published: file.fileDate,
    files: url ? [{ url, filename: file.fileName, primary: true, size: file.fileLength }] : [],
    source: 'curseforge',
    downloadable: !!url,
    pageUrl: `${pageUrlOf({ ...mod, classId: mod.classId ?? CLASS_ID[type] })}/files/${file.id}`
  }
}

/* ------------------------------ slug → id ------------------------------ */

const slugIdCache = new Map<string, number>()

/** 把「数字 id 或 slug」统一解析成 CurseForge 的 modId。 */
async function resolveModId(key: string, idOrSlug: string): Promise<number | null> {
  const raw = idOrSlug.trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) return Number(raw)
  const cached = slugIdCache.get(raw.toLowerCase())
  if (cached !== undefined) return cached
  const data = (await cfFetch(
    key,
    `/mods/search?gameId=${CF_GAME}&slug=${encodeURIComponent(raw)}&pageSize=1`
  )) as { data?: CfMod[] } | null
  const id = data?.data?.[0]?.id
  if (typeof id === 'number') {
    slugIdCache.set(raw.toLowerCase(), id)
    return id
  }
  return null
}

/* ------------------------------ 对外接口 ------------------------------ */

/**
 * 搜索资源。
 * @param category 本启动器（Modrinth 语义）的类别名；会按 classId 翻译成 CurseForge 的
 *   categoryId（见 CATEGORY_ID）。没有对应映射的类别不额外过滤——宁可放宽，
 *   也不要用一个不相干的 id 把正确结果滤掉。
 */
export async function cfSearch(
  key: string,
  opts: {
    query: string
    limit: number
    type: ModrinthType
    category?: string
    gameVersion?: string
    loader?: string
    offset?: number
  }
): Promise<ModrinthSearchResult> {
  const params = new URLSearchParams()
  const query = (opts.query ?? '').trim()
  params.set('gameId', String(CF_GAME))
  params.set('classId', String(CLASS_ID[opts.type]))
  if (query) params.set('searchFilter', query)
  // 无关键词时按人气排序，避免默认顺序把冷门项目排前面
  else params.set('sortField', '2')
  if (!query) params.set('sortOrder', 'desc')
  if (opts.gameVersion) params.set('gameVersion', opts.gameVersion)
  const categoryId = categoryIdFor(opts.type, opts.category)
  if (categoryId) params.set('categoryId', String(categoryId))
  // 光影没有加载器分类；模组 / 整合包才传 modLoaderType
  if (opts.loader && opts.loader !== 'all' && opts.type !== 'shader' && opts.type !== 'resourcepack') {
    const id = LOADER_ID[opts.loader.toLowerCase()]
    if (id) params.set('modLoaderType', String(id))
  }
  params.set('index', String(opts.offset ?? 0))
  params.set('pageSize', String(Math.min(50, Math.max(1, opts.limit))))

  const data = (await cfFetch(key, `/mods/search?${params.toString()}`)) as {
    data?: CfMod[]
    pagination?: { totalCount?: number }
  } | null
  const list = data?.data ?? []
  return {
    hits: list.map((m) => toProject(m, opts.type)),
    totalHits: data?.pagination?.totalCount ?? list.length
  }
}

/** 取项目详情（含简介；CurseForge 的完整介绍是 HTML，这里不取正文）。 */
export async function cfProjectDetail(
  key: string,
  idOrSlug: string,
  type: ModrinthType
): Promise<ModrinthProjectDetail> {
  const mod = await cfProject(key, idOrSlug)
  if (!mod) throw new Error('CurseForge 未找到该项目')
  const cls = (mod.classId ?? CLASS_ID[type]) as number
  return {
    slug: mod.slug || String(mod.id),
    title: mod.name,
    description: mod.summary ?? '',
    body: '',
    icon_url: iconOf(mod),
    downloads: mod.downloadCount ?? 0,
    categories: [],
    project_type: type,
    source: 'curseforge',
    pageUrl: `https://www.curseforge.com/minecraft/${CLASS_PATH[cls] ?? 'mc-mods'}/${mod.slug}`
  }
}

/** 取原始项目对象（整合包安装等需要 id / classId 的场景）。 */
export async function cfProject(key: string, idOrSlug: string): Promise<CfMod | null> {
  const id = await resolveModId(key, idOrSlug)
  if (!id) return null
  const data = (await cfFetch(key, `/mods/${id}`)) as { data?: CfMod } | null
  return data?.data ?? null
}

/** 取项目的文件列表（按加载器 + 游戏版本过滤，最新在前）。 */
export async function cfVersions(
  key: string,
  idOrSlug: string,
  loaders: string[],
  gameVersions: string[],
  type: ModrinthType
): Promise<ModrinthVersion[]> {
  const mod = await cfProject(key, idOrSlug)
  if (!mod) return []
  const params = new URLSearchParams()
  if (gameVersions.length > 0) params.set('gameVersion', gameVersions[0])
  const loaderId = loaders.map((l) => LOADER_ID[l.toLowerCase()]).find((x) => x !== undefined)
  if (loaderId && type !== 'shader' && type !== 'resourcepack') params.set('modLoaderType', String(loaderId))
  params.set('pageSize', '50')
  const qs = params.toString()
  const data = (await cfFetch(key, `/mods/${mod.id}/files${qs ? `?${qs}` : ''}`)) as { data?: CfFile[] } | null
  const files = data?.data ?? []
  return files.filter((f) => f.isAvailable !== false).map((f) => toVersion(f, mod, type))
}

/** 批量取文件信息（整合包安装：一次拿齐 fileName / 下载地址 / 体积 / SHA-1）。 */
export async function cfFilesByIds(key: string, fileIds: number[]): Promise<CfFile[]> {
  if (fileIds.length === 0) return []
  const out: CfFile[] = []
  // 官方限制单次最多 1000 个 id，这里按 200 一批，稳妥且不会让单次请求过大
  for (let i = 0; i < fileIds.length; i += 200) {
    const batch = fileIds.slice(i, i + 200)
    const data = (await cfFetch(key, '/mods/files', { method: 'POST', body: { fileIds: batch } })) as {
      data?: CfFile[]
    } | null
    out.push(...(data?.data ?? []))
  }
  return out
}

/** 批量取项目的 classId（整合包安装：决定每个文件落到 mods/ 还是 resourcepacks/ 等）。 */
export async function cfClassIds(key: string, projectIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>()
  const uniq = [...new Set(projectIds)].filter((n) => n > 0)
  for (let i = 0; i < uniq.length; i += 200) {
    const batch = uniq.slice(i, i + 200)
    const data = (await cfFetch(key, '/mods', { method: 'POST', body: { modIds: batch } })) as {
      data?: CfMod[]
    } | null
    for (const m of data?.data ?? []) {
      if (typeof m.classId === 'number') map.set(m.id, m.classId)
    }
  }
  return map
}

/** 取单个文件（整合包安装的兜底路径）。 */
export async function cfFileById(key: string, projectId: number, fileId: number): Promise<CfFile | null> {
  const data = (await cfFetch(key, `/mods/${projectId}/files/${fileId}`)) as { data?: CfFile } | null
  return data?.data ?? null
}
