import { existsSync, promises as fsp } from 'fs'
import { join } from 'path'
import { gunzipSync, gzipSync } from 'zlib'
import type { InstalledVersion } from '@shared/types'
import { nativeScanDirs } from './native-downloader'

function runDir(gameDir: string, versionId: string, isolated: boolean): string {
  return isolated ? join(gameDir, 'versions', versionId) : gameDir
}

/**
 * 并行度上限。目录扫描是 IO 密集型，条目可能很多（几十个版本 × 若干存档）：
 * 全串行会让「切换版本目录」明显卡顿；并发开太大反而更慢 —— Node 的 fs 操作跑在
 * 默认只有 4 个线程的 libuv 线程池上，超额并发只会排队。实测 8 是稳定的折中点。
 */
const IO_CONCURRENCY = 8

/** 以受控并发映射处理列表（保持输入顺序）。 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * 从目录条目名里筛出「目标文件确实存在」的那些（保持顺序）。
 *
 * 这里刻意保留同步的 existsSync：单次判断只是一个微秒级的系统调用，几十个加起来也不足 1ms；
 * 换成异步 fsp.access 反而更慢 —— 每个调用都要经 libuv 线程池（默认仅 4 线程）派发与回传，
 * 开销远大于 syscall 本身，扫描量大时会互相排队。
 *
 * 真正会造成「未响应」的是解析几百 KB 的 version JSON（见 readVersionMeta），那部分已改为
 * 按 mtime 缓存 + 并发处理。
 */
function keepExisting(names: string[], pathOf: (name: string) => string): string[] {
  return names.filter((n) => existsSync(pathOf(n)))
}

