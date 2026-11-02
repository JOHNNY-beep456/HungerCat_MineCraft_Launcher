/**
 * 「愚人节版」判定与接入的回归测试。
 *
 * 核心判定在 `src/shared/version-type.ts`，本测试**直接 import 真实模块跑行为**
 * （Node 24 原生剥离类型），而不是只做源码正则断言 —— 分类逻辑错了必须真的报错。
 *
 * 为什么这个逻辑值得单测：官方版本清单只给 release/snapshot，愚人节版混在
 * snapshot 里；一旦判定写错，会把正常快照（24w14a）误标成愚人节版，
 * 或者把愚人节版漏进快照分栏。
 *
 * 运行：node scripts/test-version-type.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { displayVersionType, isAprilFoolsVersion } from '../src/shared/version-type.ts'

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

console.log('已知愚人节版（白名单）')
// 2.0 在官方清单里是 release 类型；15w14a 符合标准快照格式 —— 都只能靠白名单
for (const [id, type] of [
  ['2.0', 'release'],
  ['15w14a', 'snapshot'],
  ['2.0', undefined]
]) {
  ok(`${id}（type=${type ?? '未给'}）判定为愚人节版`, isAprilFoolsVersion(id, type))
}

console.log('\n格式启发式：不符合标准格式的快照')
const PATTERN = [
  '1.RV-Pre1',
  '3D Shareware v1.34',
  '20w14infinite',
  '22w13oneBlockAtATime',
  '23w13a_or_b',
  '24w14potato',
  '25w14craftmine'
]
for (const id of PATTERN) {
  ok(`${id} 判定为愚人节版`, displayVersionType(id, 'snapshot') === 'aprilfools')
}

console.log('\n常规版本不能被误判（最重要的反向断言）')
for (const id of ['1.20.1', '1.7.10', '1.21', '1.20', '2.0.0']) {
  const got = displayVersionType(id, 'release')
  ok(`${id} 是正式版`, got === 'release', `实际 ${got}`)
}
for (const id of ['24w14a', '20w14a', '15w14b', '13w01a']) {
  const got = displayVersionType(id, 'snapshot')
  ok(`${id} 是快照（不是愚人节版）`, got === 'snapshot', `实际 ${got}`)
}

console.log('\n新命名格式的快照（2026 起）：绝不能被当成愚人节版')
// 真实回归：实例 26.4-snapshot-1 / -2 曾被误标为「愚人节版」
for (const id of ['26.4-snapshot-1', '26.4-snapshot-2', '27.1-snapshot-1', '26.4-snapshot-12']) {
  ok(`${id}（type=snapshot）是快照`, displayVersionType(id, 'snapshot') === 'snapshot')
  ok(`${id}（无 type）是快照`, displayVersionType(id) === 'snapshot')
  ok(`${id} 不是愚人节版`, isAprilFoolsVersion(id) === false)
}

console.log('\n未知/自定义 id 一律不算愚人节版（宁可漏判，不可错判）')
for (const id of ['custom-1.2', '我的整合包', 'snapshot-x', '1.20.1-hotfix']) {
  ok(`${id} 不会被判成愚人节版`, isAprilFoolsVersion(id) === false)
}

console.log('\n远古版本保留原类型')
ok('old_beta 保留', displayVersionType('b1.7.3', 'old_beta') === 'old_beta')
ok('old_alpha 保留', displayVersionType('a1.2.6', 'old_alpha') === 'old_alpha')

console.log('\n实例场景：只有 base 版本号、没有 type')
// 已安装实例只能拿到 base mcVersion，必须仍能识别愚人节版
for (const id of ['24w14potato', '20w14infinite', '15w14a', '2.0']) {
  ok(`${id}（无 type）仍判为愚人节版`, displayVersionType(id) === 'aprilfools')
}
for (const id of ['1.20.1', '24w14a', '26.4-snapshot-1']) {
  const want = id === '1.20.1' ? 'release' : 'snapshot'
  ok(`${id}（无 type）判为 ${want}`, displayVersionType(id) === want)
}

console.log('\n健壮性')
ok('空串不会崩', displayVersionType('') === 'release')
ok('空白串不会崩', isAprilFoolsVersion('   ') === false)
// 大小写：白名单统一小写比较，官方 id 大小写混杂（3D Shareware v1.34）
ok('大小写不敏感', isAprilFoolsVersion('3d shareware v1.34'))

console.log('\n接入点：版本列表分栏')
const versionsPage = read('src/renderer/src/pages/VersionsPage.tsx')
ok(
  'Filter 类型含 aprilfools',
  /type Filter = 'all' \| 'release' \| 'snapshot' \| 'aprilfools'/.test(versionsPage)
)
ok(
  '列表筛选走 displayVersionType（不是直接比 v.type）',
  /displayVersionType\(v\.id, v\.type\) !== filter/.test(versionsPage)
)
ok(
  '分栏里有「愚人节版」选项',
  /value: 'aprilfools'/.test(versionsPage) && /res\.versions\.filter\.aprilfools/.test(versionsPage)
)
ok('列表卡片按派生类型显示标签', /res\.versions\.typeAprilFools/.test(versionsPage))

console.log('\n接入点：实例类型识别')
const installed = read('src/main/installed.ts')
ok(
  '按 base mcVersion 计算 versionType',
  /const versionType = displayVersionType\(mcVersion\)/.test(installed)
)
ok('返回值带上 versionType', /versionType: meta\.versionType/.test(installed))
const instancesPage = read('src/renderer/src/pages/InstancesPage.tsx')
ok('实例卡片显示愚人节版标记', /v\.versionType === 'aprilfools'/.test(instancesPage) && /ins\.aprilFools/.test(instancesPage))
ok('外部版本列表也能识别', /displayVersionType\(ver\.mcVersion\)/.test(instancesPage))
// 回归：实例方块曾写死绿蓝渐变，愚人节版实例和普通实例长得一样
ok(
  '实例方块按愚人节版上紫色',
  /v\.versionType === 'aprilfools'[\s\S]{0,120}#bf5af2/.test(instancesPage),
  '否则只有一个文字标签，扫一眼看不出区别'
)
// 回归：快照实例曾落进「其他」分支，和正式版同色
ok(
  '实例方块按快照上橙色',
  /v\.versionType === 'snapshot'[\s\S]{0,100}#ff9f0a/.test(instancesPage),
  '快照实例必须与正式版区分开'
)
ok(
  '实例与版本列表的橙色一致',
  /#ff9f0a,#ff375f/.test(instancesPage) && /#ff9f0a,#ff375f/.test(versionsPage),
  '两处配色不同会让用户以为是两种类型'
)

console.log('\n文案：三套语言齐全')
for (const locale of ['zh-CN', 'zh-TW', 'en']) {
  const res = JSON.parse(read(`src/renderer/src/i18n/locales/${locale}/resources.json`))
  const ins = JSON.parse(read(`src/renderer/src/i18n/locales/${locale}/instances.json`))
  ok(
    `${locale} 三个键齐全`,
    typeof res['res.versions.filter.aprilfools'] === 'string' &&
      typeof res['res.versions.typeAprilFools'] === 'string' &&
      typeof ins['ins.aprilFools'] === 'string'
  )
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
