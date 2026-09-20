import type { LauncherSettings } from '@shared/types'

export type MirrorKind = LauncherSettings['mirror']

export interface MirrorConfig {
  kind: MirrorKind
  label: string
  /** Version manifest URL. */
  manifest: string
  /** Version JSON URL for a vanilla version id (BMCLAPI only). */
  versionJson: (id: string) => string
  /** Asset object URL for a full SHA-1 hash. */
  assetUrl: (hash: string) => string
  /** Maven library URL for a path like com/mojang/foo/1.0/foo-1.0.jar. */
  libraryUrl: (path: string) => string
  /** Piston-data object (client jar) URL for a full SHA-1 hash. */
  objectUrl: (hash: string) => string
}

const MOJANG: MirrorConfig = {
  kind: 'mojang',
  label: 'Mojang 官方',
  manifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  versionJson: () => '',
  assetUrl: (hash) => `https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`,
  libraryUrl: (path) => `https://libraries.minecraft.net/${path}`,
  objectUrl: (hash) => `https://piston-data.mojang.com/v1/objects/${hash.slice(0, 2)}/${hash}/client.jar`
}

// BMCLAPI — the primary China-accessible mirror (OpenBMCLAPI distributed nodes).
const BMCLAPI: MirrorConfig = {
  kind: 'bmclapi',
  label: 'BMCLAPI 国内镜像',
  manifest: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
  versionJson: (id) => `https://bmclapi2.bangbang93.com/version/${id}/json`,
  assetUrl: (hash) => `https://bmclapi2.bangbang93.com/assets/${hash}`,
  libraryUrl: (path) => `https://bmclapi2.bangbang93.com/maven/${path}`,
  objectUrl: (hash) => `https://bmclapi2.bangbang93.com/objects/${hash}`
}

export function mirrorConfig(kind: MirrorKind): MirrorConfig {
  switch (kind) {
    case 'bmclapi':
      return BMCLAPI
    default:
      return MOJANG
  }
}

/** Client jar URL for a base vanilla version; null means "use the original URL". */
export function clientJarUrl(baseVersion: string, kind: MirrorKind): string | null {
  if (kind === 'bmclapi') {
    return `https://bmclapi2.bangbang93.com/version/${encodeURIComponent(baseVersion)}/client`
  }
  return null
}

/** Rewrite any Mojang download URL through the selected mirror. */
export function mirrorUrl(url: string, kind: MirrorKind): string {
  if (kind === 'mojang' || !url) return url
  const mc = mirrorConfig(kind)
  if (url.startsWith('https://libraries.minecraft.net/')) {
    return mc.libraryUrl(url.slice('https://libraries.minecraft.net/'.length))
  }
  if (url.startsWith('https://resources.download.minecraft.net/')) {
    const hash = url.split('/').filter(Boolean).pop()
    return hash && /^[0-9a-f]{40}$/.test(hash) ? mc.assetUrl(hash) : url
  }
  if (url.startsWith('https://piston-data.mojang.com/')) {
    const m = url.match(/([0-9a-f]{40})/)
    return m ? mc.objectUrl(m[1]) : url
  }
  return url
}
