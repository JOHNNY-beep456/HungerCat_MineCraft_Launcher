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
function load(path, mocks = {}, context = vm.createContext({ Object, Array, Uint8Array, URL, Headers, console, setTimeout, clearTimeout })) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const module = vm.runInContext('({ exports: {} })', context)
  const require = (key) => {
    if (!Object.hasOwn(mocks, key)) throw new Error(`未声明的测试依赖：${key}`)
    return mocks[key]
  }
  const execute = new vm.Script(`(function(require, module, exports) {\n${output}\n})`, { filename: path }).runInContext(context)
  execute(require, module, module.exports)
  return module.exports
}
const nativeDocumentMarker = 'a'.repeat(64)
function fixture({ held = false, rejected = false, marker = nativeDocumentMarker, topFrame = true } = {}) {
  const handlers = new Map()
  const calls = []
  const failures = []
  let released = false
  let unlistened = 0
  let releaseListener
  const listenerReady = held ? new Promise((resolve) => { releaseListener = resolve }) : Promise.resolve()
  const window = { __HC_NATIVE_DOCUMENT__: marker }
  window.top = topFrame ? window : {}
  const context = vm.createContext({ window, Object, Array, Uint8Array, URL, Headers, console, setTimeout, clearTimeout })
  // 仅模拟最外层原生边界；真实 nativeInvoke 必须先完成顶层 marker 检查和 header 编码。
  const core = {
    isTauri: () => true,
    invoke: async (command, args, options) => {
      assert.equal(window.top, window, '子框架不得到达原生业务边界')
      assert.equal(window.__HC_NATIVE_DOCUMENT__, nativeDocumentMarker)
      assert.equal(options?.headers?.['x-hcmcl-document'], nativeDocumentMarker)
      assert.equal(options.headers instanceof Headers, false, 'Tauri 仅接收普通 header 记录')
      assert.equal(Object.getPrototypeOf(options.headers), Object.prototype)
      calls.push({ command, args })
      return 'hcmcl-pack-download:fixture'
    }
  }
  const types = load('src/tauri/types.ts', {}, context)
  const native = load('src/tauri/native-invoke.ts', { '@tauri-apps/api/core': core }, context)
  const transport = load('src/tauri/transport.ts', {
    './types': types,
    './native-invoke': native,
    '@tauri-apps/api/core': core,
    '@tauri-apps/api/event': {
      listen: async (event, callback) => {
        await listenerReady
        if (rejected) throw new Error('fixture listen rejected')
        handlers.set(event, callback)
        released = true
        return () => { unlistened++; handlers.delete(event) }
      }
    },
    '@tauri-apps/api/webview': {
      getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} })
    }
  }, context)
  const mobileDebug = load('src/tauri/mobile-debug.ts', {}, context)
  const bridge = load('src/tauri/bridge.ts', { './transport': transport, './mobile-debug': mobileDebug }, context)
  const api = bridge.createTauriApi({ platform: 'win32', onError: (failure) => failures.push(failure) })
  return {
    api, bridge, calls, failures, types,
    ready: bridge.tauriApiReady(api),
    release: () => releaseListener?.(),
    native: (event, payload) => handlers.get(event)?.({ payload }),
    dispose: () => bridge.disposeTauriApi(api),
    get registered() { return released },
    get unlistened() { return unlistened }
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const clean = (value) => JSON.parse(JSON.stringify(value))

await test('统一原生封装投递到既有整合包和下载进度订阅', async () => {
  const current = fixture()
  const pack = []
  const downloads = []
  current.api.modpack.onProgress((payload) => pack.push(payload))
  current.api.download.onProgress((payload) => downloads.push(payload))
  await current.ready
  const payload = { taskId: 'modpack', phase: 'mod', percent: 42, currentBytes: 12, totalBytes: 24 }
  for (const channel of ['modpack:progress', 'download:progress']) {
    current.native('launcher:event', { channel, payload })
  }
  assert.deepEqual(pack, [payload])
  assert.deepEqual(downloads, [payload])
  assert.equal(current.failures.length, 0)
  current.dispose()
})

await test('裸事件、未知通道和无效封装不能误投递', async () => {
  const current = fixture()
  const received = []
  current.api.modpack.onProgress((payload) => received.push(payload))
  await current.ready
  current.native('modpack:progress', { taskId: 'modpack', percent: 10 })
  for (const envelope of [null, 'bad', {}, { channel: 3 }, { channel: 'unknown', payload: {} }]) {
    current.native('launcher:event', envelope)
  }
  assert.equal(received.length, 0)
  current.dispose()
})

await test('调用等待统一监听注册，下载仍返回不透明归档标识', async () => {
  const current = fixture({ held: true })
  const pending = current.api.modpack.download('https://example.invalid/pack.zip', 'pack.zip')
  await tick()
  assert.equal(current.calls.length, 0)
  assert.equal(current.registered, false)
  current.release()
  const result = await pending
  assert.equal(result, 'hcmcl-pack-download:fixture')
  assert.deepEqual(clean(current.calls), [{
    command: 'launcher_call',
    args: { channel: 'modpack:download', args: ['https://example.invalid/pack.zip', 'pack.zip'] }
  }])
  current.dispose()
})

await test('版本清单缺省参数编码为空值，显式刷新布尔值不变', async () => {
  const current = fixture()
  await current.api.versions.list()
  await current.api.versions.list(undefined)
  await current.api.versions.list(false)
  await current.api.versions.list(true)
  assert.deepEqual(clean(current.calls), [
    { command: 'launcher_call', args: { channel: 'versions:list', args: [null] } },
    { command: 'launcher_call', args: { channel: 'versions:list', args: [null] } },
    { command: 'launcher_call', args: { channel: 'versions:list', args: [false] } },
    { command: 'launcher_call', args: { channel: 'versions:list', args: [true] } }
  ])
  current.dispose()
})

await test('真实nativeInvoke拒绝无效marker及子框架，原生边界不被调用', async () => {
  for (const options of [
    { marker: null }, { marker: '' }, { marker: 'a'.repeat(63) },
    { marker: 'A'.repeat(64) }, { marker: 'g'.repeat(64) },
    { topFrame: false }
  ]) {
    const current = fixture(options)
    await current.ready
    try {
      await assert.rejects(current.api.versions.list(), /This document cannot invoke native business commands/)
      assert.equal(current.calls.length, 0)
      assert.equal(current.failures.length, 0, '文档拒绝不能变成监听注册失败')
    } finally { current.dispose() }
  }
})

await test('取消入口源码顺序保留权限门禁并早于存储、密钥与目录读取', () => {
  // 源码级回归只约束组合根顺序；实际任务状态由 Rust 局部夹具验证。
  const source = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  const entry = source.slice(source.indexOf('async fn launcher_call('), source.indexOf('async fn launcher_call_inner('))
  // 先校验通道，再核验日志、固定工具页、HUD 与悬浮球窄权限；全部早于 Gate 和实际分发。
  const ordered = ['validate_request(&channel, &args, CALL_CHANNELS)?', 'if channel == "debug:getLogs"', 'debug::authorize_log_read(&window)?', 'devmode::authorize_tools_window(&app,&window)?', 'ai_hud_window::authorize_snapshot_read(&window)?', 'ai_hud_window::authorize_multiplayer(&app, &window).await?', 'lyrics::channel_allowed(&channel)', 'ai_hud_window::authorize_lyrics(&app, &window, channel == "music:lyricsState").await?', 'ai_voice::hud_channel_allowed(&channel)', 'ai_hud_window::authorize_voice(&app, &window, channel == "ai:voiceState").await?', 'ai_voice::require_enabled(&app)?', 'multiplayer::authorize_danmaku(&app, &window).await?', 'multiplayer::mini_channel_allowed(&channel)', 'multiplayer::authorize_mini(&app, &window).await?', 'ai_ball_channel_allowed(&channel)', 'ai_ball::authorize(&app, &window)?', 'trusted_main(&window)?', 'app.state::<lifecycle::Gate>().enter()?', 'launcher_call_inner(app, window, channel, args).await']
  let previous = -1
  for (const fragment of ordered) {
    const index = entry.indexOf(fragment)
    assert.ok(index > previous, `入口门禁顺序不符：${fragment}`)
    previous = index
  }
  const permission = entry.slice(entry.indexOf('if channel == "debug:getLogs"'), entry.indexOf('if channel == "app:relaunch"'))
    .replace(/\/\/[^\n]*/gu, '')
  assert.match(permission, /^if channel == "debug:getLogs"\s*\{\s*debug::authorize_log_read\(&window\)\?;\s*\}\s*else if window\.label\(\) == "devtools" && matches!\(channel\.as_str\(\), "devmode:status" \| "devmode:setSecurityMode"\)\s*\{\s*#\[cfg\(desktop\)\]\s*devmode::authorize_tools_window\(&app,\s*&window\)\?;\s*#\[cfg\(mobile\)\]\s*return Err\("[^"\n]+"\.into\(\)\);\s*\}\s*else if channel == "ai:hudState" && window\.label\(\) == "ai-hud"\s*\{\s*ai_hud_window::authorize_snapshot_read\(&window\)\?;\s*\}\s*else if channel == "mp:hudState" && window\.label\(\) == "ai-hud"\s*\{\s*ai_hud_window::authorize_multiplayer\(&app,\s*&window\)\.await\?;\s*\}\s*else if window\.label\(\) == "ai-hud" && lyrics::channel_allowed\(&channel\)\s*\{\s*ai_hud_window::authorize_lyrics\(&app,\s*&window,\s*channel == "music:lyricsState"\)\.await\?;\s*\}\s*else if window\.label\(\) == "ai-hud" && ai_voice::hud_channel_allowed\(&channel\)\s*\{\s*ai_hud_window::authorize_voice\(&app,\s*&window,\s*channel == "ai:voiceState"\)\.await\?;\s*if channel != "ai:voiceState"\s*\{\s*ai_voice::require_enabled\(&app\)\?;\s*\}\s*\}\s*else if window\.label\(\) == "danmaku"\s*\{\s*if channel != "mp:danmakuConfig"\s*\{\s*return Err\("[^"\n]+"\.into\(\)\);\s*\}\s*multiplayer::authorize_danmaku\(&app,\s*&window\)\.await\?;\s*\}\s*else if window\.label\(\) == "mini"\s*\{\s*if !multiplayer::mini_channel_allowed\(&channel\)\s*\{\s*return Err\("[^"\n]+"\.into\(\)\);\s*\}\s*multiplayer::authorize_mini\(&app,\s*&window\)\.await\?;\s*\}\s*else if window\.label\(\) == "ai-ball"\s*\{\s*if !ai_ball_channel_allowed\(&channel\)\s*\{\s*return Err\("[^"\n]+"\.into\(\)\);\s*\}\s*ai_ball::authorize\(&app,\s*&window\)\?;\s*\}\s*else\s*\{\s*trusted_main\(&window\)\?;\s*\}\s*$/u, '专用权限仅限日志、工具页状态/安全档位、HUD 快照/歌词两入口/固定语音命令、精确自有小窗及悬浮球白名单；其余仍须主窗权限')
  const inner = source.slice(source.indexOf('async fn launcher_call_inner('), source.indexOf('async fn launcher_send('))
  const wait = inner.indexOf('wait_for_storage(&app).await?')
  assert.ok(wait > 0)
  const download = inner.indexOf('"download:cancel" => return downloads::call(')
  const ai = inner.indexOf('services::task_control_with_hud(&app, &channel)')
  assert.ok(download >= 0 && download < wait, '下载取消不得等待存储')
  assert.ok(ai >= 0 && ai < wait, 'AI 任务控制不得等待存储')
  for (const fragment of ['api_key_for_backend(', 'settings_for_backend(', 'operation_game_dir(']) {
    assert.ok(inner.indexOf(fragment) > wait, `取消前出现配置依赖：${fragment}`)
  }
  assert.equal(inner.split('"download:cancel"').length - 1, 1, '下载取消只保留一个提前分发点')
})

await test('导出取消路径使用任务缓存而不读取存储', () => {
  // 静态守卫入口及其直接调用的取消实现，不替代阻塞故障注入。
  for (const [path, start, end, required] of [
    ['src-tauri/src/desktop_export.rs', 'fn request_cancel(', 'fn state<R:', 'slot.locale'],
    ['src-tauri/src/desktop_export.rs', 'pub(super) fn cancel_download(', 'pub(super) fn cancel_for_window(', 'request_cancel('],
    ['src-tauri/src/mobile_files.rs', 'fn request_export_cancel<R:', 'pub(super) fn cancel_export<R:', 'slot.locale'],
    ['src-tauri/src/mobile_files.rs', 'pub(super) fn cancel_export<R:', 'fn start_expiry<R:', 'request_export_cancel(']
  ]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    const from = source.indexOf(start)
    const to = source.indexOf(end, from + start.length)
    assert.ok(from >= 0 && to > from, `取消函数边界缺失：${path}`)
    const body = source.slice(from, to)
    assert.ok(body.includes(required), `取消函数缺少缓存或转发：${path}`)
    for (const forbidden of ['storage_language(', 'language(app)', 'settings:get', 'settings_for_backend(', 'api_key_for_backend(']) {
      assert.ok(!body.includes(forbidden), `取消函数依赖存储：${path} ${forbidden}`)
    }
  }
})

await test('新对话只清历史而不取消聊天或独立转写', () => {
  const source = readFileSync(new URL('../src-tauri/src/services.rs', import.meta.url), 'utf8')
  const reset = source.slice(source.indexOf('fn reset_ai_from('), source.indexOf('fn reset_ai()', source.indexOf('fn reset_ai_from(')))
  assert.ok(reset.includes('state.history.clear()'))
  assert.ok(reset.includes('history_generation=state.history_generation.wrapping_add(1)'))
  assert.ok(!reset.includes('cancel.cancel()'), 'reset 不得取消当前聊天')
  const record = source.slice(source.indexOf('fn record_ai_history('), source.indexOf('fn task_control_from('))
  assert.ok(record.includes('state.history_generation==generation'))
  const control = source.slice(source.indexOf('fn task_control_from('), source.indexOf('/// 只操作内存任务登记'))
  const resetBranch = control.slice(control.indexOf('"ai:reset"'), control.indexOf('_=>'))
  assert.ok(resetBranch.includes('reset_ai_from(ai)'))
  assert.ok(!resetBranch.includes('cancel_checked'), 'reset 不得取消独立转写')
})

await test('两种导入保持可选名称和目录的位置参数，空值不移位', async () => {
  const current = fixture()
  await current.api.modpack.import('hcmcl-pack-download:fixture', undefined, 'default')
  await current.api.modpack.importFromUrl('https://example.invalid/pack.zip', 'pack.zip', ' 自定义实例 ', 'other')
  assert.deepEqual(clean(current.calls), [
    { command: 'launcher_call', args: { channel: 'modpack:import', args: ['hcmcl-pack-download:fixture', null, 'default'] } },
    { command: 'launcher_call', args: { channel: 'modpack:importFromUrl', args: ['https://example.invalid/pack.zip', 'pack.zip', ' 自定义实例 ', 'other'] } }
  ])
  current.dispose()
})

await test('退订、重复退订和dispose即时阻止后续进度', async () => {
  const current = fixture()
  const received = []
  const unsubscribe = current.api.modpack.onProgress((payload) => received.push(payload))
  await current.ready
  current.native('launcher:event', { channel: 'modpack:progress', payload: 1 })
  unsubscribe()
  unsubscribe()
  current.native('launcher:event', { channel: 'modpack:progress', payload: 2 })
  current.dispose()
  current.dispose()
  current.native('launcher:event', { channel: 'modpack:progress', payload: 3 })
  assert.deepEqual(received, [1])
  assert.equal(current.unlistened, 1)
})

await test('监听尚未完成就dispose不会残留原生监听器或派发调用', async () => {
  const current = fixture({ held: true })
  const pending = current.api.modpack.download('https://example.invalid/pack.zip', 'pack.zip')
  const rejected = assert.rejects(pending, /已释放|注册期间/)
  await tick()
  current.dispose()
  current.release()
  await rejected
  assert.equal(current.calls.length, 0)
  assert.equal(current.unlistened, 1)
})

await test('监听注册失败明确拒绝调用而不是静默丢失进度', async () => {
  const current = fixture({ rejected: true })
  const pending = current.api.modpack.download('https://example.invalid/pack.zip', 'pack.zip')
  await assert.rejects(pending, /fixture listen rejected/)
  assert.equal(current.calls.length, 0)
  assert.ok(current.failures.some((failure) => failure.operation === 'event:listen'))
  current.dispose()
})

await test('订阅异常隔离且原239公开契约保留，内部语音快照单独计数', async () => {
  const current = fixture()
  const received = []
  current.api.modpack.onProgress(() => { throw new Error('fixture subscriber failed') })
  current.api.modpack.onProgress((payload) => received.push(payload))
  await current.ready
  current.native('launcher:event', { channel: 'modpack:progress', payload: { percent: 100, phase: 'done' } })
  assert.equal(received.length, 1)
  assert.ok(current.failures.some((failure) => failure.operation === 'event:modpack:progress:callback'))
  const internalVoice = 'ai:voiceState'
  assert.equal(current.types.launcherCallChannels.filter((channel) => channel === internalVoice).length, 1)
  assert.equal(current.types.launcherEventChannels.filter((channel) => channel === internalVoice).length, 1)
  const internalMultiplayerHud = 'mp:hudState'
  const internalMiniDrag = 'mp:miniDrag'
  assert.equal(current.types.launcherCallChannels.filter((channel) => channel === internalMultiplayerHud).length, 1)
  assert.equal(current.types.launcherCallChannels.filter((channel) => channel === internalMiniDrag).length, 1)
  assert.equal(current.types.launcherCallChannels.filter((channel) => ![internalVoice, internalMultiplayerHud, internalMiniDrag].includes(channel)).length, 214)
  assert.equal('hudState' in current.api.mp, false, '内部投影不增加共享 LauncherApi 方法')
  assert.equal('miniDrag' in current.api.mp, false, '内部拖动不增加共享 LauncherApi 方法')
  assert.equal(current.types.launcherSendChannels.length, 2)
  assert.equal(current.types.launcherEventChannels.filter((channel) => channel !== internalVoice).length, 23)
  assert.equal('voiceState' in current.api.ai, false, '内部快照不增加共享 LauncherApi 方法')
  current.dispose()
})

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exitCode = failed ? 1 : 0
