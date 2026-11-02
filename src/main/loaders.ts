// 元数据获取（meta fetch_maven/fetch_game）已迁至网络进程（loaders:versions / loaders:profile）。
import { promises as fsp } from 'fs'
import { join } from 'path'
import type { LoaderKind, VersionJson } from '@shared/types'
import { netRequest } from './broker'
import { mergeLoaderProfileInPlace } from './versions'

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

/**
 * 把加载器**就地安装到已有实例**（不新建实例）。
 *
 * 与 `installLoader` 的区别：那个会写一份新的版本目录，于是界面上多出一个实例、
 * 存档与资源包要重新积累；这个把 profile 合并进实例自己的版本 JSON，实例 id、
 * 目录、存档、资源包、实例级设置全部保持不变。
 *
 * @param instanceId 目标实例 id（安装后不变）
 */
export async function installLoaderInPlace(
  kind: LoaderKind,
  mcVersion: string,
  loaderVersion: string,
  gameDir: string,
  instanceId: string
): Promise<void> {
  const profile = await netRequest<VersionJson>('loaders:profile', { kind, mcVersion, loaderVersion })
  await mergeLoaderProfileInPlace(gameDir, instanceId, profile)
}
