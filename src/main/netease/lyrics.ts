/**
 * 网易云音乐歌词：曲目匹配 + LRC 解析。
 *
 * 这一层只做「纯逻辑 + 一次网络往返」，不碰 Electron、不碰窗口：
 *   · 主进程服务（`service.ts`）负责轮询播放状态与逐句同步；
 *   · 这里负责「把 SMTC 给的 曲名 / 歌手 / 时长 换成一份带时间轴的歌词」。
 * 分开的好处是解析与打分都能脱离运行环境直接测（见 scripts 里的自测说明）。
 *
 * 接口说明（都是网易云网页版自己在用的公开接口，无需登录）：
 *   · 搜索：`/api/search/get/web?s=<关键词>&type=1&limit=8`
 *   · 歌词：`/api/song/lyric?id=<歌曲 id>&lv=-1&kv=-1&tv=-1`（`lrc` 即 LRC 原文）
 *
 * 匹配策略的由来：SMTC 只给「标题 / 歌手 / 时长」，官方客户端里同一首歌往往有
 * 原版、Live、DJ 版、翻唱等多个条目，**只按标题搜会挑错**（放到 HUD 上就是
 * 「歌词对不上歌」）。所以对每个候选算三项加权分：
 *   标题相似度 0.55 / 歌手相似度 0.25 / 时长接近度 0.20
 * 时长是这里最可靠的一维——翻唱、Live 版与原版的时长几乎不可能完全一致。
 */

/** 一行歌词：`time` 为该行开始时间（秒，带毫秒小数），`text` 为歌词正文。 */
export interface LyricLine {
  time: number
  text: string
}

/** 搜索接口里一条候选曲目（只留匹配需要的字段）。 */
interface SongCandidate {
  id: number
  name: string
  artists: string[]
  /** 时长（秒）；接口给的是毫秒，已换算。 */
  durationSec: number
}

/** 发起匹配所需的曲目信息（来自系统媒体会话）。 */
export interface LyricsQuery {
  title: string
  artist: string
  /** 总时长（秒）；<= 0 表示未知（此时时长分给中性值，不因缺时长而误判）。 */
  durationSec: number
}

const API_ORIGIN = 'https://music.163.com'

/**
 * 请求头与浏览器一致。
 *
 * 网易云接口会按 UA / Referer 判断来源：缺 Referer 时搜索直接返回
 * `{"code":200,"result":{"songCount":0}}`（看起来「成功」但一条都没有），
 * 这是这套接口最容易踩的坑。
 */
const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: `${API_ORIGIN}/`,
  Cookie: 'appver=2.0.2; os=pc'
}

/** 单次网络请求超时：歌词是「锦上添花」的浮层，宁可放弃也不能把主进程拖住。 */
const REQUEST_TIMEOUT_MS = 8000

/**
 * 取 JSON。
 *
 * 统一在这里做超时与状态码判断：返回 `null` 表示「这次请求本身没成功」
 * （网络 / 超时 / 非 2xx），与「请求成功但结果为空」是两件事 ——
 * 前者要给用户「取歌词失败」，后者才是「这首歌没有歌词」，HUD 上提示不同。
 */
async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers: REQUEST_HEADERS, signal: controller.signal })
    if (!res.ok) return null
    const data: unknown = await res.json()
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 归一化曲名 / 歌手名，供相似度比较。
 *
 * 去掉括号补充说明（`(Live)`、`（Remix）`、`【伴奏】`…）、标点与空白，并统一小写。
 * 「原版 vs Live」的差别通常就写在括号里，先剥掉再比标题，才能比出真正的同名歌曲。
 */
export function normalizeName(raw: string): string {
  return raw
    .replace(/[（(【[].*?[）)】\]]/g, ' ')
    .replace(/[\s\-_·、,，.。!！?？'":：;；/\\|~`@#$%^&*+=<>（）()\[\]{}]/g, '')
    .toLowerCase()
}

/** 二元组集合：中文没有空格分词，用字符二元组做相似度比按字符集合稳。 */
function bigrams(text: string): Set<string> {
  const set = new Set<string>()
  if (!text) return set
  if (text.length === 1) {
    set.add(text)
    return set
  }
  for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2))
  return set
}

