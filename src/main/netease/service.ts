/**
 * 网易云歌词浮层服务（主进程）。
 *
 * 职责：把「系统媒体会话的播放状态」+「网易云歌词接口」合成**一句当前歌词**，
 * 推给 HUD 窗口。三层分工：
 *   · `smtc.ts`   —— 每 0.4 秒采样一次系统媒体会话（谁在放、放到第几秒）；
 *   · `lyrics.ts` —— 曲名 / 歌手 / 时长 → 带时间轴的 LRC；
 *   · 本文件      —— 换歌检测、歌词缓存、进度外推、逐句定位、状态推送。
 *
 * 两个关键设计：
 *
 * 1. **进度由自己外推，不照抄采样值。** SMTC 的 `Position` 由播放器按需上报，
 *    两次采样之间可能完全不动（网易云就是只在暂停 / 拖动时刷新）。直接拿它算
 *    「唱到哪一句」会让歌词一句一卡。所以这里以采样值为锚点（`basePos` / `baseAt`），
 *    用本地时钟按 1x 推进；只有和采样值偏差超过 1.5 秒（拖动进度、切换播放）才重新锚定。
 *
 * 2. **只推「变了就推」。** 250ms 一次的定时器算出三行歌词，与上次推送的内容一致就
 *    不发 IPC —— 歌词通常 3–5 秒才换一句，实际 IPC 频率极低，而逐句跟进的精度仍在
 *    250ms 以内。
 */

import type { NeteaseLyricsState } from '@shared/types'
import { settings } from '../store'
import { fetchLyrics, locateLineIndex, normalizeName, type LyricLine } from './lyrics'
import {
  applyAnchor,
  applyFreeze,
  decideProgress,
  estimateAt,
  initialProgress,
  type ProgressSample,
  type ProgressState
} from './progress'
import { isSmtcSupported, startSmtcPoller, type SmtcSample, type SmtcSession } from './smtc'
import { isTimelinePublished, songPositionAt, toSongDuration } from './timeline'

/**
 * 只认 AUMID 里带这些片段的媒体会话。
 *
 * 网易云音乐（Windows 客户端）的 AUMID 形如 `Netease.CloudMusic` / `cloudmusic.exe`，
 * 不同版本、不同安装方式不完全一致，所以按关键词匹配；顺带兼容「网易云」早期
 * 用域名当 AUMID 的情形。系统里同时开着浏览器 / 其它播放器时，这一层负责把它们挡掉。
 */
const NETEASE_AUMID = /cloudmusic|netease|wangyiyun/i

/** 逐句同步的节拍：250ms 足够跟住歌词，又不至于让定时器成为负担。 */
const TICK_MS = 250

/** 网络类失败后的重试间隔（同一首歌不反复打接口）。 */
const RETRY_MS = 30_000

/** 歌词缓存上限：来回切歌时不重复打接口，又不至于无限占内存。 */
const LYRIC_CACHE_MAX = 12

export interface NeteaseLyricsHooks {
  /** 把最新快照推给 HUD 窗口（窗口可能不存在，由调用方判断）。 */
  push(state: NeteaseLyricsState): void
}

export interface NeteaseLyricsService {
  /** 按当前设置 / 运行模式重新对表：该开就开、该关就关（幂等）。 */
  sync(): void
  /** 当前快照：HUD 窗口刚建好时补推一次。 */
  current(): NeteaseLyricsState
  /**
   * 手动校准：把当前句向上（-1）/ 向下（+1）移一行并重锚。
   *
   * 网易云的 SMTC 不发布时间轴（实测播放 / 暂停 / 拖动都是全零 + 哨兵），
   * 进度只能本地外推，用户中途加入 / 拖动过的漂移不可检测 —— 这是唯一对齐手段。
   */
  nudge(direction: -1 | 1): void
  /** 退出前收尾（停子进程 / 清定时器）。 */
  dispose(): void
}

