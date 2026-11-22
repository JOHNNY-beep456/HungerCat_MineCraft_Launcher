/**
 * 主页迁移离线行为回归：转译真实 TS，在同一 VM realm 中运行参数、Hooks 与消息夹具。
 * 不复制桥接协议实现，不加载 Tauri 原生能力，不访问用户数据或网络。
 * Hooks 只模拟本测试所需的 render/layout/passive/cleanup 顺序；不替代浏览器实机验证。
 * 运行：node scripts/test-tauri-homepage.mjs
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
const modules = {
  session: 'src/renderer/src/pages/customhome/session.ts',
  bridge: 'src/renderer/src/pages/customhome/bridge.ts',
  sdk: 'src/renderer/src/pages/customhome/sdk.ts',
  constants: 'src/renderer/src/pages/customhome/constants.ts',
  security: 'src/renderer/src/pages/customhome/security.ts',
  native: 'src/tauri/native-invoke.ts'
}
const compiled = new Map()
const syntaxErrors = []
for (const [key, fileName] of Object.entries(modules)) {
  const source = readFileSync(new URL(`../${fileName}`, import.meta.url), 'utf8')
  const output = ts.transpileModule(source, {
    fileName, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  })
  for (const error of output.diagnostics ?? []) {
    if (error.category === ts.DiagnosticCategory.Error) syntaxErrors.push(`${fileName}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`)
  }
  compiled.set(key, output.outputText)
}

function realm(setup) {
  const context = vm.createContext({ console, URL, Headers, assert })
  const cache = new Map()
  function load(key) {
    if (cache.has(key)) return cache.get(key).exports
    assert.ok(compiled.has(key), `未声明的真实模块：${key}`)
    const module = vm.runInContext('({ exports: {} })', context)
    cache.set(key, module)
    const require = (name) => {
      if (Object.prototype.hasOwnProperty.call(context.__stubs, name)) return context.__stubs[name]
      const local = { './session': 'session', './constants': 'constants', './security': 'security' }[name]
      if (local) return load(local)
      throw new Error(`未声明的测试依赖：${name}`)
    }
    const fn = new vm.Script(`(function(require, module, exports) {\n${compiled.get(key)}\n})`, { filename: modules[key] }).runInContext(context)
    fn(require, module, module.exports)
    return module.exports
  }
  context.__load = load
  vm.runInContext(`(${setup.toString()})()`, context, { timeout: 2000 })
  return {
    context,
    load,
    run(fn) { return vm.runInContext(`(${fn.toString()})()`, context, { timeout: 2000 }) }
  }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

// 此函数在被测模块所在 realm 内执行，所有参数、原型与 Promise 均在该 realm 内创建。
function setupHost() {
  const state = {
    slots: [], cursor: 0, layout: [], passive: [], posts: [], scans: [], scanJobs: [],
    holdScans: false, hits: [], stopOnHit: false, updates: [], launches: [], stopped: 0,
    logs: [], external: [], cursorMoves: [], raf: new Map(), nextRaf: 1, holdUpdate: false,
    updateJobs: [], nativeCalls: []
  }
  const listeners = new Map()
  const window = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    api: {
      homepage: { log: (...args) => state.logs.push(args) },
      shell: { openExternal: async (url) => { state.external.push(url) } }
    }
  }
  window.top = window
  globalThis.window = window
  globalThis.document = { documentElement: {} }
  globalThis.getComputedStyle = () => ({ getPropertyValue: (name) => name === '--text-primary' ? ' #123456 ' : '' })
  globalThis.requestAnimationFrame = (fn) => { const id = state.nextRaf++; state.raf.set(id, fn); return id }
  globalThis.cancelAnimationFrame = (id) => state.raf.delete(id)
  const sameDeps = (left, right) => left !== undefined && right !== undefined
    && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  function slot(kind) {
    const index = state.cursor++
    const prior = state.slots[index]
    if (prior) { assert.equal(prior.kind, kind); return prior }
    return (state.slots[index] = { kind, initialized: false })
  }
  function memo(kind, factory, deps) {
    const item = slot(kind)
    if (!item.initialized || !sameDeps(item.deps, deps)) {
      item.value = factory(); item.deps = deps; item.initialized = true
    }
    return item.value
  }
  function effect(kind, callback, deps) {
    const item = slot(kind)
    if (item.initialized && sameDeps(item.deps, deps)) return
    state[kind].push({ item, callback, deps })
  }
  function flush(kind) {
    const queue = state[kind].splice(0)
    for (const { item } of queue) item.cleanup?.()
    for (const { item, callback, deps } of queue) {
      item.deps = deps; item.initialized = true; item.cleanup = callback()
    }
  }
  globalThis.__stubs = {
    react: {
      useRef(initial) {
        const item = slot('ref')
        if (!item.initialized) { item.value = { current: initial }; item.initialized = true }
        return item.value
      },
      useCallback: (callback, deps) => memo('callback', () => callback, deps),
      useMemo: (factory, deps) => memo('memo', factory, deps),
      useLayoutEffect: (callback, deps) => effect('layout', callback, deps),
      useEffect: (callback, deps) => effect('passive', callback, deps)
    },
    '@shared/homepage-runtime': {
      scanHomepageCodeAsync(text, kind, options) {
        const record = { text, kind, options }
        state.scans.push(record)
        if (!state.holdScans) return Promise.resolve([])
        return new Promise((resolve, reject) => state.scanJobs.push({ ...record, resolve, reject }))
      }
    },
    '../../store': { activeGameDir: (settings) => settings.gameDir },
    '../../cursor': { emitCursor: (x, y) => state.cursorMoves.push([x, y]) },
    '@tauri-apps/api/core': {
      isTauri: () => true,
      invoke: async (...args) => { state.nativeCalls.push(args); return { invoked: true } }
    }
  }
  const frameWindow = { postMessage: (payload, target) => state.posts.push({ payload, target }) }
  const frame = { contentWindow: frameWindow, getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 80 }) }
  const options = {
    frameRef: { current: frame }, frameGeneration: 'generation-one', enabled: true,
    settings: { memoryMb: 4096, debugMode: false, theme: 'system', accentColor: '#abcdef', background: 'none', reducedMotion: false, gameDir: '/fixture/game', javaPath: '' },
    theme: 'light', securityMode: 'full',
    securityHit(reason, detail) { state.hits.push({ reason, detail }); return state.stopOnHit },
    entry: { networkApproved: true }, memInfo: { free: 16384, total: 32768 }, accountInfo: { name: 'Fixture' }, modelSkin: null,
    installed: [{ id: 'fixture-version' }], selectedVersionId: 'fixture-version', selectedVersion: null,
    versionDirInfos: [], activeDirId: 'default', selectVersionDir: async (id) => id,
    launcherVersion: 'fixture', launchState: null, launchLog: [], launchPid: null,
    running: false, starting: false, busy: false, selectedAccount: { id: 'fixture-account' },
    launch: async (args) => { state.launches.push(args) }, stopLaunch: () => { state.stopped++ },
    updateSettings(patch) {
      state.updates.push(patch)
      if (state.holdUpdate) return new Promise((resolve) => state.updateJobs.push(resolve))
      return Promise.resolve()
    },
    approvedOrigins: ['https://fixture.invalid'], avatarOrigin: '', skinOrigin: ''
  }
  let bridge
  const api = {
    state, options, frame, frameWindow,
    render(patch = {}) {
      flush('passive')
      Object.assign(options, patch)
      state.cursor = 0
      bridge = __load('bridge').useHostBridge(options)
      assert.equal(state.cursor, state.slots.length)
      return bridge
    },
    layout: () => flush('layout'), passive: () => flush('passive'),
    raf() { const queue = [...state.raf.values()]; state.raf.clear(); for (const callback of queue) callback() },
    send(data, source = frameWindow) { for (const listener of [...(listeners.get('message') ?? [])]) listener({ source, data }) },
    hello(generation = options.frameGeneration, source = frameWindow) { api.send({ hc: 1, kind: 'hello', generation }, source) },
    call(id, method, params = {}, generation = options.frameGeneration, source = frameWindow) {
      api.send({ hc: 1, kind: 'call', generation, id, method, params }, source)
    },
    probe(text, generation = options.frameGeneration) { api.send({ hc: 1, kind: 'probe', generation, batch: [{ where: 'element:script', text }] }) },
    results: () => state.posts.map((item) => item.payload).filter((item) => item.kind === 'result'),
    listeners: () => listeners.get('message')?.size ?? 0,
    helloSeen: () => bridge.helloRef.current,
    unmount() { for (const item of state.slots) item.cleanup?.(); state.layout.length = 0; state.passive.length = 0 }
  }
  globalThis.host = api
  globalThis.session = __load('session')
}

function setupSdk() {
  const listeners = new Map()
  const state = { sent: [], timers: [], raf: [], tokens: {}, settled: [], updates: [], errors: [] }
  const parent = { postMessage: (payload, target) => state.sent.push({ payload, target }) }
  const window = {
    __HC_FRAME_GENERATION__: 'sdk-generation',
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    requestAnimationFrame: (callback) => { state.raf.push(callback); return state.raf.length },
    setTimeout: (callback, delay) => { state.timers.push({ callback, delay }); return state.timers.length }
  }
  const document = {
    documentElement: { style: { setProperty: (key, value) => { state.tokens[key] = value } } },
    getElementById: () => null,
    addEventListener() {}
  }
  globalThis.__stubs = { '@tauri-apps/api/core': { isTauri: () => true } }
  globalThis.parent = parent
  globalThis.window = window
  globalThis.document = document
  globalThis.navigator = {}
  globalThis.sdk = {
    state, parent,
    send(data, source = parent) { for (const listener of [...(listeners.get('message') ?? [])]) listener({ source, data }) },
    call() {
      window.hc.settings.memory.get().then((value) => state.settled.push(value), (error) => state.errors.push(error.message))
      return state.sent.at(-1).payload.id
    }
  }
}
function hostFixture() { return realm(setupHost) }
function sdkFixture() {
  const fixture = realm(setupSdk)
  new vm.Script(fixture.load('sdk').SDK, { filename: 'homepage-sdk-runtime.js' }).runInContext(fixture.context, { timeout: 2000 })
  return fixture
}

await test('六个真实 TS 模块可转译，SDK 在 VM 中实际解析并初始化', () => {
  assert.deepEqual(syntaxErrors, [])
  const fixture = sdkFixture()
  fixture.run(() => {
    assert.equal(typeof window.hc.settings.memory.get, 'function')
    assert.equal(sdk.state.sent[0].payload.kind, 'hello')
    assert.equal(sdk.state.sent[0].payload.generation, 'sdk-generation')
  })
})
await test('FrameSession 只接受当前活动代次及安全正整数调用号', () => {
  hostFixture().run(() => {
    const item = new session.FrameSession('g1')
    assert.equal(item.current('g1'), true)
    assert.equal(item.current('g2'), false)
    for (const id of [0, -1, 1.1, NaN, Infinity, '1', null, Number.MAX_SAFE_INTEGER + 1]) assert.equal(item.beginCall(id), false)
    assert.equal(item.beginCall(1), true)
    assert.equal(item.beginCall(1), false)
  })
})
await test('FrameSession 32 并发上限、去重与释放槽位', () => {
  hostFixture().run(() => {
    const item = new session.FrameSession('g')
    for (let id = 1; id <= 32; id++) assert.equal(item.beginCall(id), true)
    assert.equal(item.beginCall(33), false)
    item.endCall(12)
    assert.equal(item.beginCall(33), true)
    assert.equal(item.beginCall(33), false)
  })
})
await test('FrameSession close 永久撤销调用与探针预约', () => {
  hostFixture().run(() => {
    const item = new session.FrameSession('g')
    item.beginCall(1); item.reserveProbe(100); item.close(); item.endCall(1); item.releaseProbe(100)
    assert.equal(item.current('g'), false)
    assert.equal(item.beginCall(1), false)
    assert.equal(item.reserveProbe(0), false)
  })
})
await test('FrameSession 探针单批 2 MiB、累计 4 MiB 和 64 批上限', () => {
  hostFixture().run(() => {
    const item = new session.FrameSession('g')
    for (const count of [-1, 1.5, NaN, 2 * 1024 * 1024 + 1]) assert.equal(item.reserveProbe(count), false)
    assert.equal(item.reserveProbe(2 * 1024 * 1024), true)
    assert.equal(item.reserveProbe(2 * 1024 * 1024), true)
    assert.equal(item.reserveProbe(1), false)
    item.releaseProbe(2 * 1024 * 1024)
    assert.equal(item.reserveProbe(1), true)
    const batches = new session.FrameSession('g')
    for (let i = 0; i < 64; i++) assert.equal(batches.reserveProbe(0), true)
    assert.equal(batches.reserveProbe(0), false)
    batches.releaseProbe(0)
    assert.equal(batches.reserveProbe(0), true)
  })
})
await test('boundedParams 接受同 realm 普通对象、空原型和 JSON 标量', () => {
  hostFixture().run(() => {
    assert.equal(session.boundedParams({ text: '安全参数', nested: [1, true, null, { x: 2 }] }), true)
    assert.equal(session.boundedParams(Object.assign(Object.create(null), { id: 1 })), true)
    for (const value of [null, [], 1, 'x', new Date(), { x: undefined }, { x: () => {} }, { x: Infinity }, { x: 1n }]) assert.equal(session.boundedParams(value), false)
  })
})
await test('boundedParams 拒绝字符、节点、深度超限和循环引用', () => {
  hostFixture().run(() => {
    assert.equal(session.boundedParams({ x: 'a'.repeat(65535) }), true)
    assert.equal(session.boundedParams({ x: 'a'.repeat(65536) }), false)
    assert.equal(session.boundedParams({ items: Array(2047).fill(null) }), false)
    const deep = {}; let tail = deep
    for (let i = 0; i < 17; i++) { tail.next = {}; tail = tail.next }
    assert.equal(session.boundedParams(deep), false)
    const cycle = {}; cycle.self = cycle
    assert.equal(session.boundedParams(cycle), false)
    const shared = {}; assert.equal(session.boundedParams({ one: shared, two: shared }), false)
  })
})
await test('bridge 在 layout 后 passive 前接收早期 hello 并分发首条调用', async () => {
  const fixture = hostFixture()
  fixture.run(() => {
    host.render(); assert.equal(host.listeners(), 0); host.layout()
    assert.equal(host.listeners(), 1)
    assert.equal(host.state.raf.size, 0)
    host.hello(); host.hello()
    assert.equal(host.helloSeen(), true)
    assert.equal(host.state.posts.filter((item) => item.payload.kind === 'init').length, 1)
    assert.equal(host.state.posts[0].payload.data.tokens['--hc-text-primary'], '#123456')
    host.call(1, 'settings.memory.get')
  })
  await settle()
  fixture.run(() => {
    assert.equal(host.results().length, 1)
    assert.equal(host.results()[0].data, 4096)
    assert.equal(host.results()[0].generation, 'generation-one')
    assert.equal(host.state.raf.size, 0)
    host.passive(); host.raf()
    assert.equal(host.state.posts.at(-1).payload.kind, 'update')
    host.unmount(); assert.equal(host.listeners(), 0)
  })
})
await test('bridge 拒绝错误 source、generation 和协议标记的消息', async () => {
  const fixture = hostFixture()
  fixture.run(() => {
    host.render(); host.layout()
    host.hello('generation-one', {}); host.hello('stale')
    host.call(1, 'settings.memory.set', { memoryMb: 2048 }, 'generation-one', {})
    host.call(2, 'settings.memory.set', { memoryMb: 2048 }, 'stale')
    host.probe('old', 'stale')
    host.send({ hc: 2, kind: 'hello', generation: 'generation-one' })
    host.send({ hc: 1, kind: 'cursor', generation: 'stale', x: 1, y: 2 })
    assert.equal(host.helloSeen(), false)
    assert.equal(host.state.posts.length, 0)
    assert.equal(host.state.scans.length, 0)
    assert.equal(host.state.hits.length, 0)
    assert.equal(host.state.cursorMoves.length, 0)
    host.hello()
  })
  await settle()
  fixture.run(() => {
    assert.equal(host.state.updates.length, 0)
    assert.equal(host.helloSeen(), true)
    host.unmount()
  })
})
await test('bridge 实际调用路径限制 32 并发并拒绝重复调用号', async () => {
  const fixture = hostFixture()
  fixture.run(() => {
    host.render(); host.layout(); host.state.holdScans = true
    for (let id = 1; id <= 32; id++) host.call(id, 'settings.memory.get')
    host.call(1, 'settings.memory.get'); host.call(33, 'settings.memory.get')
    assert.equal(host.state.scanJobs.length, 32)
    assert.equal(host.state.hits.length, 2)
    for (const job of host.state.scanJobs) job.resolve([])
  })
  await settle()
  fixture.run(() => {
    assert.equal(host.results().length, 32)
    assert.equal(new Set(host.results().map((item) => item.id)).size, 32)
    host.state.holdScans = false
    host.call(33, 'settings.memory.get')
  })
  await settle()
  fixture.run(() => { assert.equal(host.results().length, 33); host.unmount() })
})
await test('bridge 在扫描前拒绝超长方法、循环和超限参数', async () => {
  const fixture = hostFixture()
  fixture.run(() => {
    host.render(); host.layout()
    const cyclic = {}; cyclic.self = cyclic
    host.call(1, 'x'.repeat(81)); host.call(2, 'settings.memory.set', cyclic)
    host.call(3, 'settings.memory.set', { text: 'x'.repeat(65537) })
    assert.equal(host.state.scans.length, 0)
    assert.equal(host.state.hits.length, 3)
  })
  await settle()
  fixture.run(() => { assert.equal(host.state.updates.length, 0); assert.equal(host.results().length, 0); host.unmount() })
})
await test('bridge 异步扫描后切换代次不执行宿主写入且不晚回复', async () => {
  const fixture = hostFixture()
  fixture.run(() => {
    host.render(); host.layout(); host.state.holdScans = true
    host.call(11, 'settings.memory.set', { memoryMb: 2048 })
    assert.equal(host.state.scanJobs.length, 1)
    host.render({ frameGeneration: 'generation-two' }); host.layout(); host.hello()
    host.state.scanJobs[0].resolve(['旧扫描命中'])
  })
  await settle()
  fixture.run(() => {
    assert.equal(host.state.updates.length, 0)
    assert.equal(host.results().length, 0)
    assert.equal(host.state.hits.length, 0)
    host.state.holdScans = false
    host.call(11, 'settings.memory.set', { memoryMb: 3072 })
  })
  await settle()
  fixture.run(() => {
    assert.equal(host.state.updates.length, 1)
    assert.equal(host.state.updates[0].memoryMb, 3072)
    assert.equal(host.results().length, 1)
    assert.equal(host.results()[0].generation, 'generation-two')
    host.unmount()
  })
})
await test('bridge 已开始的宿主异步操作完成后不给替代文档回复', async () => {
  const fixture = hostFixture()
  fixture.run(() => {
    host.render({ securityMode: 'off' }); host.layout(); host.state.holdUpdate = true
    host.call(1, 'settings.memory.set', { memoryMb: 2048 })
    assert.equal(host.state.updates.length, 1)
    assert.equal(host.state.updateJobs.length, 1)
    host.render({ frameGeneration: 'generation-two' }); host.layout()
    host.state.updateJobs[0]()
  })
  await settle()
  fixture.run(() => { assert.equal(host.results().length, 0); host.unmount() })
})
await test('bridge 撤销中的 probe 扫描命中不会封锁新 frame', async () => {
  const fixture = hostFixture()
  fixture.run(() => { host.render(); host.layout(); host.state.holdScans = true; host.probe('old text') })
  await settle()
  fixture.run(() => {
    assert.equal(host.state.scanJobs.length, 1)
    host.render({ frameGeneration: 'generation-two' }); host.layout(); host.hello()
    host.state.scanJobs[0].resolve(['旧探针命中'])
    host.state.holdScans = false
  })
  await settle()
  fixture.run(() => { assert.equal(host.state.hits.length, 0); host.call(1, 'settings.memory.get') })
  await settle()
  fixture.run(() => { assert.equal(host.results()[0].generation, 'generation-two'); host.unmount() })
})
await test('bridge 旧 probe 拒绝后不关闭新会话且新 probe 能独立运行', async () => {
  const fixture = hostFixture()
  fixture.run(() => { host.render(); host.layout(); host.state.holdScans = true; host.probe('old') })
  await settle()
  fixture.run(() => {
    host.render({ frameGeneration: 'generation-two' }); host.layout()
    host.state.scanJobs[0].reject(new Error('旧代次扫描失败'))
    host.state.holdScans = false
    host.probe('new')
  })
  await settle()
  fixture.run(() => {
    assert.equal(host.state.hits.length, 0)
    assert.equal(host.state.scans.at(-1).text, 'new')
    host.call(1, 'settings.memory.get')
  })
  await settle()
  fixture.run(() => { assert.equal(host.results().length, 1); host.unmount() })
})
await test('bridge 当前 probe 扫描失败会关闭当前会话', async () => {
  const fixture = hostFixture()
  fixture.run(() => { host.render(); host.layout(); host.state.holdScans = true; host.probe('current') })
  await settle()
  fixture.run(() => { host.state.scanJobs[0].reject(new Error('夹具扫描失败')) })
  await settle()
  fixture.run(() => {
    assert.equal(host.state.hits.length, 1)
    host.hello(); host.call(1, 'settings.memory.get')
    assert.equal(host.helloSeen(), false)
    assert.equal(host.results().length, 0)
    host.unmount()
  })
})
await test('bridge 禁用后移除监听且不回复待处理调用', async () => {
  const fixture = hostFixture()
  fixture.run(() => {
    host.render(); host.layout(); host.state.holdScans = true; host.call(1, 'settings.memory.get')
    host.render({ enabled: false }); host.layout()
    assert.equal(host.listeners(), 0)
    host.state.scanJobs[0].resolve([])
  })
  await settle()
  fixture.run(() => { assert.equal(host.results().length, 0); host.unmount() })
})
await test('SDK 回复必须同时来自 parent 且匹配 generation', async () => {
  const fixture = sdkFixture()
  fixture.run(() => {
    const id = sdk.call()
    assert.equal(sdk.state.sent.at(-1).payload.generation, 'sdk-generation')
    const reply = { hc: 1, kind: 'result', generation: 'sdk-generation', id, ok: true, data: 4096 }
    sdk.send(reply, {}); sdk.send({ ...reply, generation: 'stale' }); sdk.send({ ...reply, generation: undefined })
  })
  await settle()
  fixture.run(() => {
    assert.equal(sdk.state.settled.length, 0)
    const id = sdk.state.sent.at(-1).payload.id
    sdk.send({ hc: 1, kind: 'result', generation: 'sdk-generation', id, ok: true, data: 4096 })
    sdk.send({ hc: 1, kind: 'result', generation: 'sdk-generation', id, ok: true, data: 8192 })
  })
  await settle()
  fixture.run(() => { assert.equal(sdk.state.settled.length, 1); assert.equal(sdk.state.settled[0], 4096) })
})
await test('SDK 对错误来源的 init/update 不变更快照与主题令牌', () => {
  sdkFixture().run(() => {
    window.hc.onUpdate((value) => sdk.state.updates.push(value))
    const update = { hc: 1, kind: 'init', generation: 'sdk-generation', data: { snapshot: { version: 1 }, tokens: { '--hc-accent': '#123456' } } }
    sdk.send(update, {}); sdk.send({ ...update, generation: 'stale' })
    assert.equal(sdk.state.updates.length, 0)
    assert.equal(Object.keys(sdk.state.tokens).length, 0)
    sdk.send(update)
    assert.equal(sdk.state.updates.length, 1)
    assert.equal(window.hc.state().version, 1)
    assert.equal(sdk.state.tokens['--hc-accent'], '#123456')
  })
})
await test('SDK 只将匹配的失败回复交给对应 Promise', async () => {
  const fixture = sdkFixture()
  fixture.run(() => {
    const id = sdk.call()
    sdk.send({ hc: 1, kind: 'result', generation: 'stale', id, ok: false, error: 'stale error' })
  })
  await settle()
  fixture.run(() => {
    assert.equal(sdk.state.errors.length, 0)
    sdk.send({ hc: 1, kind: 'result', generation: 'sdk-generation', id: sdk.state.sent.at(-1).payload.id, ok: false, error: '业务拒绝' })
  })
  await settle()
  fixture.run(() => { assert.equal(sdk.state.errors.length, 1); assert.equal(sdk.state.errors[0], '业务拒绝') })
})
await test('SDK 超时移除 pending，随后晚回复不再完成调用', async () => {
  const fixture = sdkFixture()
  fixture.run(() => {
    const id = sdk.call()
    assert.equal(sdk.state.timers.at(-1).delay, 10000)
    sdk.state.timers.at(-1).callback()
    sdk.send({ hc: 1, kind: 'result', generation: 'sdk-generation', id, ok: true, data: 'late' })
  })
  await settle()
  fixture.run(() => {
    assert.equal(sdk.state.settled.length, 0)
    assert.equal(sdk.state.errors.length, 1)
    assert.match(sdk.state.errors[0], /调用超时/)
  })
})
await test('nativeInvoke 顶级文档 marker 转普通 header 记录且保留其余选项', async () => {
  await hostFixture().run(async () => {
    const native = __load('native')
    window.__HC_NATIVE_DOCUMENT__ = 'a'.repeat(64)
    const args = { channel: 'homepage:list', args: [] }
    const result = await native.nativeInvoke('bridge_call', args, { headers: { 'x-extra': 'fixture', 'x-hcmcl-document': 'forged' } })
    assert.equal(result.invoked, true)
    assert.equal(host.state.nativeCalls.length, 1)
    const [command, received, options] = host.state.nativeCalls[0]
    assert.equal(command, 'bridge_call'); assert.equal(received, args)
    assert.equal(Object.getPrototypeOf(options.headers), Object.prototype)
    assert.equal(options.headers['x-extra'], 'fixture')
    assert.equal(options.headers['x-hcmcl-document'], 'a'.repeat(64))
  })
})
await test('nativeInvoke 拒绝子框架和无效 marker，完全不触发原生调用', async () => {
  await hostFixture().run(async () => {
    const native = __load('native')
    for (const marker of [undefined, {}, '', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) {
      window.__HC_NATIVE_DOCUMENT__ = marker
      await assert.rejects(native.nativeInvoke('bridge_call'), /This document cannot invoke native business commands/)
    }
    window.__HC_NATIVE_DOCUMENT__ = 'a'.repeat(64); window.top = {}
    await assert.rejects(native.nativeInvoke('bridge_call'), /This document cannot invoke native business commands/)
    assert.equal(host.state.nativeCalls.length, 0)
  })
})

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1
