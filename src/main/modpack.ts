// TODO(网络进程迁移): modpack.ts 的下载部分（downloadModpack / importModpackFromUrl 的远程拉取）
// 待迁入网络进程，进度经 progress 事件回传并保住 phase:'done'。本模块暂保留主进程路径，不退化。
import { createHash } from 'crypto'
import { createReadStream, existsSync, promises as fsp } from 'fs'
import { tmpdir } from 'os'
import { join, dirname, basename } from 'path'
import type {
  DownloadProgress,
  ExportItem,
  ForgeKind,
  LoaderKind,
  ModpackExportInventory,
  ModpackExportOptions,
  ModpackFormat,
  ModpackProbe
} from '@shared/types'
import type { MirrorKind } from './mirror'
import { streamDownload } from './stream-download'
import { netRequest } from './broker'
import { resolveVersionJson, createVanillaInstance } from './versions'
import { installVersion } from './downloader'
import { loaderVersions, installLoader } from './loaders'
import { forgeVersions, installForge } from './forge'
import { pickInstallerJava, requiredJavaForMc } from './java'
import { settings } from './store'
import { extractArchive, listArchive, readArchiveText, zipDirectory } from './archive'

/* ------------------------------------------------------------------ */
/* 整合包归档读写（内嵌 zip / tar 解析，见 archive.ts）                  */
/* ------------------------------------------------------------------ */

function findEntry(entries: string[], name: string): string | null {
  for (const e of entries) {
    const parts = e.split('/').filter(Boolean)
    if (parts[parts.length - 1] === name) return e
  }
  return null
}

async function readJsonEntry(archive: string, entry: string): Promise<unknown> {
  const raw = await readArchiveText(archive, entry)
  return JSON.parse(raw.replace(/^\uFEFF/, ''))
}

/* ------------------------------------------------------------------ */
/* 格式检测与解析                                                       */
/* ------------------------------------------------------------------ */

async function detectFormat(archive: string): Promise<ModpackFormat | null> {
  const entries = await listArchive(archive)
  if (findEntry(entries, 'modrinth.index.json')) return 'modrinth'
  if (findEntry(entries, 'mcbbs.packmeta')) return 'mcbbs'
  if (findEntry(entries, 'launcher.packmeta')) return 'native'
  const manifestEntry = findEntry(entries, 'manifest.json')
  if (manifestEntry) {
    try {
      const manifest = (await readJsonEntry(archive, manifestEntry)) as Record<string, unknown>
      // MCBBS（addons）或 CurseForge（minecraft）风格均按 MCBBS 解析
      if (manifest && (manifest['addons'] !== undefined || manifest['mcbbs'] !== undefined || manifest['minecraft'] !== undefined)) {
        return 'mcbbs'
      }
    } catch {
      /* not json */
    }
  }
  return null
}

function normalizeLoader(l: string | null | undefined): string | null {
  if (!l) return null
  const s = String(l).toLowerCase()
  if (s.includes('fabric')) return 'fabric'
  if (s.includes('quilt')) return 'quilt'
  if (s.includes('neoforge') || s.includes('neo-forge')) return 'neoforge'
  if (s.includes('forge')) return 'forge'
  return null
}

/* ------------------------------------------------------------------ */
/* 下载完整性校验与 CurseFile 文件名探测（对照 HMCL）                    */
/* ------------------------------------------------------------------ */

const BROWSER_UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
}

/** 计算文件的摘要（十六进制小写），用于下载后完整性校验。 */
function hashFile(path: string, algo: 'sha1' | 'sha512'): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algo)
    const stream = createReadStream(path)
    stream.on('data', (d) => hash.update(d))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * 校验单个已下载文件（思路参考 PCL2 的 FileChecker，独立实现）：
 * 先比对文件大小（可识别被截断 / 未写完的文件），再比对摘要（SHA-512 优先，其次 SHA-1）。
 * 清单未提供任何可校验信息时直接通过（例如 CurseFile 探测不到哈希与大小）。
 * 任一不符即抛错，由调用方删除后重下。
 */
async function verifyPackFile(path: string, f: PackFile): Promise<void> {
  if (f.size && f.size > 0) {
    const st = await fsp.stat(path)
    if (st.size !== f.size) {
      throw new Error(`文件大小不一致（期望 ${f.size} 字节，实际 ${st.size} 字节）`)
    }
  }
  if (f.sha512) {
    const actual = await hashFile(path, 'sha512')
    if (actual.toLowerCase() !== f.sha512.toLowerCase()) {
      throw new Error(`SHA-512 校验失败（期望 ${f.sha512}，实际 ${actual}）`)
    }
    return
  }
  if (f.sha1) {
    const actual = await hashFile(path, 'sha1')
    if (actual.toLowerCase() !== f.sha1.toLowerCase()) {
      throw new Error(`SHA-1 校验失败（期望 ${f.sha1}，实际 ${actual}）`)
    }
  }
}

/** 模组文件后缀（含禁用态）；清单路径与落盘校验共用同一判定。 */
const MOD_FILE_RE = /\.jar(\.disabled)?$/i

/** 归一化清单中的相对路径（去首尾分隔符），用于判定落点是否属于 mods/。 */
function normRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '')
}

/**
 * 安装后模组完整性校验（思路参考 PCL2 的安装后自检，独立实现）：
 * 逐个确认清单声明的模组文件确实落盘，返回缺失的相对路径列表（空数组表示全部就绪）。
 */
function findMissingMods(runDir: string, expectedMods: Set<string>): string[] {
  const missing: string[] = []
  for (const rel of expectedMods) {
    if (!existsSync(join(runDir, ...rel.split('/')))) missing.push(rel)
  }
  return missing
}

/** 网络执行由网络进程承担（net:fetchJson，合并取消信号与 10s 超时）。 */
function fetchJson(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return netRequest<Record<string, unknown>>('net:fetchJson', { url, headers: BROWSER_UA }, { signal })
}