/** List installed version ids (dirs under versions/ with a matching <id>.json). */
export async function installedVersions(gameDir: string): Promise<string[]> {
  const versionsDir = join(gameDir, 'versions')
  // 优先走原生扫描（并行检查 `<目录名>.json`，见 native-downloader.ts / scan.rs）。
  // 返回 null 表示原生不可用或缺失该能力 —— 此时回退到下面的 TS 实现。
  // 目录不存在时原生返回空数组（与 TS catch → [] 一致）。排序留在 TS，保证顺序不变。
  const scanned = await nativeScanDirs(versionsDir, '{name}.json')
  if (scanned) return scanned.sort()
  let entries
  try {
    entries = await fsp.readdir(versionsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const names = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  return keepExisting(names, (n) => join(versionsDir, n, `${n}.json`)).sort()
}

/** List single-player worlds (dirs under saves/ containing a level.dat). */
export async function versionWorlds(gameDir: string, versionId: string, isolated: boolean): Promise<string[]> {
  const savesDir = join(runDir(gameDir, versionId, isolated), 'saves')
  // 原生优先（并行检查 `level.dat`）；null 回退 TS。排序留在 TS 保证顺序不变。
  const scanned = await nativeScanDirs(savesDir, 'level.dat')
  if (scanned) return scanned.sort()
  let entries
  try {
    entries = await fsp.readdir(savesDir, { withFileTypes: true })
  } catch {
    return []
  }
  const names = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  return keepExisting(names, (n) => join(savesDir, n, 'level.dat')).sort()
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
    return parseServersDat(data).map((s) => ({ name: s.name, address: s.ip }))
  } catch {
    return []
  }
}

/**
 * 向某个实例的 servers.dat 追加一条服务器（名称 + 地址）。
 *
 * 文件不存在时按空列表创建；已有内容（含 icon / hidden / acceptTextures）原样保留，
 * 只追加新条目。名称留空时用地址兜底，方便在游戏里辨认。写回 gzip 压缩格式
 * （与原版 NbtIo.writeCompressed 一致，读取端两种都认）。返回更新后的完整列表。
 */
export async function addVersionServer(
  gameDir: string,
  versionId: string,
  isolated: boolean,
  name: string,
  address: string
): Promise<Array<{ name: string; address: string }>> {
  const dir = runDir(gameDir, versionId, isolated)
  const serversDat = join(dir, 'servers.dat')
  let entries: ServerEntry[] = []
  try {
    const raw = await fsp.readFile(serversDat)
    const data = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw
    entries = parseServersDat(data)
  } catch {
    entries = []
  }
  const ip = address.trim()
  const trimmedName = name.trim()
  entries.push({ name: trimmedName || ip, ip })
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(serversDat, writeServersDat(entries))
  return entries.map((s) => ({ name: s.name, address: s.ip }))
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

/**
 * 版本元数据缓存：key = 版本 JSON 的绝对路径。
 *
 * 模组包的 version JSON 动辄几百 KB，而解析它只为了拿 mcVersion / loader —— 这两个值在文件
 * 没变时也不会变。首次扫描后按「mtime + size」判定是否失效，重复扫描（切目录、刷新、启动游戏）
 * 就只剩一次 stat，不必再读几 MB 的 JSON 重新解析。
 */
interface MetaCacheEntry {
  mtimeMs: number
  size: number
  meta: { mcVersion: string; loader: string | null }
}

const META_CACHE_MAX = 512
const metaCache = new Map<string, MetaCacheEntry>()

function rememberMeta(path: string, mtimeMs: number, size: number, meta: MetaCacheEntry['meta']): void {
  metaCache.delete(path)
  metaCache.set(path, { mtimeMs, size, meta })
  // 简单上限：超了就丢最早写入的那些（用户不会同时拥有几百个版本）。
  while (metaCache.size > META_CACHE_MAX) {
    const oldest = metaCache.keys().next().value
    if (oldest === undefined) break
    metaCache.delete(oldest)
  }
}

/** Read version metadata (base MC version + mod loader) for an installed version id. */
async function readVersionMeta(gameDir: string, id: string): Promise<{ mcVersion: string; loader: string | null }> {
  const p = join(gameDir, 'versions', id, `${id}.json`)
  try {
    const st = await fsp.stat(p)
    const hit = metaCache.get(p)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.meta
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
    const meta = { mcVersion, loader }
    rememberMeta(p, st.mtimeMs, st.size, meta)
    return meta
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

/**
 * Full installed-version tree for the versions page.
 *
 * 每个版本要读「存档列表 + 服务器列表 + 版本元数据」，原先是一条 for + await 串行跑完，
 * 几十个版本就是几百次串行 IO —— 这正是「切换版本目录很卡」的直接原因。改成受控并发后，
 * 耗时基本只取决于最慢的那一个版本。
 */
export async function listInstalled(
  gameDir: string,
  isolated: boolean,
  isolatedVersions: string[] = []
): Promise<InstalledVersion[]> {
  const ids = await installedVersions(gameDir)
  const isolatedSet = new Set(isolatedVersions)
  return mapLimit(ids, IO_CONCURRENCY, async (id) => {
    const isIso = isolated || isolatedSet.has(id)
    const [worlds, servers, meta] = await Promise.all([
      versionWorlds(gameDir, id, isIso),
      versionServers(gameDir, id, isIso),
      readVersionMeta(gameDir, id)
    ])
    return { id, mcVersion: meta.mcVersion, loader: meta.loader, worlds, servers }
  })
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

/** servers.dat 里的单条服务器记录（保留 icon / hidden / acceptTextures，写回时不丢字段）。 */
interface ServerEntry {
  name: string
  ip: string
  icon?: string
  hidden?: boolean
  acceptTextures?: boolean
}

function parseServersDat(data: Buffer): ServerEntry[] {
  try {
    const root = new NbtReader(data).readRoot()
    const servers = root['servers']
    if (!Array.isArray(servers)) return []
    return servers
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map((s) => {
        const entry: ServerEntry = { name: String(s['name'] ?? ''), ip: String(s['ip'] ?? '') }
        if (typeof s['icon'] === 'string' && s['icon']) entry.icon = s['icon']
        if (s['hidden'] !== undefined) entry.hidden = Number(s['hidden']) !== 0
        if (s['acceptTextures'] !== undefined) entry.acceptTextures = Number(s['acceptTextures']) !== 0
        return entry
      })
      .filter((s) => s.ip.length > 0)
  } catch {
    return []
  }
}

/**
 * 写 servers.dat（NBT）。结构固定：根 Compound "" 下挂 List<Compound> "servers"，
 * 每条含 name / ip（String）以及可选的 icon（String）/ hidden / acceptTextures（Byte）。
 * 输出 gzip 压缩——与原版 NbtIo.writeCompressed 一致，读取端（含本文件的解析）两种都认。
 */
function writeServersDat(servers: ServerEntry[]): Buffer {
  const parts: Buffer[] = []
  const u8 = (v: number): void => void parts.push(Buffer.from([v & 0xff]))
  const i16 = (v: number): void => {
    const b = Buffer.alloc(2)
    b.writeInt16BE(v & 0xffff)
    parts.push(b)
  }
  const i32 = (v: number): void => {
    const b = Buffer.alloc(4)
    b.writeInt32BE(v | 0)
    parts.push(b)
  }
  const str = (s: string): void => {
    const b = Buffer.from(s, 'utf8')
    i16(b.length)
    parts.push(b)
  }
  /** 写入「标签类型 + 名称」头部，payload 紧随其后 */
  const tag = (type: number, name: string): void => {
    u8(type)
    str(name)
  }

  tag(10, '') // 根：TAG_Compound ""
  tag(9, 'servers') // TAG_List
  u8(10) // 列表元素类型：TAG_Compound
  i32(servers.length)
  for (const s of servers) {
    tag(8, 'name')
    str(s.name)
    tag(8, 'ip')
    str(s.ip)
    if (s.icon !== undefined) {
      tag(8, 'icon')
      str(s.icon)
    }
    if (s.hidden !== undefined) {
      tag(1, 'hidden')
      u8(s.hidden ? 1 : 0)
    }
    if (s.acceptTextures !== undefined) {
      tag(1, 'acceptTextures')
      u8(s.acceptTextures ? 1 : 0)
    }
    u8(0) // TAG_End：结束该服务器 Compound
  }
  u8(0) // TAG_End：结束根 Compound
  return gzipSync(Buffer.concat(parts))
}
