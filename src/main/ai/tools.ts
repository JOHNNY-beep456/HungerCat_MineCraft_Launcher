/**
 * AI 可调用的「启动器工具」（MCP 风格的 name / description / inputSchema）。
 *
 * 分两层：
 *   1. **声明**（`AI_TOOLS`）——给模型看的工具清单，格式与 MCP 的 `tools/list` 一致，
 *      因此以后要接外部 MCP 服务器时，这套结构可以原样复用。
 *   2. **执行**（`executeAiTool`）——主进程里真正干活的地方，只认白名单里的工具名。
 *
 * 安全边界：
 *   · `risk: 'safe'` 的工具（查状态、启动、停止）不需要确认；
 *   · `risk: 'dangerous'` 的工具（删版本、删文件）默认**每次都要用户点同意**
 *     （策略来自设置里的 `aiToolPolicy`，见 service.ts）；
 *   · 任何涉及路径的工具都会校验「落在当前游戏目录内」，避免模型把路径拼到别处。
 */
import { rm } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import type { AiToolSpec, ModrinthType, ModSource } from '@shared/types'
import { accounts, activeGameDir, createOfflineAccount, settings } from '../store'
import { deleteVersion, renameVersion, listMods } from '../manage'
import { listInstalled } from '../installed'
import { installMod } from '../modrinth'
import { resolveVersionsFor, searchResources } from '../sources'
import type { IpcContext } from '../handlers/context'

/** JSON Schema 小工具：只用到最简单的几种类型。 */
const str = (description: string): Record<string, unknown> => ({ type: 'string', description })

/** 资源类型枚举（模型给中文 / 别名时由 `argResourceType` 归一）。 */
const RESOURCE_TYPE_SCHEMA: Record<string, unknown> = {
  type: 'string',
  enum: ['mod', 'resourcepack', 'shader'],
  description: '资源类型：mod 模组 / resourcepack 资源包 / shader 光影，默认 mod'
}

/** 全部内置工具（顺序即设置页权限表的展示顺序）。 */
export const AI_TOOLS: AiToolSpec[] = [
  {
    name: 'launcher_list_versions',
    title: '查询已安装实例',
    risk: 'safe',
    description: '列出当前已安装的所有 Minecraft 实例（版本 id、是否隔离、存档数）。不需要参数。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'launcher_list_accounts',
    title: '查询账号列表',
    risk: 'safe',
    description: '列出启动器里已登录的账号（名称、类型、当前选中项）。不要输出任何令牌或密码。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'launcher_get_status',
    title: '查询启动器状态',
    risk: 'safe',
    description: '查询游戏是否正在运行、当前游戏目录、以及是否开启了版本隔离。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'launcher_create_offline_account',
    title: '新建离线账号',
    risk: 'safe',
    description:
      '新建一个离线（免登录、仅单机可用）账号，并把它设为当前账号。名字会作为游戏内昵称，1–16 个字符；已存在同名账号时会被拒绝。',
    inputSchema: {
      type: 'object',
      properties: { name: str('离线账号名（游戏内昵称，1–16 个字符）') },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    name: 'launcher_delete_account',
    title: '删除账号',
    risk: 'dangerous',
    description:
      '从启动器里删除一个账号（按 id 或完全同名的账号名指定）。只移除本地登录状态，不影响该账号在服务器上的数据，也不删除存档。不可撤销。',
    inputSchema: {
      type: 'object',
      properties: { account: str('账号 id 或完全同名的账号名（先查 launcher_list_accounts）') },
      required: ['account'],
      additionalProperties: false
    }
  },
  {
    name: 'launcher_launch_version',
    title: '启动游戏实例',
    risk: 'safe',
    description: '用当前选中的账号启动指定实例。会像用户自己点「启动」一样走完整流程（含补全文件）。',
    inputSchema: {
      type: 'object',
      properties: { versionId: str('要启动的实例 id（来自 launcher_list_versions）') },
      required: ['versionId'],
      additionalProperties: false
    }
  },
  {
    name: 'launcher_stop_game',
    title: '结束游戏进程',
    risk: 'safe',
    description: '结束当前正在运行的游戏进程。没有运行时返回相应说明。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'launcher_delete_version',
    title: '删除实例',
    risk: 'dangerous',
    description: '彻底删除一个已安装实例（含该实例版本目录、natives、以及隔离时的存档与模组）。不可恢复。',
    inputSchema: {
      type: 'object',
      properties: { versionId: str('要删除的实例 id（务必与用户确认过）') },
      required: ['versionId'],
      additionalProperties: false
    }
  },
  {
    name: 'launcher_list_mods',
    title: '查询实例模组',
    risk: 'safe',
    description: '列出某个实例的模组文件名，用于在删除前确认目标。',
    inputSchema: {
      type: 'object',
      properties: { versionId: str('实例 id') },
      required: ['versionId'],
      additionalProperties: false
    }
  },
  {
    name: 'launcher_search_resources',
    title: '搜索资源（模组 / 资源包 / 光影）',
    risk: 'safe',
    description:
      '在 Modrinth / CurseForge 上按关键词搜索资源，返回项目 slug、标题、下载量与是否可下载。装之前先用它找到正确的项目。',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('搜索关键词，例如「小地图」「Iris」'),
        type: RESOURCE_TYPE_SCHEMA,
        gameVersion: str('可选：只保留适配某个 MC 版本的结果，例如 1.20.1'),
        loader: str('可选：只保留适配某个加载器的结果，例如 fabric / forge / neoforge / quilt')
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'launcher_install_resource',
    title: '下载并安装资源',
    risk: 'dangerous',
    description:
      '把 Modrinth / CurseForge 上的一个资源下载并安装进指定实例（模组进 mods，资源包进 resourcepacks，光影进 shaderpacks）。会按实例的 MC 版本与加载器挑选文件；只下载允许分发的文件。',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: str('目标实例 id（来自 launcher_list_versions）'),
        project: str('项目 slug 或 id（来自 launcher_search_resources）'),
        type: RESOURCE_TYPE_SCHEMA,
        source: {
          type: 'string',
          enum: ['modrinth', 'curseforge'],
          description: '来源；不传则先试 Modrinth，没结果再兜底 CurseForge'
        }
      },
      required: ['versionId', 'project'],
      additionalProperties: false
    }
  },
  {
    name: 'launcher_delete_path',
    title: '删除游戏目录内的文件 / 文件夹',
    risk: 'dangerous',
    description:
      '删除当前游戏目录内的某个文件或文件夹（模组、资源包、存档等）。路径必须是游戏目录内的绝对路径；越界会被拒绝。不可恢复。',
    inputSchema: {
      type: 'object',
      properties: { path: str('要删除的绝对路径，必须位于当前游戏目录内') },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'launcher_rename_version',
    title: '重命名实例',
    risk: 'dangerous',
    description: '修改实例名称（同时改目录名与 JSON 内的 id）。会影响依赖旧名字的快捷方式 / 配置。',
    inputSchema: {
      type: 'object',
      properties: { versionId: str('原实例 id'), newName: str('新名称') },
      required: ['versionId', 'newName'],
      additionalProperties: false
    }
  }
]