/** 清理探测到的文件名，防止路径穿越。 */
function sanitizeFileName(n: string): string {
  const clean = n.replace(/[\\/]/g, '_').replace(/^\.+/, '').trim()
  return clean || ''
}

/** 从下载链接的重定向 / Content-Disposition 中探测文件名（HMCL 的 detectFileName，网络执行在网络进程）。 */
async function detectFileNameFromUrl(url: string): Promise<string | null> {
  try {
    return await netRequest<string | null>('net:detectFilename', { url, headers: BROWSER_UA })
  } catch {
    return null
  }
}

/**
 * 探测 CurseForge 文件的真实元数据（文件名、下载地址、SHA-1、大小），顺序：
 *   1) cursemeta（fileNameOnDisk / downloadURL / sha1 / fileLength）；
 *   2) forgesvc v2（fileName / downloadURL / hashes / fileLength）；
 *   3) 下载链接重定向 / Content-Disposition 兜底探测文件名（无哈希 / 大小）。
 * 前两级能一次拿到大小与哈希，供下载后完整性校验；全部失败返回 null。
 * 注：CurseForge 另有批量 POST /v1/mods/files 接口，但本启动器网络层仅支持 GET，
 * 故逐文件 GET 元数据（在并发工作池内并行执行）。
 */
async function resolveCurseFile(
  projectID: number,
  fileID: number,
  fallbackUrl: string,
  signal?: AbortSignal
): Promise<{ fileName: string; url: string; sha1?: string; size?: number } | null> {
  try {
    const m = await fetchJson(`https://cursemeta.dries007.net/${projectID}/${fileID}.json`, signal)
    const name = String(m['fileNameOnDisk'] ?? m['fileName'] ?? '')
    const url = String(m['downloadURL'] ?? '')
    if (name) return { fileName: sanitizeFileName(name), url: url || fallbackUrl, ...pickCurseMeta(m) }
  } catch {
    /* cursemeta 不可用，继续 */
  }

  try {
    const m = await fetchJson(`https://addons-ecs.forgesvc.net/api/v2/addon/${projectID}/file/${fileID}`, signal)
    const name = String(m['fileName'] ?? '')
    const url = String(m['downloadURL'] ?? '')
    if (name) return { fileName: sanitizeFileName(name), url: url || fallbackUrl, ...pickCurseMeta(m) }
  } catch {
    /* forgesvc 不可用，继续 */
  }

  const fromUrl = await detectFileNameFromUrl(fallbackUrl)
  if (fromUrl) return { fileName: fromUrl, url: fallbackUrl }

  return null
}

/** 从 CurseForge 系接口响应中提取 SHA-1 与文件大小（cursemeta 顶层字段 / forgesvc hashes[algo=1]）。 */
function pickCurseMeta(m: Record<string, unknown>): { sha1?: string; size?: number } {
  const out: { sha1?: string; size?: number } = {}
  const direct = m['sha1']
  if (typeof direct === 'string' && /^[0-9a-f]{40}$/i.test(direct.trim())) out.sha1 = direct.trim().toLowerCase()
  const hashes = m['hashes']
  if (!out.sha1 && Array.isArray(hashes)) {
    for (const h of hashes) {
      if (!h || typeof h !== 'object') continue
      const rec = h as Record<string, unknown>
      const algo = rec['algo']
      const value = rec['value']
      // CurseForge AddonFile.hashes：algo 1 = SHA-1，algo 2 = MD5
      if ((algo === 1 || algo === '1' || String(algo).toLowerCase() === 'sha1') && typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value.trim())) {
        out.sha1 = value.trim().toLowerCase()
        break
      }
    }
  }
  const len = Number(m['fileLength'] ?? m['size'] ?? 0)
  if (Number.isFinite(len) && len > 0) out.size = len
  return out
}

interface PackFile {
  path: string
  url: string
  /** MCBBS AddonFile：下载失败不中断导入（overrides 兜底）。 */
  optional?: boolean
  /** 附加请求头（例如 CurseForge 需要浏览器 UA）。 */
  headers?: Record<string, string>
  /** 期望的 SHA-1 摘要（Modrinth hashes.sha1 / MCBBS AddonFile hash / CurseForge），下载后校验。 */
  sha1?: string
  /** 期望的 SHA-512 摘要（Modrinth hashes.sha512），下载后校验。 */
  sha512?: string
  /** 期望的文件字节数（Modrinth fileSize / CurseForge fileLength），下载后校验，可识别被截断的文件。 */
  size?: number
  /** 备用下载地址（Modrinth downloads 数组），主地址失败时顺序回退。 */
  mirrors?: string[]
  /** CurseFile 缺 fileName 时，下载阶段据此探测真实文件名。 */
  curseFile?: { projectID: number; fileID: number }
}

interface ParsedPack {
  name: string
  mcVersion: string
  loader: string | null
  loaderVersion: string
  summary: string
  files: PackFile[]
}

