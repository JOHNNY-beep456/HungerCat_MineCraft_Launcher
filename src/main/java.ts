import { execFile } from 'child_process'
import { createWriteStream, existsSync, readdirSync, statSync, promises as fsp } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { DownloadPhase, JavaRuntime } from '@shared/types'

const JAVA_BIN = process.platform === 'win32' ? 'java.exe' : 'java'

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

function findJavaExecutables(): string[] {
  const found: string[] = []
  const seen = new Set<string>()

  const add = (p: string): void => {
    if (seen.has(p)) return
    seen.add(p)
    found.push(p)
  }

  // JAVA_HOME
  const javaHome = process.env['JAVA_HOME']
  if (javaHome) add(join(javaHome, 'bin', JAVA_BIN))

  for (const dir of candidateDirs()) {
    if (!existsSync(dir)) continue
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const bin = join(dir, entry, 'bin', JAVA_BIN)
      if (existsSync(bin)) add(bin)
    }
  }

  // Common macOS Homebrew openjdk symlinks
  if (process.platform === 'darwin') {
    for (const ver of ['21', '17', '11', '8']) {
      const p = join('/opt/homebrew/opt', `openjdk@${ver}`, 'bin', 'java')
      if (existsSync(p)) add(p)
    }
  }

  // Explicit bundled JDK dirs shipped with vanilla launcher style layout
  const home = homedir()
  for (const rel of [
    '.jdks',
    join('AppData', 'Local', 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime')
  ]) {
    const dir = join(home, rel)
    if (!existsSync(dir)) continue
    try {
      for (const entry of readdirSync(dir)) {
        const bin = join(dir, entry, 'bin', JAVA_BIN)
        if (existsSync(bin)) add(bin)
      }
    } catch {
      /* ignore */
    }
  }

  return found
}

/** 递归收集启动器自动安装于 `<gameDir>/java/<major>/` 下的 Java 可执行文件。 */
function findBundledJavaExecutables(gameDir: string): string[] {
  const root = join(gameDir, 'java')
  if (!existsSync(root)) return []
  const found: string[] = []
  let majors: string[]
  try {
    majors = readdirSync(root)
  } catch {
    return found
  }
  for (const major of majors) {
    const majorDir = join(root, major)
    const direct = join(majorDir, 'bin', JAVA_BIN)
    if (existsSync(direct)) {
      found.push(direct)
      continue
    }
    // 解压出的顶层目录名不确定，递归查找第一个 java 可执行文件
    const rec = findJavaBinRecursive(majorDir)
    if (rec) found.push(rec)
  }
  return found
}

export async function detectJava(gameDir?: string): Promise<JavaRuntime[]> {
  const executables = findJavaExecutables()
  // 额外纳入启动器自动安装的 Java（位于 <gameDir>/java/ 下，系统扫描会遗漏）
  if (gameDir) {
    for (const bin of findBundledJavaExecutables(gameDir)) {
      if (!executables.includes(bin)) executables.push(bin)
    }
  }
  const results = await Promise.all(executables.map((p) => probe(p)))
  const list = results.filter((r): r is JavaRuntime => r !== null)
  list.sort((a, b) => b.major - a.major)
  // Dedupe by path
  return list.filter((r, i) => list.findIndex((x) => x.path === r.path) === i)
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
  gameDir: string,
  configuredPath: string | undefined,
  requiredMajor = 17
): Promise<JavaRuntime | null> {
  // 1. Configured Java.
  if (configuredPath) {
    const jr = await probe(configuredPath)
    if (jr) return jr
  }
  // 2. Launcher-bundled Java under <gameDir>/java/.
  const bundledDir = join(gameDir, 'java')
  if (existsSync(bundledDir)) {
    const bin = findJavaBinRecursive(bundledDir)
    if (bin) {
      const jr = await probe(bin)
      if (jr && jr.major >= requiredMajor) return jr
    }
  }
  // 3. System Java.
  const runtimes = await detectJava()
  return pickJava(runtimes, requiredMajor) ?? runtimes[0] ?? null
}

function findJavaBinRecursive(root: string): string | null {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop() as string
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(dir, e)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) stack.push(p)
      else if (e === JAVA_BIN) return p
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

/** 通过 Adoptium assets 接口获取 JRE 文件名与候选下载地址（含国内镜像）。 */
async function jreDownloadUrls(
  major: number,
  os: string,
  arch: string,
  signal?: AbortSignal
): Promise<{ filename: string; urls: string[] }> {
  const res = await fetch(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot`, {
    headers: { 'User-Agent': 'HungerCatLauncher/0.1' },
    signal
  })
  if (!res.ok) throw new Error(`获取 Java 版本信息失败 (HTTP ${res.status})`)
  const assets = (await res.json()) as JreAsset[]
  const asset = assets.find(
    (a) => a.binary.os === os && a.binary.architecture === arch && a.binary.image_type === 'jre'
  )
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
  const res = await fetch(url, { headers: { 'User-Agent': 'HungerCatLauncher/0.1' }, signal })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const reader = res.body.getReader()
  const out = createWriteStream(dest)
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      onProgress(received, total)
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((r) => out.once('drain', r))
      }
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))
  } finally {
    out.destroy()
  }
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
  await new Promise<void>((resolve, reject) => {
    execFile('tar', ['-xf', archive, '-C', root], { windowsHide: true }, (err) => (err ? reject(err) : resolve()))
  })
  await fsp.rm(archive, { force: true })

  const bin = findJavaBinRecursive(root)
  if (!bin) throw new Error('解压后未找到 java 可执行文件')
  onProgress(100, `Java ${major} 安装完成`, total, total, 'done')
  return bin
}
