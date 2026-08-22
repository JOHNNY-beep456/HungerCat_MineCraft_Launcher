import { promises as fsp } from 'fs'
import { join } from 'path'
import type { ModrinthProject, ModrinthSearchResult, ModrinthType, ModrinthVersion } from '@shared/types'
import { streamDownload } from './stream-download'

/**
 * Modrinth API client. Modrinth provides a keyless REST API;
 * CurseForge requires an API key and is not supported.
 */

const BASE = 'https://api.modrinth.com/v2'
const UA = { 'User-Agent': 'HungerCatLauncher/0.1 (github: hunger-cat)' }

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
  const facets: string[][] = [[`project_type:${type}`]]
  // Modrinth 的搜索接口把「加载器」归入 categories 维度（如 categories:fabric、
  // categories:forge）。`category`（内容分类）与 `loader`（加载器）各自成组，
  // 组间为 AND 关系，因此可同时按「分类 + 加载器」筛选。
  if (category && category !== 'all') facets.push([`categories:${category}`])
  if (loader && loader !== 'all') facets.push([`categories:${loader}`])
  if (gameVersion) facets.push([`versions:${gameVersion}`])
  const url = `${BASE}/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(JSON.stringify(facets))}&limit=${limit}&offset=${offset}`
  const res = await fetch(url, { headers: UA, signal })
  if (!res.ok) throw new Error(`Modrinth 搜索失败 (HTTP ${res.status})`)
  const data = (await res.json()) as { hits: ModrinthProject[]; total_hits: number }
  return { hits: data.hits, totalHits: data.total_hits }
}

/** 根据模组元数据（id / 名称）查找匹配的 Modrinth 项目，未找到或出错返回 null。 */
export async function findProject(modId: string, name: string): Promise<ModrinthProject | null> {
  const query = (name && name.trim()) || (modId && modId.trim())
  if (!query) return null
  try {
    const { hits } = await searchMods(query, 5, 'mod', undefined, undefined, undefined, 0, AbortSignal.timeout(8000))
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

export async function getVersions(
  slug: string,
  loaders: string[],
  gameVersions: string[]
): Promise<ModrinthVersion[]> {
  const params = new URLSearchParams()
  // 空数组表示不筛选，需省略参数（Modrinth 将 [] 视为“无匹配”）
  if (loaders.length > 0) params.set('loaders', JSON.stringify(loaders))
  if (gameVersions.length > 0) params.set('game_versions', JSON.stringify(gameVersions))
  const qs = params.toString()
  const url = `${BASE}/project/${encodeURIComponent(slug)}/version${qs ? `?${qs}` : ''}`
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`获取模组版本失败 (HTTP ${res.status})`)
  return (await res.json()) as ModrinthVersion[]
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
  signal?: AbortSignal
): Promise<string> {
  const runDir = isolated ? join(gameDir, 'versions', versionId) : gameDir
  const targetDir = join(runDir, folderFor(type))
  await fsp.mkdir(targetDir, { recursive: true })

  const safeName = filename.replace(/[\\/:*?"<>|]/g, '_')
  const dest = join(targetDir, safeName)

  let received = 0
  let total = 0
  await streamDownload(fileUrl, dest, {
    signal,
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
  signal?: AbortSignal
): Promise<string> {
  let received = 0
  let total = 0
  await streamDownload(fileUrl, destPath, {
    signal,
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
