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
import { isSmtcSupported, startSmtcPoller, type SmtcSample, type SmtcSession } from './smtc'

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

/** 允许的进度偏差（秒）：超过就认为播放位置「跳了」，重新锚定。 */
const RESYNC_THRESHOLD_SEC = 1.5

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
  /** 退出前收尾（停子进程 / 清定时器）。 */
  dispose(): void
}

/** 「不显示」的快照（开关关掉 / 非 Windows）。 */
function offState(): NeteaseLyricsState {
  return { enabled: false, status: 'off', title: '', artist: '', prev: '', current: '', next: '' }
}

/** 「开着但没在放」：HUD 不渲染卡片，但内部状态已就绪。 */
function idleState(): NeteaseLyricsState {
  return { enabled: false, status: 'idle', title: '', artist: '', prev: '', current: '', next: '' }
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

/** 歌曲身份：标题 + 歌手 + 时长。三者任一变化都算「换歌」（同一首歌的不同版本时长不同）。 */
function songKeyOf(session: SmtcSession): string {
  return [normalizeName(session.title), normalizeName(session.artist), Math.round(session.end)].join('|')
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
  let anchored = false
  let basePos = 0
  let baseAt = 0
  let playing = false

  /**
   * 外推当前播放位置（秒）。
   * 未锚定（还没收到采样）时返回 0；播放中按本地时钟推进，暂停则停在锚点。
   */
  function estimatePosition(now: number): number {
    if (!anchored) return 0
    const raw = playing ? basePos + (now - baseAt) / 1000 : basePos
    const end = session?.end ?? 0
    // 歌曲尾部：SMTC 的 Position 偶尔会越过 EndTime 停住，钳住避免「最后一句之后空转」。
    return end > 0 ? Math.min(raw, end) : raw
  }

  /** 用一次采样重新锚定播放位置。 */
  function anchor(sample: SmtcSession, sampledAt: number): void {
    basePos = sample.pos
    baseAt = sampledAt
    playing = sample.status === 'Playing'
    anchored = true
  }

  /** 推送（内容没变就不发）。 */
  function publish(force = false): void {
    const next = JSON.stringify(state)
    if (!force && next === emitted) return
    emitted = next
    hooks.push(state)
  }

  /** 回到「没有在播放」：清掉曲目与歌词，并让在途的歌词请求作废。 */
  function resetIdle(): void {
    session = null
    songKey = ''
    lines = []
    fetching = false
    retryAt = 0
    anchored = false
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
      durationSec: target.end
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
    // 进度：偏差大才重新锚定（拖动进度、切歌、播放器重新上报）。
    const estimated = estimatePosition(sample.ts)
    if (!anchored || Math.abs(next.pos - estimated) > RESYNC_THRESHOLD_SEC) {
      anchor(next, sample.ts)
    } else {
      playing = next.status === 'Playing'
    }

    const key = songKeyOf(next)
    if (key !== songKey) {
      startSong(next)
      return
    }
    // 同一首歌：只更新时长 / 状态这类元信息（标题可能在播放器里被编辑）。
    session = { ...next }
    if (state.title !== next.title.trim() || state.artist !== next.artist.trim()) {
      state = { ...state, title: next.title.trim(), artist: next.artist.trim() }
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
    const index = locateLineIndex(lines, estimatePosition(Date.now()))
    const prev = index > 0 ? lines[index - 1].text : ''
    const current = index >= 0 ? lines[index].text : ''
    const next = index + 1 < lines.length ? lines[index + 1].text : ''
    if (prev === state.prev && current === state.current && next === state.next) return
    state = { ...state, prev, current, next }
    publish()
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
    anchored = false
    fetchToken++
    state = offState()
    publish(true)
  }

  return {
    sync(): void {
      const s = settings.get()
      // 「本地」模式关掉了全部联网功能：歌词要联网，这里跟着一起停。
      const want = isSmtcSupported() && s.neteaseLyricsHudEnabled === true && s.mode !== 'local'
      if (want === running) return
      if (want) start()
      else stop()
    },
    current(): NeteaseLyricsState {
      return state
    },
    dispose(): void {
      stop()
    }
  }
}
