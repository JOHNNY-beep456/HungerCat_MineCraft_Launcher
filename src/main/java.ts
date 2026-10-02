import { execFile } from 'child_process'
import { promises as fsp } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { DownloadPhase, JavaRuntime } from '@shared/types'
import { extractArchive } from './archive'
import { netRequest } from './broker'
import { streamDownload } from './stream-download'

const JAVA_BIN = process.platform === 'win32' ? 'java.exe' : 'java'

/**
 * 探测并发上限。每次探测都要真正启动一个 java 进程，一次性放开几十个会在低配机上
 * 造成明显的 CPU / 内存尖峰（看起来就像启动器卡死），故限制在少量并行。
 */
const PROBE_CONCURRENCY = 4

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

/** 路径是否存在（异步，不阻塞主进程事件循环）。 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

/** 从候选路径里挑出真实存在的（并发判断）。 */
async function existingPaths(paths: string[]): Promise<string[]> {
  const flags = await Promise.all(
    paths.map(async (p) => {
      try {
        await fsp.access(p)
        return true
      } catch {
        return false
      }
    })
  )
  return paths.filter((_, i) => flags[i])
}

function runJavaVersion(javaPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(javaPath, ['-version'], { timeout: 8000 }, (err, _stdout, stderr) => {
      if (err && !stderr) {
        // Exit code 1 with version on stderr is normal; missing binary is not.
        reject(err)
        return
      }
      resolve((_stdout || '') + '\n' + (stderr || ''))
    })
  })
}

function parseJavaVersion(output: string): Omit<JavaRuntime, 'path'> | null {
  const first = output.split('\n').find((l) => l.includes('version'))
  if (!first) return null
  const m = first.match(/"([^"]+)"/)
  if (!m) return null
  const raw = m[1]
  let major = 0
  const parts = raw.split('.')
  if (parts[0] === '1') major = parseInt(parts[1], 10)
  else major = parseInt(parts[0], 10)
  if (!Number.isFinite(major)) return null
  const is64Bit = output.includes('64-Bit')
  let vendor: string | undefined
  if (/openjdk/i.test(output)) vendor = 'OpenJDK'
  else if (/java\(tm\)/i.test(output)) vendor = 'Oracle'
  else if (/zulu/i.test(output)) vendor = 'Azul Zulu'
  else if (/temurin|adoptium/i.test(output)) vendor = 'Eclipse Temurin'
  else if (/microsoft/i.test(output)) vendor = 'Microsoft'
  return { version: raw, major, is64Bit, vendor }
}

async function probe(path: string): Promise<JavaRuntime | null> {
  try {
    const out = await runJavaVersion(path)
    const parsed = parseJavaVersion(out)
    return parsed ? { path, ...parsed } : null
  } catch {
    return null
  }
}

function* candidateDirs(): Generator<string> {
  const home = homedir()
  if (process.platform === 'win32') {
    const roots = [
      process.env['ProgramFiles'],
      process.env['ProgramFiles(x86)'],
      join('C:', 'Program Files'),
      join('C:', 'Program Files (x86)')
    ]
    for (const root of roots) {
      if (!root) continue
      yield join(root, 'Java')
      yield join(root, 'Eclipse Adoptium')
      yield join(root, 'Microsoft')
      yield join(root, 'Zulu')
      yield join(root, 'BellSoft')
      yield join(root, 'Amazon Corretto')
    }
    yield join(home, '.jdks')
  } else {
    yield '/Library/Java/JavaVirtualMachines'
    yield join(home, 'Library', 'Java', 'JavaVirtualMachines')
    yield '/opt/homebrew/opt'
    yield '/usr/lib/jvm'
  }
}

/**
 * 收集候选的 java 可执行文件路径。
 *
 * 全程异步：这条路径在「进入设置页」与「每次启动游戏」都会走一遍，原先用
 * readdirSync / existsSync / statSync 同步扫 PATH 与各个 JDK 安装目录，会把主进程
 * 完整卡住（界面表现为「未响应」）。
 */
