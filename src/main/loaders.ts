import { promises as fsp } from 'fs'
import { join } from 'path'
import type { LoaderKind, VersionJson } from '@shared/types'

/**
 * Mod loader installation via the official meta APIs. This builds a
 * "loader profile" version JSON (which `inheritsFrom` the vanilla version) and
 * requires running no installer binary — the loader libraries are downloaded
 * like any other library.
 */

const META: Record<
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

export async function loaderVersions(kind: LoaderKind, mcVersion: string): Promise<string[]> {
  const res = await fetch(META[kind].versionsUrl(mcVersion), {
    headers: { 'User-Agent': 'HungerCatLauncher/0.1' }
  })
  if (!res.ok) throw new Error(`获取 ${kind} 加载器版本失败 (HTTP ${res.status})`)
  const data = (await res.json()) as LoaderVersionEntry[]
  return data
    .map((d) => d.loader?.version ?? d.version)
    .filter((v): v is string => typeof v === 'string')
}

/** Install a loader profile for a Minecraft version; returns the new version id. */
export async function installLoader(
  kind: LoaderKind,
  mcVersion: string,
  loaderVersion: string,
  gameDir: string,
  customId?: string
): Promise<string> {
  const res = await fetch(META[kind].profileUrl(mcVersion, loaderVersion), {
    headers: { 'User-Agent': 'HungerCatLauncher/0.1' }
  })
  if (!res.ok) throw new Error(`获取 ${kind} 加载器配置失败 (HTTP ${res.status})`)
  const profile = (await res.json()) as VersionJson

  const id = customId || profile.id || `${kind}-loader-${loaderVersion}-${mcVersion}`
  profile.id = id

  const dir = join(gameDir, 'versions', id)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(join(dir, `${id}.json`), JSON.stringify(profile, null, 2), 'utf-8')
  return id
}
