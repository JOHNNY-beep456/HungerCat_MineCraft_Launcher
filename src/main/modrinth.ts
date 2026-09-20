// 元数据（search / getVersions / findProject / findFabricApi）已迁至网络进程；
// installMod/downloadTo 的下载核心经 streamDownload 走网络进程，此处仅做目标目录编排。
import { promises as fsp } from 'fs'
import { join } from 'path'
import type { ModrinthProject, ModrinthSearchResult, ModrinthType, ModrinthVersion } from '@shared/types'
import { netRequest } from './broker'
import { streamDownload } from './stream-download'

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
