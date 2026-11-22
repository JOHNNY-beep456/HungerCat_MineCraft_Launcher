/** 直接转译生产共享卡片；仅模拟 Hooks 与 native 监听，不执行 WebView / socket / core。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const file = 'src/renderer/src/components/MultiplayerHudCard.tsx'
const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { fileName: file, compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText
const jsx = (type, props) => ({ type, props: props ?? {} })
const text = (node) => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join('')
  : typeof node === 'object' ? text(node.props?.children) : String(node)
const sample = (patch = {}) => ({ enabled: true, opacity: 0.65,
  players: [{ id: 'self', name: 'Alice', isSelf: true, virtualIp: '10.126.126.1' }, { id: 'peer', name: 'Bob', isSelf: false }], ...patch })
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise((done) => setImmediate(done))
function fixture({ hook = false, language = 'zh-CN', heldListen = false, synchronous, value = sample() } = {}) {
  let mounted = true, cursor = 0, dirty = true, tree, effects = [], setters = 0, offCount = 0
  const slots = [], order = [], requests = [], callbacks = [], active = new Set(), registration = deferred()
  const hooks = {
    useState(initial) {
      const index = cursor++; slots[index] ??= { value: initial }
      return [slots[index].value, (next) => { if (!mounted) throw Error('late setState'); setters++; slots[index].value = next; dirty = true }]
    },
    useEffect(run) { const index = cursor++; if (!slots[index]) { slots[index] = {}; effects.push(() => { slots[index].cleanup = run() }) } },
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled, { module, exports: module.exports, Promise, window: { __HC_AI_HUD_LOCALE__: language },
    document: { documentElement: { lang: 'zh-CN' } }, navigator: { language: 'zh-CN' },
    require(name) {
      if (name === 'react') return hooks
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === '../../../tauri/native-invoke') return { nativeInvoke(command, args) {
        assert.equal(command, 'launcher_call'); assert.equal(args.channel, 'mp:hudState'); assert.equal(args.args.length, 0)
        order.push('snapshot'); const pending = deferred(); requests.push(pending); return pending.promise
      } }
      if (name === '@tauri-apps/api/event') return { async listen(name, callback) {
        assert.equal(name, 'launcher:event'); order.push('listen'); callbacks.push(callback)
        if (heldListen) await registration.promise
        order.push('registered'); active.add(callback)
        if (synchronous !== undefined) callback({ payload: { channel: 'mp:hudState', payload: synchronous } })
        return () => { offCount++; active.delete(callback) }
      } }
      throw Error(`unexpected dependency ${name}`)
    },
  }, { filename: file })
  const actual = module.exports
  function flush() {
    if (!mounted || !dirty) return
    dirty = false; cursor = 0; effects = []
    tree = actual.MultiplayerHudCard({ state: hook ? actual.useMultiplayerHudState() : value, opacity: 0.65 })
    for (const run of effects) run()
  }
  flush()
  return { actual, order, requests,
    get tree() { return tree }, get text() { return text(tree) }, get setters() { return setters }, get offCount() { return offCount },
    async settle() { await tick(); flush() }, release() { registration.resolve() },
    emit(payload, channel = 'mp:hudState') { for (const callback of active) callback({ payload: { channel, payload } }); flush() },
    late(payload) { for (const callback of callbacks) callback({ payload: { channel: 'mp:hudState', payload } }); flush() },
    unmount() { if (!mounted) return; mounted = false; for (const slot of slots) slot.cleanup?.() },
  }
}
let passed = 0, failed = 0
async function test(label, run) { try { await run(); passed++; console.log(`  ok   ${label}`) } catch (error) { failed++; console.error(`  FAIL ${label}: ${error.stack ?? error}`) } }
await test('原成员卡片样式、顺序、三语及隐藏状态', () => {
  for (const [language, title, own] of [['zh-CN', '大厅状态', '（我）'], ['zh-TW', '大廳狀態', '（我）'], ['en', 'Lobby status', '(me)']]) {
    const f = fixture({ language }); assert.ok(f.text.includes(title)); assert.ok(f.text.includes(own)); assert.ok(f.text.indexOf('Alice') < f.text.indexOf('Bob'))
    assert.equal(f.tree.props.className, 'rounded-2xl p-2.5'); assert.equal(f.tree.props.style.background, 'rgba(18, 18, 24, 0.72)')
    assert.equal(f.tree.props.style.backdropFilter, 'blur(10px)'); assert.equal(f.tree.props.style.opacity, 0.65); f.unmount()
  }
  assert.equal(fixture({ value: sample({ enabled: false }) }).tree, null)
  assert.equal(fixture({ value: sample({ players: [] }) }).tree, null)
})
await test('投影拒绝畸形或超限并去除非显示字段', () => {
  const f = fixture(), project = f.actual.projectMultiplayerHud
  const result = project(sample({ secret: 'not-for-view', players: [{ id: 'p', name: 'Player', isSelf: false, password: 'private' }] }))
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { enabled: true, opacity: 0.65, players: [{ id: 'p', name: 'Player', isSelf: false }] })
  for (const invalid of [null, {}, [], sample({ opacity: NaN }), sample({ enabled: 1 }), sample({ players: [{ id: '1', name: 'p', isSelf: 'true' }] }), sample({ players: Array(130).fill(sample().players[0]) })]) assert.equal(project(invalid), null)
  f.unmount()
})
await test('native listen 回执早于快照，实时事件覆盖迟到快照', async () => {
  const f = fixture({ hook: true, heldListen: true }); await f.settle()
  assert.deepEqual(f.order, ['listen']); assert.equal(f.requests.length, 0)
  f.release(); await f.settle(); assert.deepEqual(f.order, ['listen', 'registered', 'snapshot'])
  f.emit(sample({ players: [{ id: 'live', name: 'Live', isSelf: false }] })); f.requests[0].resolve(sample()); await f.settle()
  assert.ok(f.text.includes('Live')); assert.ok(!f.text.includes('Alice'))
  f.emit(sample({ enabled: false })); assert.equal(f.tree, null)
  f.unmount(); assert.equal(f.offCount, 1); const before = f.setters; f.late(sample()); assert.equal(f.setters, before)
})
await test('卸载先于监听或快照返回时立即清理且不迟到写入', async () => {
  const held = fixture({ hook: true, heldListen: true }); await held.settle(); held.unmount(); held.release(); await held.settle()
  assert.equal(held.offCount, 1); assert.equal(held.requests.length, 0); held.late(sample()); assert.equal(held.setters, 0)
  const late = fixture({ hook: true }); await late.settle(); late.unmount(); late.requests[0].resolve(sample()); await late.settle()
  assert.equal(late.offCount, 1); assert.equal(late.setters, 0)
  const event = fixture({ hook: true, synchronous: sample({ players: [{ id: 'sync', name: 'Synchronous', isSelf: true }] }) }); await event.settle()
  event.requests[0].resolve(sample()); await event.settle(); assert.ok(event.text.includes('Synchronous')); event.unmount()
})
await test('Electron 和 Tauri 复用同一卡片且不增加公开方法或主窗权限', () => {
  for (const component of ['GameHud.tsx', 'TauriAiHudDesktop.tsx']) {
    const body = readFileSync(new URL(`../src/renderer/src/components/${component}`, import.meta.url), 'utf8')
    assert.ok(body.includes('<MultiplayerHudCard state=')); assert.ok(body.includes("from './MultiplayerHudCard'"))
  }
  const root = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
  assert.ok(root.includes('channel == "mp:hudState" && window.label() == "ai-hud"'))
  assert.ok(root.includes('ai_hud_window::authorize_multiplayer(&app, &window).await?'))
  const host = readFileSync(new URL('../src-tauri/src/ai_hud_window.rs', import.meta.url), 'utf8')
  assert.ok(host.includes('voice_target_on_ui(&handle,true)?')); assert.ok(host.includes('"mp:hudState","payload":view.snapshot'))
  const route = readFileSync(new URL('../src-tauri/src/multiplayer.rs', import.meta.url), 'utf8')
  assert.match(route, /"mp:hudState" =>\s*\{\s*if !args\.is_empty\(\) \{ return Err\(invalid\(\)\); \}/u)
})
console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exitCode = failed ? 1 : 0