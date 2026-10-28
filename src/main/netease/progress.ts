/**
 * 歌词进度：按 SMTC 标准消费模型推算「此刻唱到第几秒」。
 *
 * ## 标准依据（Microsoft 官方文档）
 *
 * 「手动控制系统媒体传输控件」明确要求播放器：
 *
 * > 建议您通过在播放期间每隔 5 秒更新一次这些属性，并在播放状态变化时
 * > （例如暂停或切换到新位置）再次更新，以保持系统控件与媒体播放的同步。
 *
 *   <https://learn.microsoft.com/zh-cn/windows/uwp/audio-video-camera/system-media-transport-controls>
 *   <https://learn.microsoft.com/zh-cn/windows/apps/develop/media-playback/integrate-with-systemmediatransportcontrols>
 *
 * 即：`Position` + `LastUpdatedTime` 是一组**权威快照**，最多 5 秒陈旧，且暂停 /
 * 拖动 / 切歌必然伴随快照更新。API 参考还明确 `Position` 的语义是
 * 「播放位置，当前为 LastUpdatedTime」——位置必须连同它的时间戳一起解读。
 *
 * 据此，标准的消费方式只有三条规则：
 *
 *   1. **快照可用** → 当前位置 = `Position − StartTime + (now − LastUpdatedTime)`
 *      （播放中补时间差；暂停不补）。这是唯一权威值，直接锚定。
 *   2. **同一份快照被重复采样**（Position 与 LastUpdatedTime 都没变）→ 说明播放器
 *      还没更新，沿本地时钟从锚点外推即可。
 *   3. **时间轴未发布**（全部为零 / 时间戳是哨兵值，网易云暂停时实测如此：
 *      `pos=0 start=0 end=0 updated=FILETIME零值`）→ 位置数据**不存在**，
 *      只同步播放状态，绝不采纳位置。
 *
 * ## 为什么这版没有任何阈值常量
 *
 * 之前几版用「位置差 > 1.5s 才重锚」「倒退 > 1s 必重锚」「暂停时归零可疑」等启发式
 * 猜意图，每个阈值都是新 bug 的来源（两秒一回跳、暂停跳回第一句、拖动回开头失效）。
 * 按标准模型，这些意图区分全部由**数据本身**给出：
 *
 *   · 「暂停归零」= 时间轴未发布（end=0 + 哨兵时间戳）→ 规则 3，不采纳位置；
 *   · 「拖动归零」= 时间轴有效（end>0）且快照更新 → 规则 1，照常锚定到 0；
 *   · 「位置冻结」= 同一快照重复采样 → 规则 2，外推，绝不重锚（两秒回跳的根因）。
 */

/**
 * 判断 `updatedAt` 是否为可用时间戳。
 *
 * 与 `timeline.ts` 的 `isUsableTimestamp` 语义一致。这里**内联了一份**而不是 import：
 * `progress.ts` 会被测试脚本直接以原生 TS 加载，跨文件 import 需要写 `.ts` 扩展名，
 * 而 tsc 又要求 `allowImportingTsExtensions` —— 两边冲突。这个函数只有三行，
 * 内联比为了复用它去改编译配置更划算（`test-lyrics.mjs` 会同时校验两者的行为一致）。
 */
function usableTimestamp(value: number): boolean {
  if (!Number.isFinite(value)) return false
  /** 2000-01-01T00:00:00Z：比这更早的时间戳一定不是「刚才更新过」。 */
  const EPOCH_2000_MS = 946_684_800_000
  return value >= EPOCH_2000_MS
}

/** 快照指纹里的时间戳分量（无效哨兵统一记 0，保证「同样无效」比较为相等）。 */
function stampFingerprint(updatedAt: number): number {
  return usableTimestamp(updatedAt) ? updatedAt : 0
}

/** 歌词进度的锚点状态（纯数据，可安全复制 / 序列化）。 */
export interface ProgressState {
  /** 是否已经有可用的锚点。 */
  anchored: boolean
  /** 锚点处的歌曲内位置（秒）。 */
  basePos: number
  /** 锚点的时刻（epoch ms）。 */
  baseAt: number
  /** 锚点时刻是否处于播放状态。 */
  playing: boolean
  /**
   * 上一次快照的原始 `Position`（**绝对时间轴**，秒）。
   *
   * 只用于「快照是否更新过」的比较，绝不直接当位置用。
   */
  lastSampledPos: number
  /**
   * 上一次快照的 `LastUpdatedTime`（epoch ms；无效哨兵记为 0）。
   *
   * 与 `lastSampledPos` 一起构成快照指纹：两者都没变 = 播放器没更新。
   */
  lastSampledAt: number
}

/**
 * 一次采样的归一化视图（由调用方换算好，本模块只做纯判定）。
 */