/** 工具名 → 声明，用于取 risk / title。 */
export const AI_TOOL_MAP = new Map(AI_TOOLS.map((t) => [t.name, t]))

/** 工具执行结果：一段给模型看的文本 + 是否成功。 */
export interface AiToolResult {
  ok: boolean
  text: string
}

/** 取参数字符串并校验非空。 */
function argStr(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || !v.trim()) throw new Error(`缺少参数 ${key}`)
  return v.trim()
}

/** 可选字符串参数：缺省 / 空串 / 非字符串一律视为「没给」。 */
function argOptStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/**
 * 资源类型归一。
 *
 * 模型的措辞不固定（`mods` / `resource-pack` / `shaderpack` 都见过），
 * 这里统一收敛到启动器内部的三种类型；无法识别时按模组处理（最常见）。
 */
function argResourceType(args: Record<string, unknown>): ModrinthType {
  const raw = typeof args['type'] === 'string' ? args['type'].trim().toLowerCase() : ''
  if (['resourcepack', 'resourcepacks', 'resource-pack', 'resource_pack'].includes(raw)) return 'resourcepack'
  if (['shader', 'shaders', 'shaderpack', 'shaderpacks', 'shader-pack'].includes(raw)) return 'shader'
  return 'mod'
}

/** 资源来源归一：只认 modrinth / curseforge，其它值当作「不指定」。 */
function argSource(args: Record<string, unknown>): ModSource | undefined {
  const raw = typeof args['source'] === 'string' ? args['source'].trim().toLowerCase() : ''
  return raw === 'modrinth' || raw === 'curseforge' ? raw : undefined
}

/** 当前游戏目录（已解析绝对路径）。 */
function gameDirNow(): string {
  return resolve(activeGameDir(settings.get()))
}

/**
 * 判断目标路径是否严格位于游戏目录内（防目录穿越）。
 *
 * Windows 的路径大小写不敏感：`C:\Games\MC` 与 `c:\games\mc\mods` 是同一个位置。
 * 用区分大小写的 startsWith 比较，用户填的大小写与设置里不一致时会被误判为越界
 * （明明在目录里却删不掉）。因此 NTFS 上统一按小写比较；其它平台仍严格比较。
 */
