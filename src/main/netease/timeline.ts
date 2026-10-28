/**
 * SMTC 时间轴换算与位置推算。
 *
 * 本文件的所有规则都对照 Microsoft 官方文档，不再靠「猜播放器有没有刷新位置」：
 *
 *   · `Position`     —— 「播放位置，**当前为 LastUpdatedTime**」
 *     <https://learn.microsoft.com/zh-cn/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessiontimelineproperties.position>
 *   · `LastUpdatedTime` —— 「上次更新时间线属性的 UTC 时间」
 *     <https://learn.microsoft.com/zh-cn/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessiontimelineproperties.lastupdatedtime>
 *   · `StartTime` / `EndTime` —— 「当前媒体项的起始 / 结束时间戳」
 *     <https://learn.microsoft.com/zh-cn/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessiontimelineproperties>
 *
 * 这三条合起来说明一件此前被误解的事：
 *
 *   **`Position` 不是「现在的播放位置」，而是「LastUpdatedTime 那一刻的位置」。**
 *
 * 它是一组带时间戳的快照。播放器完全可能长时间不更新这组值（网易云就是如此），
 * 于是连续多次采样读到**同一个 Position 和同一个 LastUpdatedTime** —— 这不是「位置
 * 冻结」，而是快照没变。只要顺着时间戳把差值补上，任何一次采样都能算出准确位置：
 *
 *     当前位置 = Position + (现在 − LastUpdatedTime)
 *
 * 而歌词 LRC 的时间戳从 0 开始，`Position`/`StartTime`/`EndTime` 在时间轴坐标系里，
 * 所以「歌曲内时间」还要减去 `StartTime`：
 *
 *     歌曲内位置 = Position − StartTime + (现在 − LastUpdatedTime)
 *
 * 抽成纯函数便于脱离 Electron 单测。
 */

/** 时间轴字段（全部为秒，`updatedAt` 为 epoch ms）。 */
export interface TimelineFields {
  /** 绝对时间轴起点（秒）。 */
  start: number
  /** `LastUpdatedTime` 那一刻的播放位置（绝对时间轴，秒）。 */
  pos: number
  /** 绝对时间轴终点（秒）。 */
  end: number
  /**
   * `Position` 对应的实际时刻（epoch ms）。
   *
   * 0 / 缺失表示播放器没给这个值（旧版 Windows 或客户端没上报），此时只能把
   * `pos` 当作「采样那一刻的位置」来近似 —— 见 `songPositionAt` 的说明。
   */
  updatedAt: number
}

/** 把 `StartTime` 归一：非法 / 负值一律按 0（绝大多数媒体就是 0）。 */
function safeStart(start: number): number {
  return Number.isFinite(start) && start > 0 ? start : 0
}

/**
 * 歌曲内时间（秒）：`Position − StartTime`，夹到 `>= 0`。
 *
 * 注意这是「LastUpdatedTime 那一刻」的歌曲内位置；要拿**当前**位置请用
 * `songPositionAt`（它会把时间差补上）。
 */
export function toSongTime(session: Pick<TimelineFields, 'pos' | 'start'>): number {
  const pos = Number.isFinite(session.pos) && session.pos > 0 ? session.pos : 0
  return Math.max(0, pos - safeStart(session.start))
}

/**
 * 歌曲真实时长（秒）：`EndTime − StartTime`，夹到 `>= 0`。
 *
 * 0 表示「未知」——调用方据此跳过末尾钳制与时长匹配。
 */
export function toSongDuration(session: Pick<TimelineFields, 'end' | 'start'>): number {
  const end = Number.isFinite(session.end) && session.end > 0 ? session.end : 0
  if (end <= 0) return 0
  return Math.max(0, end - safeStart(session.start))
}