/**
 * Dice 系数（0–1）。
 *
 * 相比「相等 / 包含」这类硬判断，它对「歌名后缀略有差别」更宽容：
 * 例如 `晴天` 与 `晴天 (Live)` 剥括号后完全相同 → 1.0，
 * 而 `起风了` 与 `起风了（伴奏）` 同样为 1.0，真正的错配（`起风了` vs `风继续吹`）会明显偏低。
 */
export function diceSimilarity(a: string, b: string): number {
  const left = bigrams(a)
  const right = bigrams(b)
  if (left.size === 0 || right.size === 0) return 0
  let hit = 0
  for (const gram of left) if (right.has(gram)) hit++
  return (2 * hit) / (left.size + right.size)
}

/** 歌手分：任一候唱歌手与目标歌手（归一化后）相同或互相包含，即视为命中。 */
function artistScore(candidates: string[], target: string): number {
  const want = normalizeName(target)
  if (!want) return 0.5
  let best = 0
  for (const name of candidates) {
    const got = normalizeName(name)
    if (!got) continue
    if (got === want) return 1
    if (got.includes(want) || want.includes(got)) best = Math.max(best, 0.9)
    else best = Math.max(best, diceSimilarity(got, want))
  }
  return best
}

/** 时长分：差 2.5 秒内算同一版本；超过 15 秒基本可排除。 */
function durationScore(candidateSec: number, targetSec: number): number {
  if (targetSec <= 0 || candidateSec <= 0) return 0.5
  const diff = Math.abs(candidateSec - targetSec)
  if (diff <= 2.5) return 1
  if (diff <= 6) return 0.7
  if (diff <= 15) return 0.35
  return 0
}

/** 候选打分明细（0–1）。拆开是为了让「接受 / 拒绝」能按单项设底线，而不只看加权总分。 */
export interface CandidateScore {
  /** 标题相似度。 */
  title: number
  /** 歌手相似度。 */
  artist: number
  /** 时长接近度。 */
  duration: number
  /** 加权总分 = 标题 0.55 + 歌手 0.25 + 时长 0.20。 */
  total: number
}

/** 计算候选与目标曲目的匹配明细。 */
export function matchCandidate(
  candidate: { name: string; artists: string[]; durationSec: number },
  query: LyricsQuery
): CandidateScore {
  const title = diceSimilarity(normalizeName(candidate.name), normalizeName(query.title))
  const artist = artistScore(candidate.artists, query.artist)
  const duration = durationScore(candidate.durationSec, query.durationSec)
  return { title, artist, duration, total: title * 0.55 + artist * 0.25 + duration * 0.2 }
}

/** 候选总分（0–1）。导出以便自测时直接断言。 */
export function scoreCandidate(
  candidate: { name: string; artists: string[]; durationSec: number },
  query: LyricsQuery
): number {
  return matchCandidate(candidate, query).total
}

/**
 * 判定「这个候选值得去取歌词吗」。
 *
 * 加权总分会被中性分抬高：歌手未知（0.5）、时长未知（0.5）时，一条完全不相关的
 * 结果也能凑到 0.5 上下（实测搜一串随机字母，会命中 "Not A Real Cop" 这种条目）。
 * 所以这里再加两道硬底线：
 *   · 标题必须像（>= 0.6）；
 *   · 歌手与时长**都**没有时，标题必须几乎完全一致（>= 0.85）——
 *     这正是「客户端只给了歌名」的极端情况，宁可不显示也不要放错歌词。
 */
function isAcceptable(score: CandidateScore, query: LyricsQuery): boolean {
  if (score.title < 0.6 || score.total < 0.5) return false
  const artistKnown = query.artist.trim().length > 0
  const durationKnown = query.durationSec > 0
  if (!artistKnown && !durationKnown) return score.title >= 0.85
  return true
}

/**
 * 解析 LRC。
 *
 * 兼容：
 *   · `[mm:ss]`、`[mm:ss.xx]`、`[mm:ss.xxx]`、`[mm:ss:xxx]`（网易云的翻译歌词用冒号分隔毫秒）；
 *   · 一行多个时间戳（`[00:12.00][01:20.00]副歌`，副歌重复时网易云会这样压行）；
 *   · 元信息行（`[ti:]` / `[ar:]` / `[al:]` / `[by:]`）与纯时间空行（间奏占位）。
 *
 * 空行直接丢弃：整首歌词的时间轴已经决定了「当前该唱哪句」，间奏期间停在上一句
 * 比清空成一片空白更像常规播放器的表现（也让浮层不会反复闪空）。
 */
