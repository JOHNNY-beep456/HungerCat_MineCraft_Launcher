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
function load(path, mocks = {}, globals = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    module, exports: module.exports, console, setTimeout, clearTimeout,
    require(key) { if (!Object.hasOwn(mocks, key)) throw new Error(`未声明的测试依赖：${key}`); return mocks[key] },
    ...globals
  }, { filename: path })
  return module.exports
}
function fixture() {
  let sequence = 0
  const timers = new Map()
  const mobile = load('src/tauri/mobile-debug.ts', {}, {
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) }
  })
  const controller = mobile.createTauriMobileDebugController()
  const shown = []
  const hidden = []
  const host = { show: (request) => shown.push(request), hide: (id) => hidden.push(id) }
  return { mobile, controller, host, shown, hidden, timers }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

await test('宿主未挂载时打开明确失败，不提前报告页面已打开', async () => {
  const { controller } = fixture()
  await assert.rejects(controller.open(), /not mounted/)
  assert.equal(controller.visible(), false)
  controller.dispose()
})
await test('同轮重复打开共用真实挂载回执，已打开时不再显示第二页', async () => {
  const current = fixture()
  current.controller.attach(current.host)
  const first = current.controller.open()
  const second = current.controller.open()
  assert.equal(first, second)
  let completed = false
  void first.then(() => { completed = true })
  await settle()
  assert.equal(completed, false)
  assert.equal(current.controller.visible(), false)
  assert.equal(current.shown.length, 1)
  current.shown[0].opened()
  await first
  assert.equal(current.controller.visible(), true)
  assert.equal(current.timers.size, 0)
  await current.controller.open()
  assert.equal(current.shown.length, 1)
  current.controller.dispose()
})
await test('关闭等待实际撤页回执，重复关闭只派发一次', async () => {
  const current = fixture()
  current.controller.attach(current.host)
  const opened = current.controller.open()
  current.shown[0].opened()
  await opened
  const closing = current.controller.close()
  assert.equal(closing, current.controller.close())
  let completed = false
  void closing.then(() => { completed = true })
  await settle()
  assert.equal(completed, false)
  assert.deepEqual(current.hidden, [current.shown[0].id])
  current.shown[0].closed()
  await closing
  assert.equal(current.controller.visible(), false)
  assert.equal(current.timers.size, 0)
  current.controller.dispose()
})
await test('同批打开后立即关闭，旧opened不能完成打开', async () => {
  const current = fixture()
  current.controller.attach(current.host)
  const opening = current.controller.open()
  const rejected = assert.rejects(opening, /did not complete/)
  const closing = current.controller.close()
  current.shown[0].opened()
  assert.equal(current.controller.visible(), false)
  current.shown[0].closed()
  await Promise.all([rejected, closing])
  current.controller.dispose()
})
await test('卸载或宿主失败拒绝未完成操作，重挂载忽略上一轮回执', async () => {
  const current = fixture()
  const detach = current.controller.attach(current.host)
  const first = current.controller.open()
  const rejected = assert.rejects(first, /did not complete/)
  const stale = current.shown[0]
  detach(); detach()
  await rejected
  assert.equal(current.timers.size, 0)
  current.controller.attach(current.host)
  const second = current.controller.open()
  stale.opened(); stale.closed(); stale.failed()
  assert.equal(current.controller.visible(), false)
  current.shown[1].opened()
  await second
  assert.equal(current.controller.visible(), true)
  current.controller.dispose()
})
await test('宿主show抛错或明确failed都返回固定失败且不回显异常内容', async () => {
  const current = fixture()
  const detach = current.controller.attach({ show() { throw new Error('private host details') }, hide() {} })
  await assert.rejects(current.controller.open(), (error) => /did not complete/.test(error.message) && !error.message.includes('private'))
  detach()
  current.controller.attach(current.host)
  const opening = current.controller.open()
  const rejected = assert.rejects(opening, /did not complete/)
  current.shown[0].failed()
  await rejected
  assert.equal(current.controller.visible(), false)
  current.controller.dispose()
})
await test('真实回执超时后撤页并拒绝，迟到回执不复活页面', async () => {
  const current = fixture()
  current.controller.attach(current.host)
  const opening = current.controller.open()
  const rejected = assert.rejects(opening, /did not complete/)
  const [{ callback, delay }] = [...current.timers.values()]
  assert.equal(delay, 15_000)
  callback()
  await rejected
  current.shown[0].opened()
  assert.equal(current.controller.visible(), false)
  assert.deepEqual(current.hidden, [current.shown[0].id])
  assert.equal(current.timers.size, 0)
  current.controller.dispose()
})
await test('dispose拒绝等待并禁止后续打开、关闭和注册', async () => {
  const current = fixture()
  current.controller.attach(current.host)
  const opening = current.controller.open()
  const rejected = assert.rejects(opening, /did not complete/)
  current.controller.dispose(); current.controller.dispose()
  await rejected
  await assert.rejects(current.controller.open(), /not mounted/)
  await assert.rejects(current.controller.close(), /not mounted/)
  assert.throws(() => current.controller.attach(current.host), /not mounted/)
  assert.equal(current.timers.size, 0)
})

