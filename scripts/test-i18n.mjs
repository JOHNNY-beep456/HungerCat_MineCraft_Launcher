/**
 * i18n 完整性测试：**源码引用的每个键都必须有文案定义**。
 *
 * 为什么需要它：`t()` 找不到键时不会报错，而是原样返回键名字符串 —— 界面上直接
 * 显示 `settings.dev.subtitle` 这种东西。这类故障在编译期与类型检查里都发现不了，
 * 只有真的打开页面才会看见，很容易漏掉（本项目就踩过一次：设置页两个子标题一直
 * 显示原始键名）。
 *
 * 顺带检查三语（zh-CN / zh-TW / en）的板块标题与关键新增文案是否齐全。
 *
 * 运行：node scripts/test-i18n.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCALES = join(ROOT, 'src/renderer/src/i18n/locales')

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

/** 收集源码里所有 t('...') 的键。 */
const sourceFiles = []
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (/\.tsx?$/.test(name)) sourceFiles.push(full)
  }
}
walk(join(ROOT, 'src'))

const used = new Set()
const re = /\bt\(\s*'([^']+)'/g
for (const file of sourceFiles) {
  const text = readFileSync(file, 'utf8')
  let m
  while ((m = re.exec(text)) !== null) used.add(m[1])
}

/** 每种语言定义的键。 */
const perLocale = new Map()
const allDefined = new Set()
for (const locale of readdirSync(LOCALES)) {
  const dir = join(LOCALES, locale)
  if (!statSync(dir).isDirectory()) continue
  const keys = new Set()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const dict = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    for (const k of Object.keys(dict)) {
      keys.add(k)
      allDefined.add(k)
    }
  }
  perLocale.set(locale, keys)
}

console.log(`引用的键 ${used.size} 个，已定义 ${allDefined.size} 个`)

console.log('\n引用但未定义（会原样显示键名）')
{
  const missing = [...used].filter((k) => !allDefined.has(k)).sort()
  ok('没有悬空引用', missing.length === 0, missing.join('\n       '))
}

console.log('\n简体中文（兜底语言）必须齐全')
{
  const zh = perLocale.get('zh-CN') ?? new Set()
  const missing = [...used].filter((k) => !zh.has(k)).sort()
  ok('zh-CN 覆盖所有引用', missing.length === 0, missing.join(', '))
}

console.log('\n「开发者选项」两个子标题')
{
  for (const key of ['settings.dev.subtitle', 'settings.dev.debugSubtitle']) {
    for (const locale of ['zh-CN', 'zh-TW', 'en']) {
      const keys = perLocale.get(locale) ?? new Set()
      ok(`${locale} 有 ${key}`, keys.has(key))
    }
  }
}

console.log('\n「游戏」板块 Java 开关文案')
{
  // 需求：原「自动检测」改为「自动选择 Java 运行时版本」
  for (const locale of ['zh-CN', 'zh-TW', 'en']) {
    const dict = JSON.parse(readFileSync(join(LOCALES, locale, 'core.json'), 'utf8'))
    const value = dict['settings.row.javaAutoDetect'] ?? ''
    ok(`${locale} 文案已更新（不是旧的「自动检测」）`, value !== '' && value !== '自动检测' && value !== '自動偵測', `实际: "${value}"`)
  }
}

console.log('\n废弃键已移除')
{
  // 悬浮球展开态的「关闭」按钮已删除，其文案不应再残留
  for (const locale of ['zh-CN', 'zh-TW', 'en']) {
    const dict = JSON.parse(readFileSync(join(LOCALES, locale, 'ai.json'), 'utf8'))
    ok(`${locale} 无 ai.close`, !('ai.close' in dict))
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
