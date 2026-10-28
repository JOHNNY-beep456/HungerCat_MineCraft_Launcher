/**
 * 网易云歌词单测（离线，不走网络）。
 *
 * 直接跑 TS（Node 22+ 原生类型擦除），无需编译：
 *   node scripts/test-lyrics.mjs
 *   node scripts/test-lyrics.mjs --net   # 额外跑一次真实接口 + SMTC 采样（需联网）
 *
 * 覆盖：LRC 解析（多时间戳 / 毫秒 / 元信息 / 空行）、曲名归一化与相似度、
 * 候选打分与「接受底线」、纯音乐占位词识别、时间轴定位。
 */
import {
  parseLrc,
  normalizeName,
  diceSimilarity,
  matchCandidate,
  scoreCandidate,
  isPlaceholderLyric,
  locateLineIndex,
  fetchLyrics
} from '../src/main/netease/lyrics.ts'
import {
  applyAnchor,
  applyFreeze,
  decideProgress,
  estimateAt,
  initialProgress
} from '../src/main/netease/progress.ts'
import { toSongTime, toSongDuration, songPositionAt, isUsableTimestamp, isTimelinePublished } from '../src/main/netease/timeline.ts'

/**
 * 测试用基准时间戳：2024-01-01T00:00:00Z。
 *
 * 必须用真实量级（13 位 epoch ms）——`isUsableTimestamp` 会挡掉一切早于 2000-01-01
 * 的时间戳（那是 FILETIME 零值一类的哨兵），用 1000 / 5000 这种假值测不到真实行为。
 */
const T0 = Date.UTC(2024, 0, 1)

/** 构造一次归一化采样（对应 service.ts 的组装方式）。 */
function sampleOf({ songPos = 0, rawPos = songPos, updatedAt = T0, isPlaying = true, statusKnown = true, timelineValid = true } = {}) {
  return { songPos, rawPos, updatedAt, isPlaying, statusKnown, timelineValid }
}

/** 走完「判定 + 应用」一整步，返回 { action, state }（与 service.ts 行为一致）。 */
function step(state, sample, sampledAt) {
  const action = decideProgress(state, sample, sampledAt)
  let next = state
  if (action === 'anchor') next = applyAnchor(state, sample, sampledAt)
  else if (action === 'freeze') next = applyFreeze(state, sample.isPlaying, sampledAt)
  return { action, state: next }
}

let pass = 0
let fail = 0

