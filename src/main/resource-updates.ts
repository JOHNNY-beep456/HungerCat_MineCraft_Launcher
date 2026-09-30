// ---------------------------------------------------------------------------
// 资源更新检测：进入实例管理时在后台比对 Modrinth，判断模组 / 资源包 / 光影有没有新版本。
//
// 判定原则是「宁可漏报，不可误报」——应用更新会删掉旧文件换上新文件，认错项目等于毁掉用户的资源，
// 所以只有同时满足下面三点才判定为「可更新」：
//   1. 能解析出对应的 Modrinth 项目（模组靠 JAR 元数据 id/名称，资源包 / 光影只能靠文件名搜）；
//   2. 能在该项目的版本列表里**定位到本地这一版**（按文件名精确匹配，或按 JAR 声明的版本号匹配）；
//   3. 定位到的位置不是列表里的最新一项（列表按发布时间倒序，index 0 即最新）。
// 定位不到（用户改过文件名、装的根本不是 Modrinth 版本、元数据读不出来）一律不报。
//
// 版本列表按实例的加载器 + 游戏版本过滤，避免把「给别的 MC 版本准备的版本」当成更新。
// 检测结果按「路径 + 体积 + 类型」缓存一段时间，反复进出实例管理不会重复联网。
// ---------------------------------------------------------------------------

import { promises as fsp } from 'fs'
import type {
  ModrinthType,
  ModrinthVersion,
  ResourceFile,
  ResourceUpdateInfo,
  UpdateKind
} from '@shared/types'
import { findProject, findProjectByName, getVersions, installMod } from './modrinth'
import { listResources } from './resources'
import { loadModFiles, mapLimit, packSearchName, resolveVersionDir, type ModMeta } from './manage'

/** 同一条目在这个时间内不重复联网。 */
const CHECK_TTL = 10 * 60 * 1000
/** 检测并发上限：Modrinth 无鉴权接口，压低并发避免被限流。 */
const CHECK_CONCURRENCY = 4

interface CacheEntry {
  at: number
  update: ResourceUpdateInfo | null
}

const resultCache = new Map<string, CacheEntry>()
/** 项目解析结果缓存：模组按元数据 id、资源包 / 光影按搜索名，避免每次进入都重新搜索。 */
const projectCache = new Map<string, ProjectRef | null>()

interface ProjectRef {
  slug: string
  title: string
}

function cacheKey(kind: UpdateKind, path: string, size: number): string {
  return `${kind}\n${path}\n${size}`
}

/** 作废某条路径的检测缓存（文件被替换后调用）。 */
function invalidateCache(path: string): void {
  const suffix = `\n${path}\n`
  for (const key of [...resultCache.keys()]) {
    if (key.includes(suffix)) resultCache.delete(key)
  }
}

/** 解析模组对应的 Modrinth 项目；识别不出返回 null。 */
async function resolveModProject(meta: ModMeta): Promise<ProjectRef | null> {
  const id = (meta.id ?? '').trim()
  const name = (meta.name ?? '').trim()
  if (!id && !name) return null
  const key = `mod:${(id || name).toLowerCase()}`
  const cached = projectCache.get(key)
  if (cached !== undefined) return cached
  const project = await findProject(id, name)
  const ref = project ? { slug: project.slug, title: project.title } : null
  projectCache.set(key, ref)
  return ref
}

/** 解析资源包 / 光影对应的 Modrinth 项目（压缩包里没有可读元数据，只能按文件名搜）。 */
async function resolvePackProject(fileName: string, type: 'resourcepack' | 'shader'): Promise<ProjectRef | null> {
  const search = packSearchName(fileName)
  if (!search) return null
  const key = `${type}:${search.toLowerCase()}`
  const cached = projectCache.get(key)
  if (cached !== undefined) return cached
  const project = await findProjectByName(search, type)
  const ref = project ? { slug: project.slug, title: project.title } : null
  projectCache.set(key, ref)
  return ref
}

/** 在版本列表里定位「本地这一版」：先按文件名精确匹配，再退回 JAR 声明的版本号；找不到返回 -1。 */
function findLocalVersion(versions: ModrinthVersion[], localName: string, declaredVersion: string): number {
  const byFile = versions.findIndex((v) => v.files.some((f) => f.filename === localName))
  if (byFile >= 0) return byFile
  if (declaredVersion) {
    const byNumber = versions.findIndex((v) => v.version_number === declaredVersion)
    if (byNumber >= 0) return byNumber
  }
  return -1
}

interface DetectInput {
  kind: UpdateKind
  /** 本地文件绝对路径。 */
  path: string
  /** 本地真实文件名（模组已剥掉 `.disabled` 后缀）。 */
  localName: string
  size: number
  project: ProjectRef
  /** JAR 元数据里声明的版本号（仅模组有）。 */
  declaredVersion?: string
  loaders: string[]
  gameVersions: string[]
}

/** 判定单个资源是否有更新；已是最新 / 定位不到时返回 null。 */
async function detectUpdate(input: DetectInput): Promise<ResourceUpdateInfo | null> {
  const key = cacheKey(input.kind, input.path, input.size)
  const hit = resultCache.get(key)
  if (hit && Date.now() - hit.at < CHECK_TTL) return hit.update

  let versions: ModrinthVersion[]
  try {
    versions = await getVersions(input.project.slug, input.loaders, input.gameVersions)
  } catch {
    // 联网失败 / 项目不存在：本次无法判定，且不写缓存，下次进入再试。
    return null
  }

  const update = pickUpdate(versions, input)
  resultCache.set(key, { at: Date.now(), update })
  return update
}

