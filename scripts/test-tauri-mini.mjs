/** 联机小窗定向夹具：直接转译生产 TSX，不执行 WebView、core 或 socket。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compile = (path) => ts.transpileModule(read(path), {
  fileName: path,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
}).outputText
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise((done) => setImmediate(done))
const jsx = (type, props) => ({ type, props: props ?? {} })
const text = (node) => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join('')
  : typeof node === 'object' ? text(node.props?.children) : String(node)
const lobby = (name) => ({ lobby: { name, password: '', serverNode: '', signalingServer: '', virtualIp: '10.126.126.1', useDomain: false, isHost: true, createdAt: '' }, players: [], appState: 'in-lobby' })

let passed = 0
let failed = 0
async function test(label, run) {
  try { await run(); passed++; console.log(`  ok   ${label}`) }
  catch (error) { failed++; console.error(`  FAIL ${label}: ${error.stack ?? error}`) }
}

function miniFixture() {
  const file = 'src/renderer/src/components/MiniWindow.tsx'
  const slots = []
  const callbacks = []
  const order = []
  const snapshot = deferred()
  let mounted = true
  let cursor = 0
  let dirty = true
  let tree
  let effects = []
  let setters = 0
  let offCount = 0
  const hooks = {
    useState(initial) {
      const index = cursor++
      slots[index] ??= { value: initial }
      return [slots[index].value, (next) => {
        if (!mounted) throw new Error('late setState')
        setters++
        slots[index].value = typeof next === 'function' ? next(slots[index].value) : next
        dirty = true
      }]
    },
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index] },
    useEffect(run) { const index = cursor++; if (!slots[index]) { slots[index] = {}; effects.push(() => { slots[index].cleanup = run() }) } }
  }
  const module = { exports: {} }
  vm.runInNewContext(compile(file), {
    module, exports: module.exports, Promise, Math, Number, String, Object, Array, Set, Map, Date, console,
    setInterval, clearInterval, setTimeout, clearTimeout, requestAnimationFrame: (run) => { run(); return 1 }, cancelAnimationFrame: () => {},
    navigator: { clipboard: { writeText: async () => {} } },
    window: { api: { mp: {
      onMiniState(callback) { order.push('listen'); callbacks.push(callback); return () => { offCount++; callbacks.splice(callbacks.indexOf(callback), 1) } },
      miniState() { order.push('snapshot'); return snapshot.promise },
      miniResize: async () => {}, hasMainWindow: async () => false,
      leaveLobby: async () => {}, closeMiniWindow: async () => {}
    } } },
    require(name) {
      if (name === 'react') return hooks
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
      if (name === 'motion/react') return { AnimatePresence: 'AnimatePresence', motion: { div: 'motion.div' } }
      if (name === '../store') return { useApp: () => ({ t: (key) => key }) }
      if (name === './ui') return { Button: 'Button', Icon: 'Icon' }
      if (name === './MultiplayerChat') return { MultiplayerChat: 'MultiplayerChat' }
      if (name === '@shared/types') return {}
      throw new Error(`unexpected dependency ${name}`)
    }
  }, { filename: file })
  function flush() {
    if (!mounted || !dirty) return
    dirty = false; cursor = 0; effects = []
    tree = module.exports.MiniWindow()
    for (const run of effects) run()
  }
  flush()
  return {
    order, snapshot,
    get tree() { return tree }, get text() { return text(tree) }, get setters() { return setters }, get offCount() { return offCount },
    emit(value) { for (const callback of [...callbacks]) callback(value); flush() },
    late(value) { for (const callback of callbacks) callback(value); flush() },
    async settle() { await tick(); flush() },
    unmount() { if (!mounted) return; mounted = false; for (const slot of slots) slot.cleanup?.() }
  }
}

function chatFixture() {
  const file = 'src/renderer/src/components/MultiplayerChat.tsx'
  const slots = []
  const callbacks = []
  const order = []
  const history = deferred()
  let mounted = true, cursor = 0, dirty = true, tree, effects = [], setters = 0, offCount = 0
  const hooks = {
    useState(initial) {
      const index = cursor++; slots[index] ??= { value: initial }
      return [slots[index].value, (next) => {
        if (!mounted) throw new Error('late chat setState')
        setters++; slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; dirty = true
      }]
    },
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index] },
    useEffect(run) { const index = cursor++; if (!slots[index]) { slots[index] = {}; effects.push(() => { slots[index].cleanup = run() }) } }
  }
  const module = { exports: {} }
  vm.runInNewContext(compile(file), {
    module, exports: module.exports, Promise, Object, Array, console,
    window: { api: { mp: {
      onChat(callback) { order.push('listen'); callbacks.push(callback); return () => { offCount++; callbacks.splice(callbacks.indexOf(callback), 1) } },
      getMessages() { order.push('history'); return history.promise }, sendChat: async () => {}
    } } },
    require(name) {
      if (name === 'react') return hooks
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === '../store') return { useApp: () => ({ t: (key) => key }) }
      if (name === './ui') return { Icon: 'Icon' }
      if (name === '@shared/types') return {}
      throw new Error(`unexpected dependency ${name}`)
    }
  }, { filename: file })
  function flush() {
    if (!mounted || !dirty) return
    dirty = false; cursor = 0; effects = []; tree = module.exports.MultiplayerChat()
    for (const run of effects) run()
  }
  flush()
  const message = (id) => ({ id, playerId: id, playerName: id, content: id, timestamp: 1, isSelf: false })
  return {
    order, history, message,
    get text() { return text(tree) }, get setters() { return setters }, get offCount() { return offCount },
    emit(value) { for (const callback of [...callbacks]) callback(value); flush() },
    late(value) { for (const callback of callbacks) callback(value); flush() },
    async settle() { await tick(); flush() },
    unmount() { if (!mounted) return; mounted = false; for (const slot of slots) slot.cleanup?.() }
  }
}

await test('小窗先订阅再取快照，实时大厅覆盖迟到快照', async () => {
  const f = miniFixture()
  assert.deepEqual(f.order, ['listen', 'snapshot'])
  f.emit(lobby('Live lobby'))
  f.snapshot.resolve(lobby('Stale lobby'))
  await f.settle()
  assert.ok(f.text.includes('Live lobby'))
  assert.ok(!f.text.includes('Stale lobby'))
  f.unmount()
  assert.equal(f.offCount, 1)
})

await test('卸载后迟到快照和事件均不再写入', async () => {
  const f = miniFixture()
  f.unmount()
  const before = f.setters
  f.snapshot.resolve(lobby('Late snapshot'))
  await f.settle()
  f.late(lobby('Late event'))
  assert.equal(f.setters, before)
  assert.equal(f.offCount, 1)
})

await test('聊天先订阅再读历史，新消息优先且卸载后隔离迟到回调', async () => {
  const f = chatFixture()
  assert.deepEqual(f.order, ['listen', 'history'])
  f.emit(f.message('live-message'))
  f.history.resolve([f.message('stale-message')])
  await f.settle()
  assert.ok(f.text.includes('live-message'))
  assert.ok(!f.text.includes('stale-message'))
  f.unmount()
  const before = f.setters
  f.late(f.message('late-message'))
  assert.equal(f.setters, before)
  assert.equal(f.offCount, 1)
})

await test('Tauri 挂载只创建一个 root，拖动走内部命令且 abort 完整清理', async () => {
  const file = 'src/renderer/src/mini-bootstrap.tsx'
  const order = []
  const calls = []
  const listeners = new Map()
  let unmounts = 0
  let prevented = 0
  class FakeElement {
    closest(selector) { return selector === '[data-mini-drag]' ? this : null }
  }
  const controller = new AbortController()
  const window = { __TAURI_INTERNALS__: {}, api: { mp: { miniState: async () => { order.push('ready'); return lobby('Ready') } } } }
  const document = {
    getElementById(id) { assert.equal(id, 'root'); return {} },
    addEventListener(name, callback) { assert.equal(name, 'pointerdown'); listeners.set(name, callback) },
    removeEventListener(name, callback) { assert.equal(listeners.get(name), callback); listeners.delete(name) }
  }
  const module = { exports: {} }
  vm.runInNewContext(compile(file), {
    module, exports: module.exports, window, document, Element: FakeElement, AbortController, Promise, Error, Object, Array, console,
    setTimeout, clearTimeout,
    require(name) {
      if (name === 'react') return {}
      if (name === './index.css') return {}
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === 'react-dom/client') return { __esModule: true, default: { createRoot: () => { order.push('root'); return { render: () => order.push('render'), unmount: () => { unmounts++ } } } } }
      if (name === './store') return { AppProvider: 'AppProvider' }
      if (name === './components/MiniWindow') return { MiniWindow: 'MiniWindow' }
      if (name === '../../tauri/native-invoke') return { nativeInvoke: async (command, args) => { calls.push({ command, args }) } }
      throw new Error(`unexpected dependency ${name}`)
    }
  }, { filename: file })
  await module.exports.mountMiniWindow(controller.signal)
  assert.deepEqual(order, ['ready', 'root', 'render'])
  listeners.get('pointerdown')({ button: 0, isPrimary: true, target: new FakeElement(), preventDefault: () => { prevented++ } })
  await tick()
  assert.equal(prevented, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ command: 'launcher_call', args: { channel: 'mp:miniDrag', args: [] } }])
  controller.abort()
  assert.equal(unmounts, 1)
  assert.equal(listeners.size, 0)
})

await test('原生小窗保留窄权限、可重开关闭及异步退出接线', () => {
  const host = read('src-tauri/src/multiplayer/mini.rs')
  assert.ok(!host.includes('async_runtime::block_on'))
  assert.ok(host.includes('pub(crate) fn request_close'))
  assert.ok(host.includes('inner.requested = false'))
  assert.ok(host.includes('inner.model.destroyed(id, state.now())'))
  assert.ok(host.includes('handle.get_window(LABEL).is_none() && handle.get_webview(LABEL).is_none()'))
  const route = read('src-tauri/src/multiplayer.rs')
  for (const channel of ['mp:openMiniWindow', 'mp:closeMiniWindow', 'mp:miniState', 'mp:miniResize', 'mp:miniDrag', 'mp:hasMainWindow']) assert.ok(route.includes(`"${channel}"`))
  assert.ok(route.includes('mini::shutdown(app).await'))
  assert.ok(route.includes('mini::relaunch_ready(app)'))
  const entry = read('src-tauri/src/lib.rs')
  assert.ok(entry.includes('window.label() == "mini"'))
  assert.ok(entry.includes('multiplayer::authorize_mini(&app, &window).await?'))
  assert.ok(entry.includes('with_settings_for_backend(multiplayer::mini_settings)'))
  const capability = JSON.parse(read('src-tauri/capabilities/mini.json'))
  assert.deepEqual(capability.windows, ['mini'])
  assert.deepEqual(capability.permissions, ['core:event:allow-listen', 'core:event:allow-unlisten'])
})

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exitCode = failed ? 1 : 0
