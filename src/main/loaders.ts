// 元数据获取（meta fetch_maven/fetch_game）已迁至网络进程（loaders:versions / loaders:profile）。
import { promises as fsp } from 'fs'
import { join } from 'path'
import type { LoaderKind, VersionJson } from '@shared/types'
import { netRequest } from './broker'

/**
 * Mod loader installation via the official meta APIs. This builds a
 * "loader profile" version JSON (which `inheritsFrom` the vanilla version) and
 * requires running no installer binary — the loader libraries are downloaded
 * like any other library.
 */

export async function loaderVersions(kind: LoaderKind, mcVersion: string): Promise<string[]> {
  return netRequest<string[]>('loaders:versions', { kind, mcVersion })
}

/** Install a loader profile for a Minecraft version; returns the new version id. */
export async function installLoader(
  kind: LoaderKind,
  mcVersion: string,
  loaderVersion: string,
  gameDir: string,
  customId?: string
): Promise<string> {
  // 远程 profile JSON 由网络进程获取；本地落盘仍由本模块编排。
  const profile = await netRequest<VersionJson>('loaders:profile', { kind, mcVersion, loaderVersion })

  const id = customId || profile.id || `${kind}-loader-${loaderVersion}-${mcVersion}`
  profile.id = id

  const dir = join(gameDir, 'versions', id)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(join(dir, `${id}.json`), JSON.stringify(profile, null, 2), 'utf-8')
  return id
}
