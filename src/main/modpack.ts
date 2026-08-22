import { execFile } from 'child_process'
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
import { resolveVersionJson, createVanillaInstance } from './versions'
import { installVersion } from './downloader'
import { loaderVersions, installLoader } from './loaders'
import { forgeVersions, installForge } from './forge'
import { pickInstallerJava, requiredJavaForMc } from './java'
import { settings } from './store'

/* ------------------------------------------------------------------ */
/* tar (bsdtar) helpers — 用于读取/解压 zip 格式的整合包                */
/* ------------------------------------------------------------------ */

function tarRun(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tar', args, { windowsHide: true, maxBuffer: 128 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message))
      else resolve(stdout)
    })
  })
}

async function tarList(archive: string): Promise<string[]> {
  const out = await tarRun(['-tf', archive])
  return out.split(/\r?\n/).map((s) => s.replace(/^\.\/?/, '')).filter(Boolean)
}

async function tarRead(archive: string, entry: string): Promise<string> {
  return tarRun(['-xOf', archive, entry])
}

async function tarExtract(archive: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true })
  await tarRun(['-xf', archive, '-C', dest])
}

async function zipDir(srcDir: string, outPath: string): Promise<void> {
  await tarRun(['--format=zip', '-cf', outPath, '-C', srcDir, '.'])
}

function findEntry(entries: string[], name: string): string | null {
  for (const e of entries) {
    const parts = e.split('/').filter(Boolean)
    if (parts[parts.length - 1] === name) return e
  }
  return null
}

async function readJsonEntry(archive: string, entry: string): Promise<unknown> {
  const raw = await tarRead(archive, entry)
  return JSON.parse(raw.replace(/^\uFEFF/, ''))
}

/* ------------------------------------------------------------------ */
/* 格式检测与解析                                                       */
/* ------------------------------------------------------------------ */

async function detectFormat(archive: string): Promise<ModpackFormat | null> {
  const entries = await tarList(archive)
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

/** 计算文件的 SHA-1（十六进制小写），用于 AddonFile 完整性校验。 */
function sha1File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    const stream = createReadStream(path)
    stream.on('data', (d) => hash.update(d))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 带超时的中止信号（默认 15s），并叠加外部取消信号。 */
function abortWithTimeout(signal?: AbortSignal, ms = 15000): AbortSignal {
  const t = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, t]) : t
}

function fetchJson(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return fetch(url, { headers: BROWSER_UA, signal: abortWithTimeout(signal) }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json() as Promise<Record<string, unknown>>
  })
}

/** 清理探测到的文件名，防止路径穿越。 */
function sanitizeFileName(n: string): string {
  const clean = n.replace(/[\\/]/g, '_').replace(/^\.+/, '').trim()
  return clean || ''
}

