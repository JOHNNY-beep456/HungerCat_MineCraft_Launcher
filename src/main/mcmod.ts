// ---------------------------------------------------------------------------
// MC百科（mcmod.cn）中文元数据服务。
//
// 作用：为 Modrinth / CurseForge 的资源补上**中文名（译名）**，并支持「按译名搜索」
// —— 中文查询词先经 MC百科解析成原文名，再拿去官方源检索。
//
// 分工：真正的网络抓取在网络进程（`mcmod:search`），本模块只负责编排；
// 名称归一化 / 映射等纯计算在 mcmod-util.ts（无 Electron 依赖，可单测）。
//
// 开关：`社区资源来源` 选「尽量使用官方源」时不查询 MC百科（见 shouldUseMcmod）。
// 任何失败都被吞掉并降级为「没有中文名」，绝不影响正常搜索/下载。
// ---------------------------------------------------------------------------

import type { McmodHit, ModrinthProject } from '@shared/types'
import { netRequest } from './broker'
import { shouldUseMcmod } from './mirror'
import { applyNameMap, buildNameMap, pickBestHit, pickEnglishQuery } from './mcmod-util'

export { applyNameMap, buildNameMap, hasCjk, normalizeName } from './mcmod-util'

/** 搜索 MC百科；失败或无结果返回空数组（不抛错，调用方无需 try）。 */
export async function searchMcmod(query: string, signal?: AbortSignal): Promise<McmodHit[]> {
  const q = query.trim()
  if (!q) return []
  if (!shouldUseMcmod()) return []
  try {
    return await netRequest<McmodHit[]>('mcmod:search', { query: q }, { signal })
  } catch {
    return []
  }
}

/**
 * 一次 MC百科 查询同时完成两件事（**只发一次 HTTP**）：
 *   1. 把结果补进 `projects` 的 `translatedName` / `mcmodUrl`；
 *   2. 若查询是中文，返回解析出的原文名，供调用方再去官方源检索。
 *
 * 返回原始 `hits` 与 `extraQueries`：调用方拿到补充检索的结果后，可用
 * `applyNameMap(..., buildNameMap(hits))` 复用同一份映射补译名，无需二次请求。
 */
export async function enrichWithMcmod(
  projects: ModrinthProject[],
  query: string,
  signal?: AbortSignal
): Promise<{ hits: McmodHit[]; extraQueries: string[] }> {
  if (!shouldUseMcmod()) return { hits: [], extraQueries: [] }
  const hits = await searchMcmod(query, signal)
  if (hits.length === 0) return { hits: [], extraQueries: [] }
  applyNameMap(projects, buildNameMap(hits))
  const en = pickEnglishQuery(hits, query)
  return { hits, extraQueries: en ? [en] : [] }
}

/**
 * 按名称查 MC百科并返回最佳匹配的译名（用于已安装模组的译名补全）。
 */
export async function lookupMcmodName(
  name: string,
  signal?: AbortSignal
): Promise<{ nameZh: string; url: string } | null> {
  const hits = await searchMcmod(name, signal)
  const best = pickBestHit(hits, name)
  return best?.nameZh ? { nameZh: best.nameZh, url: best.url } : null
}
