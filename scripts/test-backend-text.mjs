/**
 * 后端三语文案解析回归测试（scripts/test-backend-text.mjs）。
 *
 * 目标：Rust 下发的「简体 / 繁體 / English」三段并列串必须按界面语言取出对应段，
 * 且**绝不能**误伤正常文本（用户目录名、模组名、AI 工具描述里也含 ` / `）。
 *
 * 运行：node scripts/test-backend-text.mjs
 */
import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setBackendLanguage, resolveBackendText, resolveBackendValue, localizeBackendError } from '../src/shared/backend-text.ts'

let pass = 0
let fail = 0
function ok(label, fn) {
  try {
    fn()
    pass++
    console.log(`  ok   ${label}`)
  } catch (error) {
    fail++
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

const TRI = '主页文件操作失败 / 主頁檔案操作失敗 / Homepage file operation failed'

ok('zh-CN 取简体段', () => assert.equal(resolveBackendText(TRI, 'zh-CN'), '主页文件操作失败'))
ok('zh-TW 取繁体段', () => assert.equal(resolveBackendText(TRI, 'zh-TW'), '主頁檔案操作失敗'))
ok('en 取英文段', () => assert.equal(resolveBackendText(TRI, 'en'), 'Homepage file operation failed'))
ok('ja 等未收录语言回落英文段', () => assert.equal(resolveBackendText(TRI, 'ja'), 'Homepage file operation failed'))
ok('语言大小写与下划线兼容', () => {
  assert.equal(resolveBackendText(TRI, 'ZH_tw'), '主頁檔案操作失敗')
  assert.equal(resolveBackendText(TRI, 'zh_Hant'), '主頁檔案操作失敗')
})
ok('简繁顺序颠倒时按字形纠正', () => {
  const reversed = '主頁檔案操作失敗 / 主页文件操作失败 / Homepage file operation failed'
  assert.equal(resolveBackendText(reversed, 'zh-CN'), '主页文件操作失败')
  assert.equal(resolveBackendText(reversed, 'zh-TW'), '主頁檔案操作失敗')
})
ok('带插值的文案同样可解析', () => {
  const text = '日志已上传（剩余可用次数 3） / 日誌已上傳（剩餘可用次數 3） / Logs uploaded (3 uses remaining)'
  assert.equal(resolveBackendText(text, 'zh-CN'), '日志已上传（剩余可用次数 3）')
  assert.equal(resolveBackendText(text, 'en'), 'Logs uploaded (3 uses remaining)')
})
ok('解析幂等（重复解析不再变化）', () => {
  const once = resolveBackendText(TRI, 'zh-TW')
  assert.equal(resolveBackendText(once, 'zh-CN'), once)
})

// ---- 不误伤 ----
const untouched = [
  '路径不存在或已被移动',
  '在 Modrinth / CurseForge 上按关键词搜索资源',
  '包含对外的可执行文件 / 压缩包 / 矢量图下载：https://example.com/a.zip',
  '可选：只保留适配某个加载器的结果，例如 fabric / forge / neoforge / quilt',
  'C:/Users/name/.minecraft/versions',
  '机械动力 / 附属 / Create',
]
for (const text of untouched) {
  ok(`保持原样：${text.slice(0, 22)}…`, () => assert.equal(resolveBackendText(text, 'en'), text))
}

// ---- 深度解析 ----
setBackendLanguage('en')
ok('嵌套结构中的文案被替换，其余字段保持不变', () => {
  const payload = {
    ok: false,
    items: [{ message: TRI, name: '机械动力 / Create' }, { message: '普通文本' }],
    count: 2
  }
  const resolved = resolveBackendValue(payload, 1000)
  assert.equal(resolved.items[0].message, 'Homepage file operation failed')
  assert.equal(resolved.items[0].name, '机械动力 / Create')
  assert.equal(resolved.items[1].message, '普通文本')
  assert.equal(resolved.count, 2)
  assert.equal(resolved.ok, false)
})
ok('没有命中时返回同一引用（零拷贝）', () => {
  const payload = { list: [{ name: 'sodium' }, { name: 'iris' }] }
  assert.equal(resolveBackendValue(payload), payload)
})
ok('预算耗尽时停止深入而不是抛错', () => {
  const huge = { list: Array.from({ length: 200 }, () => ({ message: TRI })) }
  const resolved = resolveBackendValue(huge, 10)
  assert.ok(resolved.list.length === 200)
})
ok('非普通对象（Uint8Array）原样返回', () => {
  const bytes = new Uint8Array([1, 2, 3])
  assert.equal(resolveBackendValue(bytes), bytes)
})

// ---- 错误对象 ----
ok('Error 的 message 被本地化，name 保留', () => {
  const error = new TypeError(TRI)
  const resolved = localizeBackendError(error)
  assert.ok(resolved instanceof Error)
  assert.equal(resolved.message, 'Homepage file operation failed')
  assert.equal(resolved.name, 'TypeError')
})
ok('无需本地化的 Error 原样返回同一对象', () => {
  const error = new Error('普通错误')
  assert.equal(localizeBackendError(error), error)
})

// ---- 语言注入 ----
ok('setBackendLanguage 影响后续解析', () => {
  setBackendLanguage('zh-TW')
  assert.equal(resolveBackendText(TRI), '主頁檔案操作失敗')
  setBackendLanguage('en')
  assert.equal(resolveBackendText(TRI), 'Homepage file operation failed')
  setBackendLanguage('')
})

// ---- 语料覆盖：Rust 现有三语串必须全部可解析 ----
ok('Rust 语料中的三语串全部可解析（防新增漏判）', () => {
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.rs')) files.push(full)
    }
  }
  walk(fileURLToPath(new URL('../src-tauri/src', import.meta.url)))
  const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
  const missed = []
  let candidates = 0
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      const literal = match[1]
      const parts = literal.split(' / ')
      if (parts.length !== 3) continue
      if (!cjk.test(parts[0]) || !cjk.test(parts[1]) || cjk.test(parts[2])) continue
      candidates += 1
      if (resolveBackendText(literal, 'zh-CN') === literal) missed.push(`${file}: ${literal.slice(0, 60)}`)
    }
  }
  assert.ok(candidates > 100, `语料量异常：仅 ${candidates} 条`)
  assert.equal(missed.length, 0, `以下三语串无法解析：\n${missed.slice(0, 10).join('\n')}`)
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
