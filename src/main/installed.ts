import { existsSync, promises as fsp } from 'fs'
import { join } from 'path'
import { gunzipSync } from 'zlib'
import type { InstalledVersion } from '@shared/types'

function runDir(gameDir: string, versionId: string, isolated: boolean): string {
  return isolated ? join(gameDir, 'versions', versionId) : gameDir
}

/** List installed version ids (dirs under versions/ with a matching <id>.json). */
export async function installedVersions(gameDir: string): Promise<string[]> {
  const versionsDir = join(gameDir, 'versions')
  try {
    const entries = await fsp.readdir(versionsDir, { withFileTypes: true })
    const ids: string[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (existsSync(join(versionsDir, e.name, `${e.name}.json`))) ids.push(e.name)
    }
    return ids.sort()
  } catch {
    return []
  }
}

/** List single-player worlds (dirs under saves/ containing a level.dat). */
export async function versionWorlds(gameDir: string, versionId: string, isolated: boolean): Promise<string[]> {
  const savesDir = join(runDir(gameDir, versionId, isolated), 'saves')
  try {
    const entries = await fsp.readdir(savesDir, { withFileTypes: true })
    const worlds: string[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (existsSync(join(savesDir, e.name, 'level.dat'))) worlds.push(e.name)
    }
    return worlds.sort()
  } catch {
    return []
  }
}

/** List servers from servers.dat (NBT, possibly gzip-compressed). */
export async function versionServers(
  gameDir: string,
  versionId: string,
  isolated: boolean
): Promise<Array<{ name: string; address: string }>> {
  const serversDat = join(runDir(gameDir, versionId, isolated), 'servers.dat')
  try {
    const raw = await fsp.readFile(serversDat)
    const data = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw
    return parseServersDat(data)
  } catch {
    return []
  }
}

/**
 * Best-effort recovery of the base Minecraft version from a version id (folder
 * name) when the version JSON carries no explicit `clientVersion`/`inheritsFrom`.
 * Only strips a known loader marker, e.g. "1.20.1-forge-47.4.18" -> "1.20.1",
 * so snapshot ids like "26.3-snapshot-8" are left untouched.
 */
function extractMcVersion(id: string): string {
  const m = id.match(/^(\d+\.\d+(?:\.\d+)?)[-_](?:forge|fabric|quilt|neoforge|optifine)/i)
  return m ? m[1] : id
}

/**
 * Derive the base Minecraft version from loader libraries. This is the most
 * reliable signal and fixes profiles whose `clientVersion` was persisted as the
 * instance/folder id (e.g. "1.20.1-fabric" instead of "1.20.1").
 */
function deriveMcFromLibraries(libraries: Array<{ name?: string }>): string | null {
  for (const lib of libraries) {
    const name = lib.name ?? ''
    // Fabric: net.fabricmc:intermediary:<mc> / net.fabricmc:hashed:<mc>
    let m = name.match(/^net\.fabricmc:(?:intermediary|hashed):([0-9][0-9a-z.+-]*)$/i)
    if (m) return m[1]
    // Quilt: org.quiltmc:hashed:<mc>
    m = name.match(/^org\.quiltmc:hashed:([0-9][0-9a-z.+-]*)$/i)
    if (m) return m[1]
    // Forge/NeoForge: net.minecraftforge:forge:<mc>-<ver>, net.minecraftforge:fmlloader:<mc>-<ver>,
    // net.neoforged:neoforge:<mc>-<ver>
    m = name.match(/^net\.(?:minecraftforge:(?:forge|fmlloader)|neoforged:neoforge):([0-9]+\.[0-9]+(?:\.[0-9]+)?)-/)
    if (m) return m[1]
  }
  return null
}

/** Read version metadata (base MC version + mod loader) for an installed version id. */
async function readVersionMeta(gameDir: string, id: string): Promise<{ mcVersion: string; loader: string | null }> {
  try {
    const p = join(gameDir, 'versions', id, `${id}.json`)
    const json = JSON.parse(await fsp.readFile(p, 'utf-8')) as {
      id?: string
      clientVersion?: string
      inheritsFrom?: string
      mainClass?: string
      libraries?: Array<{ name?: string }>
    }
    const mcVersion =
      deriveMcFromLibraries(json.libraries ?? []) ??
      json.inheritsFrom ??
      json.clientVersion ??
      extractMcVersion(json.id ?? id)
    const loader = detectLoader(json.mainClass ?? '', json.id ?? id, json.libraries ?? [])
    return { mcVersion, loader }
  } catch {
    return { mcVersion: extractMcVersion(id), loader: null }
  }
}

