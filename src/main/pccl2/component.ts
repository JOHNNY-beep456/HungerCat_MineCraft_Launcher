import { createHash } from 'crypto'
import { promises as fsp, createReadStream } from 'fs'
import { app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { Readable } from 'stream'
import { createInflateRaw } from 'zlib'
import { extractArchive } from '../archive'

export interface Pccl2ComponentStatus {
  supported: boolean
  installed: boolean
  version?: string
  path?: string
}
export interface Pccl2InstallProgress {
  phase: 'manifest' | 'download' | 'verify' | 'extract' | 'install'
  received?: number
  total?: number
}
export interface Pccl2Manifest {
  schemaVersion: 1
  component: 'pccl2'
  version: string
  platform: 'win32'
  arch: 'x64'
  entry: string
  url: string
  sha256: string
  size: number
  bridgeVersion: 1
}

const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024
const COMPONENT_DIR = 'pccl2'
let installing = false

function componentRoot(): string {
  return join(app.getPath('userData'), 'components', COMPONENT_DIR)
}
function markerPath(root = componentRoot()): string { return join(root, '.pccl2.json') }
function fail(message: string): never { throw new Error(`PCCL2 组件：${message}`) }
function httpsUrl(value: string, base?: string): URL {
  let u: URL
  try { u = new URL(value, base) } catch { fail('URL 无效') }
  if (u.protocol !== 'https:' || u.username || u.password) fail('只允许无凭据的 HTTPS URL')
  return u
}
function validPath(name: string): boolean {
  if (!name || name.length > 240 || /[\\\x00-\x1f\x7f:<>"|?*]/.test(name)) return false
  return name.split('/').every((part) => !!part && part !== '.' && part !== '..' &&
    !/[. ]$/.test(part) && !/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(part.split('.')[0].trimEnd()))
}
function validRelativeEntry(entry: unknown): entry is string {
  return typeof entry === 'string' && validPath(entry) && /^[^/]+\.exe$/i.test(entry)
}
function parseManifest(raw: unknown, manifestUrl: string): Pccl2Manifest {
  if (!raw || typeof raw !== 'object') fail('manifest 不是对象')
  const m = raw as Record<string, unknown>
  if (m.schemaVersion !== 1 || m.component !== 'pccl2' || m.platform !== 'win32' || m.arch !== 'x64' || m.bridgeVersion !== 1) fail('manifest schema/platform/arch/bridgeVersion 不受支持')
  if (typeof m.version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(m.version)) fail('版本号无效')
  if (!validRelativeEntry(m.entry)) fail('entry 必须是根目录下的 .exe 文件名')
  if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(m.sha256)) fail('sha256 无效')
  if (typeof m.size !== 'number' || !Number.isSafeInteger(m.size) || m.size <= 0 || m.size > MAX_PACKAGE_BYTES) fail('package size 超出限制')
  if (typeof m.url !== 'string' || !m.url) fail('package URL 无效')
  const url = httpsUrl(m.url, manifestUrl).toString()
  return { schemaVersion: 1, component: 'pccl2', version: m.version, platform: 'win32', arch: 'x64', entry: m.entry, url, sha256: m.sha256.toLowerCase(), size: m.size, bridgeVersion: 1 }
}

/** 手动处理重定向，每一跳均验证 HTTPS，超时覆盖响应体读取。 */
async function receive(url: string, limit: number, timeout: number, consume: (chunk: Buffer) => Promise<void>, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController()
  const abort = (): void => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const timer = setTimeout(() => controller.abort(new Error('PCCL2 下载超时')), timeout)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    let current = httpsUrl(url).toString()
    for (let hop = 0; hop <= 5; hop++) {
      const res = await fetch(current, { redirect: 'manual', signal: controller.signal })
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        await res.body?.cancel()
        const location = res.headers.get('location')
        if (!location || hop === 5) fail('重定向无效或次数过多')
        current = httpsUrl(location, current).toString()
        continue
      }
      reader = res.body?.getReader()
      if (!res.ok || res.status !== 200) fail(`下载失败（HTTP ${res.status}）`)
      const length = res.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) fail('响应体超过大小限制')
      if (!reader) fail('下载无响应体')
      let total = 0
      for (;;) {
        controller.signal.throwIfAborted()
        const part = await reader.read()
        if (part.done) break
        total += part.value.byteLength
        if (total > limit) fail('响应体超过大小限制')
        await consume(Buffer.from(part.value))
      }
      return current
    }
    return fail('重定向次数过多')
  } finally {
    controller.abort()
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
async function readManifest(url: string, signal?: AbortSignal): Promise<Pccl2Manifest> {
  const chunks: Buffer[] = []
  const finalUrl = await receive(url, MAX_MANIFEST_BYTES, 30_000, async (chunk) => { chunks.push(chunk) }, signal)
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail('manifest JSON 无效') }
  return parseManifest(parsed, finalUrl)
}
async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
function safeChild(root: string, name: string): string {
  if (!validPath(name)) fail('归档路径包含无效名称或 Windows 别名')
  const target = resolve(root, name)
  const rel = relative(resolve(root), target)
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) fail('归档条目越界')
  return target
}

