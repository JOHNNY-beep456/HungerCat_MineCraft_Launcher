// ---------------------------------------------------------------------------
// 公告筛选（纯逻辑，不依赖 Electron / React，便于单测）。
//
// 服务端下发全部公告，由启动器按「展示范围（全部 / 仅重要）」与「展示时机」决定
// 本次启动要弹哪些：
//   - every-launch                每次开启都展示；
//   - first-launch-after-publish  发布后（或再次发布后）首次开启时展示一次，
//                                 依据 seen（id → 展示时的发布时间）去重。
// ---------------------------------------------------------------------------

import type { Announcement } from '@shared/types'

export interface AnnouncementFilterOptions {
  /** 展示范围：all 全部 / important-only 仅重要。 */
  display: 'all' | 'important-only'
  /** 已展示过的公告：id → 展示时的发布时间。 */
  seen: Record<string, number>
}

/** 规范化一条服务端公告：补齐缺省字段、丢弃明显无效的条目。 */
export function normalizeAnnouncement(raw: Announcement): Announcement | null {
  if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) return null
  const publishedAt = Number.isFinite(raw.publishedAt) ? Number(raw.publishedAt) : 0
  return {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    important: raw.important === true,
    timing: raw.timing === 'first-launch-after-publish' ? 'first-launch-after-publish' : 'every-launch',
    publishedAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : undefined
  }
}

/**
 * 从服务端公告中筛选出「本次启动应展示」的公告。
 * 结果按「重要优先、其次发布时间倒序」排序，保证重要公告排在最前。
 */
export function selectPendingAnnouncements(
  list: readonly Announcement[],
  opts: AnnouncementFilterOptions
): Announcement[] {
  const picked: Announcement[] = []
  for (const raw of list) {
    const a = normalizeAnnouncement(raw)
    if (!a) continue
    if (opts.display === 'important-only' && !a.important) continue
    if (a.timing === 'first-launch-after-publish' && opts.seen[a.id] === a.publishedAt) continue
    picked.push(a)
  }
  return picked.sort((a, b) => Number(b.important) - Number(a.important) || b.publishedAt - a.publishedAt)
}

/** 关闭公告后要并入 announcementSeen 的增量：记录每条公告当前的发布时间。 */
export function seenPatch(list: readonly Announcement[]): Record<string, number> {
  const patch: Record<string, number> = {}
  for (const a of list) patch[a.id] = a.publishedAt
  return patch
}