function detectLoader(
  mainClass: string,
  id: string,
  libraries: Array<{ name?: string }> = []
): string | null {
  // Libraries are the most reliable signal — Forge and NeoForge both use
  // `cpw.mods.bootstraplauncher.BootstrapLauncher` as mainClass, so the class
  // name alone cannot tell them apart.
  const libs = libraries.map((l) => l.name ?? '').join(' ')
  if (/net\.neoforged/i.test(libs)) return 'neoforge'
  if (/net\.minecraftforge/i.test(libs)) return 'forge'
  if (/net\.fabricmc/i.test(libs)) return 'fabric'
  if (/org\.quiltmc/i.test(libs)) return 'quilt'
  // mainClass fallback (Fabric/Quilt have distinctive classes).
  if (/fabric/i.test(mainClass)) return 'fabric'
  if (/quilt/i.test(mainClass)) return 'quilt'
  if (/bootstraplauncher|modlauncher/i.test(mainClass)) return 'forge'
  // id fallback (custom-named versions may not carry the loader in mainClass).
  if (/neoforge/i.test(id)) return 'neoforge'
  if (/fabric/i.test(id)) return 'fabric'
  if (/quilt/i.test(id)) return 'quilt'
  if (/forge/i.test(id)) return 'forge'
  return null
}

/** Full installed-version tree for the versions page. */
export async function listInstalled(
  gameDir: string,
  isolated: boolean,
  isolatedVersions: string[] = []
): Promise<InstalledVersion[]> {
  const ids = await installedVersions(gameDir)
  const out: InstalledVersion[] = []
  for (const id of ids) {
    const isIso = isolated || isolatedVersions.includes(id)
    const [worlds, servers, meta] = await Promise.all([
      versionWorlds(gameDir, id, isIso),
      versionServers(gameDir, id, isIso),
      readVersionMeta(gameDir, id)
    ])
    out.push({ id, mcVersion: meta.mcVersion, loader: meta.loader, worlds, servers })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Minimal NBT reader (servers.dat)                                    */
/* ------------------------------------------------------------------ */

class NbtReader {
  private offset = 0
  constructor(private buf: Buffer) {}

  private byte(): number {
    return this.buf.readInt8(this.offset++)
  }
  private ubyte(): number {
    return this.buf.readUInt8(this.offset++)
  }
  private short(): number {
    const v = this.buf.readInt16BE(this.offset)
    this.offset += 2
    return v
  }
  private int(): number {
    const v = this.buf.readInt32BE(this.offset)
    this.offset += 4
    return v
  }
  private long(): bigint {
    const v = this.buf.readBigInt64BE(this.offset)
    this.offset += 8
    return v
  }
  private float(): number {
    const v = this.buf.readFloatBE(this.offset)
    this.offset += 4
    return v
  }
  private double(): number {
    const v = this.buf.readDoubleBE(this.offset)
    this.offset += 8
    return v
  }
  private string(): string {
    const len = this.buf.readUInt16BE(this.offset)
    this.offset += 2
    const s = this.buf.toString('utf8', this.offset, this.offset + len)
    this.offset += len
    return s
  }
  private byteArray(): Buffer {
    const len = this.int()
    const b = this.buf.subarray(this.offset, this.offset + len)
    this.offset += len
    return b
  }
  private payload(type: number): unknown {
    switch (type) {
      case 1:
        return this.byte()
      case 2:
        return this.short()
      case 3:
        return this.int()
      case 4:
        return this.long()
      case 5:
        return this.float()
      case 6:
        return this.double()
      case 7:
        return this.byteArray()
      case 8:
        return this.string()
      case 9:
        return this.list()
      case 10:
        return this.compound()
      case 11: {
        const n = this.int()
        const a: number[] = []
        for (let i = 0; i < n; i++) a.push(this.int())
        return a
      }
      case 12: {
        const n = this.int()
        const a: bigint[] = []
        for (let i = 0; i < n; i++) a.push(this.long())
        return a
      }
      default:
        throw new Error(`未知 NBT 标签 ${type}`)
    }
  }
  private named(): { name: string; value: unknown } | null {
    const type = this.ubyte()
    if (type === 0) return null
    const name = this.string()
    return { name, value: this.payload(type) }
  }
  private list(): unknown[] {
    const elemType = this.ubyte()
    const len = this.int()
    const arr: unknown[] = []
    for (let i = 0; i < len; i++) arr.push(this.payload(elemType))
    return arr
  }
  private compound(): Record<string, unknown> {
    const obj: Record<string, unknown> = {}
    for (;;) {
      const tag = this.named()
      if (!tag) break
      obj[tag.name] = tag.value
    }
    return obj
  }
  readRoot(): Record<string, unknown> {
    this.ubyte() // root type (0x0A compound)
    this.string() // root name (empty)
    return this.compound()
  }
}

function parseServersDat(data: Buffer): Array<{ name: string; address: string }> {
  try {
    const root = new NbtReader(data).readRoot()
    const servers = root['servers']
    if (!Array.isArray(servers)) return []
    return servers
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map((s) => ({ name: String(s['name'] ?? ''), address: String(s['ip'] ?? '') }))
      .filter((s) => s.address.length > 0)
  } catch {
    return []
  }
}
