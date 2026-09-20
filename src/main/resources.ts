import { promises as fsp } from 'fs'
import { join } from 'path'
import type { ResourceFile, ResourceKind } from '@shared/types'
import { withLocalTimeout } from './local-timeout'

function resourceDir(gameDir: string, versionId: string, isolated: boolean, kind: ResourceKind): string {
  const runDir = isolated ? join(gameDir, 'versions', versionId) : gameDir
  return join(runDir, kind)
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
        files.push({ name: e.name, size: st.size, path })
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