export function parseLrc(raw: string): LyricLine[] {
  if (!raw) return []
  const timeTag = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  const out: LyricLine[] = []
  for (const line of raw.split(/\r?\n/)) {
    const stamps = [...line.matchAll(timeTag)]
    if (stamps.length === 0) continue
    const text = line.replace(timeTag, '').trim()
    if (!text) continue
    for (const stamp of stamps) {
      const minutes = Number(stamp[1] ?? 0)
      const seconds = Number(stamp[2] ?? 0)
      const fraction = stamp[3] ?? ''
      const millis = fraction ? Number(fraction.padEnd(3, '0').slice(0, 3)) : 0
      out.push({ time: minutes * 60 + seconds + millis / 1000, text })
    }
  }
  out.sort((a, b) => a.time - b.time)
  // 重复时间戳（同一句被压了两遍）只留一条，否则「当前句」会瞬间跳两次。
  return out.filter((line, i) => i === 0 || line.time !== out[i - 1].time || line.text !== out[i - 1].text)
}

/** 搜索结果 → 候选列表（字段名按接口原样取，缺失即跳过该条）。 */
function toCandidates(payload: Record<string, unknown> | null): SongCandidate[] {
  const result = payload?.['result'] as Record<string, unknown> | undefined
  const songs = result?.['songs']
  if (!Array.isArray(songs)) return []
  const out: SongCandidate[] = []
  for (const raw of songs) {
    if (!raw || typeof raw !== 'object') continue
    const song = raw as Record<string, unknown>
    const id = Number(song['id'])
    const name = typeof song['name'] === 'string' ? song['name'] : ''
    if (!Number.isFinite(id) || id <= 0 || !name) continue
    const artists: string[] = []
    const rawArtists = song['artists']
    if (Array.isArray(rawArtists)) {
      for (const item of rawArtists) {
        const value = (item as Record<string, unknown>)?.['name']
        if (typeof value === 'string' && value) artists.push(value)
      }
    }
    const durationMs = Number(song['duration'])
    out.push({
      id,
      name,
      artists,
      durationSec: Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : 0
    })
  }
  return out
}

/** 按关键词搜歌；`null` = 请求失败（网络 / 超时），`[]` = 确实没有结果。 */
async function searchSongs(keyword: string): Promise<SongCandidate[] | null> {
  const url = `${API_ORIGIN}/api/search/get/web?s=${encodeURIComponent(keyword)}&type=1&offset=0&limit=8`
  const payload = await fetchJson(url)
  if (!payload) return null
  return toCandidates(payload)
}

/**
 * 取某首歌的歌词原文。
 *
 * 优先 `lrc`；纯音乐 / 无版权时 `lrc` 为空，再看 `tlyric`（翻译歌词，同样带时间轴），
 * 最后才认「没有歌词」。`klyric`（卡拉OK 逐字）结构不同，这里不用。
 * 返回值：歌词原文 / 空串（服务器明确说没有）/ `null`（请求失败）。
 */
async function fetchLyricText(songId: number): Promise<string | null> {
  const url = `${API_ORIGIN}/api/song/lyric?id=${songId}&lv=-1&kv=-1&tv=-1`
  const payload = await fetchJson(url)
  if (!payload) return null
  for (const key of ['lrc', 'tlyric']) {
    const block = payload[key] as Record<string, unknown> | undefined
    const lyric = block?.['lyric']
    if (typeof lyric === 'string' && lyric.trim()) return lyric
  }
  return ''
}

/**
 * 网易云给「没有歌词」的曲目塞的占位词。
 *
 * 典型 LRC 只有一行：`[00:05.000] 纯音乐，请欣赏`。它看起来是合法时间轴，
 * 直接显示就成了「一直停在纯音乐，请欣赏」—— 必须识别出来当作没有歌词。
 */
const PLACEHOLDER_LYRIC = /纯音乐|純音樂|没有填词|沒有填詞|请您欣赏|請您欣賞|此歌曲|没有歌词|instrumental/i

/**
 * 是否是「无歌词」的占位歌词。
 *
 * 只在歌词极短（<= 3 行）时判定：正常歌曲里偶尔也会出现一句「纯音乐」，
 * 但这种短歌词整体都只有占位词，不可能误伤完整歌词。
 */
