// ---------------------------------------------------------------------------
// MC百科 名称匹配的纯函数（无 electron / 网络依赖，便于单测）。
//
// 与 mcmod.ts 的关系：mcmod.ts 负责网络编排（经网络进程抓取），这里只做
// 「名称归一化 / 映射构建 / 应用」这类纯计算，因此可以脱离 Electron 直接测试。
// ---------------------------------------------------------------------------

import type { McmodHit, ModrinthProject } from '@shared/types'

/** 归一化名称：只留字母数字与中日韩字符，用于跨来源匹配（大小写/标点/空格不敏感）。 */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 查询是否包含中日韩文字（用于判断「可能是译名」）。 */
export function hasCjk(s: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(s)
}

/**
 * 把一次 MC百科 查询整理成「归一化名称 → 中文名/地址」的映射。
 * 原文名与中文名都登记：前者用于「英文标题 → 译名」，后者用于「中文标题 → 译名」。
 *
 * **首次写入优先**（不是覆盖）：MC百科 搜索结果按相关度排序，越靠前越可信。
 * 实测搜 `sodium` 时会返回大量「链接指向无关条目、但锚文本恰好写成 `(<em>Sodium</em>)`」
 * 的条目（如 `Acedium Sodiumized (<em>Sodium</em>)`），它们排在真正的「钠」之后。
 * 若用「后写覆盖」，`sodium` 这个键就会被最后那条垃圾数据（Acedium Sodiumized）抢走，
 * 导致搜索页显示错误的译名——这正是「资源下载不显示译名/显示乱译名」的根因。
 * 因此这里只在该键尚未登记时才写入。
 */
export function buildNameMap(hits: McmodHit[]): Map<string, { nameZh: string; url: string }> {
  const map = new Map<string, { nameZh: string; url: string }>()
  for (const h of hits) {
    const value = { nameZh: h.nameZh, url: h.url }
    // 原文名：只有它确实是非空、且与中文名不同才登记，避免把中文名当成英文键。
    const enKey = normalizeName(h.nameEn)
    if (enKey && !map.has(enKey)) map.set(enKey, value)
    // 中文名：同样首次优先。
    const zhKey = normalizeName(h.nameZh)
    if (zhKey && !map.has(zhKey)) map.set(zhKey, value)
  }
  return map
}

/** 用名称映射给项目补 `translatedName` / `mcmodUrl`（已填过的不覆盖）。 */
export function applyNameMap(
  projects: ModrinthProject[],
  map: Map<string, { nameZh: string; url: string }>
): void {
  for (const p of projects) {
    if (p.translatedName) continue
    const hit = map.get(normalizeName(p.title)) ?? map.get(normalizeName(p.slug))
    if (hit) {
      p.translatedName = hit.nameZh
      p.mcmodUrl = hit.url
    }
  }
}

/**
 * 中文查询时挑出「原文名」，作为补充检索词。
 *
 * 只在 MC百科 的结果**与查询确实相关**时才采纳，否则返回 null：
 *   1. 有中文名与查询精确相等 → 直接用它的原文名；
 *   2. 否则若第一条的中文名与查询互为包含（如「机械动」→「机械动力」）→ 采纳；
 *   3. 都不满足（例如搜了不存在的词，MC百科 仍会返回一堆无关结果）→ 返回 null，
 *      避免把无关结果也塞进官方源检索里。
 */
export function pickEnglishQuery(hits: McmodHit[], query: string): string | null {
  if (!hasCjk(query)) return null
  const normQ = normalizeName(query)
  if (!normQ) return null
  const exact = hits.find((h) => normalizeName(h.nameZh) === normQ)
  let chosen = exact ?? null
  if (!chosen) {
    const first = hits[0]
    const normZh = first ? normalizeName(first.nameZh) : ''
    if (first && normZh && (normZh.includes(normQ) || normQ.includes(normZh))) chosen = first
  }
  if (!chosen) return null
  const en = chosen.nameEn?.trim()
  if (!en || normalizeName(en) === normQ || hasCjk(en)) return null
  return en
}

/** 按名称挑最佳匹配（中文名或原文名归一化后相等优先，否则第一条）。 */
export function pickBestHit(hits: McmodHit[], name: string): McmodHit | null {
  if (hits.length === 0) return null
  const norm = normalizeName(name)
  return (
    hits.find((h) => normalizeName(h.nameEn) === norm) ??
    hits.find((h) => normalizeName(h.nameZh) === norm) ??
    hits[0]
  )
}