async function findJavaExecutables(): Promise<string[]> {
  const candidates: string[] = []

  // JAVA_HOME
  const javaHome = process.env['JAVA_HOME']
  if (javaHome) candidates.push(join(javaHome, 'bin', JAVA_BIN))

  // PATH：手动解压 / 便携版 / 包管理器安装的 JDK 往往只加进了 PATH，并不在标准安装目录下。
  // 不扫 PATH 是「找不到 Java」最常见的原因之一。
  const pathEnv = process.env['PATH'] ?? process.env['Path'] ?? ''
  for (const dir of pathEnv.split(process.platform === 'win32' ? ';' : ':')) {
    const p = dir.trim().replace(/^"|"$/g, '')
    if (p) candidates.push(join(p, JAVA_BIN))
  }

  // 常见安装根目录下的 <root>/<jdk>/bin/java
  for (const dir of candidateDirs()) {
    let entries: string[]
    try {
      entries = await fsp.readdir(dir)
    } catch {
      // 目录不存在 / 无权限：readdir 抛错即等价于原先的 existsSync 判断，省掉一次系统调用
      continue
    }
    for (const entry of entries) candidates.push(join(dir, entry, 'bin', JAVA_BIN))
  }

  // Common macOS Homebrew openjdk symlinks
  if (process.platform === 'darwin') {
    for (const ver of ['21', '17', '11', '8']) {
      candidates.push(join('/opt/homebrew/opt', `openjdk@${ver}`, 'bin', 'java'))
    }
  }

  // Explicit bundled JDK dirs shipped with vanilla launcher style layout
  const home = homedir()
  for (const rel of [
    '.jdks',
    join('AppData', 'Local', 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime')
  ]) {
    const dir = join(home, rel)
    let entries: string[]
    try {
      entries = await fsp.readdir(dir)
    } catch {
      continue
    }
    for (const entry of entries) candidates.push(join(dir, entry, 'bin', JAVA_BIN))
  }

  return [...new Set(await existingPaths(candidates))]
}

/** 递归收集启动器自动安装于 `<gameDir>/java/<major>/` 下的 Java 可执行文件。 */
async function findBundledJavaExecutables(gameDir: string): Promise<string[]> {
  const root = join(gameDir, 'java')
  let majors: string[]
  try {
    majors = await fsp.readdir(root)
  } catch {
    return []
  }
  const found: string[] = []
  for (const major of majors) {
    const majorDir = join(root, major)
    const direct = join(majorDir, 'bin', JAVA_BIN)
    if (await pathExists(direct)) {
      found.push(direct)
      continue
    }
    // 解压出的顶层目录名不确定，递归查找第一个 java 可执行文件
    const rec = await findJavaBinRecursive(majorDir)
    if (rec) found.push(rec)
  }
  return found
}

/**
 * 检测结果缓存。扫描系统 Java 要读几十个目录、逐条判断可执行文件，还要为每个候选
 * 真正启动一次 `java -version` —— 这条路径每次进设置页、每次启动游戏都会走一遍。
 * 安装 / 手动指定 Java 后由调用方调 invalidateJavaCache() 主动失效。
 */
const JAVA_CACHE_TTL = 30_000
let javaCache: { key: string; at: number; list: JavaRuntime[] } | null = null

/** 让 Java 检测缓存失效（装完 / 手动指定 Java 后调用）。 */
export function invalidateJavaCache(): void {
  javaCache = null
}

/**
 * 检测可用 Java。
 * @param gameDirs 启动器自动安装 Java 的根目录（`<dir>/java/<major>/`）。
 *   可传多个：启动器可能在不同「版本目录」下都装过 Java，若只扫当前选中的目录，
 *   切换版本目录后此前装好的 Java 就会「凭空消失」。因此这里接受目录列表，
 *   把所有版本目录下的 Java 一并纳入。
 */
export async function detectJava(gameDirs?: string | string[]): Promise<JavaRuntime[]> {
  const dirs = Array.isArray(gameDirs) ? gameDirs : gameDirs ? [gameDirs] : []
  const cacheKey = dirs.join('\n')
  if (javaCache && javaCache.key === cacheKey && Date.now() - javaCache.at < JAVA_CACHE_TTL) {
    return javaCache.list
  }

  const executables = await findJavaExecutables()
  // 额外纳入启动器自动安装的 Java（位于 <gameDir>/java/ 下，系统扫描会遗漏）
  for (const dir of dirs) {
    for (const bin of await findBundledJavaExecutables(dir)) {
      if (!executables.includes(bin)) executables.push(bin)
    }
  }
  const results = await mapLimit(executables, PROBE_CONCURRENCY, (p) => probe(p))
  const list = results.filter((r): r is JavaRuntime => r !== null)
  list.sort((a, b) => b.major - a.major)
  // Dedupe by path
  const deduped = list.filter((r, i) => list.findIndex((x) => x.path === r.path) === i)
  javaCache = { key: cacheKey, at: Date.now(), list: deduped }
  return deduped
}

export async function javaVersionAt(path: string): Promise<JavaRuntime | null> {
  return probe(path)
}

/** Pick the best Java for a required major version (prefer exact major). */
export function pickJava(runtimes: JavaRuntime[], major: number): JavaRuntime | null {
  const exact = runtimes.filter((r) => r.major === major)
  const pool = exact.length ? exact : runtimes
  return pool.find((r) => r.is64Bit) ?? pool[0] ?? null
}

/**
 * 判断某个 Java 是否「能启动」需要 `required` 大版本的游戏（即启动前不必再提示装 Java）。
 *
 * - 大版本完全一致：能启动。
 * - 比要求更高：16 及以后的要求（1.17 / Java 16 起）都能接受更高的运行时，
 *   例如 1.17（Java 16）、1.18–1.20.4（Java 17）用 Java 21 都没问题。
 * - 更早的版本（1.16.5 及以前，要求 Java 8）只认 Java 8：它们依赖旧字节码与已被高版本
 *   Java 移除的内部 API，用 Java 17/21/25 启动会直接崩溃，所以此时仍应提示装 Java 8。
 *
 * 该判定同时用于启动前的兼容性检查：不满足时提示用户安装 Java `required`，
 * 而不是静默用起不来的 Java 去启动。
 */
export function isJavaSuitable(jr: JavaRuntime, required: number): boolean {
  return jr.major === required || (jr.major > required && required >= 16)
}

/** Minimum Java major needed to run the Forge/NeoForge installer for an MC version. */
export function requiredJavaForMc(mcVersion: string): number {
  const [a, b, c] = mcVersion.split('.').map((n) => Number(n) || 0)
  if (a > 1 || (a === 1 && (b > 20 || (b === 20 && c >= 5)))) return 21 // 1.20.5+
  if (a === 1 && b >= 18) return 17 // 1.18 – 1.20.4
  return 8
}

/**
 * Find a usable Java for running installers (Forge/NeoForge), searching in
 * order: the configured path (auto-installed or user-specified), any launcher-
 * bundled Java under `<gameDir>/java/`, then system Java. This matters because
 * `detectJava` only scans system locations and would miss the JRE the launcher
 * itself downloaded.
 */
export async function pickInstallerJava(
  gameDirs: string | string[],
  configuredPath: string | undefined,
  requiredMajor = 17
): Promise<JavaRuntime | null> {
  const dirs = Array.isArray(gameDirs) ? gameDirs : [gameDirs]
  // 1. Configured Java.
  if (configuredPath) {
    const jr = await probe(configuredPath)
    if (jr) return jr
  }
  // 2. Launcher-bundled Java under <gameDir>/java/。
  //    遍历所有版本目录：Java 可能装在别的版本目录下，只看安装目标目录会漏掉。
  for (const dir of dirs) {
    const bundledDir = join(dir, 'java')
    if (!(await pathExists(bundledDir))) continue
    const bin = await findJavaBinRecursive(bundledDir)
    if (!bin) continue
    const jr = await probe(bin)
    if (jr && jr.major >= requiredMajor) return jr
  }
  // 3. System Java（把所有版本目录下的 bundled Java 一并纳入，避免系统扫描遗漏）。
  const runtimes = await detectJava(dirs)
  return pickJava(runtimes, requiredMajor) ?? runtimes[0] ?? null
}

/**
 * 广度优先查找第一个 java 可执行文件。
 * 用 readdir(withFileTypes) 拿到类型，省掉原先「每个条目一次 statSync」的同步调用；
 * 解压出的 JDK 目录层级不深，但条目不少，同步遍历是启动卡顿的常见来源。
 */
async function findJavaBinRecursive(root: string): Promise<string | null> {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(join(dir, e.name))
      else if (e.name === JAVA_BIN) return join(dir, e.name)
    }
  }
  return null
}