function ok(label, condition, detail) {
  if (condition) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail === undefined ? '' : `\n       ${detail}`}`)
  }
}

function near(label, actual, expected, epsilon = 1e-6) {
  ok(label, Math.abs(actual - expected) <= epsilon, `expected ${expected}, actual ${actual}`)
}

console.log('LRC 解析')
{
  const lrc = [
    '[ti:测试]',
    '[ar:某人]',
    '[00:01.00]第一句',
    '[00:05.50]第二句',
    '',
    '[00:10.123][01:20.123]副歌',
    '[00:12:34]冒号毫秒'
  ].join('\n')
  const lines = parseLrc(lrc)
  ok('压行 + 多时间戳共 5 行', lines.length === 5, JSON.stringify(lines))
  ok('首行时间与文本', lines[0].time === 1 && lines[0].text === '第一句', JSON.stringify(lines[0]))
  near('毫秒三位精度', lines[2].time, 10.123)
  near('冒号分隔毫秒', lines[3].time, 12.34)
  near('同行第二时间戳', lines[4].time, 80.123)
  ok('按时间升序', lines.every((line, i) => i === 0 || line.time >= lines[i - 1].time))
  ok('空串 → 空数组', parseLrc('').length === 0)
  ok('只有元信息 → 空数组', parseLrc('[ti:x]\n[ar:y]').length === 0)
}

console.log('曲名归一化 / 相似度')
{
  ok('括号补充说明被剥掉', normalizeName('起风了 (Live)') === normalizeName('起风了'))
  ok('完全同名相似度 1', diceSimilarity(normalizeName('晴天'), normalizeName('晴天')) === 1)
  ok(
    '不同歌名相似度 < 0.5',
    diceSimilarity(normalizeName('起风了'), normalizeName('风继续吹')) < 0.5
  )
}

console.log('候选打分')
{
  const query = { title: '起风了', artist: '买辣椒也用券', durationSec: 326 }
  const right = { name: '起风了', artists: ['买辣椒也用券'], durationSec: 325.4 }
  const cover = { name: '起风了', artists: ['某翻唱'], durationSec: 240 }
  const other = { name: '风继续吹', artists: ['张国荣'], durationSec: 326 }
  const sRight = scoreCandidate(right, query)
  const sCover = scoreCandidate(cover, query)
  const sOther = scoreCandidate(other, query)
  ok('正确版本分最高', sRight > sCover && sRight > sOther, `${sRight} / ${sCover} / ${sOther}`)
  ok('正确版本 > 0.9', sRight > 0.9, String(sRight))
  ok('错歌 < 0.5', sOther < 0.5, String(sOther))

  // 只有歌名的极端情况：随机串不能被当成「像」（会匹配到 Not A Real Cop 这类条目）。
  const fuzzy = matchCandidate(
    { name: 'Not A Real Cop', artists: ['Michael Giacchino'], durationSec: 94 },
    { title: 'zzzz-not-a-real-song-zzzz', artist: '', durationSec: 0 }
  )
  ok('随机串标题相似度 < 0.6', fuzzy.title < 0.6, String(fuzzy.title))
}

console.log('纯音乐占位词')
{
  ok('纯音乐单行占位 → 无歌词', isPlaceholderLyric(parseLrc('[00:05.000] 纯音乐，请欣赏')))
  ok('Instrumental → 无歌词', isPlaceholderLyric(parseLrc('[00:01.00]Instrumental')))
  ok(
    '完整歌词不误判',
    !isPlaceholderLyric(parseLrc('[00:01.00]一\n[00:05.00]二\n[00:09.00]三\n[00:13.00]四'))
  )
  ok('空歌词不算占位（由上层判 nolyric）', !isPlaceholderLyric([]))
}

console.log('时间轴定位')
{
  const lines = [
    { time: 1, text: 'a' },
    { time: 5, text: 'b' },
    { time: 9, text: 'c' }
  ]
  ok('前奏返回 -1', locateLineIndex(lines, 0) === -1)
  ok('第一句内', locateLineIndex(lines, 1.5) === 0)
  ok('句间停在上一句', locateLineIndex(lines, 7) === 1)
  ok('末句之后仍是末句', locateLineIndex(lines, 100) === 2)
  ok('提前量生效', locateLineIndex(lines, 4.9) === 1)
}

console.log('SMTC 标准消费模型：时间轴发布判定')
{
  /*
   * 规则 3 的分界线：网易云暂停时实测上报 pos=0 start=0 end=0 + FILETIME 哨兵，
   * 那是「没有时间轴」，不是「位置在 0」。这条判据决定位置数据可不可信。
   */
  ok('正常时间轴（end>0）已发布', isTimelinePublished({ pos: 120, start: 0, end: 300, updatedAt: T0 }))
  ok('真实时间戳即视为发布', isTimelinePublished({ pos: 120, start: 0, end: 0, updatedAt: T0 }))
  ok('pos>start 视为发布（流式兜底）', isTimelinePublished({ pos: 120, start: 100, end: 0, updatedAt: 0 }))
  ok('网易云暂停形态 = 未发布', !isTimelinePublished({ pos: 0, start: 0, end: 0, updatedAt: -11644473600000 }))
  ok('全零且无时间戳 = 未发布', !isTimelinePublished({ pos: 0, start: 0, end: 0, updatedAt: 0 }))
}

console.log('SMTC 标准消费模型：规则 2 —— 同一快照重复采样绝不重锚')
{
  /*
   * 「两秒一回跳」的终结者。播放器只在暂停/拖动时更新快照（网易云常态），
   * 播放中每次采样都是同一份快照 —— 必须外推，绝不能把旧快照当新位置。
   */
  const sample = sampleOf({ songPos: 120, rawPos: 120, updatedAt: T0 })
  let st = initialProgress()
  let r = step(st, sample, 0)
  ok('首个快照 → anchor', r.action === 'anchor', r.action)
  st = r.state
  let bad = 0
  for (let i = 1; i <= 10; i++) {
    const r2 = step(st, sample, i * 400) // 同一快照，重复采样
    if (r2.action !== 'ignore') bad++
    st = r2.state
  }
  ok('同一快照重复 10 次 → 全部 ignore', bad === 0, bad + ' 次非 ignore')
  ok('4 秒后外推到 124s', Math.abs(estimateAt(st, 4000) - 124) < 0.01, String(estimateAt(st, 4000)))
}

console.log('SMTC 标准消费模型：规则 1 —— 快照更新直接锚定（拖动 / 切歌 / 周期刷新）')
{
  // 锚在 120s，用户拖到 200s（新快照时间戳）
  let st = applyAnchor(initialProgress(), sampleOf({ songPos: 120, rawPos: 120, updatedAt: T0 }), 0)
  const dragged = sampleOf({ songPos: 200, rawPos: 200, updatedAt: T0 + 30_000 })
  const r = step(st, dragged, 1000)
  ok('快照更新（拖到 200s）→ anchor', r.action === 'anchor', r.action)
  ok('锚点 = 200', r.state.basePos === 200)
  st = r.state

  // 标准建议「播放期间每 5 秒更新一次」：周期刷新的快照也应直接锚定（而不是抖动）
  const periodic = sampleOf({ songPos: 205, rawPos: 205, updatedAt: T0 + 35_000 })
  const r2 = step(st, periodic, 6000)
  ok('标准 5 秒周期刷新 → anchor', r2.action === 'anchor', r2.action)
  ok('锚点 = 205', r2.state.basePos === 205)

  // 向后拖（倒退）同样是快照更新
  const back = sampleOf({ songPos: 98, rawPos: 98, updatedAt: T0 + 40_000 })
  const r3 = step(st, back, 7000)
  ok('倒退（拖回 98s）→ anchor', r3.action === 'anchor', r3.action)
}

console.log('SMTC 标准消费模型：规则 3 —— 时间轴未发布时绝不采纳位置')
{
  /*
   * 网易云暂停形态：pos=0 start=0 end=0 updated=FILETIME零值。
   * 用户停在 120s，暂停后歌词必须停在当前句。
   */
  let st = applyAnchor(initialProgress(), sampleOf({ songPos: 120, rawPos: 120, updatedAt: T0 }), 0)
  const unpublished = sampleOf({ songPos: 0, rawPos: 0, updatedAt: -11644473600000, isPlaying: false, timelineValid: false })
  let r = step(st, unpublished, 1000)
  ok('暂停 + 时间轴未发布 → freeze', r.action === 'freeze', r.action)
  ok('锚点仍在当前句（≈121s）', Math.abs(r.state.basePos - 121) < 0.05, String(r.state.basePos))
  ok('playing 已变为 false', r.state.playing === false)
  st = r.state
  const frozen = st.basePos

  // 暂停持续多帧（同一份未发布快照）→ ignore，位置纹丝不动
  let moved = false
  for (let i = 2; i <= 6; i++) {
    const r2 = step(st, unpublished, i * 400)
    if (r2.action !== 'ignore') moved = true
    st = r2.state
  }
  ok('持续暂停 → 全部 ignore', !moved)
  ok('持续暂停期间位置不变', Math.abs(estimateAt(st, 4000) - frozen) < 1e-9)

  // 恢复播放瞬间：播放器可能仍报未发布的时间轴 → 状态要跟上，位置不能跳
  const resumeUnpublished = sampleOf({ songPos: 0, rawPos: 0, updatedAt: -11644473600000, isPlaying: true, timelineValid: false })
  const r3 = step(st, resumeUnpublished, 5000)
  ok('恢复播放 + 时间轴未发布 → freeze（状态跟上）', r3.action === 'freeze', r3.action)
  ok('恢复后位置不跳回开头', r3.state.basePos > 100, String(r3.state.basePos))
  ok('恢复后 playing = true', r3.state.playing === true)
}

console.log('SMTC 标准消费模型：拖动回开头（时间轴有效 + 位置 0）必须生效')
{
  /*
   * 与规则 3 的本质区别：真拖动时时间轴是**发布**的（end>0 / 时间戳可用），
   * 位置 0 是真实数据。标准模型不再需要「可疑归零」启发式。
   */
  let st = applyAnchor(initialProgress(), sampleOf({ songPos: 120, rawPos: 120, updatedAt: T0 }), 0)
  const dragToZero = sampleOf({ songPos: 0, rawPos: 0, updatedAt: T0 + 30_000 })
  const r = step(st, dragToZero, 1000)
  ok('拖回 0（时间轴已发布 + 新快照）→ anchor', r.action === 'anchor', r.action)
  ok('锚点 = 0', r.state.basePos === 0)
}

console.log('SMTC 标准消费模型：暂停 → 恢复（规范播放器会更新快照）')
{
  // 规范播放器：暂停时按标准更新时间轴，位置停留在暂停处
  let st = applyAnchor(initialProgress(), sampleOf({ songPos: 60, rawPos: 60, updatedAt: T0 }), 0)
  const pausedSnap = sampleOf({ songPos: 65, rawPos: 65, updatedAt: T0 + 10_000, isPlaying: false })
  const r = step(st, pausedSnap, 1000)
  ok('规范暂停（新快照）→ anchor', r.action === 'anchor', r.action)
  ok('锚点 = 65', r.state.basePos === 65)
  st = r.state
  ok('暂停后位置不再前进', Math.abs(estimateAt(st, 5000) - 65) < 1e-9)

  // 恢复：新快照（位置没动，但时间戳更新了）
  const resumed = sampleOf({ songPos: 65, rawPos: 65, updatedAt: T0 + 60_000, isPlaying: true })
  const r2 = step(st, resumed, 6000)
  ok('恢复播放（新快照）→ anchor', r2.action === 'anchor', r2.action)
  ok('恢复后从 65s 继续', r2.state.basePos === 65)
}

console.log('SMTC 标准消费模型：状态读不到 ≠ 暂停')
{
  let st = applyAnchor(initialProgress(), sampleOf({ songPos: 120, rawPos: 120, updatedAt: T0 }), 0)
  let wronglyPaused = false
  for (let i = 1; i <= 8; i++) {
    const s = sampleOf({ songPos: 120, rawPos: 120, updatedAt: T0, isPlaying: true, statusKnown: false })
    const r = step(st, s, i * 400)
    if (r.state.playing === false) wronglyPaused = true
    st = r.state
  }
  ok('状态读不到时沿用上次已知状态（播放中）', !wronglyPaused)
  ok('进度继续推进（3.2s 后 ≈123.2）', Math.abs(estimateAt(st, 3200) - 123.2) < 0.05, String(estimateAt(st, 3200)))
}

console.log('SMTC 标准消费模型：从中途起播')
{
  const first = sampleOf({ songPos: 120, rawPos: 120, updatedAt: T0 })
  const r = step(initialProgress(), first, 0)
  ok('首个快照 120s → anchor', r.action === 'anchor', r.action)
  ok('锚点 = 120', r.state.basePos === 120)
  let st = r.state
  let bad = 0
  for (let i = 1; i <= 10; i++) {
    const r2 = step(st, first, i * 400)
    if (r2.action !== 'ignore') bad++
    st = r2.state
  }
  ok('之后同一快照不再重锚', bad === 0)
  ok('4 秒后到 124s', Math.abs(estimateAt(st, 4000) - 124) < 0.01)
}

console.log('SMTC 标准消费模型： songPositionAt 换算（端到端）')
{
  // StartTime 非 0 的流式媒体：pos=215, start=100, updatedAt=T0 → 歌曲内 115s
  near('快照时刻 = 115', songPositionAt({ pos: 215, start: 100, updatedAt: T0 }, T0), 115)
  near('5 秒后 = 120', songPositionAt({ pos: 215, start: 100, updatedAt: T0 }, T0 + 5000), 120)
  near('暂停不推进', songPositionAt({ pos: 215, start: 100, updatedAt: T0 }, T0 + 5000, false), 115)
  near('FILETIME 哨兵不参与外推', songPositionAt({ pos: 215, start: 100, updatedAt: -11644473600000 }, T0 + 999_999), 115)
  near('时间戳晚于 now 不倒退', songPositionAt({ pos: 215, start: 100, updatedAt: T0 + 60_000 }, T0), 115)
  near('无时间戳退化为 pos-start', songPositionAt({ pos: 215, start: 100, updatedAt: 0 }, T0 + 999_999), 115)
}

console.log('SMTC 时间轴换算（StartTime 非 0）')
{
  /*
   * Position / EndTime 与 StartTime 在同一坐标系，而 LRC 从 0 开始。
   * 直接拿 Position 比对会整体偏移 —— 这就是「重启后歌词对不上」的成因：
   * 每次重新采样拿到的 StartTime 可能不同，偏移量随之变化。
   */
  ok('start=0 时位置不变', toSongTime({ pos: 120, start: 0 }) === 120)
  ok('start=100 时 120 → 20', toSongTime({ pos: 120, start: 100 }) === 20)
  ok('pos < start 夹到 0', toSongTime({ pos: 50, start: 100 }) === 0)
  ok('时长 start=0', toSongDuration({ end: 326, start: 0 }) === 326)
  ok('时长 start=100（426-100）', toSongDuration({ end: 426, start: 100 }) === 326)
  ok('时长为负夹到 0', toSongDuration({ end: 50, start: 100 }) === 0)

  // 端到端：偏移会导致定位到不同句
  const songLines = []
  for (let i = 0; i < 30; i++) songLines.push({ time: i * 10, text: '第' + (i + 1) + '句' })
  const sample = { pos: 215, start: 100 } // 真实歌曲内 115s -> 第12句
  const wrong = locateLineIndex(songLines, sample.pos)
  const right = locateLineIndex(songLines, toSongTime(sample))
  ok('不换算会定位到错误句', wrong === 21, '第' + (wrong + 1) + '句')
  ok('换算后定位到正确句', right === 11, '第' + (right + 1) + '句')
}

if (process.argv.includes('--net')) {
  console.log('真实接口（需要联网）')
  const result = await fetchLyrics({ title: '起风了', artist: '买辣椒也用券', durationSec: 326 })
  ok('取到歌词', result.lines.length > 0, `reason=${result.reason ?? ''}`)
  ok('命中正确曲目', result.matched !== null && result.matched.name.includes('起风了'), JSON.stringify(result.matched))
  if (result.lines.length > 0) {
    console.log(`       首句 ${result.lines[0].time.toFixed(2)}s "${result.lines[0].text}"`)
    console.log(`       共 ${result.lines.length} 行`)
  }
  const bogus = await fetchLyrics({ title: 'zzzz-not-a-real-song-zzzz', artist: '', durationSec: 0 })
  ok(
    '伪曲目不匹配任何歌',
    bogus.lines.length === 0 && bogus.reason === 'low-similarity',
    `reason=${bogus.reason ?? ''} lines=${bogus.lines.length}`
  )
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
