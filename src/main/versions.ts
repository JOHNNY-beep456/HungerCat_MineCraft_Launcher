import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { VersionJson, VersionManifest } from '@shared/types'
import { netRequest } from './broker'

/**
 * 版本清单 / 版本 JSON 的【远程获取核心执行】已迁到网络进程（out/main/network.js）。
 * 本模块仅保留调用方视角的封装：本地磁盘解析、inheritsFrom 合并仍在主进程完成。
 *
 * 下载源由设置在「版本列表源 / 文件下载源」里选择，实际选源与自动回退都在网络进程
 * 内完成，故这里无需传 kind（主进程只关心「拿到清单 / 版本 JSON」这个结果）。
 */
export function fetchVersionManifest(): Promise<VersionManifest> {
  return netRequest<VersionManifest>('versions:manifest', {})
}

/** 获取单个原版版本 JSON（不含合并），远程部分委托给网络进程。 */
function fetchRawVersionJson(id: string): Promise<VersionJson> {
  return netRequest<VersionJson>('versions:json', { id })
}

type VersionArg = string | { rules: unknown[]; value: string | string[] }

/**
 * Merge `arguments` for `inheritsFrom`. Loader profiles ship a *partial*
 * `arguments` block relative to their vanilla parent:
 *   - Fabric/Quilt: `jvm` = only the loader flag, `game` = empty array.
 *   - Forge/NeoForge: `jvm` = loader module-path flags (no `-cp`), `game` =
 *     loader flags (no auth args) — they rely on the parent for `-cp
 *     ${classpath}`, natives and auth.
 * The correct semantics are therefore a pure concatenation, parent first:
 *   - jvm  = parent.jvm + child.jvm
 *   - game = parent.game + child.game
 */
function mergeArguments(
  parent?: VersionJson['arguments'],
  child?: VersionJson['arguments']
): VersionJson['arguments'] | undefined {
  if (!parent && !child) return undefined
  if (!child) return parent
  if (!parent) return child
  return {
    jvm: [...(parent.jvm ?? []), ...(child.jvm ?? [])],
    game: [...(parent.game ?? []), ...(child.game ?? [])]
  }
}

/**
 * Detect the stale (broken) `arguments` saved by older builds for loader
 * profiles. Those builds replaced the parent block wholesale, so a loader
 * profile ended up missing the vanilla contributions: `-cp ${classpath}` in
 * the jvm and `--username ${auth_player_name}` in the game args.
 */
function argumentsLookStale(args?: VersionJson['arguments']): boolean {
  if (!args) return true
  const jvm = (args.jvm ?? []) as VersionArg[]
  const game = (args.game ?? []) as VersionArg[]
  const hasClasspath = jvm.some(
    (a) => typeof a === 'string' && (a === '-cp' || a.includes('${classpath}'))
  )
  const hasAuth = game.some(
    (a) => typeof a === 'string' && (a === '--username' || a.includes('${auth_player_name}'))
  )
  return !hasClasspath || !hasAuth
}

/** Merge a child version JSON with its parent (for inheritsFrom). */
function mergeVersions(parent: VersionJson, child: VersionJson): VersionJson {
  return {
    ...parent,
    ...child,
    mainClass: child.mainClass || parent.mainClass,
    assetIndex: child.assetIndex || parent.assetIndex,
    assets: child.assets || parent.assets,
    javaVersion: child.javaVersion || parent.javaVersion,
    downloads: { ...parent.downloads, ...child.downloads },
    libraries: [...(parent.libraries ?? []), ...(child.libraries ?? [])],
    arguments: mergeArguments(parent.arguments, child.arguments),
    minecraftArguments: child.minecraftArguments ?? parent.minecraftArguments,
    logging: child.logging ?? parent.logging,
    id: child.id,
    clientVersion: child.inheritsFrom ?? child.id
  }
}

/**
 * Resolve a version JSON, honoring local disk first (loader profiles written
 * by the Fabric/Quilt/Forge installers) and following `inheritsFrom` chains.
 */
