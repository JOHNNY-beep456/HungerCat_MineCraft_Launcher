import { spawn } from 'child_process'
import { createWriteStream, existsSync, promises as fsp } from 'fs'
import { join } from 'path'
import type { DownloadProgress, ForgeKind } from '@shared/types'

/**
 * Forge / NeoForge installation. Unlike Fabric/Quilt (which expose a clean
 * profile JSON), Forge-family loaders ship a Java installer that must be run to
 * generate the version profile and download the loader libraries.
 */

const UA = { 'User-Agent': 'HungerCatLauncher/0.1' }

const MAVEN: Record<ForgeKind, { metadata: string; installer: (v: string) => string }> = {
  forge: {
    metadata: 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml',
    installer: (v) => `https://maven.minecraftforge.net/net/minecraftforge/forge/${v}/forge-${v}-installer.jar`
  },
  neoforge: {
    metadata: 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml',
    installer: (v) => `https://maven.neoforged.net/releases/net/neoforged/neoforge/${v}/neoforge-${v}-installer.jar`
  }
}

function naturalDesc(a: string, b: string): number {
  const pa = a.split(/(\d+)/)
  const pb = b.split(/(\d+)/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ca = pa[i] ?? ''
    const cb = pb[i] ?? ''
    if (ca === cb) continue
    const na = Number(ca)
    const nb = Number(cb)
    if (Number.isFinite(na) && Number.isFinite(nb)) return nb - na
    return cb.localeCompare(ca)
  }
  return 0
}

function matchesMc(version: string, mcVersion: string, kind: ForgeKind): boolean {
  if (version.startsWith(`${mcVersion}-`)) return true
  if (kind === 'neoforge') {
    // NeoForge moved to standalone versioning for 1.20.5+: "1.21" -> "21.0.x",
    // "1.21.1" -> "21.1.x", "1.20.6" -> "20.6.x".
    const parts = mcVersion.split('.')
    if (parts.length >= 2 && parts[0] === '1') {
      const prefix = parts[2] ? `${parts[1]}.${parts[2]}.` : `${parts[1]}.`
      if (version.startsWith(prefix)) return true
    }
  }
  return false
}

export async function forgeVersions(kind: ForgeKind, mcVersion: string): Promise<string[]> {
  const res = await fetch(MAVEN[kind].metadata, { headers: UA })
  if (!res.ok) throw new Error(`获取 ${kind} 版本列表失败 (HTTP ${res.status})`)
  const xml = await res.text()
  const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1])
  const matched = versions.filter((v) => matchesMc(v, mcVersion, kind))
  const stable = matched.filter((v) => !/-(pre|rc|beta|alpha|snapshot)/i.test(v))
  const pre = matched.filter((v) => /-(pre|rc|beta|alpha|snapshot)/i.test(v))
  return [...stable.sort(naturalDesc), ...pre.sort(naturalDesc)].slice(0, 200)
}

/** Snapshot the set of installed version ids (directories under `versions/`). */
async function listVersionIds(gameDir: string): Promise<Set<string>> {
  try {
    const entries = await fsp.readdir(join(gameDir, 'versions'))
    return new Set(entries)
  } catch {
    return new Set()
  }
}

export async function installForge(
  kind: ForgeKind,
  mcVersion: string,
  version: string,
  gameDir: string,
  javaPath: string,
  onLog: (line: string) => void,
  customId?: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<string> {
  const installerUrl = MAVEN[kind].installer(version)
  const installerDir = join(gameDir, '.installers')
  await fsp.mkdir(installerDir, { recursive: true })
  const installerPath = join(installerDir, `${kind}-${version}-installer.jar`)

  const taskId = `forge-install-${version}`
  const label = `${kind === 'neoforge' ? 'NeoForge' : 'Forge'} ${version}`

  onLog(`下载 ${kind} 安装器 ${version}…\n`)
  const res = await fetch(installerUrl, { headers: UA })
  if (!res.ok || !res.body) throw new Error(`下载 ${kind} 安装器失败 (HTTP ${res.status})`)
  const totalBytes = Number(res.headers.get('content-length') ?? 0)
  const reader = res.body.getReader()
  const out = createWriteStream(installerPath)
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      onProgress?.({
        taskId,
        task: `下载安装器 ${label}`,
        current: 0,
        total: 1,
        currentBytes: received,
        totalBytes,
        phase: 'mod',
        percent: totalBytes > 0 ? Math.min(100, Math.round((received / totalBytes) * 100)) : 0
      })
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((r) => out.once('drain', r))
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })
  } finally {
    out.destroy()
  }

  onLog(`运行安装器 (Java ${javaPath})…\n`)
  onProgress?.({ taskId, task: `运行安装器 ${label}`, current: 0, total: 1, currentBytes: 0, totalBytes: 0, phase: 'mod', percent: 0 })

  // The Forge/NeoForge client installer refuses to run unless the official
  // launcher's `launcher_profiles.json` exists in the target directory (it
  // injects the loader profile into it afterwards). Create a minimal one so the
  // headless install can proceed.
  const launcherProfiles = join(gameDir, 'launcher_profiles.json')
  if (!existsSync(launcherProfiles)) {
    await fsp.writeFile(launcherProfiles, JSON.stringify({ profiles: {} }, null, 2), 'utf-8')
  }

  // Snapshot existing versions so we can find the profile the installer creates
  // (its id is e.g. "1.20.1-forge-47.x", not the raw maven version).
  const before = await listVersionIds(gameDir)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(javaPath, ['-jar', installerPath, '--installClient', gameDir], {
      cwd: gameDir,
      windowsHide: true
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${kind} 安装器运行超时（超过 10 分钟），请重试或更换网络`))
    }, 10 * 60 * 1000)
    child.stdout.on('data', (d: Buffer) => onLog(d.toString()))
    child.stderr.on('data', (d: Buffer) => onLog(d.toString()))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${kind} 安装器退出码 ${code}`))
    })
  })

  onLog(`${kind} 安装完成\n`)
  onProgress?.({ taskId, task: `安装完成 ${label}`, current: 1, total: 1, currentBytes: totalBytes, totalBytes, phase: 'done', percent: 100 })

  const after = await listVersionIds(gameDir)
  // The installer may also (re)create the vanilla `<mcVersion>` directory while
  // downloading the client jar, so exclude it and any pre-existing dirs; the
  // generated profile id is the remaining new entry (e.g. "1.20.1-forge-47.x",
  // "neoforge-21.1.x").
  const generatedId = [...after].find((id) => !before.has(id) && id !== mcVersion)
  if (!generatedId) throw new Error(`${kind} 安装器未生成版本配置文件`)
  return finalizeForgeInstall(gameDir, generatedId, customId)
}

/** 若指定了自定义版本名，重命名安装器生成的版本目录并更新 JSON 的 id。 */
async function finalizeForgeInstall(gameDir: string, generatedId: string, customId?: string): Promise<string> {
  if (!customId || customId === generatedId) return generatedId
  const srcDir = join(gameDir, 'versions', generatedId)
  const dstDir = join(gameDir, 'versions', customId)
  if (existsSync(join(dstDir, `${customId}.json`))) {
    throw new Error(`版本名「${customId}」已存在`)
  }
  const json = JSON.parse(await fsp.readFile(join(srcDir, `${generatedId}.json`), 'utf-8'))
  json.id = customId
  await fsp.rename(srcDir, dstDir)
  await fsp.writeFile(join(dstDir, `${customId}.json`), JSON.stringify(json, null, 2), 'utf-8')
  await fsp.rm(join(dstDir, `${generatedId}.json`), { force: true }).catch(() => {})
  return customId
}