function bridgeFixture(platform, ready = Promise.resolve()) {
  const current = fixture()
  const calls = []
  let disposed = 0
  const transport = {
    ready,
    call: async (channel, ...args) => { calls.push({ channel, args }); return channel === 'debug:getLogs' ? [] : undefined },
    send() {}, subscribe: () => () => () => {}, report() {}, dispose() { disposed++ }
  }
  const bridge = load('src/tauri/bridge.ts', {
    './mobile-debug': current.mobile,
    './transport': {
      createTauriTransport: () => transport,
      createNativeDropPathCache: () => ({ getPathForFile: () => '', dispose() {} }),
      detectTauriPlatform: () => platform,
      isTauriMobile: (value) => value === 'android' || value === 'ios'
    }
  })
  const api = bridge.createTauriApi({ platform })
  return { ...current, api, bridge, calls, get disposed() { return disposed } }
}
await test('Android与iOS沿用公开API，在页面回执后完成且不调用桌面窗口IPC', async () => {
  for (const platform of ['android', 'ios']) {
    const current = bridgeFixture(platform)
    const detach = current.bridge.attachTauriMobileDebugHost(current.api, current.host)
    const opening = current.api.debug.openWindow()
    await settle()
    assert.equal(current.shown.length, 1)
    assert.equal(current.calls.length, 0)
    current.shown[0].opened()
    await opening
    await current.api.debug.getLogs()
    assert.equal(current.calls[0].channel, 'debug:getLogs')
    const closing = current.api.debug.closeWindow()
    await settle()
    current.shown[0].closed()
    await closing
    assert.equal(current.calls.length, 1)
    detach()
    current.bridge.disposeTauriApi(current.api)
  }
})
await test('桌面日志接口仍调用原生open/close，不能注册移动宿主', async () => {
  const current = bridgeFixture('win32')
  await current.api.debug.openWindow()
  await current.api.debug.closeWindow()
  assert.deepEqual(current.calls.map((item) => item.channel), ['debug:open', 'debug:close'])
  assert.throws(() => current.bridge.attachTauriMobileDebugHost(current.api, current.host), /no mobile log host/)
  current.bridge.disposeTauriApi(current.api)
})
await test('移动页面打开先等待原生监听ready，释放桥接会撤下本地页面', async () => {
  let release
  const ready = new Promise((resolve) => { release = resolve })
  const current = bridgeFixture('android', ready)
  current.bridge.attachTauriMobileDebugHost(current.api, current.host)
  const opening = current.api.debug.openWindow()
  await settle()
  assert.equal(current.shown.length, 0)
  release()
  await settle()
  assert.equal(current.shown.length, 1)
  const rejected = assert.rejects(opening, /did not complete/)
  current.bridge.disposeTauriApi(current.api)
  await rejected
  assert.equal(current.disposed, 1)
  current.shown[0].opened()
  await assert.rejects(current.api.debug.openWindow(), /not mounted/)
})

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exitCode = failed ? 1 : 0