export async function resolveVersionJson(id: string, gameDir?: string): Promise<VersionJson> {
  // 1. Local disk (loader profiles and previously-installed versions).
  if (gameDir) {
    const localPath = join(gameDir, 'versions', id, `${id}.json`)
    if (existsSync(localPath)) {
      try {
        const local = JSON.parse(readFileSync(localPath, 'utf-8')) as VersionJson
        if (local.inheritsFrom && local.inheritsFrom !== id) {
          const parent = await resolveVersionJson(local.inheritsFrom, gameDir)
          return mergeVersions(parent, local)
        }
        // Resolved loader profile (clientVersion points to the base MC version).
        // Older builds saved stale, unmerged `arguments`; re-derive them from the
        // base version so the launch keeps `-cp ${classpath}` and game args.
        if (local.clientVersion && local.clientVersion !== id && argumentsLookStale(local.arguments)) {
          const base = await resolveVersionJson(local.clientVersion, gameDir)
          local.arguments = mergeArguments(base.arguments, local.arguments)
        }
        return local
      } catch {
        /* fall through to remote fetch */
      }
    }
  }

  // 2. Remote fetch (vanilla versions).
  const json = await fetchRawVersionJson(id)
  if (json.inheritsFrom) {
    const parent = await resolveVersionJson(json.inheritsFrom, gameDir)
    return mergeVersions(parent, json)
  }
  return json
}

/**
 * 把模组加载器的 profile **就地合并进已有实例**的版本 JSON。
 *
 * ## 为什么可以就地合并
 *
 * 加载器 profile 本来是一份「继承原版」的增量 JSON。`mergeVersions` 已经能把它与
 * 父版本合成为**自包含** JSON —— 既然如此，就可以把合成结果直接写回实例自己的
 * `versions/<id>/<id>.json`，而**不必新建实例**：
 *
 *   · 实例 id 不变 → 启动器里仍是同一个实例；
 *   · 版本目录不变 → 存档、资源包、光影、投影、模组、实例级设置全部原样保留；
 *   · 原版 JSON 备份到 `<id>.json.vanilla.bak`，需要时可还原。
 *
 * ## 为什么要先解析再合并
 *
 * 实例的 JSON 有两种形态：完整的原版 JSON，或 `{id, inheritsFrom}` 这样的包装
 * （导入整合包 / 自定义命名实例）。直接读文件合并会把包装当成原版，丢掉
 * client / assetIndex。所以先用 `resolveVersionJson` 把它解析成完整的原版 JSON
 * 再作为父版本。
 *
 * @param instanceId 目标实例 id（安装后保持不变）
 * @param profile    加载器 profile（会带 inheritsFrom，合并时丢弃）
 */
export async function mergeLoaderProfileInPlace(
  gameDir: string,
  instanceId: string,
  profile: VersionJson
): Promise<void> {
  const base = await resolveVersionJson(instanceId, gameDir)

  /*
   * 防重复安装：真正的闸门在界面（只有原版实例显示入口），这里只是主进程侧兜底。
   * 判据用 mainClass —— 原版的入口类是 net.minecraft.client.main.Main，
   * 而 Fabric / Quilt / Forge / NeoForge 都会换成自己的启动器类。
   * 这是启发式判断，不足以冒充「权威检测」，故只在明显不符时拒绝。
   */
  if (base.mainClass && !base.mainClass.includes('net.minecraft.client.main.Main')) {
    throw new Error('该实例已安装模组加载器，无法重复安装')
  }

  // 以实例自身 id 作为子版本合并：profile 的 inheritsFrom 由 base 实际承担，故丢弃。
  const merged = mergeVersions(base, { ...profile, id: instanceId } as VersionJson)
  merged.id = instanceId
  merged.clientVersion = base.clientVersion || base.id || instanceId
  delete (merged as { inheritsFrom?: string }).inheritsFrom

  const dir = join(gameDir, 'versions', instanceId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${instanceId}.json`)

  /*
   * 原版 JSON 只备份一次。
   * 重复安装（换加载器）时当前文件已经是「合并过的」，拿它覆盖备份就把唯一的原版
   * 副本弄丢了 —— 所以备份存在时不再写。
   */
  const backup = join(dir, `${instanceId}.json.vanilla.bak`)
  if (!existsSync(backup) && existsSync(file)) {
    writeFileSync(backup, readFileSync(file), 'utf-8')
  }

  writeFileSync(file, JSON.stringify(merged, null, 2), 'utf-8')
}

/** 创建原版的自定义命名实例：`versions/<customName>/<customName>.json`，继承基础版本。 */
export async function createVanillaInstance(
  gameDir: string,
  baseVersion: string,
  customName: string
): Promise<void> {
  // 默认名与原版一致时无需包装（直接下载原版即可，避免自继承）
  if (customName === baseVersion) return
  const dir = join(gameDir, 'versions', customName)
  if (existsSync(join(dir, `${customName}.json`))) {
    throw new Error(`版本名「${customName}」已存在`)
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${customName}.json`), JSON.stringify({ id: customName, inheritsFrom: baseVersion }, null, 2), 'utf-8')
}