/** 仅接受无注释 ZIP32；禁止数据描述符和扩展字段，避免解压器对元数据产生不同解释。 */
async function validateZipArchive(file: string): Promise<void> {
  const data = await fsp.readFile(file)
  const end = data.length - 22
  if (end < 0 || data.readUInt32LE(end) !== 0x06054b50) fail('组件包不是受支持的 ZIP32')
  const count = data.readUInt16LE(end + 10)
  const offset = data.readUInt32LE(end + 16)
  const size = data.readUInt32LE(end + 12)
  if (!count || count > 10000 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || data.readUInt16LE(end + 8) !== count || data.readUInt16LE(end + 20) || offset + size !== end) fail('ZIP 中央目录无效')
  let p = offset
  let localEnd = 0
  let unpacked = 0
  const names = new Map<string, boolean>()
  const explicit = new Set<string>()
  const spelling = new Map<string, string>()
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || data.readUInt32LE(p) !== 0x02014b50) fail('ZIP 条目无效')
    const flags = data.readUInt16LE(p + 8)
    const method = data.readUInt16LE(p + 10)
    const compressed = data.readUInt32LE(p + 20)
    const expanded = data.readUInt32LE(p + 24)
    const nameLen = data.readUInt16LE(p + 28)
    const extraLen = data.readUInt16LE(p + 30)
    const commentLen = data.readUInt16LE(p + 32)
    const attrs = data.readUInt32LE(p + 38)
    const local = data.readUInt32LE(p + 42)
    if (p + 46 + nameLen + extraLen + commentLen > end || extraLen || commentLen || data.readUInt16LE(p + 34)) fail('ZIP 扩展字段或分卷不受支持')
    const bytes = data.subarray(p + 46, p + 46 + nameLen)
    const name = bytes.toString('utf8')
    if (!Buffer.from(name, 'utf8').equals(bytes) || (!(flags & 0x800) && bytes.some((b) => b > 127))) fail('ZIP 文件名编码无效')
    const directory = name.endsWith('/')
    const clean = directory ? name.slice(0, -1) : name
    safeChild(componentRoot(), clean)
    if (clean.toLowerCase() === '.pccl2.json') fail('ZIP 不得包含安装标记')
    const type = (attrs >>> 16) & 0xf000
    if (type && type !== (directory ? 0x4000 : 0x8000)) fail('ZIP 含符号链接或特殊文件')
    if ((attrs & 0x10) && !directory) fail('ZIP 目录标记不一致')
    if ((flags & ~0x800) !== 0 || (method !== 0 && method !== 8)) fail('ZIP 加密或压缩方式不受支持')
    unpacked += expanded
    if (compressed > MAX_PACKAGE_BYTES || expanded > MAX_PACKAGE_BYTES || unpacked > MAX_UNPACKED_BYTES || (directory && (expanded || compressed))) fail('ZIP 解压大小超出限制')
    const key = clean.toUpperCase()
    if (explicit.has(key) || (names.has(key) && names.get(key) !== directory)) fail('ZIP 路径重复或文件目录冲突')
    explicit.add(key)
    names.set(key, directory)
    const parts = clean.split('/')
    for (let j = 1; j <= parts.length; j++) {
      const prefix = parts.slice(0, j).join('/')
      const folded = prefix.toUpperCase()
      if (spelling.has(folded) && spelling.get(folded) !== prefix) fail('ZIP 目录大小写别名冲突')
      spelling.set(folded, prefix)
    }
    for (let j = 1; j < parts.length; j++) {
      const parent = parts.slice(0, j).join('/').toUpperCase()
      if (names.get(parent) === false) fail('ZIP 父路径是文件')
      names.set(parent, true)
    }
    if (local !== localEnd || local + 30 > offset || data.readUInt32LE(local) !== 0x04034b50) fail('ZIP 本地头无效或重叠')
    const localNameLen = data.readUInt16LE(local + 26)
    const localExtraLen = data.readUInt16LE(local + 28)
    const start = local + 30 + localNameLen + localExtraLen
    if (localExtraLen || start + compressed > offset || !bytes.equals(data.subarray(local + 30, local + 30 + localNameLen)) ||
      data.readUInt16LE(local + 6) !== flags || data.readUInt16LE(local + 8) !== method ||
      data.readUInt32LE(local + 14) !== data.readUInt32LE(p + 16) || data.readUInt32LE(local + 18) !== compressed || data.readUInt32LE(local + 22) !== expanded) fail('ZIP 本地头与中央目录不一致')
    // 预检实际解压流长度，不能相信可伪造的 uncompressed size。
    const contents = data.subarray(start, start + compressed)
    if (method === 0) {
      if (compressed !== expanded) fail('ZIP 存储大小不一致')
    } else {
      const inflater = Readable.from([contents]).pipe(createInflateRaw())
      let actual = 0
      try {
        for await (const chunk of inflater) {
          actual += chunk.length
          if (actual > expanded) fail('ZIP 实际解压大小超出声明')
        }
        if (actual !== expanded) fail('ZIP 实际解压大小与声明不符')
      } finally { inflater.destroy() }
    }
    localEnd = start + compressed
    p += 46 + nameLen + extraLen + commentLen
  }
  if (p !== end || localEnd !== offset) fail('ZIP 中央目录或本地数据长度无效')
}

