/**
 * 模组安装兼容性错误与依赖提示的离线回归。
 * 覆盖：Rust 兼容性错误码、Forge 自包含 JSON 的加载器探测、三语文案、错误格式化与实例管理的依赖确认接线。
 * 不替代真实 React/WebView、Modrinth 网络或安装事务验收。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
let failed = 0
async function test(label, run) {
  try { await run(); passed++; console.log(`  ok   ${label}`) }
  catch (error) { failed++; console.error(`  FAIL ${label}: ${error.stack ?? error.message}`) }
}
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

await test('兼容性错误为 HC_COMPAT 机器码而非三语拼接', () => {
  const compat = read('src-tauri/src/catalog/install/compatibility.rs')
  for (const code of ['HC_COMPAT|METADATA', 'HC_COMPAT|NO_LOADER', 'HC_COMPAT|GAME|', 'HC_COMPAT|LOADER|']) {
    assert.ok(compat.includes(code), `缺少 ${code}`)
  }
  // 旧的三语拼接常量必须消失（前端按界面语言翻译）。
  assert.ok(!compat.includes('所选模组不适配'), '仍存在三语拼接 MISMATCH')
  assert.ok(!compat.includes('Invalid official mod compatibility metadata'), '仍存在三语拼接 INVALID')
  const install = read('src-tauri/src/catalog/install.rs')
  assert.ok(install.includes('HC_COMPAT|EVIDENCE'), 'install.rs 缺少 EVIDENCE 码')
  assert.ok(!install.includes('Official mod compatibility evidence is missing'), 'install.rs 仍存在三语拼接')
  // 错误码带实例值与文件值，便于前端说明「同一游戏版本但加载器不同」。
  assert.match(compat, /HC_COMPAT\|LOADER\|\{loader\}\|\{\}/)
  assert.match(compat, /fn summarize\(values: &\[String\]\)/)
})

await test('自包含 Forge JSON 经 fmlloader 坐标识别加载器', () => {
  const local = read('src-tauri/src/resource_updates/local.rs')
  assert.match(local, /Some\(\("net\.minecraftforge", "forge"\)\) \| Some\(\("net\.minecraftforge", "fmlloader"\)\) => Some\("forge"\)/)
  assert.match(local, /self_contained_forge_profile_detects_loader_via_fmlloader_coordinate/)
  assert.match(local, /net\.minecraftforge:fmlloader:1\.20\.1-47\.4\.28/)
})

await test('三语 res.compat.* 文案齐全', () => {
  for (const locale of ['zh-CN', 'zh-TW', 'en']) {
    const resources = JSON.parse(read(`src/renderer/src/i18n/locales/${locale}/resources.json`))
    for (const key of ['res.compat.game', 'res.compat.loader', 'res.compat.noLoader', 'res.compat.metadata', 'res.compat.evidence']) {
      assert.equal(typeof resources[key], 'string', `${locale} 缺少 ${key}`)
      assert.ok(resources[key].length > 0, `${locale} 的 ${key} 为空`)
    }
  }
})

await test('错误格式化把 HC_COMPAT 码映射为界面语言', () => {
  const formatter = read('src/renderer/src/mod-install-error.ts')
  assert.match(formatter, /startsWith\('HC_COMPAT\|'\)/)
  for (const key of ['res.compat.game', 'res.compat.loader', 'res.compat.noLoader', 'res.compat.metadata', 'res.compat.evidence']) {
    assert.ok(formatter.includes(key), `formatter 缺少 ${key}`)
  }
  assert.ok(formatter.includes("return message"), '未知错误必须原样返回')
  // 两个安装入口都在 catch 里套了格式化。
  for (const page of ['src/renderer/src/pages/ResourceDownloadPage.tsx', 'src/renderer/src/pages/InstanceManagePage.tsx']) {
    const source = read(page)
    assert.ok(source.includes('formatInstallError('), `${page} 未使用 formatInstallError`)
  }
})

await test('实例管理在线安装接入缺失前置确认', () => {
  const page = read('src/renderer/src/pages/InstanceManagePage.tsx')
  assert.ok(page.includes('findMissingDependencies('), 'installOnline 未检查缺失前置')
  assert.ok(page.includes('installPendingWithDependencies'), '缺少确认后并发安装')
  assert.ok(page.includes('<DependencyPromptDialog'), '未渲染依赖确认弹窗')
  // 切换实例必须重置版本 / 加载器筛选，避免把上一个实例的筛选带给新实例。
  assert.match(page, /setLoaderSel\(entryLoader \?\? 'fabric'\)/)
  assert.match(page, /setMcSel\(entry\?\.mcVersion \?\? ''\)/)
  assert.ok(!page.includes("prev === 'fabric' ? entryLoader"), '旧的「仅初始值覆盖」逻辑仍在')
})

await test('已安装资源图标联网补齐与列表容错', () => {
  // 通道与桥接
  const types = read('src/tauri/types.ts')
  assert.ok(types.includes("'manage:enrichMods'") && types.includes("'manage:enrichResources'"), 'types.ts 未登记补齐通道')
  const bridge = read('src/tauri/bridge.ts')
  assert.ok(bridge.includes("call('manage:enrichMods'"), 'bridge 未接 enrichMods')
  assert.ok(bridge.includes("call('manage:enrichResources'"), 'bridge 未接 enrichResources')
  // Rust 端：身份提取、挑选策略、门禁、事件通道对齐既有 resources:updated
  const catalog = read('src-tauri/src/catalog.rs')
  assert.ok(catalog.includes('mod_metadata::mod_identity'), '模组身份未接入补齐')
  assert.ok(catalog.includes('fn pick_project(') && catalog.includes('fn pick_pack_project('), '缺少项目挑选函数')
  assert.ok(catalog.includes('fn pack_search_name('), '缺少 packSearchName 移植')
  assert.ok(catalog.includes('"manage:enrichMods"') && catalog.includes('"manage:enrichResources"'), 'local_call 未注册补齐通道')
  assert.ok(catalog.includes('manage:mods-updated'), '模组补齐事件未走 manage:mods-updated')
  assert.ok(catalog.includes('"resources:updated"'), '资源补齐事件未走既有 resources:updated')
  assert.ok(catalog.includes('enrichment_gated'), '缺少本地/仅元数据门禁')
  // 列表逐条容错：单个坏文件不再让整列变空。
  const list = catalog.slice(catalog.indexOf('fn list_content'), catalog.indexOf('fn content_path'))
  assert.ok(list.includes('if let Ok(Some(row)) = row'), 'list_content 未改为逐条跳过')
  assert.ok(list.includes('let row = (|| -> Result<Option<Value>>'), 'list_content 未包逐条容错闭包')
  // 前端触发点与既有合并 effect。
  const page = read('src/renderer/src/pages/InstanceManagePage.tsx')
  assert.ok(page.includes('manage.enrichMods(') && page.includes("manage.enrichResources("), 'reload 后未触发补齐')
  assert.ok(page.includes('resources.onUpdated'), '资源合并 effect 缺失')
  // 元数据身份提取
  const meta = read('src-tauri/src/catalog/mod_metadata.rs')
  assert.ok(meta.includes('pub(super) fn mod_identity'), 'mod_identity 不存在')
})

await test('依赖检查与弹窗为共享模块，资源下载页同步复用', () => {
  const helper = read('src/renderer/src/pages/shared/mod-dependencies.ts')
  assert.ok(helper.includes('findMissingDependencies'))
  assert.ok(helper.includes("d.dependency_type === 'required'"))
  const dialog = read('src/renderer/src/pages/shared/DependencyPromptDialog.tsx')
  assert.ok(dialog.includes('res.dep.title'))
  const page = read('src/renderer/src/pages/ResourceDownloadPage.tsx')
  assert.ok(page.includes("from './shared/mod-dependencies'"))
  assert.ok(page.includes("from './shared/DependencyPromptDialog'"))
  assert.ok(!page.includes('async function findMissingDependencies'), '资源下载页仍保留本地副本')
})

console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed) process.exitCode = 1