async function parseModrinth(archive: string): Promise<ParsedPack> {
  const entries = await listArchive(archive)
  const idxEntry = findEntry(entries, 'modrinth.index.json')
  if (!idxEntry) throw new Error('modrinth.index.json 不存在')
  const index = (await readJsonEntry(archive, idxEntry)) as {
    name?: string
    versionId?: string
    summary?: string
    dependencies?: Record<string, unknown>
    files?: Array<{
      path?: string
      downloads?: string[]
      hashes?: { sha1?: string; sha512?: string }
      fileSize?: number
      env?: { client?: string; server?: string }
    }>
  }
  const deps: Record<string, unknown> = index.dependencies ?? {}
  let loader: string | null = null
  let loaderVersion = ''
  if (deps['fabric-loader']) {
    loader = 'fabric'
    loaderVersion = String(deps['fabric-loader'])
  } else if (deps['quilt-loader']) {
    loader = 'quilt'
    loaderVersion = String(deps['quilt-loader'])
  } else if (deps['forge']) {
    loader = 'forge'
    loaderVersion = String(deps['forge'])
  } else if (deps['neoforge'] || deps['neo-forge']) {
    loader = 'neoforge'
    loaderVersion = String(deps['neoforge'] ?? deps['neo-forge'])
  }
  // Modrinth 每个文件可声明 env.client：unsupported 表示该文件仅供服务端、
  // 不应安装到客户端（对照 PCL2 的处理），直接跳过，避免污染客户端模组目录。
  const files: PackFile[] = (index.files ?? [])
    .filter((f) => String(f.env?.client ?? '').toLowerCase() !== 'unsupported')
    .map((f) => {
      const mirrors = (Array.isArray(f.downloads) ? f.downloads : []).filter((u): u is string => typeof u === 'string' && u.length > 0)
      const sha1 = typeof f.hashes?.sha1 === 'string' ? f.hashes.sha1.trim().toLowerCase() : ''
      const sha512 = typeof f.hashes?.sha512 === 'string' ? f.hashes.sha512.trim().toLowerCase() : ''
      const file: PackFile = { path: f.path ?? '', url: mirrors[0] ?? '' }
      if (mirrors.length > 1) file.mirrors = mirrors
      if (sha1) file.sha1 = sha1
      if (sha512) file.sha512 = sha512
      if (typeof f.fileSize === 'number' && Number.isFinite(f.fileSize) && f.fileSize > 0) file.size = f.fileSize
      return file
    })
    .filter((f) => f.path)
  return {
    name: index.name ?? '',
    // MC 版本来自 dependencies.minecraft；versionId 是整合包自身的版本标识，不是 MC 版本。
    mcVersion: deps['minecraft'] === undefined ? '' : String(deps['minecraft']),
    loader,
    loaderVersion,
    summary: index.summary ?? '',
    files
  }
}

/** 从 manifest 中尽可能可靠地提取 MC 版本、加载器与加载器版本。 */
function extractMcbbsMeta(manifest: Record<string, unknown>): { mcVersion: string; loader: string | null; loaderVersion: string } {
  const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v))

  let mcVersion = ''
  let loader: string | null = null
  let loaderVersion = ''

  const addons = manifest['addons']
  if (Array.isArray(addons)) {
    for (const a of addons) {
      if (!a || typeof a !== 'object') continue
      const id = str((a as Record<string, unknown>)['id']).toLowerCase()
      const ver = str((a as Record<string, unknown>)['version'])
      if (id === 'game' || id === 'minecraft') {
        if (!mcVersion) mcVersion = ver
      } else if (id === 'fabric') {
        loader = 'fabric'
        loaderVersion = ver
      } else if (id === 'quilt') {
        loader = 'quilt'
        loaderVersion = ver
      } else if (id === 'neoforge') {
        loader = 'neoforge'
        loaderVersion = ver
      } else if (id === 'forge') {
        loader = 'forge'
        loaderVersion = ver
      }
    }
  } else if (addons && typeof addons === 'object') {
    // addons 也可能是 map 形式：{ game: "1.20.1", forge: "47.2.0" }
    const map = addons as Record<string, unknown>
    mcVersion = str(map['game'] ?? map['minecraft'])
    if (map['fabric']) {
      loader = 'fabric'
      loaderVersion = str(map['fabric'])
    } else if (map['quilt']) {
      loader = 'quilt'
      loaderVersion = str(map['quilt'])
    } else if (map['neoforge']) {
      loader = 'neoforge'
      loaderVersion = str(map['neoforge'])
    } else if (map['forge']) {
      loader = 'forge'
      loaderVersion = str(map['forge'])
    }
  }

  // CurseForge 风格：minecraft.version + minecraft.modLoaders
  const mcObj = manifest['minecraft']
  if (!mcVersion) {
    if (typeof mcObj === 'string') {
      mcVersion = mcObj
    } else if (mcObj && typeof mcObj === 'object') {
      mcVersion = str((mcObj as Record<string, unknown>)['version'] ?? (mcObj as Record<string, unknown>)['id'])
    }
  }
  if (!loader) {
    const modLoaders = (mcObj && typeof mcObj === 'object' ? (mcObj as Record<string, unknown>)['modLoaders'] : undefined) as Array<Record<string, unknown>> | undefined
    if (Array.isArray(modLoaders)) {
      for (const ml of modLoaders) {
        const id = str(ml?.['id']).toLowerCase()
        const m = id.match(/^(forge|neoforge|fabric|quilt)-?(.+)$/)
        if (m) {
          loader = m[1]
          loaderVersion = m[2] || ''
          break
        }
      }
    }
  }

  // 其它常见字段回退（versionId 是 Modrinth 概念，不用于 MCBBS/CurseForge，避免误读整合包版本号）
  if (!mcVersion) {
    for (const k of ['gameVersion', 'mcVersion', 'minecraftVersion', 'game_version', 'mc_version']) {
      const v = manifest[k]
      if (typeof v === 'string' && v.trim() && /^\d+\.\d+/.test(v.trim())) {
        mcVersion = v.trim()
        break
      }
    }
  }
  if (!loader) {
    loader = normalizeLoader(str(manifest['mod_loader'] ?? manifest['loader']))
    loaderVersion = str(manifest['mod_loader_version'] ?? manifest['loader_version'])
  }

  return { mcVersion, loader, loaderVersion }
}