async function readInstalled(): Promise<{ version: string; path: string } | null> {
  const root = componentRoot()
  try {
    const marker = JSON.parse(await fsp.readFile(markerPath(root), 'utf8')) as { version?: unknown; entry?: unknown; sha256?: unknown }
    if (typeof marker.version !== 'string' || !validRelativeEntry(marker.entry) || typeof marker.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(marker.sha256)) return null
    const entry = safeChild(root, marker.entry)
    const st = await fsp.lstat(entry)
    if (!st.isFile() || st.isSymbolicLink()) return null
    if ((await sha256File(entry)).toLowerCase() !== marker.sha256.toLowerCase()) return null
    return { version: marker.version, path: entry }
  } catch { return null }
}
export async function getComponentStatus(_manifestUrl?: string): Promise<Pccl2ComponentStatus> {
  if (process.platform !== 'win32' || process.arch !== 'x64') return { supported: false, installed: false }
  const installed = await readInstalled()
  return installed ? { supported: true, installed: true, version: installed.version, path: installed.path } : { supported: true, installed: false }
}
export async function installComponent(manifestUrl: string, onProgress?: (progress: Pccl2InstallProgress) => void, signal?: AbortSignal): Promise<string> {
  if (process.platform !== 'win32') fail('当前平台不受支持')
  if (process.arch !== 'x64') fail('当前架构不受支持，仅支持 win32/x64')
  if (installing) fail('已有组件安装正在进行')
  installing = true
  const root = componentRoot()
  const parent = dirname(root)
  let temp: string | undefined
  let lock: Awaited<ReturnType<typeof fsp.open>> | undefined
  const lockPath = `${root}.install.lock`
  try {
    await fsp.mkdir(parent, { recursive: true })
    // 文件锁同时防止多个启动器进程安装；异常退出遗留锁需人工确认后清理。
    lock = await fsp.open(lockPath, 'wx')
    signal?.throwIfAborted()
    onProgress?.({ phase: 'manifest' })
    const manifest = await readManifest(manifestUrl, signal)
    temp = await fsp.mkdtemp(join(parent, '.pccl2-install-'))
    const archive = join(temp, 'package.zip')
    onProgress?.({ phase: 'download', received: 0, total: manifest.size })
    const handle = await fsp.open(archive, 'wx')
    let received = 0
    try {
      await receive(manifest.url, manifest.size, 10 * 60_000, async (chunk) => {
        await handle.writeFile(chunk)
        received += chunk.length
        onProgress?.({ phase: 'download', received, total: manifest.size })
      }, signal)
    } finally { await handle.close() }
    if (received !== manifest.size) fail('下载大小与 manifest 不符')
    onProgress?.({ phase: 'verify', received, total: manifest.size })
    if (await sha256File(archive) !== manifest.sha256) fail('SHA-256 校验失败')
    await validateZipArchive(archive)
    signal?.throwIfAborted()
    const payload = join(temp, 'payload')
    await fsp.mkdir(payload)
    onProgress?.({ phase: 'extract' })
    await extractArchive(archive, payload)
    const exe = safeChild(payload, manifest.entry)
    const exeStat = await fsp.lstat(exe)
    if (!exeStat.isFile() || exeStat.isSymbolicLink()) fail('安装包缺少安全的入口 EXE')
    await fsp.writeFile(markerPath(payload), JSON.stringify({ version: manifest.version, entry: manifest.entry, sha256: await sha256File(exe) }), { flag: 'wx' })
    signal?.throwIfAborted()
    onProgress?.({ phase: 'install' })
    const backup = join(temp, 'previous')
    let movedOld = false
    try {
      try { await fsp.rename(root, backup); movedOld = true } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      await fsp.rename(payload, root)
    } catch (err) {
      if (movedOld) {
        try { await fsp.rename(backup, root) } catch (rollbackError) {
          const recovery = backup
          temp = undefined
          throw new AggregateError([err, rollbackError], `PCCL2 安装及回滚失败，原组件保留于 ${recovery}`)
        }
      }
      throw err
    }
    return join(root, manifest.entry)
  } finally {
    try {
      if (temp) await fsp.rm(temp, { recursive: true, force: true })
    } finally {
      try {
        if (lock) { await lock.close(); await fsp.unlink(lockPath) }
      } finally { installing = false }
    }
  }
}