/** 「不显示」的快照（开关关掉 / 非 Windows）。 */
function offState(): NeteaseLyricsState {
  return { enabled: false, status: 'off', title: '', artist: '', source: '', prev: '', current: '', next: '' }
}

/** 「开着但没在放」：HUD 不渲染卡片，但内部状态已就绪。 */
function idleState(): NeteaseLyricsState {
  return { enabled: false, status: 'idle', title: '', artist: '', source: '', prev: '', current: '', next: '' }
}

/** 从一次采样里挑出网易云的会话：优先正在播放的那条，其次暂停中的。 */
function pickNeteaseSession(sessions: SmtcSession[]): SmtcSession | null {
  const matched = sessions.filter(
    (item) => NETEASE_AUMID.test(item.aumid) && (item.title.trim() || item.artist.trim())
  )
  if (matched.length === 0) return null
  const playing = matched.find((item) => item.status === 'Playing')
  return playing ?? matched[0]
}

/**
 * 歌曲身份：标题 + 歌手 + 时长。
 *
 * 两条稳定性要求（都来自实际故障）：
 *
 * 1. **时长读不到时不能当成「换了首歌」。** 改成占位 `?` 仍不够 —— 先读到 326、
 *    下一次读到 0，key 还是会从 `…|326` 变成 `…|?`，照样触发换歌。所以身份判定
 *    改成「标题 + 歌手」为主：时长只在**两边都读到**时才参与比较（见 `sameSong`），
 *    这里保留它只是为了区分「同名不同版本」的极端情况。
 *
 * 2. **取整到秒。** 播放器上报的时长可能有小数抖动（326.0 / 326.4），不取整会让
 *    同一首歌每隔几次采样就换一次 key。
 */
function songKeyOf(session: SmtcSession): string {
  const duration = toSongDuration(session)
  const shown = duration > 0 ? String(Math.round(duration)) : '?'
  return [normalizeName(session.title), normalizeName(session.artist), shown].join('|')
}

/**
 * 判断两次采样是否**仍是同一首歌**。
 *
 * 与直接比 `songKeyOf` 的字符串不同，这里对「时长读不到」做了宽容处理：
 *   · 标题 / 歌手不同 → 一定是换了歌；
 *   · 标题 / 歌手相同，且两边时长都读到了、但差得多（> 5 秒）→ 认为是同名不同版本；
 *   · 其余情况（含任一方时长没读到）→ 仍算同一首歌，避免因一次读失败就重载歌词。
 */
function sameSong(a: SmtcSession | null, b: SmtcSession): boolean {
  if (!a) return false
  if (normalizeName(a.title) !== normalizeName(b.title)) return false
  if (normalizeName(a.artist) !== normalizeName(b.artist)) return false
  // 比较真实时长（都已减去各自时间轴起点）；任一方读不到就不参与判定。
  const da = toSongDuration(a)
  const db = toSongDuration(b)
  if (da > 0 && db > 0 && Math.abs(da - db) > 5) return false
  return true
}