async function parseMcbbs(archive: string): Promise<ParsedPack> {
  const entries = await listArchive(archive)
  let manifest: Record<string, unknown> | null = null
  const packmeta = findEntry(entries, 'mcbbs.packmeta')
  if (packmeta) {
    manifest = (await readJsonEntry(archive, packmeta)) as Record<string, unknown>
  } else {
    const m = findEntry(entries, 'manifest.json')
    if (m) manifest = (await readJsonEntry(archive, m)) as Record<string, unknown>
  }
  if (!manifest) throw new Error('MCBBS 整合包缺少 manifest')
  const g = (k: string): string => {
    const v = (manifest as Record<string, unknown>)[k]
    return v === undefined || v === null ? '' : String(v)
  }

  const meta = extractMcbbsMeta(manifest)

  // files 参照 HMCL McbbsModpackManifest.File（用 "type" 区分两种子类型）：
  //   AddonFile {type:"addon", path, hash}  → 从 fileApi + /overrides/ + path 下载（缺 fileApi 时依赖 overrides 目录内的文件）
  //   CurseFile {type:"curse", projectID, fileID, fileName, url} → 从 url（缺省时用 CurseForge 下载链接）下载到 mods/<fileName>
  // 未标注 type 的条目按 AddonFile 处理，兼容旧版清单。
  const fileApi = g('fileApi').replace(/\/+$/, '')
  const normRel = (p: string): string => p.replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '')
  // CurseForge 页面直链需要浏览器跳转，脚本直连会返回 404；改用其 API 下载端点（302 到真实 CDN，
  // fetch 自动跟随重定向）。download-with-ip 同时规避文件名带 IP 后缀的文件。
  const curseUrl = (projectID: number, fileID: number): string =>
    `https://www.curseforge.com/api/v1/mods/${projectID}/files/${fileID}/download-with-ip`
  const files: PackFile[] = []
  for (const raw of (manifest['files'] as Array<Record<string, unknown>> | undefined) ?? []) {
    if (!raw || typeof raw !== 'object') continue
    const type = String(raw['type'] ?? '').toLowerCase()
    if (type === 'curse') {
      const projectID = Number(raw['projectID'] ?? raw['projectId'] ?? 0)
      const fileID = Number(raw['fileID'] ?? raw['fileId'] ?? 0)
      let url = String(raw['url'] ?? '')
      if (!url && projectID && fileID) url = curseUrl(projectID, fileID)
      if (!url) continue
      const fileName = normRel(String(raw['fileName'] ?? ''))
      // 无论 fileName 是否已知都记录 curseFile：下载阶段据此探测 SHA-1 与文件大小，
      // 从而对 CurseForge 文件也能做下载后完整性校验（fileName 已知时仅补全校验信息）。
      const dest = fileName ? (fileName.startsWith('mods/') ? fileName : `mods/${fileName}`) : `mods/${projectID}-${fileID}.jar`
      const file: PackFile = { path: dest, url, headers: BROWSER_UA }
      if (projectID && fileID) file.curseFile = { projectID, fileID }
      files.push(file)
    } else {
      // AddonFile 或未标注类型：path + 可选 hash / url / downloads；fileApi 存在时优先构造下载地址
      const path = normRel(String(raw['path'] ?? ''))
      if (!path) continue
      let url = String(raw['url'] ?? (Array.isArray(raw['downloads']) ? (raw['downloads'] as string[])[0] ?? '' : ''))
      if (!url && fileApi) url = `${fileApi}/overrides/${path}`
      const hash = String(raw['hash'] ?? '').trim()
      if (url) files.push({ path, url, optional: true, ...(hash ? { sha1: hash.toLowerCase() } : {}) })
    }
  }

  return {
    name: g('name') || g('title'),
    mcVersion: meta.mcVersion,
    loader: meta.loader,
    loaderVersion: meta.loaderVersion,
    summary: g('description') || g('summary'),
    files
  }
}

/** 解析启动器自带格式（launcher.packmeta + overrides，无外部下载文件）。 */
async function parseNative(archive: string): Promise<ParsedPack> {
  const entries = await listArchive(archive)
  const entry = findEntry(entries, 'launcher.packmeta')
  if (!entry) throw new Error('launcher.packmeta 不存在')
  const manifest = (await readJsonEntry(archive, entry)) as Record<string, unknown>
  const g = (k: string): string => {
    const v = manifest[k]
    return v === undefined || v === null ? '' : String(v)
  }
  const meta = extractMcbbsMeta(manifest)
  return {
    name: g('name') || g('title'),
    mcVersion: meta.mcVersion || g('game_version'),
    loader: meta.loader,
    loaderVersion: meta.loaderVersion || g('mod_loader_version'),
    summary: g('description') || g('summary'),
    files: []
  }
}

function parseArchive(format: ModpackFormat, archive: string): Promise<ParsedPack> {
  if (format === 'modrinth') return parseModrinth(archive)
  if (format === 'native') return parseNative(archive)
  return parseMcbbs(archive)
}

export async function probeModpack(archive: string): Promise<ModpackProbe> {
  const format = await detectFormat(archive)
  if (!format) throw new Error('无法识别的整合包格式（仅支持 Modrinth、MCBBS/BBSMC 与启动器自带格式）')
  const p = await parseArchive(format, archive)
  return {
    format,
    name: p.name || basename(archive).replace(/\.(mrpack|zip)$/i, ''),
    mcVersion: p.mcVersion,
    loader: p.loader,
    loaderVersion: p.loaderVersion,
    summary: p.summary
  }
}

/* ------------------------------------------------------------------ */
/* 实例安装（复用现有原版/加载器安装流程）                              */
/* ------------------------------------------------------------------ */

async function downloadInstance(
  id: string,
  gameDir: string,
  kind: MirrorKind,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const s = settings.get()
  const json = await resolveVersionJson(id, kind, gameDir)
  await installVersion(json, gameDir, kind, s.maxDownloadConcurrency, (p) => {
    onProgress({ ...p, taskId: 'modpack' })
  }, signal)
}