/**
 * Download and extract an Adoptium (Eclipse Temurin) JRE for the given major
 * version into `<gameDir>/java/<major>/`, returning the java executable path.
 */
interface JreAsset {
  version: { major: number; semver: string }
  release_name: string
  binary: {
    os: string
    architecture: string
    image_type: string
    package: { name: string; link: string }
  }
}

/** 通过 Adoptium assets 接口获取 JRE 文件名与候选下载地址（含国内镜像）。网络执行由网络进程承担。 */
async function jreDownloadUrls(
  major: number,
  os: string,
  arch: string,
  signal?: AbortSignal
): Promise<{ filename: string; urls: string[] }> {
  // 必须带查询参数：不带时 Adoptium 返回「所有平台 + jdk/jre」的完整列表，响应体可达数 MB，
  // 叠加网络进程 10s 默认超时便常常取不到（表现为「无法获取 Java 下载地址」）。精确过滤后只有几 KB。
  const query = new URLSearchParams({ os, architecture: arch, image_type: 'jre' })
  const data = await netRequest(
    'net:fetchJson',
    {
      url: `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?${query.toString()}`,
      headers: { 'User-Agent': 'HungerCatLauncher/0.1' },
      timeoutMs: 30_000
    },
    { signal }
  )
  const assets = data as JreAsset[]
  // 仍做一次本地过滤兜底（接口可能忽略个别查询参数）。
  const asset =
    assets.find(
      (a) => a.binary.os === os && a.binary.architecture === arch && a.binary.image_type === 'jre'
    ) ?? assets[0]
  if (!asset) throw new Error(`Adoptium 未提供 Java ${major} 的 ${os}/${arch} JRE`)
  const filename = asset.binary.package.name
  // 清华镜像：/Adoptium/{major}/jre/{arch}/{os}/{filename}；GitHub 官方作为回退。
  const urls = [
    `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${major}/jre/${arch}/${os}/${filename}`,
    asset.binary.package.link
  ]
  return { filename, urls }
}

