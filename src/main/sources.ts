// ---------------------------------------------------------------------------
// 资源来源编排：**Modrinth 优先，拿不到再用 CurseForge 补**。
//
// 这是「全面接入 CurseForge」的统一入口：搜索、按项目识别（元数据补齐）、版本列表
// 三条链路都走这里，调用方不需要关心来源。规则：
//   * 搜索：source = modrinth / curseforge 时只查对应来源；all 时两边都查再合并去重
//     （Modrinth 结果在前），这样默认视图也能看到 CurseForge 独有的资源。
//   * 识别（按 id/名称找项目）：先 Modrinth，命中即返回；没命中且配了 CurseForge KEY
//     时才去 CurseForge 找。找不到一律返回 null，绝不猜——下游的「更新检测」会据此
//     删旧装新，认错项目代价很大。
//   * 版本列表：按项目自带的 source 分派，调用方不用判断。
//
// 未配置 CurseForge KEY 时全部退化为原来的纯 Modrinth 行为（不报错、不影响使用）。
// ---------------------------------------------------------------------------

import type {
  ModSource,
  ModrinthProject,
  ModrinthSearchResult,
  ModrinthType,
  ModrinthVersion,
  SourceFilter
} from '@shared/types'
import {
  fetchProject as mrFetchProject,
  findProject as mrFindProject,
  findProjectByName as mrFindProjectByName,
  getVersions as mrGetVersions,
  searchMods as mrSearchMods
} from './modrinth'
import { cfProjectDetail, cfSearch, cfVersions } from './curseforge'
import { defaultCurseforgeKey } from './curseforge-key'
import { applyNameMap, buildNameMap, enrichWithMcmod, lookupMcmodName } from './mcmod'
import { shouldUseMcmod } from './mirror'

/** 当前是否配了 CurseForge KEY（没配就完全不碰 CurseForge）。 */
export function hasCurseforge(): boolean {
  return defaultCurseforgeKey() !== ''
}

/** 归一化用于比较：只留字母数字。 */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/** 项目唯一键：来源 + slug（两个源的 slug 空间不重叠，但显式带上来源更保险）。 */
function keyOf(p: ModrinthProject): string {
  return `${p.source ?? 'modrinth'}:${p.slug}`
}

/* ------------------------------ 搜索 ------------------------------ */

/**
 * 按来源搜索资源。
 * @param category 本启动器的类别名；两侧都会套用（CurseForge 侧按 classId 翻译成
 *   categoryId，见 curseforge.ts 的 CATEGORY_ID）。没有对应映射的类别在 CurseForge
 *   一侧不额外过滤。
 *
 * 额外：接入 MC百科以提供中文名（译名），并支持「原名 / 译名均可搜」——
 * 中文查询词会先经 MC百科解析出原文名，再补一次官方检索。见 mcmod.ts。
 */
export async function searchResources(opts: {
  source: SourceFilter
  query: string
  limit: number
  type: ModrinthType
  category?: string
  gameVersion?: string
  loader?: string
  offset?: number
}): Promise<ModrinthSearchResult> {
  // 1) 主查询
  const primary = await searchOnce(opts, opts.query)

  // 2) MC百科：补中文名；中文查询时顺便解析出原文名
  const { hits: mcHits, extraQueries } = await enrichWithMcmod(primary.hits, opts.query)

  // 3) 译名命中：用解析出的原文名补一次官方检索并合并（译名也能搜到）
  if (extraQueries.length > 0) {
    const map = buildNameMap(mcHits)
    for (const q of extraQueries) {
      const extra = await searchOnce(opts, q)
      applyNameMap(extra.hits, map)
      for (const p of extra.hits) {
        const key = keyOf(p)
        if (primary.seen.has(key)) continue
        primary.seen.add(key)
        primary.hits.push(p)
      }
      primary.totalHits += extra.totalHits
    }
  }

  return { hits: primary.hits, totalHits: primary.totalHits }
}