async function installInstance(
  mcVersion: string,
  loader: string | null,
  loaderVersion: string,
  gameDir: string,
  instanceName: string,
  kind: MirrorKind,
  onProgress: (p: DownloadProgress) => void,
  onLog: (l: string) => void,
  signal?: AbortSignal
): Promise<void> {
  // 实例名不能等于 Minecraft 版本号：否则会触发自继承 / 与基础版本目录冲突，
  // 尤其整合包被命名为版本号（如 26.2）时会被静默合并进原版，导致「看似未安装」。
  if (instanceName === mcVersion) {
    throw new Error(`实例名不能与 Minecraft 版本号相同（${mcVersion}），请重新设置实例名`)
  }

  if (!loader) {
    await createVanillaInstance(gameDir, mcVersion, instanceName)
    await downloadInstance(instanceName, gameDir, kind, onProgress, signal)
    return
  }

  if (loader === 'fabric' || loader === 'quilt') {
    await downloadInstance(mcVersion, gameDir, kind, onProgress, signal)
    const id = await installLoader(loader as LoaderKind, mcVersion, loaderVersion, gameDir, instanceName)
    await downloadInstance(id, gameDir, kind, onProgress, signal)
    return
  }

  if (loader === 'forge' || loader === 'neoforge') {
    await downloadInstance(mcVersion, gameDir, kind, onProgress, signal)
    const s = settings.get()
    const java = await pickInstallerJava(gameDir, s.javaPath, requiredJavaForMc(mcVersion))
    if (!java) throw new Error('未找到 Java，无法安装 Forge/NeoForge 加载器')
    const id = await installForge(loader as ForgeKind, mcVersion, loaderVersion, gameDir, java.path, onLog, instanceName, onProgress, signal)
    await downloadInstance(id, gameDir, kind, onProgress, signal)
    return
  }

  throw new Error(`不支持的加载器：${loader}`)
}

async function resolveLoaderVersion(kind: LoaderKind | ForgeKind, mc: string, requested: string): Promise<string> {
  const versions = kind === 'forge' || kind === 'neoforge'
    ? await forgeVersions(kind, mc)
    : await loaderVersions(kind, mc)
  if (versions.length === 0) throw new Error(`没有可用的 ${kind} 版本（MC ${mc}）`)
  if (requested && requested !== '*' && versions.includes(requested)) return requested
  const prefix = requested.replace(/[^\d.]/g, '').split('.').filter(Boolean).slice(0, 2).join('.')
  if (prefix) {
    const m = versions.find((v) => v.startsWith(prefix))
    if (m) return m
  }
  return versions[0]
}

