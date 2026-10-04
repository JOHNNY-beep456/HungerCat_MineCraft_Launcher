// 元数据（search / getVersions / findProject / findFabricApi）已迁至网络进程；
// installMod/downloadTo 的下载核心经 streamDownload 走网络进程，此处仅做目标目录编排。
import { promises as fsp } from 'fs'
import { join } from 'path'
import type { ModrinthProject, ModrinthProjectDetail, ModrinthSearchResult, ModrinthType, ModrinthVersion } from '@shared/types'
import { netRequest } from './broker'
import { settings } from './store'
import { streamDownload } from './stream-download'
import { effectiveConcurrency } from './network-profile'

/**
 * Modrinth API client. Modrinth provides a keyless REST API;
 * CurseForge requires an API key and is not supported.
 */

export async function searchMods(
  query: string,
  limit = 24,
  type: ModrinthType = 'mod',
  category?: string,
  gameVersion?: string,
  loader?: string,
  offset = 0,
  signal?: AbortSignal
): Promise<ModrinthSearchResult> {
  return netRequest<ModrinthSearchResult>(
    'modrinth:search',
    { query, limit, type, category, gameVersion, loader, offset },
    { signal }
  )
}

/** 获取单个 Modrinth 项目的完整信息（含 body 完整介绍），用于「完整介绍」弹窗。 */
export async function fetchProject(id: string, signal?: AbortSignal): Promise<ModrinthProjectDetail> {
  return netRequest<ModrinthProjectDetail>('modrinth:project', { id }, { signal })
}

/**
 * 根据项目元数据（id / 名称）查找匹配的 Modrinth 项目，未找到或出错返回 null。
 * type 把搜索限制在某一类项目上：已安装的光影 / 资源包没有可读的内嵌元数据，
 * 只能拿文件名当名称来搜（见 manage.ts 的 enrichResources），靠它避免搜到模组。
 */
export async function findProject(
  modId: string,
  name: string,
  type: ModrinthType = 'mod'
): Promise<ModrinthProject | null> {
  const query = (name && name.trim()) || (modId && modId.trim())
  if (!query) return null
  try {
    const { hits } = await searchMods(query, 5, type, undefined, undefined, undefined, 0, AbortSignal.timeout(8000))
    if (hits.length === 0) return null
    const q = query.toLowerCase()
    const id = modId.trim().toLowerCase()
    return (
      hits.find((h) => h.slug.toLowerCase() === id || h.slug.toLowerCase() === q || h.title.toLowerCase() === q) ?? hits[0]
    )
  } catch {
    return null
  }
}

/** 归一化：只留字母数字，用于判断「同名」。 */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** 拆词：丢掉一切标点。 */
function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/**
 * 查询词里有多少个能在项目标题 / slug 里找到。
 *
 * 一两个字母的碎片只认完全相等：拆词会把 "Rob's Vanilla Reshaded" 拆出 's'，
 * 若允许前缀匹配，'stay'.startsWith('s') 就成立，于是搜 'stay' 会选中
 * "Rob's Vanilla Reshaded"。三个字母以上才放开互为前缀，用来容忍
 * Sildurs / Sildur's 这类写法差异。
 */
function coverage(project: ModrinthProject, queryTokens: string[]): number {
  const target = [...words(project.title), ...words(project.slug)]
  return queryTokens.filter((q) =>
    target.some((t) => {
      if (t === q) return true
      if (q.length < 3 || t.length < 3) return false
      return t.startsWith(q) || q.startsWith(t)
    })
  ).length
}

/**
 * 按名称在指定类型里找最匹配的项目（用于识别已安装的光影 / 资源包）。
 *
 * Modrinth 的搜索很精确：文件名里多一个版本号或括号备注就会 0 命中（实测
 * "Bliss" 有 1 条，而 "Bliss v2.1.2 (Chocapic13 Shaders edit)" 是 0 条），
 * 所以这里从完整名称开始、逐次丢掉结尾一个词再试。
 *
 * 但搜索又是「全文本」的：只在简介里出现过关键词的项目也会命中（实测搜
 * "fresh" 的第一条是 "Spring Shaders"，搜 "stay" 的第一条是 "Vanilla Plus
 * Shader"），放宽到单词后直接取第一条就会给光影挂上毫不相干的名字。所以
 * 只有标题 / slug 里真的含有查询词的才要，一个都没有就继续放宽。
 *
 * 命中多条时按下载量取最高的，避免选中衍生项目（搜 "Stay True" 的第一条是
 * 下载量最高的衍生包 "Stay True x Better Ores 3D"，而官方项目若在结果里会
 * 被上面的精确匹配提前挑走）。
 */
