import { promises as fsp } from 'fs'
import { join } from 'path'
import type { ResourceFile, ResourceKind } from '@shared/types'
import { withLocalTimeout } from './local-timeout'

function resourceDir(gameDir: string, versionId: string, isolated: boolean, kind: ResourceKind): string {
  const runDir = isolated ? join(gameDir, 'versions', versionId) : gameDir
  return join(runDir, kind)
}

/** 从 Modrinth / CurseForge 补来的那部分元数据。 */
type ResourceMeta = Pick<ResourceFile, 'displayName' | 'iconUrl' | 'slug' | 'description' | 'source' | 'pageUrl'>

/**
 * path::size → Modrinth 元数据。补过一次就记住：
 * 一来列目录时可以直接带上（刷新不会退回文件名，也不会闪一下再补上），
 * 二来不必每次刷新都重新联网搜一遍（enrichResources 只查没有元数据的项）。
 * key 里带 size 是为了文件被同名替换时不至于套用旧元数据。
 */
const metaCache = new Map<string, ResourceMeta>()

function metaKey(path: string, size: number): string {
  return `${path}::${size}`
}

/** 记下某文件的 Modrinth 元数据（由 enrichResources 在命中后调用）。 */
export function rememberResourceMeta(file: ResourceFile): void {
  metaCache.set(metaKey(file.path, file.size), {
    displayName: file.displayName,
    iconUrl: file.iconUrl,
    slug: file.slug,
    description: file.description,
    source: file.source,
    pageUrl: file.pageUrl
  })
}

export async function listResources(
  gameDir: string,
  versionId: string,
  isolated: boolean,
  kind: ResourceKind
): Promise<ResourceFile[]> {
  const dir = resourceDir(gameDir, versionId, isolated, kind)
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    const files: ResourceFile[] = []
    for (const e of entries) {
      if (!e.isFile()) continue
      if (!/\.(zip|jar|mcpack|mctemplate)$/i.test(e.name) && kind === 'resourcepacks') continue
      if (!/\.(zip|fsb|shader|glsl)$/i.test(e.name) && kind === 'shaderpacks') continue
      const path = join(dir, e.name)
      try {
        const st = await fsp.stat(path)
        const meta = metaCache.get(metaKey(path, st.size))
        files.push(meta ? { name: e.name, size: st.size, path, ...meta } : { name: e.name, size: st.size, path })
      } catch {
        /* ignore unreadable entries */
      }
    }
    return files.sort((a, b) => b.size - a.size)
  } catch {
    return []
  }
}

export async function removeResource(path: string): Promise<void> {
  await withLocalTimeout(fsp.rm(path, { force: true }), `删除资源 ${path}`)
}

export async function openResourceDir(
  gameDir: string,
  versionId: string,
  isolated: boolean,
  kind: ResourceKind
): Promise<string> {
  const dir = resourceDir(gameDir, versionId, isolated, kind)
  await fsp.mkdir(dir, { recursive: true })
  return dir
}
