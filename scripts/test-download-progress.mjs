/**
 * 下载进度口径的回归测试。
 *
 * 对应真实 bug：下载悬浮球显示 **133273%**，进度页同一文件显示「476.0 MB / 731.0 KB」。
 *
 * 根因不是「字节数算多了」，而是**分子分母口径不一致**：
 *   · doneBytes 包含「校验发现文件已存在」与所有下载完成的字节；
 *   · totalBytes 旧实现只在服务器回 Content-Length（onSize）时才累加，
 *     已存在的文件全进了分子、没进分母 → 分母偏小 → 百分比爆炸。
 *
 * 本测试直接 import 主进程真实模块（Node 24 原生剥离类型），锁住：
 *   1. computePercent 上下界夹紧；
 *   2. ProgressReporter 的「累加 / 覆盖」两种写入语义；
 *   3. 编排层的关键修复点（分母预置、onSize 只补未知大小、浮球夹紧）。
 *
 * 运行：node scripts/test-download-progress.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProgressReporter, computePercent } from '../src/main/transfer-util.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8')

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

const snap = (doneBytes, totalBytes, done = 0, total = 0) => ({
  doneBytes,
  totalBytes,
  done,
  total,
  speed: 0
})

console.log('computePercent：上下界都要夹')
ok(
  '实测溢出场景（476MB / 731KB）→ 100 而不是 133273',
  computePercent(snap(476 * 1024 * 1024, 731 * 1024)) === 100,
  `实际 ${computePercent(snap(476 * 1024 * 1024, 731 * 1024))}`
)
ok('正常 50% 不受影响', computePercent(snap(50, 100)) === 50)
ok('完全未开始 → 0', computePercent(snap(0, 100)) === 0)
ok(
  '重下回退导致 doneBytes 为负时不出现负数',
  computePercent(snap(-500, 100)) === 0,
  `实际 ${computePercent(snap(-500, 100))}`
)
ok('没有总字节时回退到文件数比例', computePercent(snap(0, 0, 1, 4)) === 25)
ok('两者都为 0 时返回 0', computePercent(snap(0, 0)) === 0)

console.log('\nProgressReporter：累加与覆盖语义')
const emits = []
const r = new ProgressReporter({ emit: (s) => emits.push(s), intervalMs: 0 })
r.setTotals(0, 3)
r.addTotalBytes(600)
ok('addTotalBytes 累加', (r.report(true), emits.at(-1).totalBytes) === 600)
r.addDoneBytes(100)
r.addDoneBytes(50)
ok('addDoneBytes 累加（两次 100+50=150）', (r.report(true), emits.at(-1).doneBytes) === 150)
r.setDoneBytes(40)
ok('setDoneBytes 覆盖而非累加', (r.report(true), emits.at(-1).doneBytes) === 40)
r.addTotalBytes(-40)
ok('addTotalBytes 支持负增量（撤回估算值）', (r.report(true), emits.at(-1).totalBytes) === 560)

console.log('\n编排层修复点：分母预置')
const downloader = read('src/main/downloader.ts')
ok(
  '队列已知大小在开始时预置进 totalBytes',
  /const knownTotalBytes = queue\.reduce\(\(sum, t\) => sum \+ \(t\.size \?\? 0\), 0\)/.test(downloader) &&
    /reporter\.addTotalBytes\(knownTotalBytes\)/.test(downloader),
  '不预置的话，已存在于磁盘的文件只进分子不进分母'
)
ok(
  'onSize 只补「大小未知」的任务（已知的会重复计入）',
  /if \(task\.size == null\) \{\s*\n\s*const prev = discoveredSize\.get\(task\) \?\? 0/.test(downloader),
  '已知 size 的任务再累加一次会把分母算大、进度走不到 100%'
)
ok(
  '未知大小用差值覆盖而非重复累加',
  /reporter\.addTotalBytes\(size - prev\)/.test(downloader)
)
ok(
  '已校验存在的文件仍计入 doneBytes（与分母口径配套）',
  /reporter\.addDoneBytes\(queue\[i\]\.size \?\? 0\)/.test(downloader)
)

console.log('\n显示层兜底：悬浮球夹紧')
const orb = read('src/renderer/src/components/DownloadOrb.tsx')
ok(
  '悬浮球百分比夹在 0–100',
  /Math\.max\(0, Math\.min\(100, Math\.round\(rawPercent\)\)\)/.test(orb),
  '显示层不该相信上游数据一定自洽'
)
ok(
  '进度页直接用主进程的 percent（已夹紧）',
  /ProgressBar percent=\{d\.percent\}/.test(read('src/renderer/src/pages/DownloadsPage.tsx'))
)

console.log('\n进度板块分级：大任务用大样式，细碎下载用小样式')
const types = read('src/shared/types.ts')
ok(
  'DownloadProgress 增加 jobTitle 字段',
  /jobTitle\?: string/.test(types),
  '没有它，大任务的标题只能是「当前文件名」'
)
ok(
  '实例安装上报 jobTitle（= 实例 id）',
  /jobTitle: json\.id/.test(downloader),
  '否则实例安装看起来和一个语言文件下载没区别'
)
ok('整合包导入上报 jobTitle', /jobTitle: `安装 \$\{name\}`/.test(read('src/main/modpack.ts')))
const forgeSrc = read('src/main/forge.ts')
ok(
  '加载器安装上报 jobTitle（= 加载器名），阶段名降为小行',
  /jobTitle: label/.test(forgeSrc) && /task: '运行安装器'/.test(forgeSrc),
  '大任务标题 + 当前阶段，才构成「大的包小的」'
)
const page = read('src/renderer/src/pages/DownloadsPage.tsx')
ok(
  '进度页按 jobTitle 分两档',
  /const bigTasks = active\.filter\(\(d\) => !!d\.jobTitle\)/.test(page) &&
    /const smallTasks = active\.filter\(\(d\) => !d\.jobTitle\)/.test(page)
)
ok(
  '大卡片里显示「当前文件」小行',
  /downloads\.currentFile/.test(page) && /d\.jobTitle/.test(page)
)
ok('大卡片显示文件计数', /downloads\.filesProgress/.test(page))
ok('小任务区有分区标题', /downloads\.otherTasks/.test(page))

console.log('\n文案：三套语言齐全')
for (const locale of ['zh-CN', 'zh-TW', 'en']) {
  const dict = JSON.parse(read(`src/renderer/src/i18n/locales/${locale}/core.json`))
  ok(
    `${locale} 三个键齐全`,
    typeof dict['downloads.currentFile'] === 'string' &&
      typeof dict['downloads.filesProgress'] === 'string' &&
      typeof dict['downloads.otherTasks'] === 'string'
  )
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