/**
 * 判断 `updatedAt` 是否为「播放器给的无效哨兵值」。
 *
 * 实机采样发现：网易云在暂停时会给出
 *
 *     status=Paused, pos=0, start=0, end=0, updated=-11644473600000
 *
 * 其中 `updated = -11644473600000` 正是 **1601-01-01**（Windows FILETIME 纪元）对应的
 * Unix 毫秒值 —— 也就是 `.NET DateTimeOffset` 的零值/MinValue。它表示「这个字段没有
 * 有意义的值」，绝不能被当成真实时间戳去参与外推（那会把位置推到几百年之外）。
 *
 * 判据：非有限数、`<= 0`、或早于 2000-01-01（`946684800000`）的都视为无效。
 * 用「早于 2000 年」这个宽松下界，既能挡住 FILETIME 零值，也能挡住各种 `DateTime.MinValue`
 * 变体，又不可能误伤任何真实使用场景。
 */
export function isUsableTimestamp(value: number): boolean {
  if (!Number.isFinite(value)) return false
  /** 2000-01-01T00:00:00Z：比这更早的时间戳一定不是「刚才更新过」。 */
  const EPOCH_2000_MS = 946_684_800_000
  return value >= EPOCH_2000_MS
}

/**
 * 按官方语义推算 `now` 时刻的**歌曲内**播放位置（秒）。
 *
 * @param session        一次时间轴采样
 * @param now            要推算到哪个时刻（epoch ms）
 * @param assumePlaying  假定这段区间内在播放（暂停时为 false，不推进时间）
 *
 * 关键点：`Position` 是 `LastUpdatedTime` 时刻的快照，所以两者之间的时间差要补上。
 * 这比「拿采样值和上一次采样值比、猜有没有刷新」可靠得多：
 *   · 播放器长时间不更新快照（网易云常态）→ 时间差自然把位置推到正确处；
 *   · 播放器刚好更新了快照 → 时间差很小，结果同样正确；
 *   · 拖动进度 / 切歌 → 新快照的 Position 变了，直接采用即可。
 *
 * `updatedAt` 无效（含 FILETIME 零值哨兵）时退化为「把 pos 当作采样时刻的位置」，
 * 即不补时间差 —— 这是最保守的做法，不会把位置推飞。
 */
export function songPositionAt(
  session: Pick<TimelineFields, 'pos' | 'start' | 'updatedAt'>,
  now: number,
  assumePlaying = true
): number {
  const base = toSongTime(session)
  if (!assumePlaying || !isUsableTimestamp(session.updatedAt)) return base
  // 只补「从现在往回看」的正向差值：LastUpdatedTime 理论上不会晚于采样时刻，
  // 若因时钟差异晚了一点，按 0 处理（不倒退）。
  const elapsed = Math.max(0, now - session.updatedAt) / 1000
  return base + elapsed
}

/**
 * 判断这次采样是否**发布了时间轴**（即存在可用的位置信息）。
 *
 * 标准要求播放器「在播放期间每隔 5 秒更新一次时间轴属性，并在播放状态变化时再次
 * 更新」（见文件头引用）。规范播放器任何时候都有完整时间轴；而实测网易云在暂停时
 * 会把整组清零：
 *
 *     status=Paused, pos=0, start=0, end=0, updated=-11644473600000
 *
 * 这不是「位置在 0」，而是「没有时间轴可读」。区分两者的意义：
 *
 *   · 时间轴有效 + 位置 0 → 用户真的拖回了开头，必须采纳；
 *   · 时间轴未发布 + 位置 0 → 位置数据不存在，绝不能当位置用（否则暂停歌词跳回第一句）。
 *
 * 判据（三者任一成立即视为已发布）：
 *   1. `EndTime > 0`        —— 有终点，说明播放器给过完整时间轴；
 *   2. `LastUpdatedTime` 可用 —— 有真实更新时刻，说明快照曾被写入；
 *   3. `Position > StartTime` —— 位置本身大于起点（startTime 非零的流式媒体可能 1/3 都不满足，
 *      但它是最直接的「有位置」证据，作为兜底）。
 */
export function isTimelinePublished(
  session: Pick<TimelineFields, 'pos' | 'start' | 'end' | 'updatedAt'>
): boolean {
  const start = Number.isFinite(session.start) && session.start > 0 ? session.start : 0
  const pos = Number.isFinite(session.pos) && session.pos > 0 ? session.pos : 0
  const end = Number.isFinite(session.end) && session.end > 0 ? session.end : 0
  return end > 0 || isUsableTimestamp(session.updatedAt) || pos > start
}