export function isPlaceholderLyric(lines: LyricLine[]): boolean {
  if (lines.length === 0 || lines.length > 3) return false
  return PLACEHOLDER_LYRIC.test(lines.map((line) => line.text).join(' '))
}

/**
 * 一次性解析结果。
 *   `lines`  非空表示可用；
 *   `reason` 说明为什么没有（用于 HUD 上的一行提示与日志）：
 *     `network`        网络 / 接口失败（可稍后重试）
 *     `empty-title`    客户端没给出歌名（无法搜索）
 *     `not-found`      搜不到这首歌
 *     `low-similarity` 搜到了，但没有一个候选像这首歌（宁可不显示也不放错歌词）
 *     `no-lyric`       歌对上了，但它没有可用歌词（纯音乐 / 无版权）
 */
export interface LyricsResult {
  lines: LyricLine[]
  /** 命中的曲目（便于日志 / 排错；未命中为 null）。 */
  matched: { id: number; name: string; artists: string[] } | null
  reason?: 'network' | 'empty-title' | 'not-found' | 'low-similarity' | 'no-lyric'
}

/**
 * 主入口：按曲目信息取回带时间轴的歌词。
 *
 * 流程：搜「歌名 歌手」→ 打分排序 → 依次尝试前 3 个候选的歌词 →
 * 第一个解析出非空时间轴的即为结果。全部落空时返回 `reason`，
 * 由上层决定显示「暂无歌词」还是「取歌词失败（稍后重试）」。
 */
export async function fetchLyrics(query: LyricsQuery): Promise<LyricsResult> {
  const title = query.title.trim()
  if (!title) return { lines: [], matched: null, reason: 'empty-title' }
  const keyword = query.artist.trim() ? `${title} ${query.artist.trim()}` : title
  let candidates = await searchSongs(keyword)
  if (candidates === null) return { lines: [], matched: null, reason: 'network' }
  // 带歌手搜不到时（歌手名在客户端里有别名 / 附加信息）退回只按歌名搜一次。
  if (candidates.length === 0 && query.artist.trim()) {
    candidates = await searchSongs(title)
    if (candidates === null) return { lines: [], matched: null, reason: 'network' }
  }
  if (candidates.length === 0) return { lines: [], matched: null, reason: 'not-found' }

  const ranked = candidates
    .map((candidate) => ({ candidate, score: matchCandidate(candidate, query) }))
    .sort((a, b) => b.score.total - a.score.total)
  // 最佳候选都对不上：宁可不显示，也不要放一份别的歌的歌词。
  const best = ranked[0]
  if (!best || !isAcceptable(best.score, query)) {
    return { lines: [], matched: null, reason: 'low-similarity' }
  }

  let attempted = 0
  let networkFailures = 0
  // 只对「标题确实像」的候选取歌词：一次换歌最多打 3 个请求。
  const attempts = ranked.filter((item) => isAcceptable(item.score, query)).slice(0, 3)
  for (const item of attempts) {
    attempted++
    const text = await fetchLyricText(item.candidate.id)
    if (text === null) {
      networkFailures++
      continue
    }
    const lines = parseLrc(text)
    if (lines.length > 0 && !isPlaceholderLyric(lines)) {
      return {
        lines,
        matched: { id: item.candidate.id, name: item.candidate.name, artists: item.candidate.artists }
      }
    }
  }
  return {
    lines: [],
    matched: { id: best.candidate.id, name: best.candidate.name, artists: best.candidate.artists },
    // 全部候选都只是「请求失败」→ 当成网络问题，让上层稍后重试；
    // 只要有一个明确回了空 / 占位词 → 就是这首歌没有可用歌词。
    reason: networkFailures > 0 && networkFailures === attempted ? 'network' : 'no-lyric'
  }
}

/**
 * 在时间轴上定位当前句。
 *
 * 返回该句下标；还没到第一句（前奏）时返回 -1。
 * `leadSec` 是提前量：歌词通常比听感「晚一点」更自然，给 0.2 秒提前到这里统一调。
 */
export function locateLineIndex(lines: LyricLine[], positionSec: number, leadSec = 0.2): number {
  const at = positionSec + leadSec
  let lo = 0
  let hi = lines.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].time <= at) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}