/** 单次查询（不含 MC百科 编排）：Modrinth / CurseForge 合并去重。 */
async function searchOnce(
  opts: {
    source: SourceFilter
    limit: number
    type: ModrinthType
    category?: string
    gameVersion?: string
    loader?: string
    offset?: number
  },
  query: string
): Promise<ModrinthSearchResult & { seen: Set<string> }> {
  const wantModrinth = opts.source === 'all' || opts.source === 'modrinth'
  const wantCf = (opts.source === 'all' || opts.source === 'curseforge') && hasCurseforge()

  const tasks: Array<Promise<ModrinthSearchResult>> = []
  if (wantModrinth) {
    tasks.push(
      mrSearchMods(
        query,
        opts.limit,
        opts.type,
        opts.category,
        opts.gameVersion,
        opts.loader,
        opts.offset ?? 0
      )
    )
  }
  if (wantCf) {
    tasks.push(
      cfSearch(defaultCurseforgeKey(), {
        query,
        limit: opts.limit,
        type: opts.type,
        category: opts.category,
        gameVersion: opts.gameVersion,
        loader: opts.loader,
        offset: opts.offset
      })
    )
  }
  // 单来源时直接透传（保留原始报错，界面才能提示「KEY 无效」这类具体原因）
  if (tasks.length === 1) {
    const r = await tasks[0]
    return { ...r, seen: new Set(r.hits.map(keyOf)) }
  }
  if (tasks.length === 0) return { hits: [], totalHits: 0, seen: new Set<string>() }

  // 合并：Modrinth 在前；CurseForge 失败不影响整体（例如 KEY 过期时仍能看到 Modrinth 结果）
  const [mr, cf] = await Promise.all([
    tasks[0].catch(() => ({ hits: [], totalHits: 0 }) as ModrinthSearchResult),
    tasks[1].catch(() => ({ hits: [], totalHits: 0 }) as ModrinthSearchResult)
  ])
  const seen = new Set(mr.hits.map(keyOf))
  const merged = [...mr.hits]
  for (const p of cf.hits) {
    const k = keyOf(p)
    if (seen.has(k)) continue
    seen.add(k)
    merged.push(p)
  }
  return { hits: merged, totalHits: mr.totalHits + cf.totalHits, seen }
}

/* ------------------------------ 识别项目 ------------------------------ */

/**
 * 按「项目标识 + 名称」识别项目（模组元数据补齐用：JAR 里的 modId / 显示名）。
 * Modrinth 优先，未命中再试 CurseForge。
 */
export async function resolveProjectByIdentity(
  modId: string,
  name: string,
  type: ModrinthType = 'mod'
): Promise<ModrinthProject | null> {
  const hit = await mrFindProject(modId, name, type)
  if (hit) return withTranslated({ ...hit, source: 'modrinth' })
  if (!hasCurseforge()) return null
  const query = (name && name.trim()) || (modId && modId.trim())
  if (!query) return null
  return withTranslated(await cfFindProject(query, modId, type))
}

/**
 * 按名称识别项目（资源包 / 光影元数据补齐用：压缩包里没有可读元数据，只能靠文件名搜）。
 * Modrinth 优先，未命中再试 CurseForge。
 */
export async function resolveProjectByName(name: string, type: ModrinthType): Promise<ModrinthProject | null> {
  const hit = await mrFindProjectByName(name, type)
  if (hit) return withTranslated({ ...hit, source: 'modrinth' })
  if (!hasCurseforge()) return null
  return withTranslated(await cfFindProject(name, '', type))
}

/**
 * 给已识别的项目补中文译名（MC百科）。
 *
 * 只在「社区资源来源」允许查 MC百科时进行；任何失败都降级为「无译名」，
 * 绝不影响项目识别本身（识别失败才是致命问题，译名只是锦上添花）。
 */
async function withTranslated(project: ModrinthProject | null): Promise<ModrinthProject | null> {
  if (!project || !shouldUseMcmod() || project.translatedName) return project
  const zh = await lookupMcmodName(project.title || project.slug)
  if (zh) {
    project.translatedName = zh.nameZh
    project.mcmodUrl = zh.url
  }
  return project
}

