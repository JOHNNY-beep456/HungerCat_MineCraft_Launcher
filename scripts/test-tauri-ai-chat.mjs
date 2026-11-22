/**
 * AI 主窗对话页的离线回归：直接执行真实导航显隐函数，并检查路由与既有 AI 桥接线。
 * 不替代真实 React/WebView、网络对话或原生悬浮球验收。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

let passed = 0
let failed = 0
async function test(label, run) {
  try { await run(); passed++; console.log(`  ok   ${label}`) }
  catch (error) { failed++; console.error(`  FAIL ${label}: ${error.stack ?? error.message}`) }
}
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

await test('对话导航仅在 AI 开启且非本地模式时显示', () => {
  const source = read('src/renderer/src/components/Sidebar.tsx')
  const navigation = source.slice(source.indexOf('export type PageId'), source.indexOf('export function Sidebar'))
  const { outputText, reportDiagnostics } = ts.transpileModule(navigation, {
    fileName: 'Sidebar.tsx', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  })
  assert.ok(!(reportDiagnostics ?? []).some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error))
  const module = { exports: {} }
  vm.runInNewContext(outputText, { module, exports: module.exports })
  const ids = (settings) => Array.from(module.exports.visibleNav({ mode: 'normal', enableMultiplayer: false, ...settings }), (item) => item.id)
  assert.ok(!ids({ aiEnabled: false }).includes('chat'))
  assert.ok(ids({ aiEnabled: true }).includes('chat'))
  assert.ok(!ids({ aiEnabled: true, mode: 'local' }).includes('chat'))
  assert.equal(module.exports.isPageVisible({ mode: 'normal', enableMultiplayer: false, aiEnabled: true }, 'chat'), true)
  assert.equal(module.exports.isPageVisible({ mode: 'normal', enableMultiplayer: false, aiEnabled: false }, 'chat'), false)
})

await test('对话路由有 AI 开关兜底并复用既有聊天、取消和重置桥', () => {
  const router = read('src/renderer/src/pages/router.tsx')
  assert.match(router, /case 'chat':\s*\/\/[^\n]*\s*if \(!aiEnabled\) return <HomeRoute \/>\s*return <AiChatPage \/>/u)
  const page = read('src/renderer/src/pages/AiChatPage.tsx')
  for (const call of ['window.api.ai.chat(', 'window.api.ai.cancel()', 'window.api.ai.reset()']) assert.ok(page.includes(call), `缺少 ${call}`)
  for (const locale of ['zh-CN', 'zh-TW', 'en']) {
    const core = JSON.parse(read(`src/renderer/src/i18n/locales/${locale}/core.json`))
    assert.equal(typeof core['nav.chat'], 'string')
    assert.ok(core['nav.chat'].length > 0)
  }
})

console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed) process.exitCode = 1
