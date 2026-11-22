/** 直接转译生产 DanmakuOverlay；仅模拟 Hooks、Tauri 监听和定时器。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const file = 'src/renderer/src/components/DanmakuOverlay.tsx'
const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  fileName: file,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
}).outputText

const jsx = (type, props) => ({ type, props: props ?? {} })
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise((done) => setImmediate(done))
const message = (id, tracks = 2) => ({ id, text: id, fontSize: 22, speed: 20, opacity: 0.8, tracks })

function fixture() {
  let mounted = true
  let dirty = true
  let cursor = 0
  let tree
  let effects = []
  let setters = 0
  let offCount = 0
  let clearCount = 0
  let timerId = 0
  const slots = []
  const callbacks = []
  const order = []
  const config = deferred()
  const timers = new Map()
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
    useRef(initial) {
      const index = cursor++
      slots[index] ??= { current: initial }
      return slots[index]
    },
    useEffect(run) {
      const index = cursor++
      if (!slots[index]) {
        slots[index] = {}
        effects.push(() => { slots[index].cleanup = run() })
      }
    }
  }
  const window = {
    innerHeight: 600,
    innerWidth: 1200,
    addEventListener(name, callback) { assert.equal(name, 'resize'); this.resize = callback },
    removeEventListener(name, callback) { assert.equal(name, 'resize'); assert.equal(this.resize, callback); this.resize = undefined },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { clearCount++; timers.delete(id) },
    api: { mp: {
      onDanmaku(callback) { order.push('listen'); callbacks.push(callback); return () => { offCount++; callbacks.splice(callbacks.indexOf(callback), 1) } },
      danmakuConfig() { order.push('config'); return config.promise }
    } }
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Promise, Date, Error, Math, Set, Map, Array, Number, String, Object, console,
    setImmediate, window, require(name) {
      if (name === 'react') return hooks
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === '@shared/types') return {}
      throw new Error(`unexpected dependency ${name}`)
    }
  }, { filename: file })
  const actual = module.exports
  function flush() {
    if (!mounted || !dirty) return
    dirty = false
    cursor = 0
    effects = []
    tree = actual.DanmakuOverlay()
    for (const run of effects) run()
  }
  flush()
  return {
    order,
    config,
    get tree() { return tree },
    get setters() { return setters },
    get offCount() { return offCount },
    get clearCount() { return clearCount },
    async settle() { await tick(); flush() },
    emit(payload) { for (const callback of [...callbacks]) callback(payload); flush() },
    resolveConfig(value) { config.resolve(value) },
    unmount() { if (!mounted) return; mounted = false; for (const slot of slots) slot.cleanup?.() }
  }
}

let passed = 0
let failed = 0
async function test(label, run) {
  try { await run(); passed++; console.log(`  ok   ${label}`) }
  catch (error) { failed++; console.error(`  FAIL ${label}: ${error.stack ?? error}`) }
}

await test('监听先于配置，实时弹幕覆盖迟到配置', async () => {
  const f = fixture()
  assert.deepEqual(f.order, ['listen', 'config'])
  f.emit(message('first', 2))
  f.emit(message('second', 2))
  f.resolveConfig({ tracks: 8 })
  await f.settle()
  const items = f.tree.props.children.flat().filter((child) => child?.props?.style?.animation)
  assert.equal(items.length, 2)
  assert.equal(items[1].props.style.top, 72)
})

await test('卸载清理监听、定时器，迟到消息不再写状态', async () => {
  const f = fixture()
  f.emit(message('one'))
  const before = f.setters
  f.unmount()
  assert.equal(f.offCount, 1)
  assert.equal(f.clearCount, 1)
  f.emit(message('late'))
  f.resolveConfig({ tracks: 8 })
  await f.settle()
  assert.equal(f.setters, before)
})

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
process.exitCode = failed ? 1 : 0