/**
 * 在 CurseForge 里按名称找项目。
 *
 * 这里刻意从严：只在「标题或 slug 与查询词完全一致」或「标题包含全部查询词」时才认，
 * 否则返回 null。原因同 Modrinth 那侧（findProjectByName 的长注释）——搜索结果里
 * 常在简介中出现关键词就命中，宽松匹配会给资源挂上毫不相干的项目名，而更新检测会
 * 据此删掉用户的文件。
 */
async function cfFindProject(query: string, modId: string, type: ModrinthType): Promise<ModrinthProject | null> {
  const key = defaultCurseforgeKey()
  const tokens = words(query)
  if (tokens.length === 0) return null
  // 逐级放宽：先完整名称，再逐步丢掉结尾的词（版本号 / 括号备注通常在结尾）
  for (let take = tokens.length; take >= 1; take--) {
    const level = tokens.slice(0, take)
    let hits: ModrinthProject[]
    try {
      const r = await cfSearch(key, { query: level.join(' '), limit: 8, type })
      hits = r.hits
    } catch {
      return null
    }
    if (hits.length === 0) continue
    const id = squash(modId)
    const exact = hits.find(
      (h) => squash(h.title) === squash(level.join(' ')) || squash(h.slug) === squash(level.join(' ')) || (id && squash(h.slug) === id)
    )
    if (exact) return exact
    // 标题里含全部查询词才算匹配（避免「简介里提了一句」的误配）
    const qualified = hits.filter((h) => {
      const target = [...words(h.title), ...words(h.slug)]
      return level.every((q) => target.some((t) => t === q || (q.length >= 3 && t.length >= 3 && (t.startsWith(q) || q.startsWith(t)))))
    })
    if (qualified.length === 0) continue
    // 多个候选时取下载量最高的（同名衍生项目通常排在前面）
    return qualified.sort((a, b) => b.downloads - a.downloads)[0]
  }
  return null
}

/* ------------------------------ 版本列表 ------------------------------ */

/** 取项目的版本列表：按项目来源自动分派（CurseForge 项目不会去请求 Modrinth）。 */
export async function resolveVersions(
  project: ModrinthProject,
  loaders: string[],
  gameVersions: string[]
): Promise<ModrinthVersion[]> {
  return resolveVersionsFor(project.slug, project.source, projectTypeOf(project), loaders, gameVersions)
}

/** 同上，但按「slug + 来源 + 类型」分派，供只拿到 slug 的调用方使用（如更新检测）。 */
export async function resolveVersionsFor(
  slug: string,
  source: ModSource | undefined,
  type: ModrinthType,
  loaders: string[],
  gameVersions: string[]
): Promise<ModrinthVersion[]> {
  if (source === 'curseforge') {
    return cfVersions(defaultCurseforgeKey(), slug, loaders, gameVersions, type)
  }
  const versions = await mrGetVersions(slug, loaders, gameVersions)
  return versions.map((v) => ({ ...v, source: 'modrinth' as const }))
}

/** 从项目 DTO 反推本启动器的资源类型（用于 CurseForge 的 classId / 目录判定）。 */
export function projectTypeOf(project: ModrinthProject): ModrinthType {
  const t = project.project_type
  if (t === 'resourcepack' || t === 'shader' || t === 'modpack' || t === 'mod') return t
  return 'mod'
}

/** 取项目详情（「完整介绍」弹窗）：Modrinth 优先，未命中再试 CurseForge。 */
export async function resolveProjectDetail(idOrSlug: string, type: ModrinthType): Promise<unknown> {
  if (hasCurseforge() && /^\d+$/.test(idOrSlug.trim())) {
    // 纯数字不可能是 Modrinth 的 slug，直接走 CurseForge，省一次必然失败的请求
    return cfProjectDetail(defaultCurseforgeKey(), idOrSlug, type)
  }
  try {
    return await mrFetchProject(idOrSlug)
  } catch (err) {
    if (!hasCurseforge()) throw err
    return cfProjectDetail(defaultCurseforgeKey(), idOrSlug, type)
  }
}
