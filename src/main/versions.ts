import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { VersionJson, VersionManifest } from '@shared/types'
import { mirrorConfig, mirrorUrl, type MirrorKind } from './mirror'

interface RawManifestVersion {
  id: string
  type: string
  releaseTime: string
  url: string
}

export async function fetchVersionManifest(kind: MirrorKind): Promise<VersionManifest> {
  const url = mirrorConfig(kind).manifest
  const res = await fetch(url, { headers: { 'User-Agent': 'HungerCatLauncher/0.1' } })
  if (!res.ok) throw new Error(`获取版本清单失败 (HTTP ${res.status})`)
  const data = (await res.json()) as { latest: { release: string; snapshot: string }; versions: RawManifestVersion[] }
  return {
    latest: data.latest,
    versions: data.versions
      .filter((v) => v.type !== 'old_alpha' && v.type !== 'old_beta')
      .map((v) => ({ id: v.id, type: v.type as VersionManifest['versions'][number]['type'], releaseTime: v.releaseTime }))
  }
}

async function fetchRawVersionJson(id: string, kind: MirrorKind): Promise<VersionJson> {
  if (kind === 'bmclapi') {
    const res = await fetch(mirrorConfig('bmclapi').versionJson(id), {
      headers: { 'User-Agent': 'HungerCatLauncher/0.1' }
    })
    if (!res.ok) throw new Error(`获取版本 ${id} 信息失败 (HTTP ${res.status})`)
    return (await res.json()) as VersionJson
  }
  const manifest = await fetch(mirrorConfig(kind).manifest)
  const data = (await manifest.json()) as { versions: RawManifestVersion[] }
  const entry = data.versions.find((v) => v.id === id)
  if (!entry) throw new Error(`未找到版本 ${id}`)
  const res = await fetch(entry.url, { headers: { 'User-Agent': 'HungerCatLauncher/0.1' } })
  if (!res.ok) throw new Error(`获取版本 ${id} 信息失败 (HTTP ${res.status})`)
  return (await res.json()) as VersionJson
}

type VersionArg = string | { rules: unknown[]; value: string | string[] }

/**
 * Merge `arguments` for `inheritsFrom`. Loader profiles ship a *partial*
 * `arguments` block relative to their vanilla parent:
 *   - Fabric/Quilt: `jvm` = only the loader flag, `game` = empty array.
 *   - Forge/NeoForge: `jvm` = loader module-path flags (no `-cp`), `game` =
 *     loader flags (no auth args) — they rely on the parent for `-cp
 *     ${classpath}`, natives and auth.
 * The correct semantics are therefore a pure concatenation, parent first:
 *   - jvm  = parent.jvm + child.jvm
 *   - game = parent.game + child.game
 */
function mergeArguments(
  parent?: VersionJson['arguments'],
  child?: VersionJson['arguments']
): VersionJson['arguments'] | undefined {
  if (!parent && !child) return undefined
  if (!child) return parent
  if (!parent) return child
  return {
    jvm: [...(parent.jvm ?? []), ...(child.jvm ?? [])],
    game: [...(parent.game ?? []), ...(child.game ?? [])]
  }
}

/**
 * Detect the stale (broken) `arguments` saved by older builds for loader
 * profiles. Those builds replaced the parent block wholesale, so a loader
 * profile ended up missing the vanilla contributions: `-cp ${classpath}` in
 * the jvm and `--username ${auth_player_name}` in the game args.
 */
function argumentsLookStale(args?: VersionJson['arguments']): boolean {
  if (!args) return true
  const jvm = (args.jvm ?? []) as VersionArg[]
  const game = (args.game ?? []) as VersionArg[]
  const hasClasspath = jvm.some(
    (a) => typeof a === 'string' && (a === '-cp' || a.includes('${classpath}'))
  )
  const hasAuth = game.some(
    (a) => typeof a === 'string' && (a === '--username' || a.includes('${auth_player_name}'))
  )
  return !hasClasspath || !hasAuth
}

/** Merge a child version JSON with its parent (for inheritsFrom). */
function mergeVersions(parent: VersionJson, child: VersionJson): VersionJson {
  return {
    ...parent,
    ...child,
    mainClass: child.mainClass || parent.mainClass,
    assetIndex: child.assetIndex || parent.assetIndex,
    assets: child.assets || parent.assets,
    javaVersion: child.javaVersion || parent.javaVersion,
    downloads: { ...parent.downloads, ...child.downloads },
    libraries: [...(parent.libraries ?? []), ...(child.libraries ?? [])],
    arguments: mergeArguments(parent.arguments, child.arguments),
    minecraftArguments: child.minecraftArguments ?? parent.minecraftArguments,
    logging: child.logging ?? parent.logging,
    id: child.id,
    clientVersion: child.inheritsFrom ?? child.id
  }
}

/**
 * Resolve a version JSON, honoring local disk first (loader profiles written
 * by the Fabric/Quilt/Forge installers) and following `inheritsFrom` chains.
 */
export async function resolveVersionJson(id: string, kind: MirrorKind, gameDir?: string): Promise<VersionJson> {
  // 1. Local disk (loader profiles and previously-installed versions).
  if (gameDir) {
    const localPath = join(gameDir, 'versions', id, `${id}.json`)
    if (existsSync(localPath)) {
      try {
        const local = JSON.parse(readFileSync(localPath, 'utf-8')) as VersionJson
        if (local.inheritsFrom && local.inheritsFrom !== id) {
          const parent = await resolveVersionJson(local.inheritsFrom, kind, gameDir)
          return mergeVersions(parent, local)
        }
        // Resolved loader profile (clientVersion points to the base MC version).
        // Older builds saved stale, unmerged `arguments`; re-derive them from the
        // base version so the launch keeps `-cp ${classpath}` and game args.
        if (local.clientVersion && local.clientVersion !== id && argumentsLookStale(local.arguments)) {
          const base = await resolveVersionJson(local.clientVersion, kind, gameDir)
          local.arguments = mergeArguments(base.arguments, local.arguments)
        }
        return local
      } catch {
        /* fall through to remote fetch */
      }
    }
  }

  // 2. Remote fetch (vanilla versions).
  const json = await fetchRawVersionJson(id, kind)
  if (json.inheritsFrom) {
    const parent = await resolveVersionJson(json.inheritsFrom, kind, gameDir)
    return mergeVersions(parent, json)
  }
  return json
}

/** 创建原版的自定义命名实例：`versions/<customName>/<customName>.json`，继承基础版本。 */
export async function createVanillaInstance(
  gameDir: string,
  baseVersion: string,
  customName: string
): Promise<void> {
  // 默认名与原版一致时无需包装（直接下载原版即可，避免自继承）
  if (customName === baseVersion) return
  const dir = join(gameDir, 'versions', customName)
  if (existsSync(join(dir, `${customName}.json`))) {
    throw new Error(`版本名「${customName}」已存在`)
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${customName}.json`), JSON.stringify({ id: customName, inheritsFrom: baseVersion }, null, 2), 'utf-8')
}
