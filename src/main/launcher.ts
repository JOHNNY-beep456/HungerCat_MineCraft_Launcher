import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { freemem } from 'os'
import { mkdirSync } from 'fs'
import { join } from 'path'
import type { LaunchEvent, LaunchOptions, MinecraftAccount, VersionJson } from '@shared/types'
import { libraryAllowed, libraryPaths, pickClassifier } from './downloader'

const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const osName = isWindows ? 'windows' : isMac ? 'osx' : 'linux'
const PATH_SEP = isWindows ? ';' : ':'

export interface LaunchContext {
  json: VersionJson
  /** Root where assets/libraries/versions/natives are installed. */
  installDir: string
  /** Directory the game actually runs in (cwd; holds saves/mods/config). */
  runDir: string
  javaPath: string
  nativesDir: string
  assetIndexId: string
  account: MinecraftAccount
  options: LaunchOptions
}

type Rule = { action: 'allow' | 'disallow'; os?: { name?: string }; features?: Record<string, boolean> }

function evalRules(rules: unknown[], features: Record<string, boolean>): boolean {
  if (!rules || rules.length === 0) return true
  let allowed = false
  for (const raw of rules) {
    const rule = raw as Rule
    if (rule.os?.name && rule.os.name !== osName) continue
    if (rule.features) {
      const ok = Object.entries(rule.features).every(([k, v]) => (features[k] ?? false) === v)
      if (!ok) continue
    }
    allowed = rule.action === 'allow'
  }
  return allowed
}

function collectClasspath(json: VersionJson, installDir: string): string[] {
  const cp: string[] = []
  for (const lib of json.libraries ?? []) {
    if (!libraryAllowed(lib)) continue
    const { prefix, base } = libraryPaths(lib.name)
    if (lib.downloads?.artifact) {
      cp.push(join(installDir, 'libraries', lib.downloads.artifact.path ?? `${prefix}/${base}.jar`))
    } else {
      cp.push(join(installDir, 'libraries', prefix, `${base}.jar`))
    }
    if (lib.natives) {
      const c = pickClassifier(lib)
      if (c) {
        cp.push(
          join(installDir, 'libraries', lib.downloads?.classifiers?.[c]?.path ?? `${prefix}/${base}-${c}.jar`)
        )
      }
    }
  }
  cp.push(join(installDir, 'versions', json.id, `${json.id}.jar`))
  return cp
}