async function downloadJavaBinary(
  url: string,
  dest: string,
  signal: AbortSignal | undefined,
  onProgress: (received: number, total: number) => void
): Promise<void> {
  let received = 0
  let total = 0
  await streamDownload(url, dest, {
    signal,
    onSize: (s) => {
      total = s
    },
    onBytes: (n) => {
      received += n
      onProgress(received, total)
    }
  })
}

export async function installJava(
  major: number,
  gameDir: string,
  onProgress: (percent: number, task: string, currentBytes: number, totalBytes: number, phase: DownloadPhase) => void,
  signal?: AbortSignal
): Promise<string> {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'

  const root = join(gameDir, 'java', String(major))
  await fsp.mkdir(root, { recursive: true })

  onProgress(1, `获取 Java ${major} 下载地址…`, 0, 0, 'java')
  const { filename, urls } = await jreDownloadUrls(major, os, arch, signal)
  const archive = join(root, filename)

  let lastErr: Error | null = null
  let received = 0
  let total = 0
  for (const url of urls) {
    if (signal?.aborted) throw new Error('下载已取消')
    try {
      onProgress(2, `下载 Java ${major} 运行时…`, 0, 0, 'java')
      await downloadJavaBinary(url, archive, signal, (r, t) => {
        received = r
        total = t
        const percent = t > 0 ? Math.round((r / t) * 85) : 1
        onProgress(
          percent,
          `下载 Java ${major}（${(r / 1024 / 1024).toFixed(1)} MB${t ? ` / ${(t / 1024 / 1024).toFixed(1)} MB` : ''}）`,
          r,
          t,
          'java'
        )
      })
      lastErr = null
      break
    } catch (err) {
      if (signal?.aborted) throw new Error('下载已取消')
      lastErr = err instanceof Error ? err : new Error(String(err))
      await fsp.rm(archive, { force: true }).catch(() => {})
    }
  }
  if (lastErr) throw lastErr

  onProgress(90, `解压 Java ${major}…`, received, total, 'java')
  await extractArchive(archive, root)
  await fsp.rm(archive, { force: true })

  const bin = await findJavaBinRecursive(root)
  if (!bin) throw new Error('解压后未找到 java 可执行文件')
  onProgress(100, `Java ${major} 安装完成`, total, total, 'done')
  return bin
}