export interface ProgressSample {
  /**
   * 换算后的**歌曲内**位置（秒）：已减去 StartTime、按 LastUpdatedTime 补过时间差、
   * 钳到 [0, 时长]。仅当 `timelineValid` 时才有意义。
   */
  songPos: number
  /** 原始 `Position`（绝对时间轴，秒），用于快照指纹。 */
  rawPos: number
  /** 原始 `LastUpdatedTime`（epoch ms，可能是无效哨兵），用于快照指纹。 */
  updatedAt: number
  /** 这次的播放状态（读不到时已由调用方沿用上次已知值）。 */
  isPlaying: boolean
  /** 这次是否真的读到了播放状态（false = 读失败，不等于暂停）。 */
  statusKnown: boolean
  /**
   * 时间轴是否已发布（存在可用的位置信息）。
   *
   * 判据见 `timeline.ts` 的 `isTimelinePublished`：`EndTime > 0`、时间戳可用、
   * 或 `Position > StartTime` 三者任一成立。网易云暂停时三者全无 → false。
   */
  timelineValid: boolean
}

/** 一次判定结果。 */
export type ProgressAction =
  /** 用这次快照重新锚定（首次 / 快照更新）。 */
  | 'anchor'
  /** 位置数据不可用但播放状态变了：丢弃位置、采纳状态，锚点钉在当前推算处。 */
  | 'freeze'
  /** 没有任何新信息（同一快照且状态没变）：什么都不做，继续外推。 */
  | 'ignore'

/** 初始状态（未锚定）。 */
export function initialProgress(): ProgressState {
  return { anchored: false, basePos: 0, baseAt: 0, playing: false, lastSampledPos: 0, lastSampledAt: 0 }
}

/** 按当前锚点推算 `now` 时刻的歌曲内位置（秒）。 */
export function estimateAt(state: ProgressState, now: number): number {
  if (!state.anchored) return 0
  return state.playing ? state.basePos + (now - state.baseAt) / 1000 : state.basePos
}

/**
 * 决定如何处理这次采样（标准消费模型，见文件头）。
 *
 * @param state     当前锚点状态
 * @param sample    归一化采样
 * @param sampledAt 采样时刻（epoch ms）
 */
export function decideProgress(
  state: ProgressState,
  sample: ProgressSample,
  sampledAt: number
): ProgressAction {
  const statusChanged = sample.statusKnown && sample.isPlaying !== state.playing

  /*
   * 规则 3：时间轴未发布 → 位置不存在。
   *
   * 网易云暂停时实测上报 `pos=0 start=0 end=0 updated=FILETIME零值`——这不是
   * 「位置在 0」，而是「没有时间轴」。此时：
   *   · 播放状态变了（正在暂停）→ 采纳状态、位置冻结在当前推算处（freeze）；
   *   · 状态没变 → 什么都不做（ignore），沿用既有锚点。
   * 绝不能把这个 0 当位置锚定 —— 那就是暂停歌词跳回第一句的成因。
   */
  if (!sample.timelineValid) {
    return statusChanged ? 'freeze' : 'ignore'
  }

  // 首个可用快照：直接作为基准。
  if (!state.anchored) return 'anchor'

  /*
   * 快照指纹：Position 与 LastUpdatedTime 都没变 = 播放器没更新。
   *
   * 这是「两秒一回跳」bug 的终结者：位置冻结的旧快照无论采样多少次都不会再被
   * 当成新位置拽回去。
   */
  const fingerprintChanged =
    sample.rawPos !== state.lastSampledPos ||
    stampFingerprint(sample.updatedAt) !== state.lastSampledAt

  /*
   * 播放状态变化：
   *   · 快照也是新的（规范播放器暂停/恢复时会按标准更新时间轴）→ 直接锚到快照；
   *   · 快照没更新（播放器偷懒）→ 在当前推算处停下（暂停）或从原地继续（恢复），
   *     位置用我们自己的外推值，比陈旧快照更接近真实。
   */
  if (statusChanged) {
    return fingerprintChanged ? 'anchor' : 'freeze'
  }

  // 规则 1/2：快照更新了 → 锚定到权威值；没更新 → 外推。
  return fingerprintChanged ? 'anchor' : 'ignore'
}

/**
 * 应用一次锚定，返回新状态（不修改入参）。
 *
 * `sample.songPos` 必须是调用方换算好的歌曲内位置（含时间差补偿与钳制）；
 * 快照指纹记录**原始** `rawPos` / `updatedAt`，供下一次比较。
 */
export function applyAnchor(
  _state: ProgressState,
  sample: ProgressSample,
  sampledAt: number
): ProgressState {
  return {
    anchored: true,
    basePos: sample.songPos,
    baseAt: sampledAt,
    playing: sample.isPlaying,
    lastSampledPos: sample.rawPos,
    lastSampledAt: stampFingerprint(sample.updatedAt)
  }
}

/**
 * 冻结：**丢弃这次不可信的位置**，但采纳它的播放状态，把锚点钉在当前推算位置上。
 *
 * 两个语义必须同时处理：
 *   · 位置丢弃 → 暂停时不会跳回第一句；
 *   · 状态跟上 → 暂停后进度不再推进（否则歌词会继续往下滚）；恢复播放时从原地继续。
 */
export function applyFreeze(
  state: ProgressState,
  playing: boolean,
  sampledAt: number
): ProgressState {
  return {
    anchored: true,
    basePos: estimateAt(state, sampledAt),
    baseAt: sampledAt,
    playing,
    // 位置不可信，快照指纹保持不动，避免下一帧把同一份垃圾当成新快照。
    lastSampledPos: state.lastSampledPos,
    lastSampledAt: state.lastSampledAt
  }
}