const execFileAsync = promisify(execFile)

/**
 * .NET Framework 4.8 是否可用。
 *
 * 上游完整前端是 .NET Framework 4.8 的 VB/WPF 程序：系统缺少该运行时，进程会在
 * 创建窗口前退出，宿主只能看到 ready 超时。这里按注册表 Release 值判断
 * （4.8 对应 >= 528040），不依赖具体语言包。
 */
export async function hasDotNet48(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  try {
    const { stdout } = await execFileAsync('reg', [
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full',
      '/v',
      'Release'
    ])
    const match = /Release\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(stdout)
    if (!match) return false
    return parseInt(match[1], 16) >= 528040
  } catch {
    return false
  }
}

/** 随组件分发的 .NET 4.8 离线安装包（缺失时使用）。 */
export function bundledRuntimeInstaller(): string {
  return join(componentRoot(), 'runtime', 'NDP48-x86-x64-AllOS-ENU.exe')
}

/**
 * 确保 .NET Framework 4.8 可用。
 *
 * 返回 'present' 表示已具备；'installed' 表示本次已用随包安装程序装好。
 * 找不到随包安装程序时明确报错，而不是让原生窗口静默闪退。
 */
export async function ensureDotNet48(): Promise<'present' | 'installed'> {
  if (await hasDotNet48()) return 'present'
  const installer = bundledRuntimeInstaller()
  try {
    await fsp.access(installer)
  } catch {
    fail('缺少 .NET Framework 4.8，且组件内未包含运行时安装程序')
  }
  try {
    // 静默安装并抑制重启；安装器退出码 0/3010 均视为成功（3010 表示需重启）。
    await execFileAsync(installer, ['/q', '/norestart'], { timeout: 15 * 60_000 })
  } catch (error) {
    const code = (error as { code?: number }).code
    if (code !== 3010) fail('安装 .NET Framework 4.8 失败，请手动安装后重试')
  }
  if (!(await hasDotNet48())) fail('安装 .NET Framework 4.8 后仍检测不到运行时，请重启系统后重试')
  return 'installed'
}

export async function getInstalledExecutable(): Promise<string> {
  if (process.platform !== 'win32' || process.arch !== 'x64') fail('当前平台或架构不受支持')
  const installed = await readInstalled()
  if (!installed) fail('PCCL2 组件未安装或完整性校验失败')
  return installed.path
}
