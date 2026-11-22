/**
 * DevToolsWindow 离线行为回归：转译真实 TSX，在同 VM realm 内运行组件与 React hooks 夹具。
 * 覆盖独立窗语言、日志订阅/快照竞态、有限去重、清理以及拒绝处理；不访问网络或真实数据。
 * 运行：node scripts/test-tauri-devtools.mjs
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

const fileName = 'src/renderer/src/components/DevToolsWindow.tsx'
const source = readFileSync(new URL(`../${fileName}`, import.meta.url), 'utf8')
const output = ts.transpileModule(source, {
  fileName,
  reportDiagnostics: true,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX
  }
})
const syntaxErrors = (output.diagnostics ?? [])
  .filter((item) => item.category === ts.DiagnosticCategory.Error)
  .map((item) => `${fileName}: ${ts.flattenDiagnosticMessageText(item.messageText, '\n')}`)

// Executed inside the VM so callbacks called by the component resolve window/navigator
// and use the same Object/Array/Promise realm as the production module.
function setupRealm() {
  const config = globalThis.__config ?? {}
  const state = {
    events: [], snapshotMode: config.snapshotMode ?? 'pending', snapshotValue: config.snapshotValue ?? [],
    snapshotResolve: null, snapshotReject: null, snapshotCalls: 0,
    subscriptions: [], unsubscriptions: 0, subscribeMode: config.subscribeMode ?? 'ok',
    statusValue: config.statusValue ?? null, statusEvent: config.statusEvent ?? null, statusMode: config.statusMode ?? 'resolve',
    statusSubscribeMode: config.statusSubscribeMode ?? 'ok', statusResolve: null, statusReject: null,
    statusEvents: [], statusCalls: 0, statusUnsubscriptions: 0, securityMode: config.securityMode ?? 'resolve',
    securityCalls: [], securityResolve: null, securityReject: null, changed: [],
    tree: null, effects: [], slots: [], cursor: 0, unmounted: false, setStateAfterUnmount: 0
  }
  const deferred = (kind) => new Promise((resolve, reject) => {
    state[`${kind}Resolve`] = resolve
    state[`${kind}Reject`] = reject
  })
  const debug = {
    onLog(callback) {
      state.events.push('subscribe')
      if (state.subscribeMode === 'throw') throw new Error('订阅失败')
      state.subscriptions.push(callback)
      return () => { state.unsubscriptions += 1 }
    },
    getLogs() {
      state.events.push('snapshot')
      state.snapshotCalls += 1
      if (state.snapshotMode === 'reject') return Promise.reject(new Error('历史快照失败'))
      if (state.snapshotMode === 'resolve') return Promise.resolve(state.snapshotValue)
      return deferred('snapshot')
    }
  }
  const devMode = {
    status() {
      state.statusEvents.push('status')
      state.statusCalls += 1
      if (state.statusMode === 'reject') return Promise.reject(new Error('状态读取失败'))
      if (state.statusMode === 'pending') return deferred('status')
      return Promise.resolve(state.statusValue)
    },
    onChanged(callback) {
      state.statusEvents.push('subscribe')
      if (state.statusSubscribeMode === 'throw') throw new Error('状态订阅失败')
      state.changed.push(callback)
      if (state.statusSubscribeMode === 'emit') callback(state.statusEvent)
      return () => {
        state.statusUnsubscriptions += 1
        state.changed = state.changed.filter((item) => item !== callback)
      }
    },
    emitChanged(value) { state.changed.forEach((callback) => callback(value)) },
    setSecurityMode(mode) {
      state.securityCalls.push(mode)
      if (state.securityMode === 'reject') return Promise.reject(new Error('安全设置拒绝'))
      if (state.securityMode === 'pending') return deferred('security')
      return Promise.resolve({ ...state.statusValue, securityMode: mode, effectiveSecurityMode: mode })
    }
  }
  const window = {
    location: { search: config.search ?? '?window=devtools' },
    __HC_DEVTOOLS_LOCALE__: config.nativeLocale,
    api: { debug, devMode }
  }
  const document = { documentElement: { lang: config.documentLanguage ?? '' }, title: '' }
  const navigator = { languages: config.languages ?? [], language: config.language ?? '' }
  window.top = window
  globalThis.window = window
  globalThis.document = document
  Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true, writable: true })

  const slot = (kind) => {
    const index = state.cursor++
    const item = state.slots[index]
    if (item) { if (item.kind !== kind) throw new Error(`Hook 顺序改变：${item.kind} != ${kind}`); return item }
    const created = { kind, initialized: false }
    state.slots[index] = created
    return created
  }
  const sameDeps = (left, right) => left && right && left.length === right.length && left.every((item, index) => Object.is(item, right[index]))
  const react = {
    useState(initial) {
      const item = slot('state')
      if (!item.initialized) { item.value = typeof initial === 'function' ? initial() : initial; item.initialized = true }
      return [item.value, (next) => {
        if (state.unmounted) { state.setStateAfterUnmount += 1; return }
        item.value = typeof next === 'function' ? next(item.value) : next
      }]
    },
    useRef(initial) {
      const item = slot('ref')
      if (!item.initialized) { item.value = { current: initial }; item.initialized = true }
      return item.value
    },
    useEffect(callback, deps) {
      const item = slot('effect')
      if (item.initialized && sameDeps(item.deps, deps)) return
      state.effects.push({ item, callback, deps })
    }
  }
  const jsx = (type, props, key) => ({ type, props: { ...(props ?? {}), ...(key === undefined ? {} : { key }) } })
  globalThis.__stubs = { react, 'react/jsx-runtime': { Fragment: Symbol.for('react.fragment'), jsx, jsxs: jsx } }
  globalThis.__host = {
    state, window, document, navigator,
    render() {
      state.cursor = 0
      state.effects = []
      state.tree = __component()
      return state.tree
    },
    flushEffects() {
      const queue = state.effects.splice(0)
      for (const item of queue) {
        if (item.item.cleanup) item.item.cleanup()
        item.item.deps = item.deps
        item.item.initialized = true
        item.item.cleanup = item.callback()
      }
    },
    unmount() {
      if (state.unmounted) return
      state.unmounted = true
      for (const item of state.slots) item.cleanup?.()
    },
    emit(entry) { for (const callback of [...state.subscriptions]) callback(entry) },
    emitChanged(value, callbacks = state.changed) { for (const callback of [...callbacks]) callback(value) },
    captureChangedCallbacks() { return [...state.changed] },
    resolveSnapshot(value) { state.snapshotResolve?.(value) },
    rejectSnapshot(error) { state.snapshotReject?.(error) },
    resolveStatus(value) { state.statusResolve?.(value) },
    rejectStatus(error) { state.statusReject?.(error) },
    findAll(node, predicate, result = []) {
      if (Array.isArray(node)) { for (const child of node) this.findAll(child, predicate, result); return result }
      if (!node || typeof node !== 'object') return result
      if (predicate(node)) result.push(node)
      const children = node.props?.children
      for (const child of (Array.isArray(children) ? children : [children])) this.findAll(child, predicate, result)
      return result
    },
    textOf(node) {
      if (node === null || node === undefined || typeof node === 'boolean') return ''
      if (typeof node === 'string' || typeof node === 'number') return String(node)
      const children = node.props?.children
      return (Array.isArray(children) ? children : [children]).map((child) => this.textOf(child)).join('')
    },
    setSnapshotMode(mode) { state.snapshotMode = mode },
    setStatusMode(mode) { state.statusMode = mode },
    setSecurityMode(mode) { state.securityMode = mode }
  }
}

function fixture(config = {}) {
  const context = vm.createContext({ assert, URLSearchParams, Date })
  context.__config = config
  vm.runInContext(`(${setupRealm.toString()})()`, context, { timeout: 2000 })
  const module = vm.runInContext('({ exports: {} })', context)
  const require = (name) => {
    if (Object.prototype.hasOwnProperty.call(context.__stubs, name)) return context.__stubs[name]
    throw new Error(`未声明的测试依赖：${name}`)
  }
  const fn = new vm.Script(`(function(require, module, exports) {\n${output.outputText}\n})`, { filename: fileName }).runInContext(context)
  fn(require, module, module.exports)
  context.__component = module.exports.DevToolsWindow
  const host = context.__host
  host.helpers = {
    resolveDevToolsLocale: module.exports.resolveDevToolsLocale,
    mergeDevToolsLogs: module.exports.mergeDevToolsLogs,
    appendDevToolsLog: module.exports.appendDevToolsLog
  }
  return { context, host }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))
const unhandled = []
const unhandledListener = (reason) => unhandled.push(reason)
process.on('unhandledRejection', unhandledListener)

await test('真实 DevToolsWindow.tsx 可完整转译并导出行为 helper', () => {
  assert.deepEqual(syntaxErrors, [])
  const { host } = fixture()
  assert.equal(typeof host.helpers.resolveDevToolsLocale, 'function')
  assert.equal(typeof host.helpers.mergeDevToolsLogs, 'function')
  assert.equal(typeof host.helpers.appendDevToolsLog, 'function')
})

await test('独立窗口 locale 按 URL、document、navigator 顺序解析并回退简体', () => {
  const { host } = fixture({ search: '?window=devtools&lang=en', documentLanguage: 'zh-CN', languages: ['zh-TW'] })
  assert.equal(host.helpers.resolveDevToolsLocale(), 'en')
  host.window.location.search = '?window=devtools&lang=invalid'
  assert.equal(host.helpers.resolveDevToolsLocale(), 'zh-CN')
  host.document.documentElement.lang = 'zh-Hant'
  assert.equal(host.helpers.resolveDevToolsLocale(), 'zh-TW')
  host.document.documentElement.lang = ''
  host.navigator.languages = ['en-US']
  assert.equal(host.helpers.resolveDevToolsLocale(), 'en')
  host.navigator.languages = ['ja-JP']; host.navigator.language = 'ja-JP'
  assert.equal(host.helpers.resolveDevToolsLocale(), 'zh-CN')
})

await test('原生窗口语言优先于文档且拒绝无效值', () => {
  const { host } = fixture({ nativeLocale: 'en', documentLanguage: 'zh-CN', languages: ['zh-TW'] })
  assert.equal(host.helpers.resolveDevToolsLocale(), 'en')
  host.window.__HC_DEVTOOLS_LOCALE__ = 'zh-TW'
  assert.equal(host.helpers.resolveDevToolsLocale(), 'zh-TW')
  host.window.__HC_DEVTOOLS_LOCALE__ = 'invalid'
  assert.equal(host.helpers.resolveDevToolsLocale(), 'zh-CN')
  host.window.__HC_DEVTOOLS_LOCALE__ = 'en'
  host.window.location.search = '?window=devtools&lang=zh-TW'
  assert.equal(host.helpers.resolveDevToolsLocale(), 'zh-TW')
})

await test('日志合并按 ts/level/message 有界去重并保留最新 3000 条', () => {
  const { host } = fixture()
  const duplicate = { ts: 2, level: 'warn', message: 'same' }
  const initial = Array.from({ length: 3001 }, (_, index) => ({ ts: index + 10, level: 'info', message: `history-${index}` }))
  const merged = host.helpers.mergeDevToolsLogs([...initial, duplicate], [duplicate, { ts: 4, level: 'error', message: 'live' }])
  assert.equal(merged.length, 3000)
  assert.equal(merged.filter((entry) => entry.ts === 2).length, 1)
  assert.equal(merged.filter((entry) => entry.message === 'same').length, 1)
  assert.equal(merged.at(-1).message, 'live')
  const appended = host.helpers.appendDevToolsLog([duplicate], duplicate)
  assert.equal(JSON.stringify(appended), JSON.stringify([duplicate]))
})

await test('日志 effect 先注册订阅再请求快照，并合并竞态日志且不重复', async () => {
  const a = { ts: 1, level: 'info', message: 'history-a' }
  const b = { ts: 2, level: 'warn', message: 'race-b' }
  const c = { ts: 3, level: 'error', message: 'live-c' }
  const { host } = fixture({ snapshotMode: 'pending', snapshotValue: [a, b] })
  host.render(); host.flushEffects()
  assert.equal(JSON.stringify(host.state.events), JSON.stringify(['subscribe']))
  await settle()
  assert.equal(JSON.stringify(host.state.events), JSON.stringify(['subscribe', 'snapshot']))
  host.emit(b); host.emit(c)
  host.resolveSnapshot([a, b])
  await settle(); await settle()
  host.render()
  const visible = host.textOf(host.state.tree)
  assert.equal(visible.split('race-b').length - 1, 1)
  assert.equal(visible.split('live-c').length - 1, 1)
  assert.ok(visible.includes('history-a'))
  host.unmount(); assert.equal(host.state.unsubscriptions, 1)
})

await test('状态 effect 先订阅再取快照，快照等待期间的事件优先', async () => {
  const eventState = { granted: true, enabled: true, securityMode: 'warn', effectiveSecurityMode: 'warn', emailMasked: 'event', expiresAt: Date.now() + 3600000 }
  const snapshotState = { granted: true, enabled: false, securityMode: 'full', effectiveSecurityMode: 'full', emailMasked: 'snapshot', expiresAt: Date.now() + 3600000 }
  const { host } = fixture({ statusMode: 'pending', statusValue: snapshotState })
  host.render(); host.flushEffects()
  assert.equal(JSON.stringify(host.state.statusEvents), JSON.stringify(['subscribe']))
  await settle()
  assert.equal(host.state.statusCalls, 1)
  assert.equal(JSON.stringify(host.state.statusEvents), JSON.stringify(['subscribe', 'status']))
  host.emitChanged(eventState)
  host.resolveStatus(snapshotState)
  await settle(); await settle()
  host.render()
  assert.ok(host.textOf(host.state.tree).includes('event'))
  assert.ok(!host.textOf(host.state.tree).includes('snapshot'))
  host.unmount()
})

await test('订阅时同步发出的状态事件也不能被后续快照覆盖', async () => {
  const eventState = { granted: true, enabled: true, securityMode: 'off', effectiveSecurityMode: 'off', emailMasked: 'sync-event', expiresAt: Date.now() + 3600000 }
  const snapshotState = { granted: true, enabled: false, securityMode: 'full', effectiveSecurityMode: 'full', emailMasked: 'late-snapshot', expiresAt: Date.now() + 3600000 }
  const { host } = fixture({ statusMode: 'pending', statusSubscribeMode: 'emit', statusEvent: eventState })
  host.render(); host.flushEffects()
  await settle()
  assert.equal(host.state.statusCalls, 1)
  host.resolveStatus(snapshotState)
  await settle(); await settle()
  host.render()
  assert.ok(host.textOf(host.state.tree).includes('sync-event'))
  assert.ok(!host.textOf(host.state.tree).includes('late-snapshot'))
  host.unmount()
})

await test('状态 onChanged 同步抛错被捕获，快照仍安全处理', async () => {
  const { host } = fixture({ statusSubscribeMode: 'throw', statusValue: null })
  host.render(); host.flushEffects()
  await settle(); await settle()
  host.render()
  assert.ok(host.textOf(host.state.tree).includes('开发模式状态订阅失败'))
  assert.equal(host.state.statusCalls, 1)
  host.unmount()
})

await test('状态快照与事件在卸载后都不再 setState', async () => {
  const eventState = { granted: true, enabled: true, securityMode: 'off', effectiveSecurityMode: 'off', emailMasked: 'late-event', expiresAt: Date.now() + 3600000 }
  const { host } = fixture({ statusMode: 'pending', statusSubscribeMode: 'ok' })
  host.render(); host.flushEffects()
  await settle()
  const staleCallbacks = host.captureChangedCallbacks()
  host.unmount()
  host.emitChanged(eventState, staleCallbacks)
  host.resolveStatus(eventState)
  await settle(); await settle()
  assert.equal(host.state.setStateAfterUnmount, 0)
  assert.equal(host.state.statusUnsubscriptions, 1)
})

await test('快照拒绝显示有界错误且不泄漏 rejected Promise', async () => {
  const { host } = fixture({ snapshotMode: 'reject' })
  host.render(); host.flushEffects()
  await settle(); await settle()
  host.render()
  assert.ok(host.textOf(host.state.tree).includes('历史日志加载失败'))
  host.unmount()
})

await test('订阅同步异常显示订阅错误，快照仍按自己的 Promise 处理', async () => {
  const { host } = fixture({ subscribeMode: 'throw', snapshotMode: 'resolve' })
  host.render(); host.flushEffects()
  await settle(); await settle()
  host.render()
  assert.ok(host.textOf(host.state.tree).includes('实时日志订阅失败'))
  host.unmount()
})

await test('clear 在快照等待期不会被迟到历史覆盖，清空后新实时日志仍可见', async () => {
  const a = { ts: 1, level: 'info', message: 'old-history' }
  const live = { ts: 2, level: 'error', message: 'after-clear' }
  const { host } = fixture({ snapshotMode: 'pending' })
  host.render(); host.flushEffects()
  await settle()
  host.emit({ ts: 0, level: 'info', message: 'before-clear' })
  host.render()
  const clear = host.findAll(host.state.tree, (node) => node.type === 'button' && host.textOf(node) === '清空')[0]
  assert.ok(clear)
  clear.props.onClick()
  host.emit(live)
  host.resolveSnapshot([a])
  await settle(); await settle()
  host.render()
  const visible = host.textOf(host.state.tree)
  assert.ok(!visible.includes('old-history'))
  assert.ok(!visible.includes('before-clear'))
  assert.ok(visible.includes('after-clear'))
  host.unmount()
})

await test('setSecurityMode 拒绝被 catch，显示安全设置错误且不产生未处理拒绝', async () => {
  const dev = { granted: true, enabled: true, securityMode: 'full', effectiveSecurityMode: 'full', emailMasked: 'a***@fixture.invalid', expiresAt: Date.now() + 3600000 }
  const { host } = fixture({ statusValue: dev, securityMode: 'reject', search: '?lang=en' })
  host.render(); host.flushEffects()
  await settle(); await settle()
  host.render()
  const buttons = host.findAll(host.state.tree, (node) => node.type === 'button')
  assert.equal(buttons.length, 5)
  buttons[1].props.onClick()
  await settle(); await settle()
  host.render()
  assert.ok(host.textOf(host.state.tree).includes('Security setting failed'))
  assert.equal(JSON.stringify(host.state.securityCalls), JSON.stringify(['warn']))
  host.unmount()
})

await test('状态读取拒绝显示状态错误，并保留固定 DOM 类与安全按钮数量', async () => {
  const { host } = fixture({ statusMode: 'reject' })
  host.render(); host.flushEffects()
  await settle(); await settle()
  host.render()
  const root = host.state.tree
  assert.equal(root.type, 'div')
  assert.equal(root.props.className, 'flex h-full flex-col')
  assert.equal(host.findAll(root, (node) => node.type === 'button').length, 5)
  assert.ok(host.textOf(root).includes('开发模式状态加载失败'))
  host.unmount()
})

await test('卸载后迟到快照与实时日志均不再写入组件状态', async () => {
  const { host } = fixture({ snapshotMode: 'pending' })
  host.render(); host.flushEffects()
  await settle()
  host.unmount()
  host.emit({ ts: 1, level: 'info', message: 'late-live' })
  host.resolveSnapshot([{ ts: 2, level: 'info', message: 'late-snapshot' }])
  await settle(); await settle()
  host.render()
  const visible = host.textOf(host.state.tree)
  assert.ok(!visible.includes('late-live'))
  assert.ok(!visible.includes('late-snapshot'))
})

await settle(); await settle()
assert.deepEqual(unhandled, [])
process.removeListener('unhandledRejection', unhandledListener)
console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1