async function applyModpackFiles(
  archive: string,
  format: ModpackFormat,
  parsed: ParsedPack,
  gameDir: string,
  instanceName: string,
  onProgress: (p: DownloadProgress) => void,
  onLog: (l: string) => void,
  signal?: AbortSignal
): Promise<void> {
  // 整合包实例强制隔离，模组与覆盖文件统一放入 versions/<实例名>/
  const runDir = join(gameDir, 'versions', instanceName)
  await fsp.mkdir(runDir, { recursive: true })

  // 1) 先解压并复制 overrides / client-overrides（打包在 zip 内的文件，两种格式均支持）
  const tmp = join(tmpdir(), `hc-mp-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await extractArchive(archive, tmp)
  try {
    for (const d of ['overrides', 'client-overrides']) {
      const src = join(tmp, d)
      if (existsSync(src)) {
        await fsp.cp(src, runDir, { recursive: true })
      }
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }

  // 2) 再下载 files 列表（Modrinth 下载、MCBBS 的 CurseFile 与 fileApi 增量文件）
  //
  // 参考 downloader.ts 的并发工作池：整合包常含数十到数百个模组文件，串行下载会让
  // 安装耗时线性累积。这里用 settings.maxDownloadConcurrency 个 worker 并行拉取，
  // 共享字节 / 计数并节流上报，保持与原逐文件实现完全一致的单文件语义
  // （CurseFile 探测、可选文件跳过、多候选源回退、下载后 SHA 校验）。
  const files = parsed.files
  const total = files.length
  // 清单声明的模组文件按目标路径去重；在下载结束（CurseFile 改名完成后）据此校验落盘。
  let done = 0
  let doneBytes = 0
  let totalBytes = 0

  let speed = 0
  let lastSpeedAt = Date.now()
  let lastSpeedBytes = 0
  const EMIT_INTERVAL = 80
  let lastEmitAt = 0
  let emitTimer: ReturnType<typeof setTimeout> | null = null
  let latestLabel = ''
  let finished = false

  const sendProgress = (): void => {
    if (finished) return
    emitTimer = null
    const now = Date.now()
    const delta = now - lastSpeedAt
    const bytes = doneBytes - lastSpeedBytes
    lastSpeedAt = now
    lastSpeedBytes = doneBytes
    if (delta > 0) {
      const inst = bytes / delta
      speed = inst > 0 ? Math.max(0, Math.min(inst * 1000, 1024 * 1024 * 1024)) : speed * 0.5
    }
    lastEmitAt = now
    const percent =
      totalBytes > 0
        ? Math.min(100, Math.round((doneBytes / totalBytes) * 100))
        : total > 0
          ? Math.min(100, Math.round((done / total) * 100))
          : 0
    onProgress({
      taskId: 'modpack',
      task: latestLabel || '整合包文件',
      current: done,
      total,
      currentBytes: doneBytes,
      totalBytes,
      phase: 'mod',
      percent,
      speed: Math.round(speed)
    })
  }

  const emit = (label: string, force = false): void => {
    latestLabel = label
    if (force) {
      if (emitTimer != null) {
        clearTimeout(emitTimer)
        emitTimer = null
      }
      sendProgress()
      return
    }
    const now = Date.now()
    if (now - lastEmitAt >= EMIT_INTERVAL) {
      sendProgress()
    } else if (emitTimer == null) {
      emitTimer = setTimeout(sendProgress, EMIT_INTERVAL)
    }
  }

  const concurrency = Math.max(1, settings.get().maxDownloadConcurrency || 1)
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, async () => {
    for (;;) {
      if (signal?.aborted) return
      const i = index++
      if (i >= total) return
      const f = files[i]
      // CurseForge 文件：探测真实文件名、下载地址与校验信息（SHA-1 / 大小）
      if (f.curseFile) {
        const info = await resolveCurseFile(f.curseFile.projectID, f.curseFile.fileID, f.url, signal)
        if (info) {
          f.path = info.fileName.startsWith('mods/') ? info.fileName : `mods/${info.fileName}`
          f.url = info.url
          if (info.sha1) f.sha1 = info.sha1
          if (info.size) f.size = info.size
        }
      }
      if (!f.url) {
        done++
        emit(latestLabel)
        continue
      }
      // 路径安全：去除首尾分隔符、拒绝目录穿越
      const rel = normRelPath(f.path)
      if (!rel || rel.split('/').some((s) => s === '..' || s === '')) {
        done++
        emit(latestLabel)
        continue
      }
      const dest = join(runDir, ...rel.split('/'))
      // 可选文件（MCBBS AddonFile）以 overrides 为准：已存在则跳过，避免重复下载
      if (f.optional && existsSync(dest)) {
        done++
        emit(rel)
        continue
      }
      await fsp.mkdir(dirname(dest), { recursive: true })
      emit(rel)
      // 候选源：清单给出的地址（含 Modrinth 镜像）；CurseFile 再补 CurseForge API 端点
      const candidates = Array.from(
        new Set([
          ...(f.mirrors && f.mirrors.length > 0 ? f.mirrors : [f.url]),
          ...(f.curseFile
            ? [
                `https://www.curseforge.com/api/v1/mods/${f.curseFile.projectID}/files/${f.curseFile.fileID}/download-with-ip`,
                `https://www.curseforge.com/api/v1/mods/${f.curseFile.projectID}/files/${f.curseFile.fileID}/download`
              ]
            : [])
        ])
      ).filter(Boolean)

      // 下载 + 完整性校验：单次下载可能因服务器提前断流 / 镜像截断得到不完整文件，
      // 用清单提供的 SHA 识别后删除并重下（最多 3 轮，每轮顺序尝试所有候选源），
      // 避免把损坏的模组留在实例里（对应「最后几个模组不完整」）。
      let lastErr: unknown = null
      for (let attempt = 1; attempt <= 3 && !signal?.aborted; attempt++) {
        for (const candidate of candidates) {
          await fsp.rm(dest, { force: true }).catch(() => {})
          try {
            await streamDownload(candidate, dest, {
              signal,
              headers: f.headers,
              onBytes: (n) => {
                doneBytes += n
                emit(rel)
              },
              onSize: (s) => {
                totalBytes += s
                emit(rel)
              }
            })
            lastErr = null
            break
          } catch (e) {
            lastErr = e
          }
        }
        if (lastErr) continue
        try {
          await verifyPackFile(dest, f)
          break
        } catch (e) {
          lastErr = e
          await fsp.rm(dest, { force: true }).catch(() => {})
          onLog(`[整合包] ${rel} 校验失败（第 ${attempt}/3 次），正在重下：${(e as Error).message}`)
        }
      }

      try {
        if (signal?.aborted) throw new Error('下载已取消')
        if (lastErr) throw lastErr
      } catch (e) {
        // 可选文件（MCBBS AddonFile）下载失败不中断导入：overrides 里通常已包含该文件
        if (f.optional) {
          onLog(`[整合包] 下载 ${rel} 失败，已跳过：${(e as Error).message}`)
          done++
          emit(rel)
          continue
        }
        throw e
      }
      done++
      emit(rel)
    }
  })

  try {
    await Promise.all(workers)
    if (signal?.aborted) throw new Error('下载已取消')

    // 模组完整性校验：CurseForge 文件名探测完成后，逐个确认清单声明的模组均已落盘。
    const expectedMods = new Set<string>()
    for (const f of files) {
      const rel = normRelPath(f.path)
      if (rel.toLowerCase().startsWith('mods/') && MOD_FILE_RE.test(rel)) expectedMods.add(rel)
    }
    const missingMods = findMissingMods(runDir, expectedMods)
    if (missingMods.length > 0) {
      const shown = missingMods.slice(0, 5).join('、')
      const more = missingMods.length > 5 ? ` 等 ${missingMods.length} 个` : ''
      throw new Error(
        `整合包模组数量校验失败：清单声明 ${expectedMods.size} 个模组，缺失 ${missingMods.length} 个（${shown}${more}），可能有模组下载失败或被跳过`
      )
    }
    if (expectedMods.size > 0) onLog(`[整合包] 模组数量校验通过：${expectedMods.size}/${expectedMods.size}`)
  } finally {
    // 结束后丢弃所有尚未发出的节流上报，避免残留定时器在返回后「复活」渲染端进度条。
    finished = true
    if (emitTimer != null) {
      clearTimeout(emitTimer)
      emitTimer = null
    }
  }
}

/* ------------------------------------------------------------------ */
/* 导入 / 导出                                                         */
/* ------------------------------------------------------------------ */