function pickUpdate(versions: ModrinthVersion[], input: DetectInput): ResourceUpdateInfo | null {
  if (versions.length === 0) return null
  const index = findLocalVersion(versions, input.localName, input.declaredVersion ?? '')
  // index < 0：列表里没有本地这一版 → 无法确认项目身份，不报（否则可能删错文件）。
  // index === 0：本地就是最新 → 无更新。
  if (index <= 0) return null
  const latest = versions[0]
  const file = latest.files.find((f) => f.primary) ?? latest.files[0]
  if (!file) return null
  return {
    path: input.path,
    kind: input.kind,
    currentVersion: versions[index].version_number,
    latestVersion: latest.version_number,
    fileUrl: file.url,
    filename: file.filename,
    size: file.size,
    slug: input.project.slug,
    title: input.project.title
  }
}

/** 每判定完一项（含无更新项）回调一次，供上层逐个推送给界面。 */
export interface UpdateCheckSink {
  onResult(path: string, kind: UpdateKind, update: ResourceUpdateInfo | null): void
}

/**
 * 检测该实例的模组 / 资源包 / 光影是否有更新。
 *
 * @param mcVersion 实例的 Minecraft 版本号（空串表示未知，此时不按游戏版本过滤）
 * @param loader    实例的加载器（null = 原版，没有模组，跳过模组检测）
 * @returns 全部「确认可更新」的条目（与 sink 推送的内容一致，便于调用方一次性对齐）
 */
export async function checkResourceUpdates(
  gameDir: string,
  versionId: string,
  isolated: boolean,
  mcVersion: string,
  loader: string | null,
  sink: UpdateCheckSink
): Promise<ResourceUpdateInfo[]> {
  const gameVersions = mcVersion ? [mcVersion] : []
  const found: ResourceUpdateInfo[] = []
  const report = (path: string, kind: UpdateKind, update: ResourceUpdateInfo | null): void => {
    if (update) found.push(update)
    sink.onResult(path, kind, update)
  }

  // ---- 模组：靠 JAR 元数据认出项目；原版实例没有模组目录，直接跳过 ----
  if (loader) {
    const dir = resolveVersionDir(gameDir, versionId, isolated, 'mods')
    let loaded: Awaited<ReturnType<typeof loadModFiles>> = []
    try {
      loaded = await loadModFiles(dir)
    } catch {
      loaded = []
    }
    await mapLimit(loaded, CHECK_CONCURRENCY, async ({ mod, meta }) => {
      const project = meta ? await resolveModProject(meta) : null
      const update = project
        ? await detectUpdate({
            kind: 'mod',
            path: mod.path,
            localName: mod.name,
            size: mod.size,
            project,
            declaredVersion: meta?.version,
            loaders: [loader],
            gameVersions
          })
        : null
      report(mod.path, 'mod', update)
    })
  }

  // ---- 资源包 / 光影：按文件名搜项目，再逐版核对 ----
  const packKinds: Array<[UpdateKind, 'resourcepacks' | 'shaderpacks', 'resourcepack' | 'shader']> = [
    ['resourcepack', 'resourcepacks', 'resourcepack'],
    ['shader', 'shaderpacks', 'shader']
  ]
  for (const [kind, dirKind, searchType] of packKinds) {
    let files: ResourceFile[] = []
    try {
      files = await listResources(gameDir, versionId, isolated, dirKind)
    } catch {
      files = []
    }
    await mapLimit(files, CHECK_CONCURRENCY, async (file) => {
      const project = await resolvePackProject(file.name, searchType)
      const update = project
        ? await detectUpdate({
            kind,
            path: file.path,
            localName: file.name,
            size: file.size,
            project,
            loaders: [],
            gameVersions
          })
        : null
      report(file.path, kind, update)
    })
  }

  return found
}

function toModrinthType(kind: UpdateKind): ModrinthType {
  if (kind === 'resourcepack') return 'resourcepack'
  if (kind === 'shader') return 'shader'
  return 'mod'
}

/**
 * 把某个资源更新到最新版：下载新版到同目录 → 删除旧文件。
 *
 * 模组的启用 / 禁用状态会被保留：原本禁用（`.disabled`）的模组，新文件同样以 `.disabled` 落地。
 * 新旧文件同名（重复下载同一个文件）时不删除，避免把刚下好的文件删掉。
 */
export async function applyResourceUpdate(
  gameDir: string,
  versionId: string,
  isolated: boolean,
  update: ResourceUpdateInfo,
  enabled: boolean
): Promise<string> {
  if (!/^https:\/\//i.test(update.fileUrl)) throw new Error('更新地址不合法，已取消更新')
  const disabled = update.kind === 'mod' && !enabled
  const filename = disabled ? `${update.filename}.disabled` : update.filename
  const dest = await installMod(
    update.fileUrl,
    filename,
    gameDir,
    versionId,
    isolated,
    toModrinthType(update.kind)
  )
  if (dest !== update.path) {
    await fsp.rm(update.path, { force: true }).catch(() => {
      /* 旧文件已不存在 / 被占用：更新本身已完成，不再因为删除失败而报错 */
    })
  }
  invalidateCache(update.path)
  invalidateCache(dest)
  return dest
}