export function buildCommand(ctx: LaunchContext): { cmd: string; args: string[] } {
  const { json, installDir, runDir, nativesDir, assetIndexId, account, options } = ctx
  const classpath = collectClasspath(json, installDir).join(PATH_SEP)

  const features: Record<string, boolean> = {
    is_demo_user: !!options.demo,
    has_custom_resolution: !!options.resolution
  }

  const isOffline = !!account.offline
  const isYggdrasil = account.authType === 'yggdrasil'
  const placeholders: Record<string, string> = {
    auth_player_name: account.name,
    version_name: json.id,
    game_directory: runDir,
    assets_root: join(installDir, 'assets'),
    game_assets: join(installDir, 'assets'),
    assets_index_name: assetIndexId,
    auth_uuid: account.id,
    auth_access_token: isOffline ? '0' : account.accessToken,
    auth_session: isOffline ? '0' : `token:${account.accessToken}`,
    user_type: isOffline || isYggdrasil ? 'legacy' : 'msa',
    version_type: json.type || 'release',
    clientid: '0',
    auth_xuid: '0',
    user_properties: '{}',
    natives_directory: nativesDir,
    launcher_name: 'HungerCatLauncher',
    launcher_version: '0.2.0',
    classpath,
    classpath_separator: PATH_SEP,
    library_directory: join(installDir, 'libraries'),
    resolution_width: String(options.resolution?.width ?? 854),
    resolution_height: String(options.resolution?.height ?? 480),
    language: 'zh_cn'
  }

  const substitute = (s: string): string => s.replace(/\$\{([^}]+)\}/g, (_, k: string) => placeholders[k] ?? '')

  // Fabric/Quilt ship `-DFabricMcEmu= net.minecraft.client.main.Main ` with stray
  // leading/trailing spaces; the loader trims the property value anyway, so
  // tidy it to a single clean argument.
  const normalizeJvmArg = (s: string): string =>
    s.startsWith('-DFabricMcEmu=') ? `-DFabricMcEmu=${s.slice('-DFabricMcEmu='.length).trim()}` : s

  // JVM arguments
  let jvmArgs: string[] = []
  if (json.arguments?.jvm) {
    for (const item of json.arguments.jvm) {
      if (typeof item === 'string') jvmArgs.push(normalizeJvmArg(substitute(item)))
      else if (evalRules(item.rules as unknown[], features)) {
        const vals = Array.isArray(item.value) ? item.value : [item.value]
        jvmArgs.push(...vals.map((v) => normalizeJvmArg(substitute(v))))
      }
    }
  } else {
    jvmArgs = [
      `-Djava.library.path=${nativesDir}`,
      '-cp',
      classpath
    ]
  }

  // Game arguments
  let gameArgs: string[] = []
  if (json.arguments?.game) {
    for (const item of json.arguments.game) {
      if (typeof item === 'string') gameArgs.push(substitute(item))
      else if (evalRules(item.rules as unknown[], features)) {
        const vals = Array.isArray(item.value) ? item.value : [item.value]
        gameArgs.push(...vals.map(substitute))
      }
    }
  } else if (json.minecraftArguments) {
    gameArgs = json.minecraftArguments.split(' ').map(substitute)
  }

  // Quick-play (1.19.3+): jump straight into a world or server.
  if (options.quickPlaySingleplayer) {
    gameArgs.push('--quickPlaySingleplayer', options.quickPlaySingleplayer)
  }
  if (options.quickPlayMultiplayer) {
    gameArgs.push('--quickPlayMultiplayer', options.quickPlayMultiplayer)
  }

  // Memory — 预留内存不得超过系统剩余可用内存
  const freeMb = Math.floor(freemem() / 1024 / 1024)
  const reservedMb = Math.min(options.memoryMb, freeMb)
  jvmArgs = [`-Xmx${reservedMb}M`, ...(options.extraJvmArgs ?? []), ...jvmArgs]

  // Yggdrasil 第三方认证：注入 authlib-injector，把皮肤/账号鉴权指向指定服务器
  if (isYggdrasil) {
    const injectorPath = join(installDir, 'libraries', 'authlib-injector.jar')
    const server = account.yggdrasilServer ?? ''
    jvmArgs.unshift(`-javaagent:${injectorPath}=${server}`)
  }

  const args = [...jvmArgs, json.mainClass, ...gameArgs, ...(options.extraGameArgs ?? [])]
  return { cmd: options.javaPath ?? ctx.javaPath, args }
}

/** Quote a single argv element for a copy-pasteable Windows CMD command line. */
function quoteWindowsArg(arg: string): string {
  // CMD metacharacters or whitespace require quoting; escape embedded quotes.
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg
}

function renderCommandLine(cmd: string, args: string[]): string {
  return [cmd, ...args].map(quoteWindowsArg).join(' ')
}

export function spawnGame(
  ctx: LaunchContext,
  emit: (e: LaunchEvent) => void
): ChildProcessWithoutNullStreams {
  const { cmd, args } = buildCommand(ctx)
  mkdirSync(ctx.runDir, { recursive: true })
  emit({ state: 'launching', log: `启动命令: ${renderCommandLine(cmd, args)}\n` })

  const child = spawn(cmd, args, {
    cwd: ctx.runDir,
    env: { ...process.env },
    windowsHide: true
  })

  child.stdout.on('data', (d: Buffer) => emit({ state: 'running', log: d.toString() }))
  child.stderr.on('data', (d: Buffer) => emit({ state: 'running', log: d.toString() }))
  child.on('spawn', () => emit({ state: 'running', pid: child.pid }))
  child.on('error', (err) => emit({ state: 'error', error: err.message }))
  child.on('exit', (code) => emit({ state: 'exited', exitCode: code ?? 0 }))

  return child
}