export function createNeteaseLyricsService(hooks: NeteaseLyricsHooks): NeteaseLyricsService {
  let running = false
  let stopPoller: (() => void) | null = null
  let timer: NodeJS.Timeout | null = null

  let state: NeteaseLyricsState = offState()
  /** 上次真正推出去的内容：用它判断「这次算出来的是不是同一份」。 */
  let emitted = JSON.stringify(state)

  /* ---- 当前曲目与歌词 ---- */
  let session: SmtcSession | null = null
  let songKey = ''
  let lines: LyricLine[] = []
  /** 取歌词的并发令牌：换歌 / 关闭时自增，回来的旧结果直接丢弃。 */
  let fetchToken = 0
  /** 是否已有请求在路上（避免重试与换歌各打一次接口）。 */
  let fetching = false
  /** 网络失败后的重试时间点（0 = 不重试）。 */
  let retryAt = 0
  /** 上一次记录过的「其它媒体会话」AUMID 组合（只用于日志去重）。 */
  let reportedSessions = ''
  /** 已取到的歌词（歌曲身份 → 时间轴）。同一首歌来回切时不重复请求。 */
  const lyricCache = new Map<string, LyricLine[]>()

  /** 写缓存（超出上限就丢掉最早的一条：Map 保持插入顺序）。 */
  function cacheLyrics(key: string, value: LyricLine[]): void {
    if (!key) return
    lyricCache.delete(key)
    lyricCache.set(key, value)
    while (lyricCache.size > LYRIC_CACHE_MAX) {
      const oldest = lyricCache.keys().next().value
      if (oldest === undefined) break
      lyricCache.delete(oldest)
    }
  }

  /* ---- 进度外推 ---- */
  /**
   * 锚点状态。
   *
   * 判定逻辑抽在 `progress.ts`（纯函数、可单测）：这里的坑是「播放器没刷新位置」与
   * 「播放器上报了一个旧位置」在数值上完全一样，必须靠**采样值有没有变化**来区分，
   * 不能拿冻结值和前进的外推值比差。详见那个文件的头部注释。
   */
  let progress: ProgressState = initialProgress()

  /** 外推当前播放位置（歌曲内时间，秒）。 */
  function estimatePosition(now: number): number {
    const raw = estimateAt(progress, now)
    // 用「歌曲真实时长」做上限，而不是绝对时间轴的 EndTime。
    const duration = session ? toSongDuration(session) : 0
    // 歌曲尾部：SMTC 的 Position 偶尔会越过 EndTime 停住，钳住避免「最后一句之后空转」。
    return duration > 0 ? Math.min(raw, duration) : raw
  }

  /** 按一次采样决定是否需要重新锚定（标准消费模型，细节见 progress.ts）。 */
  function handleSampleProgress(sample: SmtcSession, sampledAt: number): void {
    /**
     * 播放状态未知时沿用「上一次已知的状态」。
     *
     * 不能直接 `sample.status === 'Playing'`：读失败是空串，那样会被判成「暂停」，
     * 于是进度钉死在锚点、歌词停止滚动 —— 而用户明明在放歌。见 smtc.ts 的
     * `statusKnown` 与 progress.ts 的说明。
     */
    const nowPlaying = sample.statusKnown ? sample.status === 'Playing' : progress.playing
    /*
     * 时间轴是否发布（标准模型的规则 3 分界线）：
     * 网易云暂停时实测上报 pos=0 start=0 end=0 + FILETIME 哨兵时间戳，
     * 那是「没有时间轴」，不是「位置在 0」。
     */
    const timelineValid = isTimelinePublished(sample)
    /**
     * 换算「此刻」的歌曲内位置（标准模型的规则 1）。
     *
     * `Position` 是 `LastUpdatedTime` 那一刻的快照（API 文档原文），补上两者之间的
     * 时间差才是当前位置；暂停时不推进时间。时间轴未发布时这个值无意义，
     * 但仍会安全地算出来（为 0）—— 由 decideProgress 决定用不用它。
     */
    const songPos = songPositionAt(sample, sampledAt, nowPlaying)
    const action = decideProgress(
      progress,
      {
        songPos,
        rawPos: sample.pos,
        updatedAt: sample.updatedAt,
        isPlaying: nowPlaying,
        statusKnown: sample.statusKnown,
        timelineValid
      },
      sampledAt
    )
    if (action === 'anchor') {
      progress = applyAnchor(
        progress,
        {
          songPos,
          rawPos: sample.pos,
          updatedAt: sample.updatedAt,
          isPlaying: nowPlaying,
          statusKnown: sample.statusKnown,
          timelineValid
        },
        sampledAt
      )
    } else if (action === 'freeze') {
      /*
       * 位置不可用但播放状态可信（典型：网易云暂停时清空时间轴）。
       *
       * 必须走 freeze 而不是「什么都不做」：只保留锚点而不更新 `playing`，
       * 暂停后进度仍按本地时钟前进，歌词会继续往下滚 —— 与「暂停」直接矛盾。
       * freeze 把锚点钉在当前推算位置，并采纳新的播放状态。
       */
      progress = applyFreeze(progress, nowPlaying, sampledAt)
    }
    // 'ignore'：没有任何新信息（同一快照且状态没变），继续沿锚点外推。
  }

  /** 推送（内容没变就不发）。 */
  function publish(force = false): void {
    const next = JSON.stringify(state)
    if (!force && next === emitted) return
    emitted = next
    hooks.push(state)
  }

  /**
   * 手动校准：把「当前句」向上 / 向下移一行，并把锚点重新钉到那一行的时间戳上。
   *
   * 为什么需要它：网易云的 SMTC **从不发布时间轴**（实测播放 / 暂停 / 用户拖动进度条
   * 都返回全零 + FILETIME 哨兵，违反标准「每 5 秒更新」义务），所以进度只能靠本地
   * 时钟从锚点自累计。用户中途加入播放、在客户端里拖动过进度条、或从歌单中段开始
   * 播放时，锚点就会与真实位置产生**不可检测的偏差** —— 这是 SMTC 通道内无解的，
   * 唯一出路就是让用户一键对齐。
   *
   * 交互形态：HUD 歌词卡上的「上一句 / 下一句」按钮。用户看到歌词与实际演唱不齐，
   * 点一下立刻对齐；偏移只需校正一次，之后沿外推保持同步。
   *
   * 实现：把目标行的时间戳作为新锚点 —— 这比「偏移量 ±几秒」精确，因为 LRC 的时间
   * 戳就是歌词自己的坐标系，不需要猜测行与行之间的间隔。
   */
  function nudge(direction: -1 | 1): void {
    if (lines.length === 0) return
    const now = Date.now()
    const currentIndex = locateLineIndex(lines, estimatePosition(now))
    // 越界（前奏期 index=-1 视为「在第一行之前」）：统一钳到有效范围。
    const from = currentIndex < 0 ? 0 : Math.min(currentIndex, lines.length - 1)
    const target = Math.min(lines.length - 1, Math.max(0, from + direction))
    if (target === from && currentIndex >= 0) return // 已到头，无需重锚
    const at = lines[target].time
    progress = applyAnchor(progress, { songPos: at, rawPos: at, updatedAt: 0, isPlaying: progress.playing, statusKnown: true, timelineValid: false }, now)
    // 立即重算三行并推送，让用户点完马上看到对齐效果。
    runTick(true)
  }

  /** 回到「没有在播放」：清掉曲目与歌词，并让在途的歌词请求作废。 */
  function resetIdle(): void {
    session = null
    songKey = ''
    lines = []
    fetching = false
    retryAt = 0
    // 锚点连同采样基准一起清空：否则下一次换歌时会拿上一首残留的位置去做
    // 「播放器这次有没有刷新」的比较，把新歌的第一个采样误判成「没刷新」。
    progress = initialProgress()
    fetchToken++
    if (state.status !== 'idle') {
      state = idleState()
      publish()
    }
  }

  /** 换歌：先摆出「加载中」，再去取歌词。 */
  function startSong(next: SmtcSession): void {
    session = next
    songKey = songKeyOf(next)
    lines = []
    fetching = true
    retryAt = 0
    /**
     * 换歌必须清空进度锚点。
     *
     * 锚点是「某一首歌的某一秒」——上一首的 118s 与新歌的 5s 毫无关系。如果不重置，
     * 新歌的首个采样会拿旧歌的位置做比较：位置的「变化量」被判成抖动就被忽略、
     * 或差分不到阈值就被 keep，新歌的歌词于是从错误的行开始、要等好几秒才跳正。
     * 这正是「歌曲从中途开始播放时歌词显示异常」的主要成因之一。
     *
     * 清空后，`onSample` 里紧接着的 `handleSampleProgress` 会以新歌的首个采样重建锚点。
     */
    progress = initialProgress()
    const token = ++fetchToken
    // 同一首歌可能被反复切换（暂停再播放、客户端重开），命中缓存就别再打接口。
    const cached = lyricCache.get(songKey)
    if (cached) {
      lines = cached
      fetching = false
      state = {
        enabled: true,
        status: 'sync',
        title: next.title.trim(),
        artist: next.artist.trim(),
        source: next.source,
        prev: '',
        current: '',
        next: '',
        message: undefined
      }
      publish(true)
      return
    }
    state = {
      enabled: true,
      status: 'loading',
      title: next.title.trim(),
      artist: next.artist.trim(),
      source: next.source,
      prev: '',
      current: '',
      next: '',
      // 上一次失败的提示不能带到新歌上。
      message: undefined
    }
    publish(true)
    void loadLyrics(token, next)
  }

  /** 取歌词；结果只在令牌仍有效（没换歌、没关闭）时采纳。 */
  async function loadLyrics(token: number, target: SmtcSession): Promise<void> {
    const result = await fetchLyrics({
      title: target.title,
      artist: target.artist,
      durationSec: toSongDuration(target)
    })
    if (token !== fetchToken) return
    fetching = false
    if (result.lines.length > 0) {
      lines = result.lines
      cacheLyrics(songKey, result.lines)
      state = { ...state, status: 'sync', message: undefined }
      publish()
      return
    }
    if (result.reason === 'network') {
      // 网络问题：给一条明确原因并安排重试，别把「没网」说成「没歌词」。
      retryAt = Date.now() + RETRY_MS
      state = { ...state, status: 'error', message: '取歌词失败（网络），稍后自动重试' }
      publish()
      return
    }
    retryAt = 0
    state = { ...state, status: 'nolyric', message: '未找到这首歌的歌词' }
    publish()
  }

  /** 一次采样（约 400ms 一次）。 */
  function onSample(sample: SmtcSample): void {
    if (!running) return
    const next = pickNeteaseSession(sample.sessions)
    if (!next) {
      /**
       * 没识别到网易云时，把「系统里到底有谁在放」记一次日志。
       *
       * 这是这套方案唯一的外部依赖（网易云的 AUMID），万一某个版本的客户端
       * 换了标识，日志里能直接看到该往 `NETEASE_AUMID` 里加什么，而不是面对
       * 一个「什么都不显示」的浮层干瞪眼。同一个组合只记一次，不刷屏。
       */
      const others = sample.sessions
        .map((item) => item.aumid)
        .filter(Boolean)
        .sort()
        .join(',')
      if (others && others !== reportedSessions) {
        reportedSessions = others
        console.warn(`[lyrics] 检测到媒体会话但都不是网易云：${others}`)
      }
      resetIdle()
      return
    }
    /**
     * 换歌判定要在**进度校准之前**做。
     *
     * 顺序搞反会留下一个很难复现的错位：`handleSampleProgress` 拿新歌的位置去和
     * **旧歌**的锚点比较 —— 若两首歌的位置恰好接近（上一首在 118s，新歌从 119s
     * 开始），会被判成 keep 而沿用旧锚点，新歌的歌词于是整体偏了 1 秒；若差得多则
     * 重锚一次、紧接着 `startSong` 又清空锚点，白做一遍。
     * 正确顺序：先认出「这是另一首歌」→ 换歌（此时 `startSong` 会重置进度）→
     * 再按新歌的首个采样做锚定。
     *
     * 用 `sameSong` 而不是直接比 key 字符串：时长偶尔读不到时不能当成换了歌，
     * 否则会反复 `startSong`、歌词一直闪「加载中」。
     */
    if (!sameSong(session, next)) {
      startSong(next)
      // 换歌后必须用这一帧的采样重新锚定，否则进度会停在上一首的位置。
      handleSampleProgress(next, sample.ts)
      return
    }
    // 同一首歌：只有「播放器真的上报了新位置」时才用它校准，否则沿本地时钟外推。
    handleSampleProgress(next, sample.ts)
    // 元信息（标题可能在播放器里被编辑、来源名可能刚解析出来）随时更新。
    session = { ...next }
    if (
      state.title !== next.title.trim() ||
      state.artist !== next.artist.trim() ||
      state.source !== next.source
    ) {
      state = { ...state, title: next.title.trim(), artist: next.artist.trim(), source: next.source }
      publish()
    }
  }

  /** 节拍：算出三行歌词并推送；顺带处理失败重试。 */
  function tick(): void {
    if (!running || !session) return
    if (state.status === 'error' && retryAt > 0 && !fetching && Date.now() >= retryAt) {
      retryAt = 0
      fetching = true
      const token = ++fetchToken
      state = { ...state, status: 'loading', message: undefined }
      publish()
      void loadLyrics(token, session)
      return
    }
    if (state.status !== 'sync' || lines.length === 0) return
    const now = Date.now()
    const pos = estimatePosition(now)
    const duration = toSongDuration(session)
    /**
     * 越界自愈：外推位置越过歌曲总时长，说明锚点错了。
     *
     * 网易云不发布时间轴，锚点只能从「换歌 / 恢复播放」起算。若用户是**从歌单中段
     * 加入播放**（SMTC 只报曲名，不报位置），锚点 0 与真实位置的偏差无从得知；
     * 歌放完时外推值远超时长就是唯一的可观测信号。此时回到 0 重新等下一首，
     * 至少保证换歌后是对的。
     */
    if (duration > 0 && pos > duration + 3) {
      progress = applyAnchor(
        progress,
        { songPos: 0, rawPos: 0, updatedAt: 0, isPlaying: progress.playing, statusKnown: true, timelineValid: false },
        now
      )
      runTick(true)
      return
    }
    const index = locateLineIndex(lines, pos)
    const prev = index > 0 ? lines[index - 1].text : ''
    const current = index >= 0 ? lines[index].text : ''
    const next = index + 1 < lines.length ? lines[index + 1].text : ''
    if (prev === state.prev && current === state.current && next === state.next) return
    state = { ...state, prev, current, next }
    publish()
  }

  /**
   * 立即执行一轮歌词同步并强制推送。
   *
   * `tick()` 内容没变就静默返回（常规节拍的节流），但用户点「上一句 / 下一句」
   * 校准后必须**立刻**看到效果 —— 即使三行文本恰好没变（比如间奏里连点两下），
   * 也要把快照推下去，否则按钮像坏了。
   */
  function runTick(force: boolean): void {
    const before = state
    tick()
    if (force && state === before) publish(true)
  }

  function start(): void {
    if (running) return
    running = true
    stopPoller = startSmtcPoller(onSample, (message) => {
      // 采样进程偶发失败不打扰用户，留在日志里供排查。
      console.warn('[lyrics] ' + message)
    })
    timer = setInterval(tick, TICK_MS)
    publish(true)
  }

  function stop(): void {
    if (!running) {
      // 已经关着也要保证快照是 off：HUD 可能刚建好、正等着这一推。
      if (state.status !== 'off') {
        state = offState()
        publish(true)
      }
      return
    }
    running = false
    if (stopPoller) {
      stopPoller()
      stopPoller = null
    }
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    session = null
    songKey = ''
    lines = []
    fetching = false
    retryAt = 0
    progress = initialProgress()
    fetchToken++
    state = offState()
    publish(true)
  }

  return {
    sync(): void {
      const s = settings.get()
      // 「本地」模式关掉了全部联网功能：歌词要联网，这里跟着一起停。
      // 开关统一走 HUD 的「显示歌词」子选项（总开关关掉时它自然也就不跑了）。
      const want = isSmtcSupported() && s.hudEnabled === true && s.hudShowLyrics === true && s.mode !== 'local'
      if (want === running) return
      if (want) start()
      else stop()
    },
    current(): NeteaseLyricsState {
      return state
    },
    /**
     * 手动校准入口（HUD 歌词卡的「上一句 / 下一句」按钮）。
     *
     * 网易云不发布 SMTC 时间轴（实测），进度漂移不可检测，这是唯一的对齐手段。
     */
    nudge(direction: -1 | 1): void {
      if (running) nudge(direction)
    },
    dispose(): void {
      stop()
    }
  }
}
