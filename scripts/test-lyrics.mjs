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