export async function importModpack(
  archive: string,
  gameDir: string,
  customName: string,
  onProgress: (p: DownloadProgress) => void,
  onLog: (l: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const format = await detectFormat(archive)
  if (!format) throw new Error('无法识别的整合包格式（仅支持 Modrinth、MCBBS/BBSMC 与启动器自带格式）')
  const parsed = await parseArchive(format, archive)
  const name = customName.trim() || parsed.name || basename(archive).replace(/\.(mrpack|zip)$/i, '')
  if (!name) throw new Error('整合包名称为空')
  if (!parsed.mcVersion) {
    throw new Error(`无法从整合包清单中解析出 Minecraft 版本（识别到的加载器：${parsed.loader ?? '无'}）。请确认该整合包格式是否正确。`)
  }

  const s = settings.get()
  let loaderVersion = parsed.loaderVersion
  if (parsed.loader) {
    loaderVersion = await resolveLoaderVersion(parsed.loader as LoaderKind | ForgeKind, parsed.mcVersion, parsed.loaderVersion)
  }

  onProgress({ taskId: 'modpack', task: `安装 ${name}`, current: 0, total: 1, currentBytes: 0, totalBytes: 0, phase: 'client', percent: 0 })
  try {
    await installInstance(parsed.mcVersion, parsed.loader, loaderVersion, gameDir, name, s.mirror, onProgress, onLog, signal)
    await applyModpackFiles(archive, format, parsed, gameDir, name, onProgress, onLog, signal)
  } catch (err) {
    // 中途取消 / 失败也补发 done，清理进度条目，再向上抛出。
    onProgress({ taskId: 'modpack', task: `导入中断 ${name}`, current: 0, total: 1, currentBytes: 0, totalBytes: 0, phase: 'done', percent: 0 })
    throw err
  }

  // 标记为强制隔离实例
  if (!s.isolatedVersions.includes(name)) {
    settings.set({ isolatedVersions: [...s.isolatedVersions, name] })
  }

  onProgress({ taskId: 'modpack', task: `安装完成 ${name}`, current: 1, total: 1, currentBytes: 0, totalBytes: 0, phase: 'done', percent: 100 })
  return name
}

export async function importModpackFromUrl(
  url: string,
  filename: string,
  gameDir: string,
  customName: string,
  onProgress: (p: DownloadProgress) => void,
  onLog: (l: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const tmp = await downloadModpack(url, filename, onProgress, signal)
  try {
    return await importModpack(tmp, gameDir, customName, onProgress, onLog, signal)
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {})
  }
}

/** 下载整合包到临时文件并返回路径（供渲染端 probe 后重命名再 import）。 */
export async function downloadModpack(
  url: string,
  filename: string,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<string> {
  const safe = filename.replace(/[\\/:*?"<>|]/g, '_') || 'modpack.mrpack'
  const tmp = join(tmpdir(), `hc-mp-dl-${Date.now()}-${Math.random().toString(36).slice(2)}-${safe}`)
  let received = 0
  let total = 0
  const emit = (): void => {
    const percent = total > 0 ? Math.round((received / total) * 100) : 0
    onProgress({
      taskId: 'modpack',
      task: `下载 ${safe}`,
      current: 0,
      total: 1,
      currentBytes: received,
      totalBytes: total,
      phase: 'mod',
      percent
    })
  }
  try {
    await streamDownload(url, tmp, {
      signal,
      onSize: (size) => {
        total = size
        emit()
      },
      onBytes: (n) => {
        received += n
        emit()
      }
    })
  } catch (err) {
    // 取消 / 失败同样补发 done，清理进度条目，随后照常向上抛出。
    onProgress({
      taskId: 'modpack',
      task: `下载中断 ${safe}`,
      current: 0,
      total: 1,
      currentBytes: received,
      totalBytes: total,
      phase: 'done',
      percent: 0
    })
    throw err
  }
  // 下载完成后必须补发 done，否则渲染端进度条目会一直残留。
  onProgress({
    taskId: 'modpack',
    task: `下载完成 ${safe}`,
    current: 1,
    total: 1,
    currentBytes: received,
    totalBytes: total,
    phase: 'done',
    percent: 100
  })
  return tmp
}

async function getInstanceMeta(
  versionId: string,
  gameDir: string,
  kind: MirrorKind
): Promise<{ mcVersion: string; loader: string | null }> {
  const json = await resolveVersionJson(versionId, kind, gameDir)
  const mcVersion = json.clientVersion ?? json.inheritsFrom ?? json.id
  const libs = (json.libraries ?? []).map((l) => l.name ?? '').join(' ')
  let loader: string | null = null
  if (/net\.neoforged/i.test(libs)) loader = 'neoforge'
  else if (/net\.minecraftforge/i.test(libs)) loader = 'forge'
  else if (/net\.fabricmc/i.test(libs)) loader = 'fabric'
  else if (/org\.quiltmc/i.test(libs)) loader = 'quilt'
  return { mcVersion, loader }
}

const RESOURCEPACK_FILE_RE = /\.(zip|jar|mcpack|mctemplate)$/i
const GUNPACK_FILE_RE = /\.zip$/i
const SCHEMATIC_FILE_RE = /\.(litematic|schem|schematic)$/i

/** 安全叶子名：拒绝路径分隔符与相对跳转，避免解压/复制时路径穿越。 */
function isLeaf(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && basename(name) === name
}

async function readDirEntries(dir: string): Promise<Array<{ name: string; isDir: boolean; size: number }>> {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Array<{ name: string; isDir: boolean; size: number }> = []
  for (const e of entries) {
    let size = 0
    if (!e.isDirectory()) {
      try {
        size = (await fsp.stat(join(dir, e.name))).size
      } catch {
        size = 0
      }
    }
    out.push({ name: e.name, isDir: e.isDirectory(), size })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 扫描实例中可导出的全部内容，供导出界面展示选择。 */
export async function collectExportInventory(
  gameDir: string,
  versionId: string,
  isolated: boolean
): Promise<ModpackExportInventory> {
  const runDir = isolated ? join(gameDir, 'versions', versionId) : gameDir

  const resEntries = await readDirEntries(join(runDir, 'resourcepacks'))
  const guns = (await readDirEntries(join(runDir, 'tacz'))).filter(
    (e) => !e.isDir && GUNPACK_FILE_RE.test(e.name)
  )
  const schematics = (await readDirEntries(join(runDir, 'schematics'))).filter(
    (e) => !e.isDir && SCHEMATIC_FILE_RE.test(e.name)
  )
  const mods = await readDirEntries(join(runDir, 'mods'))

  const worlds: ExportItem[] = []
  for (const e of await readDirEntries(join(runDir, 'saves'))) {
    if (!e.isDir) continue
    if (existsSync(join(runDir, 'saves', e.name, 'level.dat'))) worlds.push({ name: e.name, size: 0 })
  }

  return {
    hasGameSettings: existsSync(join(runDir, 'options.txt')),
    hasModConfigs: existsSync(join(runDir, 'config')),
    hasServersList: existsSync(join(runDir, 'servers.dat')),
    worlds,
    resourcePacks: resEntries
      .filter((e) => e.isDir || RESOURCEPACK_FILE_RE.test(e.name))
      .map((e) => ({ name: e.name, size: e.size })),
    hasJei: existsSync(join(runDir, 'jei')),
    gunPacks: guns.map((e) => ({ name: e.name, size: e.size })),
    disabledMods: mods
      .filter((e) => !e.isDir && e.name.endsWith('.disabled'))
      .map((e) => ({ name: e.name.slice(0, -'.disabled'.length), size: e.size })),
    schematics: schematics.map((e) => ({ name: e.name, size: e.size }))
  }
}

export async function exportModpack(
  versionId: string,
  gameDir: string,
  options: ModpackExportOptions,
  onProgress: (p: DownloadProgress) => void
): Promise<string> {
  const s = settings.get()
  const isolated = s.versionIsolation || s.isolatedVersions.includes(versionId)
  const runDir = isolated ? join(gameDir, 'versions', versionId) : gameDir
  const meta = await getInstanceMeta(versionId, gameDir, s.mirror)
  const format = options.format

  const tmp = join(tmpdir(), `hc-export-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const overrides = join(tmp, 'overrides')
  await fsp.mkdir(overrides, { recursive: true })

  const step = (task: string): void => {
    onProgress({ taskId: 'modpack', task, current: 0, total: 1, currentBytes: 0, totalBytes: 0, phase: 'mod', percent: 0 })
  }
  const cp = async (src: string, dest: string): Promise<void> => {
    if (!existsSync(src)) return
    await fsp.mkdir(dirname(dest), { recursive: true })
    await fsp.cp(src, dest, { recursive: true })
  }

  // 1) 模组：未禁用的必须导出；禁用模组仅当勾选时导出（保留 .disabled 状态）
  const modsDir = join(runDir, 'mods')
  await fsp.mkdir(join(overrides, 'mods'), { recursive: true })
  for (const e of await readDirEntries(modsDir)) {
    if (e.isDir) continue
    const disabled = e.name.endsWith('.disabled')
    if (disabled && !options.includeDisabledMods) continue
    step(`打包模组 ${e.name}`)
    await fsp.copyFile(join(modsDir, e.name), join(overrides, 'mods', e.name))
  }

  // 2) 游戏设置 / 模组设置 / 服务器列表
  if (options.includeGameSettings) {
    step('打包游戏设置')
    await cp(join(runDir, 'options.txt'), join(overrides, 'options.txt'))
  }
  if (options.includeModConfigs) {
    step('打包模组设置')
    await cp(join(runDir, 'config'), join(overrides, 'config'))
  }
  if (options.includeServersList) {
    step('打包服务器列表')
    await cp(join(runDir, 'servers.dat'), join(overrides, 'servers.dat'))
  }

  // 3) 光影始终导出（保留旧行为）
  step('打包光影')
  await cp(join(runDir, 'shaderpacks'), join(overrides, 'shaderpacks'))

  // 4) 单人存档
  for (const name of options.worlds) {
    if (!isLeaf(name)) continue
    step(`打包存档 ${name}`)
    await cp(join(runDir, 'saves', name), join(overrides, 'saves', name))
  }

  // 5) 资源包
  for (const name of options.resourcePacks) {
    if (!isLeaf(name)) continue
    step(`打包资源包 ${name}`)
    await cp(join(runDir, 'resourcepacks', name), join(overrides, 'resourcepacks', name))
  }

  // 6) JEI 个人信息
  if (options.includeJei) {
    step('打包 JEI 个人信息')
    await cp(join(runDir, 'jei'), join(overrides, 'jei'))
  }

  // 7) 枪包
  for (const name of options.gunPacks) {
    if (!isLeaf(name)) continue
    step(`打包枪包 ${name}`)
    await cp(join(runDir, 'tacz', name), join(overrides, 'tacz', name))
  }

  // 8) 投影原理图
  for (const name of options.schematics) {
    if (!isLeaf(name)) continue
    step(`打包原理图 ${name}`)
    await cp(join(runDir, 'schematics', name), join(overrides, 'schematics', name))
  }

  // 写入对应格式的清单
  if (format === 'modrinth') {
    const index: Record<string, unknown> = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: meta.mcVersion,
      name: versionId,
      summary: '',
      files: [],
      dependencies: { minecraft: meta.mcVersion }
    }
    const deps = index.dependencies as Record<string, string>
    if (meta.loader === 'fabric') deps['fabric-loader'] = '*'
    else if (meta.loader === 'quilt') deps['quilt-loader'] = '*'
    else if (meta.loader === 'forge') deps['forge'] = '*'
    else if (meta.loader === 'neoforge') deps['neoforge'] = '*'
    await fsp.writeFile(join(tmp, 'modrinth.index.json'), JSON.stringify(index, null, 2), 'utf-8')
  } else {
    const manifest = {
      name: versionId,
      version: '1.0.0',
      game_version: meta.mcVersion,
      mod_loader: meta.loader ?? 'vanilla',
      mod_loader_version: '*',
      description: '',
      ...(format === 'native' ? { format: 'hunger-cat' } : {})
    }
    const manifestName = format === 'native' ? 'launcher.packmeta' : 'mcbbs.packmeta'
    await fsp.writeFile(join(tmp, manifestName), JSON.stringify(manifest, null, 2), 'utf-8')
  }

  const outDir = join(gameDir, 'modpacks')
  await fsp.mkdir(outDir, { recursive: true })
  const ext = format === 'modrinth' ? 'mrpack' : 'zip'
  const outPath = join(outDir, `${versionId}.${ext}`)
  await zipDirectory(tmp, outPath)
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  onProgress({ taskId: 'modpack', task: `导出完成 ${basename(outPath)}`, current: 1, total: 1, currentBytes: 0, totalBytes: 0, phase: 'done', percent: 100 })
  return outPath
}