function assertInsideGameDir(target: string): string {
  const root = gameDirNow()
  const abs = resolve(target)
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  const foldedRoot = fold(root)
  const foldedAbs = fold(abs)
  if (foldedAbs !== foldedRoot && !foldedAbs.startsWith(foldedRoot + sep)) {
    throw new Error(`路径不在当前游戏目录内，已拒绝：${target}`)
  }
  if (foldedAbs === foldedRoot) throw new Error('不能删除游戏目录本身')
  return abs
}

/**
 * 执行一个工具。
 *
 * 只接受 `AI_TOOLS` 里声明过的名字——模型返回未知工具时直接报错，
 * 而不是「猜一个相近的实现」去执行。
 */
export async function executeAiTool(
  ctx: IpcContext,
  name: string,
  args: Record<string, unknown>
): Promise<AiToolResult> {
  if (!AI_TOOL_MAP.has(name)) return { ok: false, text: `未知工具：${name}` }
  const s = settings.get()
  const gameDir = activeGameDir(s)

  try {
    switch (name) {
      case 'launcher_list_versions': {
        const list = await listInstalled(gameDir, s.versionIsolation, s.isolatedVersions)
        const brief = list.map((v) => ({
          versionId: v.id,
          mcVersion: v.mcVersion,
          loader: v.loader ?? 'vanilla',
          worlds: v.worlds.length
        }))
        return { ok: true, text: JSON.stringify(brief, null, 2) }
      }

      case 'launcher_list_accounts': {
        const selected = accounts.selected()
        const list = accounts.list().map((a) => ({
          name: a.name,
          type: a.authType,
          selected: selected?.id === a.id
        }))
        return { ok: true, text: JSON.stringify(list, null, 2) }
      }

      case 'launcher_create_offline_account': {
        const name = argStr(args, 'name')
        // 离线账号的 id 由名字推导：同名账号会互相覆盖，所以这里先挡一次。
        const dup = accounts.list().find((a) => a.name.toLowerCase() === name.toLowerCase())
        if (dup) return { ok: false, text: `已存在同名账号：${dup.name}（id=${dup.id}），未重复创建。` }
        const acc = createOfflineAccount(name)
        accounts.upsert(acc)
        accounts.select(acc.id)
        return { ok: true, text: `已创建离线账号 ${acc.name}（id=${acc.id}），并设为当前账号。` }
      }

      case 'launcher_delete_account': {
        const key = argStr(args, 'account')
        const list = accounts.list()
        const target =
          list.find((a) => a.id === key) ?? list.find((a) => a.name.toLowerCase() === key.toLowerCase())
        if (!target) {
          const names = list.map((a) => `${a.name}(id=${a.id})`).join('、') || '（当前没有任何账号）'
          return { ok: false, text: `找不到账号：${key}。现有账号：${names}` }
        }
        const rest = accounts.remove(target.id)
        return {
          ok: true,
          text: `已删除账号 ${target.name}。剩余 ${rest.accounts.length} 个账号，当前账号：${rest.selected?.name ?? '（无）'}。`
        }
      }

      case 'launcher_get_status': {        const proc = ctx.gameProcess()
        return {
          ok: true,
          text: JSON.stringify(
            {
              gameRunning: !!proc && proc.exitCode === null,
              gameDir,
              versionIsolation: s.versionIsolation,
              selectedAccount: accounts.selected()?.name ?? null
            },
            null,
            2
          )
        }
      }

      case 'launcher_launch_version': {
        const versionId = argStr(args, 'versionId')
        const list = await listInstalled(gameDir, s.versionIsolation, s.isolatedVersions)
        if (!list.some((v) => v.id === versionId)) {
          return { ok: false, text: `实例不存在：${versionId}（可用 launcher_list_versions 查询）` }
        }
        // 启动要复用渲染层那条完整链路（账号刷新、Java 选择、进度提示都在那边），
        // 因此这里只「发一个请求」给主窗口，由它像用户点按钮一样发起启动。
        ctx.requestLaunch(versionId)
        return { ok: true, text: `已请求启动实例 ${versionId}，启动进度会显示在主界面。` }
      }

      case 'launcher_stop_game': {
        const proc = ctx.gameProcess()
        if (!proc || proc.exitCode !== null) return { ok: true, text: '当前没有正在运行的游戏进程。' }
        proc.kill()
        return { ok: true, text: '已结束游戏进程。' }
      }

      case 'launcher_list_mods': {
        const versionId = argStr(args, 'versionId')
        const mods = await listMods(gameDir, versionId, s.versionIsolation || s.isolatedVersions.includes(versionId))
        return {
          ok: true,
          text: JSON.stringify(
            mods.slice(0, 200).map((m) => ({ file: basename(m.path), enabled: m.enabled })),
            null,
            2
          )
        }
      }

      case 'launcher_search_resources': {
        const query = argStr(args, 'query')
        const type = argResourceType(args)
        const result = await searchResources({
          source: 'all',
          query,
          limit: 8,
          type,
          gameVersion: argOptStr(args, 'gameVersion'),
          loader: argOptStr(args, 'loader')
        })
        const hits = result.hits.slice(0, 8).map((p) => ({
          project: p.slug,
          title: p.title,
          source: p.source ?? 'modrinth',
          downloads: p.downloads,
          downloadable: p.downloadable !== false,
          summary: (p.description ?? '').slice(0, 120)
        }))
        if (hits.length === 0) return { ok: true, text: `没有搜到匹配的资源：${query}` }
        return { ok: true, text: JSON.stringify(hits, null, 2) }
      }

      case 'launcher_install_resource': {
        const versionId = argStr(args, 'versionId')
        const project = argStr(args, 'project')
        const type = argResourceType(args)
        const source = argSource(args)
        const installed = await listInstalled(gameDir, s.versionIsolation, s.isolatedVersions)
        const entry = installed.find((v) => v.id === versionId)
        if (!entry) return { ok: false, text: `实例不存在：${versionId}（可用 launcher_list_versions 查询）` }
        // 模组要按实例的加载器过滤，否则会把 Forge 模组装进 Fabric 实例；
        // 资源包与光影与加载器无关，只需匹配 MC 版本。
        const loaders = type === 'mod' && entry.loader ? [entry.loader] : []
        const gameVersions = entry.mcVersion ? [entry.mcVersion] : []
        let versions = await resolveVersionsFor(project, source, type, loaders, gameVersions)
        if (versions.length === 0 && !source) {
          // Modrinth 上没有这个项目 / 没有适配版本时兜底 CurseForge；兜底失败沿用空结果。
          try {
            versions = await resolveVersionsFor(project, 'curseforge', type, loaders, gameVersions)
          } catch {
            versions = []
          }
        }
        if (versions.length === 0) {
          const cond = `${entry.mcVersion || '未知版本'}${loaders.length > 0 ? ' / ' + loaders[0] : ''}`
          return {
            ok: false,
            text: `没有找到适配 ${cond} 的文件：${project}（换一个项目，或先用 launcher_search_resources 确认 slug）。`
          }
        }
        const pick = versions.find(
          (v) => v.downloadable !== false && (v.files.find((f) => f.primary) ?? v.files[0])
        )
        const file = pick?.files.find((f) => f.primary) ?? pick?.files[0]
        if (!pick || !file) {
          return { ok: false, text: `该项目的文件不允许第三方渠道下载，请到官网手动下载：${project}` }
        }
        const dest = await installMod(
          file.url,
          file.filename,
          gameDir,
          versionId,
          ctx.isIsolated(versionId),
          type,
          undefined,
          undefined,
          file.size
        )
        return {
          ok: true,
          text: `已安装 ${file.filename} → ${dest}\n项目 ${project}（${pick.name || pick.version_number}，来源 ${pick.source ?? 'modrinth'}），实例 ${versionId}。`
        }
      }

      case 'launcher_delete_version': {
        const versionId = argStr(args, 'versionId')
        const list = await listInstalled(gameDir, s.versionIsolation, s.isolatedVersions)
        if (!list.some((v) => v.id === versionId)) {
          return { ok: false, text: `实例不存在：${versionId}` }
        }
        await deleteVersion(gameDir, versionId)
        return { ok: true, text: `已删除实例 ${versionId}（版本目录与 natives 均已移除）。` }
      }

      case 'launcher_rename_version': {
        const versionId = argStr(args, 'versionId')
        const newName = argStr(args, 'newName')
        const next = await renameVersion(gameDir, versionId, newName)
        return { ok: true, text: `实例已重命名：${versionId} → ${next}` }
      }

      case 'launcher_delete_path': {
        const raw = argStr(args, 'path')
        if (!isAbsolute(raw)) throw new Error('请提供绝对路径')
        const abs = assertInsideGameDir(raw)
        await rm(abs, { recursive: true, force: true })
        return { ok: true, text: `已删除：${abs}` }
      }

      default:
        return { ok: false, text: `工具 ${name} 尚未实现` }
    }
  } catch (err) {
    return { ok: false, text: `执行失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

/** 供设置页展示：把工具清单转成「标题 + 默认策略」的简化结构。 */
export function toolDefaults(): Array<{ name: string; title: string; risk: AiToolSpec['risk'] }> {
  return AI_TOOLS.map((t) => ({ name: t.name, title: t.title, risk: t.risk }))
}

/** 路径拼接辅助：给渲染层拼「实例目录」时用（保持与启动器内部一致）。 */
export function versionDirPath(gameDir: string, versionId: string): string {
  return join(gameDir, 'versions', versionId)
}