export async function findProjectByName(name: string, type: ModrinthType): Promise<ModrinthProject | null> {
  const tokens = words(name)
  if (tokens.length === 0) return null
  for (let take = tokens.length; take >= 1; take--) {
    const levelTokens = tokens.slice(0, take)
    const query = levelTokens.join(' ')
    let hits: ModrinthProject[]
    try {
      ;({ hits } = await searchMods(query, 10, type, undefined, undefined, undefined, 0, AbortSignal.timeout(8000)))
    } catch {
      return null
    }
    if (hits.length === 0) continue
    const exact = hits.find((h) => squash(h.title) === squash(query) || squash(h.slug) === squash(query))
    if (exact) return exact
    const qualified = hits.filter((h) => coverage(h, levelTokens) === levelTokens.length)
    if (qualified.length === 0) continue
    return qualified.sort((a, b) => b.downloads - a.downloads)[0]
  }
  return null
}

export async function getVersions(
  slug: string,
  loaders: string[],
  gameVersions: string[]
): Promise<ModrinthVersion[]> {
  return netRequest<ModrinthVersion[]>('modrinth:versions', { slug, loaders, gameVersions })
}

/** 查找适配指定 Minecraft 版本的 Fabric API 模组（按最新优先），未找到返回 null。 */
export async function findFabricApi(mcVersion: string): Promise<ModrinthVersion | null> {
  try {
    const versions = await getVersions('fabric-api', ['fabric'], [mcVersion])
    return versions.find((v) => v.files.some((f) => f.primary) || v.files.length > 0) ?? versions[0] ?? null
  } catch {
    return null
  }
}

function folderFor(type: ModrinthType): 'mods' | 'resourcepacks' | 'shaderpacks' {
  if (type === 'shader') return 'shaderpacks'
  if (type === 'resourcepack') return 'resourcepacks'
  return 'mods'
}

/** Download a Modrinth file into the target directory for its type. */
export async function installMod(
  fileUrl: string,
  filename: string,
  gameDir: string,
  versionId: string,
  isolated: boolean,
  type: ModrinthType = 'mod',
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal,
  /** 已知文件大小：可跳过下载前的 HEAD 探测（CurseForge 这类重定向 CDN 上能省约 1s/文件）。 */
  sizeHint?: number
): Promise<string> {
  const runDir = isolated ? join(gameDir, 'versions', versionId) : gameDir
  const targetDir = join(runDir, folderFor(type))
  await fsp.mkdir(targetDir, { recursive: true })

  const safeName = filename.replace(/[\\/:*?"<>|]/g, '_')
  const dest = join(targetDir, safeName)

  let received = 0
  let total = sizeHint && sizeHint > 0 ? sizeHint : 0
  await streamDownload(fileUrl, dest, {
    signal,
    sizeHint,
    // 按加速档位换算连接数：无线网络下自动收敛，避免拥塞拖慢。
    connections: effectiveConcurrency(
      settings.get().downloadAcceleration,
      settings.get().downloadConnections,
      settings.get().maxDownloadConcurrency
    ).connections,
    onBytes: (n) => {
      received += n
      onProgress?.(received, total)
    },
    onSize: (s) => {
      total = s
      onProgress?.(received, total)
    }
  })
  return dest
}

/** 将 Modrinth 文件下载到任意指定路径（用于「下载到任意位置」）。 */
export async function downloadTo(
  fileUrl: string,
  destPath: string,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal,
  sizeHint?: number
): Promise<string> {
  let received = 0
  let total = sizeHint && sizeHint > 0 ? sizeHint : 0
  await streamDownload(fileUrl, destPath, {
    signal,
    sizeHint,
    // 按加速档位换算连接数：无线网络下自动收敛，避免拥塞拖慢。
    connections: effectiveConcurrency(
      settings.get().downloadAcceleration,
      settings.get().downloadConnections,
      settings.get().maxDownloadConcurrency
    ).connections,
    onBytes: (n) => {
      received += n
      onProgress?.(received, total)
    },
    onSize: (s) => {
      total = s
      onProgress?.(received, total)
    }
  })
  return destPath
}

/**
 * 游戏内离线翻译模组（MCAutoTranslationTool）的固定下载地址与文件名。
 *
 * 与 Fabric API 不同，该模组不在 Modrinth 上，站长要求从固定直链下载，
 * 因此这里硬编码地址；文件名由 URL 末段推导，便于后续版本号替换。
 */
export const OFFLINE_TRANSLATE_URL =
  'https://test13121314.cn-nb2.rains3.com/MCAutoTranslationTool-1.3.11-fabric-all.jar'

/** 从下载地址推导文件名（取路径末段，去掉查询串）。 */
function filenameFromUrl(url: string): string {
  const noQuery = url.split('?')[0]
  const seg = noQuery.split('/').pop() || ''
  return seg || 'MCAutoTranslationTool.jar'
}

/**
 * 安装游戏内离线翻译模组到指定实例的 mods 目录。
 *
 * 复用 installMod 的目录编排与下载逻辑（与 Fabric API 落入同一 mods 目录）；
 * 该模组依赖 Fabric + Fabric API，调用方需自行保证前置条件。
 */
export async function installOfflineTranslate(
  gameDir: string,
  versionId: string,
  isolated: boolean,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal
): Promise<string> {
  return installMod(
    OFFLINE_TRANSLATE_URL,
    filenameFromUrl(OFFLINE_TRANSLATE_URL),
    gameDir,
    versionId,
    isolated,
    'mod',
    onProgress,
    signal
  )
}
