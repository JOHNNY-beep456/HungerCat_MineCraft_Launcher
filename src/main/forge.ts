// 元数据获取（forge 版本清单）已迁至网络进程（forge:versions）；安装器 jar 下载走
// streamDownload（broker 代理到网络进程）。spawn java 运行安装器属后端编排，仍留本进程。
import { spawn } from 'child_process'
import { existsSync, promises as fsp } from 'fs'
import { join } from 'path'
import type { DownloadProgress, ForgeKind } from '@shared/types'
import { netRequest } from './broker'
import { streamDownload } from './stream-download'

/**
 * Forge / NeoForge installation. Unlike Fabric/Quilt (which expose a clean
 * profile JSON), Forge-family loaders ship a Java installer that must be run to
 * generate the version profile and download the loader libraries.
 */

const UA = { 'User-Agent': 'HungerCatLauncher/0.1' }

/** Forge 安装器 jar 的 Maven 下载地址（真实网络 IO 由网络进程承担）。 */
const INSTALLER: Record<ForgeKind, { installer: (v: string) => string }> = {
  forge: {
    installer: (v) => `https://maven.minecraftforge.net/net/minecraftforge/forge/${v}/forge-${v}-installer.jar`
  },
  neoforge: {
    installer: (v) => `https://maven.neoforged.net/releases/net/neoforged/neoforge/${v}/neoforge-${v}-installer.jar`
  }
}

export function forgeVersions(kind: ForgeKind, mcVersion: string): Promise<string[]> {
  return netRequest<string[]>('forge:versions', { kind, mcVersion })
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
  const installerUrl = INSTALLER[kind].installer(version)
  const installerDir = join(gameDir, '.installers')
  await fsp.mkdir(installerDir, { recursive: true })
  const installerPath = join(installerDir, `${kind}-${version}-installer.jar`)

  const taskId = `forge-install-${version}`
  const label = `${kind === 'neoforge' ? 'NeoForge' : 'Forge'} ${version}`

  onLog(`下载 ${kind} 安装器 ${version}…\n`)
  // 安装器下载委托给网络进程（stream:download），进度经 onBytes/onSize 回流。
  let received = 0
  let totalBytes = 0
  await streamDownload(installerUrl, installerPath, {
    onBytes: (n) => {
      received += n
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
    },
    onSize: (s) => {
      totalBytes = s
    }
  })

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
