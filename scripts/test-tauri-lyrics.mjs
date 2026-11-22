/**
 * 歌词共享消费者的定向离线检查：转译生产 TSX，只模拟 Hooks、当前命中点与桥。
 * 不执行 React/WebView2、SMTC、媒体、系统热键或联网查询，不替代外观 / 原生验收。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const path = 'src/renderer/src/components/LyricsHudCard.tsx'
const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { fileName: path, reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } })
let passed = 0, failed = 0
async function test(label, run) {
  try { await run(); passed++; console.log(`  ok   ${label}`) }
  catch (error) { failed++; console.error(`  FAIL ${label}: ${error.stack ?? error.message}`) }
}
const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
const children = (node) => [node?.props?.children].flat(Infinity).filter((child) => child !== null && child !== undefined && typeof child !== 'boolean')
function walk(node, predicate) {
  if (Array.isArray(node)) return node.flatMap((item) => walk(item, predicate))
  if (!node || typeof node !== 'object') return []
  return [...(predicate(node) ? [node] : []), ...children(node).flatMap((item) => walk(item, predicate))]
}
function text(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(text).join('')
  return typeof node === 'object' ? children(node).map(text).join('') : String(node)
}
const state = (patch = {}) => ({ enabled: true, status: 'sync', title: 'Song', artist: 'Artist', source: 'Cloud music', prev: 'before', current: 'current line', next: 'after', ...patch })
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes }); return { promise, resolve } }
function fixture({ hook = false, value = state(), language = 'en', nativeLocale, synchronous, subscribeThrows = false, offThrows = false } = {}) {
  let dispatcher, dirty = true, mounted = true, tree, effects = [], lateSetters = 0, setterCount = 0
  let props = { state: value, opacity: 0.7, language }
  let hit = false, timerId = 0, unsubscribes = 0
  const records = new Map(), listeners = new Map(), timers = new Map(), callbacks = [], active = new Set()
  const order = [], requests = [], interactive = [], nudges = []
  const hitNode = { closest(selector) { assert.equal(selector, '[data-hud-hit]'); return hitNode } }
  const document = { documentElement: { lang: 'zh-CN' }, elementFromPoint() { return hit ? hitNode : null } }
  const music = new Proxy({
    onLyricsState(callback) {
      order.push('subscribe')
      if (subscribeThrows) throw new Error('synthetic subscribe failure')
      active.add(callback); callbacks.push(callback)
      if (synchronous !== undefined) callback(synchronous)
      return () => { unsubscribes++; active.delete(callback); if (offThrows) throw new Error('synthetic unsubscribe failure') }
    },
    lyricsState(...args) { order.push('snapshot'); assert.equal(args.length, 0); const pending = deferred(); requests.push(pending); return pending.promise },
    lyricsNudge(direction) { assert.ok(direction === -1 || direction === 1); nudges.push(direction) }
  }, { get(target, name) { assert.ok(name in target, `歌词消费者不应调用 ${String(name)}`); return target[name] } })
  const api = new Proxy({ platform: 'win32', music, hud: { setInteractive(over) { assert.equal(typeof over, 'boolean'); interactive.push(over) } } }, {
    get(target, name) { assert.ok(name in target, `歌词消费者不应读取 ${String(name)}`); return target[name] }
  })
  const window = { api, __TAURI_INTERNALS__: {}, __HC_AI_HUD_LOCALE__: nativeLocale, location: { search: '?window=ai-hud' },
    addEventListener(name, callback) { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set) },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback) }
  }
  function slot() { assert.ok(dispatcher); const index = dispatcher.cursor++; return dispatcher.slots[index] ?? (dispatcher.slots[index] = {}) }
  const hooks = {
    useState(initial) {
      const record = dispatcher, current = slot()
      if (!current.initialized) { current.initialized = true; current.value = typeof initial === 'function' ? initial() : initial }
      if (!current.setter) current.setter = (value) => {
        setterCount++
        if (!mounted || !record.active) { lateSetters++; return }
        current.value = typeof value === 'function' ? value(current.value) : value; dirty = true
      }
      return [current.value, current.setter]
    },
    useRef(initial) { const current = slot(); return current.ref ?? (current.ref = { current: initial }) },
    useEffect(callback, deps) {
      const current = slot()
      if (sameDeps(current.deps, deps)) return
      current.deps = deps
      effects.push(() => { current.cleanup?.(); current.cleanup = callback() })
    }
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, window, document, URLSearchParams,
    navigator: { languages: ['en-US'], language: 'en-US' },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    require(name) {
      if (name === 'react') return hooks
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      throw new Error(`未声明依赖 ${name}`)
    }
  }, { filename: path })
  const actual = module.exports
  const HookCard = () => jsx(actual.LyricsHudCard, { state: actual.useLyricsHudState(), language, opacity: 0.7 })
  const Component = hook ? HookCard : actual.LyricsHudCard
  function render(node, location, seen) {
    if (Array.isArray(node)) return node.map((item, index) => render(item, `${location}.${index}`, seen))
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      let record = records.get(location)
      if (record?.type !== node.type) {
        if (record) { record.active = false; for (const current of record.slots) current.cleanup?.() }
        record = { type: node.type, active: true, cursor: 0, slots: [] }; records.set(location, record)
      }
      record.active = true; record.cursor = 0; seen.add(location)
      const previous = dispatcher; dispatcher = record
      let result
      try { result = node.type(node.props) } finally { dispatcher = previous }
      return render(result, `${location}.child`, seen)
    }
    return { ...node, props: { ...node.props, children: render(node.props.children, `${location}.children`, seen) } }
  }
  function flush() {
    let rounds = 0
    while (mounted && dirty) {
      assert.ok(++rounds < 30, '歌词消费者不能无限刷新'); dirty = false; effects = []
      const seen = new Set(); tree = render(jsx(Component, hook ? {} : props), 'root', seen)
      for (const [location, record] of records) if (!seen.has(location)) {
        record.active = false; for (const current of record.slots) current.cleanup?.(); records.delete(location)
      }
      for (const run of effects) run()
    }
  }
  flush()
  return {
    actual, requests, order, interactive, nudges, timers,
    get tree() { return tree }, get text() { return text(tree) }, get lateSetters() { return lateSetters },
    get setters() { return setterCount }, get unsubscribes() { return unsubscribes },
    get listenerCount() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0) },
    emit(value) { for (const callback of active) callback(value); flush() },
    late(value) { for (const callback of callbacks) callback(value); flush() },
    update(value) { props = { ...props, state: value }; dirty = true; flush() },
    dispatch(name, event = {}) { for (const callback of [...(listeners.get(name) ?? [])]) callback(event); flush() },
    pointer(value, point = { x: 20, y: 30 }) { hit = value; this.dispatch('hc:lyrics-pointer', { detail: point }) },
    expire() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback() } flush() },
    click(direction) { const buttons = walk(tree, (node) => node.type === 'button'); buttons[direction === -1 ? 0 : 1].props.onClick({ stopPropagation() {} }); flush() },
    async settle() { await new Promise((resolve) => setImmediate(resolve)); flush() },
    unmount() { if (!mounted) return; mounted = false; for (const record of records.values()) { record.active = false; for (const current of record.slots) current.cleanup?.() } }
  }
}

await test('三行卡片三语、隐藏状态和既有样式由真实组件渲染', () => {
  for (const [language, previous, next] of [['zh-CN', '‹ 上一句', '下一句 ›'], ['zh-TW', '‹ 上一句', '下一句 ›'], ['en', '‹ Previous', 'Next ›']]) {
    const f = fixture({ language, nativeLocale: language })
    assert.equal(f.actual.lyricsLocale(), language)
    for (const value of ['Cloud music', 'Song · Artist', 'before', 'current line', 'after', previous, next]) assert.ok(f.text.includes(value))
    assert.equal(f.tree.props.className, 'rounded-2xl p-2.5')
    assert.equal(f.tree.props.style.background, 'rgba(18, 18, 24, 0.72)')
    assert.equal(f.tree.props.style.opacity, 0.7)
    assert.equal(walk(f.tree, (node) => node.type === 'button').length, 2)
    for (const status of ['off', 'idle']) { f.update(state({ status })); assert.equal(f.tree, null) }
    f.update(state({ enabled: false })); assert.equal(f.tree, null); f.unmount()
  }
  assert.equal(fixture({ nativeLocale: 'invalid' }).actual.lyricsLocale(), 'zh-CN')
})

await test('DTO 投影只保留歌词字段并拒绝不完整、超限和伪状态', () => {
  const f = fixture()
  const input = state({ accessToken: 'synthetic-field-not-for-view' })
  const projected = f.actual.projectLyricsState(input)
  assert.equal(Object.keys(projected).includes('accessToken'), false)
  assert.equal(projected.current, 'current line')
  for (const invalid of [null, [], {}, state({ enabled: 1 }), state({ status: { toString: () => 'sync' } }), state({ current: 'x'.repeat(8193) }), state({ source: 1 }), state({ message: [] })]) {
    assert.equal(f.actual.projectLyricsState(invalid), null)
  }
  f.unmount()
})

await test('先订阅后快照，新事件优先且卸载阻止迟到快照与回调', async () => {
  const f = fixture({ hook: true })
  assert.deepEqual(f.order, ['subscribe', 'snapshot'])
  assert.equal(f.tree, null)
  f.emit(state({ current: 'live line' })); f.requests[0].resolve(state({ current: 'stale line' })); await f.settle()
  assert.ok(f.text.includes('live line')); assert.ok(!f.text.includes('stale line'))
  f.unmount(); const before = f.setters; f.late(state({ current: 'late event' }))
  assert.equal(f.setters, before); assert.equal(f.lateSetters, 0); assert.equal(f.unsubscribes, 1)
  const late = fixture({ hook: true, offThrows: true }); late.unmount()
  late.requests[0].resolve(state()); late.late(state()); await late.settle(); assert.equal(late.setters, 0)
  const fallback = fixture({ hook: true, subscribeThrows: true }); fallback.requests[0].resolve(state()); await fallback.settle()
  assert.ok(fallback.text.includes('current line')); fallback.unmount()
})

await test('固定 ±1 校准、350ms 回馈及离开、隐藏、卸载均恢复穿透', () => {
  const f = fixture()
  f.click(-1); f.click(1); assert.deepEqual(f.nudges, [-1, 1]); assert.equal(f.timers.size, 1)
  assert.equal([...f.timers.values()][0].delay, 350)
  f.expire(); assert.equal(f.timers.size, 0)
  f.pointer(true); f.pointer(true); assert.deepEqual(f.interactive, [true])
  f.dispatch('mouseleave'); assert.deepEqual(f.interactive, [true, false])
  f.pointer(true); f.dispatch('blur'); assert.deepEqual(f.interactive, [true, false, true, false])
  f.pointer(true, { x: Infinity, y: 1 }); assert.equal(f.interactive.length, 4)
  f.pointer(true); f.update(state({ status: 'loading' })); assert.deepEqual(f.interactive.slice(-2), [true, false]); assert.equal(f.listenerCount, 0)
  f.update(state()); f.pointer(true); f.unmount(); assert.deepEqual(f.interactive.slice(-2), [true, false]); assert.equal(f.listenerCount, 0)
})

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exitCode = failed ? 1 : 0
