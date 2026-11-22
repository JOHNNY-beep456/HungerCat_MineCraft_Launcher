// 直接执行真实 Tauri HTML 转换，不启动服务、不改 Electron 共用入口。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tauriHtmlPolicy } from '../vite.tauri.config.mts'

let passed = 0, failed = 0
function test(name, body) {
  try { body(); passed++; console.log(`  ok   ${name}`) }
  catch (error) { failed++; console.error(`  FAIL ${name}: ${error.stack ?? error}`) }
}
const sourcePath = new URL('../src/renderer/index.html', import.meta.url)
const original = readFileSync(sourcePath, 'utf8')
const policy = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).app.security.csp
const transformed = tauriHtmlPolicy(original)
const metas = [...transformed.matchAll(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi)]

test('共享入口只替换一条 CSP，策略来自 Tauri 真配置', () => {
  assert.equal(metas.length, 1)
  assert.ok(metas[0][0].includes(`content="${policy.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`))
})
test('主文档脚本仍严格 self，不给主页开放主应用脚本权限', () => {
  const script = /(?:^|;)\s*script-src\s+([^;]+)/.exec(policy)?.[1]
  assert.equal(script, "'self'")
  const frame = /(?:^|;)\s*frame-src\s+([^;]+)/.exec(policy)?.[1]
  assert.ok(frame?.includes('http://hc-homepage.localhost'))
  assert.ok(!frame?.split(/\s+/).includes('*'))
})
test('转换不改布局、资源标签或 Electron 原始入口', () => {
  const originalTag = original.match(/<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/i)?.[0]
  assert.ok(originalTag)
  assert.equal(transformed.replace(metas[0][0], ''), original.replace(originalTag, ''))
  assert.equal(readFileSync(sourcePath, 'utf8'), original)
})
test('缺失或重复 CSP 时拒绝构建，不能静默退到未知策略', () => {
  assert.throws(() => tauriHtmlPolicy('<html><head></head></html>'), /恰好/)
  assert.throws(() => tauriHtmlPolicy(original + metas[0][0]), /恰好/)
})
console.log(`结果：${passed} 通过 / ${failed} 失败`)
process.exitCode = failed ? 1 : 0