/** 从下载链接的重定向 / Content-Disposition 中探测文件名（HMCL 的 detectFileName）。 */
async function detectFileNameFromUrl(url: string): Promise<string | null> {
  for (const method of ['HEAD', 'GET'] as const) {
    const ac = new AbortController()
    try {
      const res = await fetch(url, { method, headers: BROWSER_UA, redirect: 'follow', signal: ac.signal })
      const cd = res.headers.get('content-disposition')
      if (cd) {
        const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd)
        if (m) {
          const name = sanitizeFileName(decodeURIComponent(m[1].replace(/["']/g, '')))
          if (name) return name
        }
      }
      const finalUrl = res.url || url
      const seg = new URL(finalUrl).pathname.split('/').filter(Boolean).pop() ?? ''
      if (seg && !/\/file$/i.test(finalUrl)) {
        const name = sanitizeFileName(seg)
        if (name) return name
      }
    } catch {
      /* 尝试下一种方法 */
    } finally {
      ac.abort()
    }
  }
  return null
}

/**
 * CurseFile 缺 fileName 时探测真实文件名与下载地址，顺序对照 HMCL：
 *   1) 下载链接重定向 / Content-Disposition；
 *   2) cursemeta（fileNameOnDisk / downloadURL）；
 *   3) forgesvc（fileName / downloadURL）。
 * 全部失败返回 null，调用方回退占位文件名。
 */
async function detectCurseFile(
  projectID: number,
  fileID: number,
  fallbackUrl: string,
  signal?: AbortSignal
): Promise<{ fileName: string; url: string } | null> {
  const fromUrl = await detectFileNameFromUrl(fallbackUrl)
  if (fromUrl) return { fileName: fromUrl, url: fallbackUrl }

  try {
    const m = await fetchJson(`https://cursemeta.dries007.net/${projectID}/${fileID}.json`, signal)
    const name = String(m['fileNameOnDisk'] ?? m['fileName'] ?? '')
    const url = String(m['downloadURL'] ?? '')
    if (name) return { fileName: sanitizeFileName(name), url: url || fallbackUrl }
  } catch {
    /* cursemeta 不可用，继续 */
  }

  try {
    const m = await fetchJson(`https://addons-ecs.forgesvc.net/api/v2/addon/${projectID}/file/${fileID}`, signal)
    const name = String(m['fileName'] ?? '')
    const url = String(m['downloadURL'] ?? '')
    if (name) return { fileName: sanitizeFileName(name), url: url || fallbackUrl }
  } catch {
    /* forgesvc 不可用，继续 */
  }

  return null
}

interface PackFile {
  path: string
  url: string
  /** MCBBS AddonFile：下载失败不中断导入（overrides 兜底）。 */
  optional?: boolean
  /** 附加请求头（例如 CurseForge 需要浏览器 UA）。 */
  headers?: Record<string, string>
  /** AddonFile 的 SHA-1 完整性校验值。 */
  hash?: string
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
  const entries = await tarList(archive)
  const idxEntry = findEntry(entries, 'modrinth.index.json')
  if (!idxEntry) throw new Error('modrinth.index.json 不存在')
  const index = (await readJsonEntry(archive, idxEntry)) as {
    name?: string
    versionId?: string
    summary?: string
    dependencies?: Record<string, unknown>
    files?: Array<{ path?: string; downloads?: string[] }>
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
  const files = (index.files ?? [])
    .map((f: { path?: string; downloads?: string[] }) => ({
      path: f.path ?? '',
      url: Array.isArray(f.downloads) ? f.downloads[0] ?? '' : ''
    }))
    .filter((f: { path: string; url: string }) => f.path)
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
  const entries = await tarList(archive)
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
  const curseUrl = (projectID: number, fileID: number): string =>
    `https://www.curseforge.com/minecraft/mc-mods/${projectID}/download/${fileID}/file`
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
      if (fileName) {
        // fileName 已知，直接定位到 mods/ 目录
        const dest = fileName.startsWith('mods/') ? fileName : `mods/${fileName}`
        files.push({ path: dest, url, headers: BROWSER_UA })
      } else if (projectID && fileID) {
        // fileName 缺失：先用占位名，下载阶段再探测真实文件名
        files.push({ path: `mods/${projectID}-${fileID}.jar`, url, headers: BROWSER_UA, curseFile: { projectID, fileID } })
      }
    } else {
      // AddonFile 或未标注类型：path + 可选 hash / url / downloads；fileApi 存在时优先构造下载地址
      const path = normRel(String(raw['path'] ?? ''))
      if (!path) continue
      let url = String(raw['url'] ?? (Array.isArray(raw['downloads']) ? (raw['downloads'] as string[])[0] ?? '' : ''))
      if (!url && fileApi) url = `${fileApi}/overrides/${path}`
      const hash = String(raw['hash'] ?? '').trim()
      if (url) files.push({ path, url, optional: true, ...(hash ? { hash } : {}) })
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
  const entries = await tarList(archive)
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
    const id = await installForge(loader as ForgeKind, mcVersion, loaderVersion, gameDir, java.path, onLog, instanceName, onProgress)
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
  await tarExtract(archive, tmp)
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
  const files = parsed.files
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    // CurseFile 缺 fileName 时，下载前探测真实文件名与下载地址（cursemeta/forgesvc，回退 URL 重定向）
    if (f.curseFile) {
      const info = await detectCurseFile(f.curseFile.projectID, f.curseFile.fileID, f.url, signal)
      if (info) {
        f.path = info.fileName.startsWith('mods/') ? info.fileName : `mods/${info.fileName}`
        f.url = info.url
      }
    }
    if (!f.url) continue
    // 路径安全：去除首尾分隔符、拒绝目录穿越
    const rel = f.path.replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '')
    if (!rel || rel.split('/').some((s) => s === '..' || s === '')) continue
    const dest = join(runDir, ...rel.split('/'))
    // 可选文件（MCBBS AddonFile）以 overrides 为准：已存在则跳过，避免重复下载
    if (f.optional && existsSync(dest)) continue
    await fsp.mkdir(dirname(dest), { recursive: true })
    onProgress({ taskId: 'modpack', task: rel, current: i, total: files.length, currentBytes: 0, totalBytes: 0, phase: 'mod', percent: Math.round((i / Math.max(1, files.length)) * 100) })
    try {
      await streamDownload(f.url, dest, { signal, headers: f.headers })
      // AddonFile 的 SHA-1 完整性校验（对照 HMCL 的 FileDownloadTask.IntegrityCheck）
      if (f.hash) {
        const actual = await sha1File(dest)
        if (actual.toLowerCase() !== f.hash.toLowerCase()) {
          await fsp.rm(dest, { force: true }).catch(() => {})
          throw new Error(`SHA-1 校验失败（期望 ${f.hash}，实际 ${actual}）`)
        }
      }
    } catch (e) {
      // 可选文件（MCBBS AddonFile）下载失败不中断导入：overrides 里通常已包含该文件
      if (f.optional) {
        onLog(`[整合包] 下载 ${rel} 失败，已跳过：${(e as Error).message}`)
        continue
      }
      throw e
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
  await zipDir(tmp, outPath)
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {})
  onProgress({ taskId: 'modpack', task: `导出完成 ${basename(outPath)}`, current: 1, total: 1, currentBytes: 0, totalBytes: 0, phase: 'done', percent: 100 })
  return outPath
}
