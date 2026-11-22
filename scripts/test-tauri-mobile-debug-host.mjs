/**
 * 移动端日志宿主的离线回归：转译真实 TSX，提供最小 Hooks 与 dialog 提交模型。
 * 不复制宿主协议、不加载原生桥、不运行浏览器；原生焦点圈定和平台 Back 仍需实机验证。
 * 运行：node scripts/test-tauri-mobile-debug-host.mjs
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
const sourcePath = 'src/renderer/src/components/TauriMobileDebugHost.tsx'
const source = readFileSync(new URL(`../${sourcePath}`, import.meta.url), 'utf8')
const output = ts.transpileModule(source, {
  fileName: sourcePath,
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
})
const syntaxErrors = (output.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error)
const childrenOf = (node) => [node?.props?.children].flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true)
function walk(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((item) => walk(item, predicate))
  return [...(predicate(node) ? [node] : []), ...childrenOf(node).flatMap((item) => walk(item, predicate))]
}
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return childrenOf(node).map(textOf).join('')
}

class Element {
  constructor(document) { this.document = document; this.isConnected = true; this.focusCalls = 0 }
  focus() { this.focusCalls++; if (this.document) this.document.activeElement = this }
}
class FakeDialog extends Element {
  constructor(props, document, options) {
    super()
    this.props = props
    this.document = document
    this.options = options
    this.open = false
    this.showCalls = 0
    this.closeCalls = 0
  }
  showModal() {
    this.showCalls++
    if (this.options.showFailure) throw new Error('private showModal detail')
    if (!this.isConnected) throw new Error('detached dialog')
    this.open = true
    const focusTarget = walk(this.props.children, (node) => node.props?.autoFocus === true)[0]
    if (focusTarget) this.document.activeElement = focusTarget
  }
  close() {
    this.closeCalls++
    if (this.options.closeFailure) throw new Error('private close detail')
    this.open = false
    this.props.onClose?.({ currentTarget: this })
  }
}
function fixture({ language = 'en', showFailure = false, closeFailure = false, attachFailure = false, controller } = {}) {
  const document = { documentElement: { lang: language }, title: 'Main app' }
  const priorFocus = new Element(document)
  document.activeElement = priorFocus
  const options = { showFailure, closeFailure }
  const dialogNodes = new Map()
  const bridge = { currentHost: null, attachCount: 0, detachCount: 0, detachHide: false, rejectClose: false }
  const closeCalls = []
  let dispatcher = null
  let renderDirty = true
  let mounted = true
  let tree
  let dialogRefValue = null
  let childCommitted = false
  const JSX_FRAGMENT = Symbol('Fragment')
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
  const hooks = {
    useState(initial) {
      const slot = dispatcher.slot()
      if (!slot.initialized) {
        slot.value = typeof initial === 'function' ? initial() : initial
        slot.initialized = true
      }
      return [slot.value, (update) => {
        if (!mounted) return
        slot.value = typeof update === 'function' ? update(slot.value) : update
        renderDirty = true
      }]
    },
    useRef(initial) {
      const slot = dispatcher.slot()
      if (!slot.initialized) { slot.value = { current: initial }; slot.initialized = true }
      return slot.value
    },
    useEffect(callback, deps) { dispatcher.effect('passive', callback, deps) },
    useLayoutEffect(callback, deps) { dispatcher.effect('layout', callback, deps) }
  }
  const EmbeddedProbe = (props) => ({ type: 'section', props: { 'data-embedded': props.embedded } })
  const module = { exports: {} }
  vm.runInNewContext(output.outputText, {
    module, exports: module.exports, document,
    navigator: { languages: [language], language },
    HTMLElement: Element,
    window: { api: { debug: { closeWindow() {
      closeCalls.push(true)
      if (bridge.rejectClose) return Promise.reject(new Error('private closeWindow detail'))
      return controller ? controller.close() : Promise.resolve()
    } } } },
    require(key) {
      if (key === 'react') return hooks
      if (key === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: JSX_FRAGMENT }
      if (key === '../../../tauri/bridge') return {
        attachTauriMobileDebugHost(_api, host) {
          if (attachFailure) throw new Error('private registration detail')
          bridge.attachCount++
          bridge.currentHost = host
          const detachController = controller?.attach(host)
          return () => {
            bridge.detachCount++
            if (bridge.currentHost === host) bridge.currentHost = null
            detachController?.()
            if (bridge.detachHide) host.hide(bridge.lastId)
          }
        }
      }
      if (key === './DebugLogWindow') return { DebugLogWindow: EmbeddedProbe }
      throw new Error(`未声明的测试依赖：${key}`)
    }
  }, { filename: sourcePath })
  const Component = module.exports.TauriMobileDebugHost
  assert.equal(typeof Component, 'function')
  const slots = []
  const pendingLayout = []
  const pendingPassive = []
  let cursor = 0
  const depsEqual = (left, right) => left !== undefined && right !== undefined && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  dispatcher = {
    slot() { const index = cursor++; return slots[index] ?? (slots[index] = { initialized: false, kind: 'state' }) },
    effect(kind, callback, deps) {
      const index = cursor++
      let slot = slots[index]
      if (!slot) slot = slots[index] = { initialized: true, kind, deps: undefined, cleanup: undefined }
      slot.callback = callback
      assert.equal(slot.kind, kind)
      if (depsEqual(slot.deps, deps)) return
      const run = () => {
        slot.cleanup?.()
        slot.deps = deps
        slot.cleanup = callback()
      }
      ;(kind === 'layout' ? pendingLayout : pendingPassive).push(run)
    }
  }
  function renderNode(node) {
    if (node === null || node === undefined || typeof node === 'boolean' || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) renderNode(child); return }
    if (node.type === JSX_FRAGMENT) { renderNode(node.props.children); return }
    if (node.type === EmbeddedProbe) {
      childCommitted ||= node.props.embedded === true
      renderNode(EmbeddedProbe(node.props))
      return
    }
    if (node.type === 'dialog') {
      let dialog = dialogNodes.get(node.key)
      if (!dialog) { dialog = new FakeDialog(node.props, document, options); dialogNodes.set(node.key, dialog) }
      dialog.props = node.props
      dialog.isConnected = true
      if (node.props.ref) { node.props.ref.current = dialog; dialogRefValue = dialog }
      renderNode(node.props.children)
      return
    }
    renderNode(node.props?.children)
  }
  function flush() {
    let turns = 0
    while (renderDirty && mounted) {
      assert.ok(++turns <= 30, '宿主产生未收敛的重渲染')
      renderDirty = false
      cursor = 0
      pendingLayout.length = 0
      pendingPassive.length = 0
      childCommitted = false
      tree = Component()
      for (const dialog of dialogNodes.values()) dialog.isConnected = false
      dialogRefValue = null
      renderNode(tree)
      for (let index = pendingLayout.length - 1; index >= 0; index--) pendingLayout[index]()
      for (const effect of pendingPassive) effect()
    }
  }
  flush()
  const current = {
    document, priorFocus, bridge, closeCalls,
    get tree() { return tree },
    get childCommitted() { return childCommitted },
    get dialog() { return dialogRefValue },
    get dialogs() { return [...dialogNodes.values()] },
    get attachCount() { return bridge.attachCount },
    get detachCount() { return bridge.detachCount },
    get text() { return textOf(tree) },
    host() { assert.ok(bridge.currentHost); return bridge.currentHost },
    request(id) {
      const acks = { opened: 0, closed: 0, failed: 0 }
      const request = { id, opened() { acks.opened++ }, closed() { acks.closed++ }, failed() { acks.failed++ } }
      bridge.lastId = id
      return { request, acks }
    },
    flush,
    async settle() { await new Promise((resolve) => setImmediate(resolve)); flush() },
    replayEffects() {
      // 模拟 StrictMode 的 effect cleanup/setup 重放，而不声称完整模拟 React 调度。
      for (let index = slots.length - 1; index >= 0; index--) {
        const slot = slots[index]
        if (slot.kind === 'layout' || slot.kind === 'passive') slot.cleanup?.()
      }
      for (const kind of ['layout', 'passive']) for (const slot of slots) {
        if (slot.kind === kind) slot.cleanup = slot.callback()
      }
      flush()
    },
    cancel() {
      const dialog = dialogRefValue
      assert.ok(dialog)
      let prevented = false
      dialog.props.onCancel({ preventDefault() { prevented = true } })
      return prevented
    },
    back() {
      const buttons = walk(tree, (node) => node.type === 'button')
      assert.equal(buttons.length, 1)
      buttons[0].props.onClick()
    },
    unmount() {
      if (!mounted) return
      mounted = false
      for (let index = slots.length - 1; index >= 0; index--) slots[index]?.cleanup?.()
      for (const dialog of dialogNodes.values()) dialog.isConnected = false
      if (dialogRefValue) dialogRefValue.props.ref.current = null
    }
  }
  return current
}

await test('真实宿主 TSX 转译成功且仅加载声明的组件/桥接依赖', () => {
  const errors = syntaxErrors.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n'))
  assert.deepEqual(errors, [])
})

for (const [language, title, back] of [
  ['zh-CN', '启动器日志', '返回'],
  ['zh-TW', '啟動器日誌', '返回'],
  ['en', 'Launcher logs', 'Back']
]) {
  await test(`三语宿主标题与返回按钮：${language}`, () => {
    const app = fixture({ language })
    app.host().show(app.request(100).request)
    app.flush()
    assert.ok(app.text.includes(title))
    assert.ok(app.text.includes(back))
    assert.equal(app.document.title, 'Main app')
    app.unmount()
  })
}

await test('show 只挂载；子树和 dialog commit 并 showModal 后才 opened', () => {
  const app = fixture()
  const { request, acks } = app.request(1)
  app.host().show(request)
  assert.deepEqual(acks, { opened: 0, closed: 0, failed: 0 })
  app.flush()
  assert.equal(app.childCommitted, true)
  assert.equal(app.dialog.showCalls, 1)
  assert.equal(app.dialog.open, true)
  assert.equal(acks.opened, 1)
  assert.equal(acks.failed, 0)
  assert.notEqual(app.document.activeElement, app.priorFocus)
  app.unmount()
})

await test('hide 等 React 撤下并关闭自己的 dialog 后才 closed、恢复原焦点', () => {
  const app = fixture()
  const { request, acks } = app.request(2)
  app.host().show(request)
  app.flush()
  const dialog = app.dialog
  app.host().hide(2)
  assert.equal(acks.closed, 0)
  app.flush()
  assert.deepEqual(acks, { opened: 1, closed: 1, failed: 0 })
  assert.equal(app.dialog, null)
  assert.equal(dialog.open, false)
  assert.equal(app.priorFocus.focusCalls, 1)
  assert.equal(app.document.activeElement, app.priorFocus)
  assert.equal(app.closeCalls.length, 0)
  app.unmount()
})

await test('同批 show→hide 不打开 dialog 仍回执 closed', () => {
  const app = fixture()
  const { request, acks } = app.request(3)
  app.host().show(request)
  app.host().hide(3)
  app.flush()
  assert.deepEqual(acks, { opened: 0, closed: 1, failed: 0 })
  assert.equal(app.dialogs.reduce((count, dialog) => count + dialog.showCalls, 0), 0)
  app.unmount()
})

await test('showModal 失败只报告固定本地错误并回执 failed', () => {
  const app = fixture({ showFailure: true })
  const { request, acks } = app.request(4)
  app.host().show(request)
  app.flush()
  assert.deepEqual(acks, { opened: 0, closed: 0, failed: 1 })
  assert.ok(app.text.includes('The log page operation did not complete. Please retry.'))
  assert.ok(!app.text.includes('private showModal detail'))
  app.unmount()
})

await test('Escape 阻止原生直接关闭并经 closeWindow 请求控制器关闭', () => {
  const app = fixture()
  const { request } = app.request(5)
  app.host().show(request)
  app.flush()
  assert.equal(app.cancel(), true)
  assert.equal(app.closeCalls.length, 1)
  assert.equal(app.dialog.open, true)
  app.host().hide(5)
  app.flush()
  app.unmount()
})

await test('可见返回按钮同样调用 closeWindow，不直接触碰 desktop/window.close', () => {
  const app = fixture()
  const { request } = app.request(6)
  app.host().show(request)
  app.flush()
  app.back()
  assert.equal(app.closeCalls.length, 1)
  assert.equal(app.dialog.open, true)
  app.host().hide(6)
  app.flush()
  app.unmount()
})

await test('detach 只关闭本轮 dialog、不调用 closeWindow，迟到 show 无效', () => {
  const app = fixture()
  const { request, acks } = app.request(7)
  app.host().show(request)
  app.flush()
  const host = app.host()
  app.unmount()
  const before = { ...acks }
  host.show(app.request(8).request)
  assert.deepEqual(acks, before)
  assert.equal(app.closeCalls.length, 0)
  assert.equal(app.detachCount, 1)
  assert.equal(app.dialog.open, false)
})

await test('意外原生 close 只请求控制器，不伪造 closed 回执', () => {
  const app = fixture()
  const { request, acks } = app.request(9)
  app.host().show(request)
  app.flush()
  const dialog = app.dialog
  dialog.open = false
  dialog.props.onClose({ currentTarget: dialog })
  assert.equal(app.closeCalls.length, 1)
  assert.equal(acks.closed, 0)
  app.host().hide(9)
  app.flush()
  assert.equal(acks.closed, 1)
  app.unmount()
})

await test('dialog 挂载失败时仅显示固定错误且 unregister 不泄漏', () => {
  const app = fixture({ attachFailure: true })
  assert.ok(app.text.includes('The log page operation did not complete. Please retry.'))
  assert.ok(!app.text.includes('private registration detail'))
  assert.equal(app.bridge.currentHost, null)
  app.unmount()
  assert.equal(app.detachCount, 0)
})

await test('StrictMode effect 重放先卸载本轮，旧 host 不能覆盖新注册', () => {
  const app = fixture()
  const first = app.request(10)
  const oldHost = app.host()
  oldHost.show(first.request)
  app.flush()
  const oldDialog = app.dialog
  app.bridge.detachHide = true
  app.replayEffects()
  assert.equal(app.attachCount, 2)
  assert.equal(app.detachCount, 1)
  assert.equal(oldDialog.open, false)
  const stale = app.request(11)
  oldHost.show(stale.request)
  app.flush()
  assert.deepEqual(stale.acks, { opened: 0, closed: 0, failed: 0 })
  const next = app.request(12)
  app.host().show(next.request)
  app.flush()
  assert.equal(next.acks.opened, 1)
  assert.equal(app.closeCalls.length, 0)
  app.unmount()
})

await test('关闭请求失败使用固定提示且卸载后的 Promise 续体无作用', async () => {
  const app = fixture()
  const { request } = app.request(13)
  app.host().show(request)
  app.flush()
  app.bridge.rejectClose = true
  app.back()
  await app.settle()
  assert.ok(app.text.includes('The log page operation did not complete. Please retry.'))
  assert.ok(!app.text.includes('private closeWindow detail'))
  const alerts = walk(app.tree, (node) => node.props?.role === 'alert')
  assert.equal(alerts.length, 1)
  assert.equal(app.dialog.open, true)
  app.back()
  app.unmount()
  await app.settle()
  assert.equal(app.detachCount, 1)
})

await test('关闭 dialog 失败回执 failed 而不是 closed', () => {
  const app = fixture({ closeFailure: true })
  const { request, acks } = app.request(14)
  app.host().show(request)
  app.flush()
  app.host().hide(14)
  app.flush()
  assert.equal(acks.closed, 0)
  assert.equal(acks.failed, 1)
  assert.ok(app.text.includes('The log page operation did not complete. Please retry.'))
  app.unmount()
})

await test('错误 id hide 不影响当前页面；同请求 show 不重复 opened', () => {
  const app = fixture()
  const { request, acks } = app.request(15)
  app.host().show(request)
  app.flush()
  app.host().hide(999)
  app.host().show(request)
  app.flush()
  assert.deepEqual(acks, { opened: 1, closed: 0, failed: 0 })
  assert.equal(app.dialog.showCalls, 1)
  app.unmount()
})

await test('CSS 只新增 hc-mobile-debug 命名空间及安全区/44px 基础规则', () => {
  const css = readFileSync(new URL('../src/renderer/src/index.css', import.meta.url), 'utf8')
  const marker = css.indexOf('/* 移动日志原生模态层')
  const nextSection = css.indexOf('/* Tauri 专用 AI HUD', marker + 1)
  assert.ok(marker >= 0 && nextSection > marker, '移动日志样式块边界缺失')
  const rules = css.slice(marker, nextSection)
  assert.doesNotMatch(css.slice(0, marker) + css.slice(nextSection), /\.hc-mobile-debug\b/u, '移动日志样式不得散落在其他段落')
  assert.ok(rules.includes('min-width: 44px'))
  assert.ok(rules.includes('min-height: 44px'))
  for (const side of ['top', 'right', 'bottom', 'left']) assert.ok(rules.includes(`safe-area-inset-${side}`))
  const selectors = rules.slice(rules.indexOf('*/') + 2).split('}')
    .filter((block) => block.includes('{')).map((block) => block.slice(0, block.indexOf('{')).trim())
  assert.ok(selectors.length > 5)
  for (const selector of selectors) {
    assert.ok(selector.split(',').every((part) => part.trim().startsWith('.hc-mobile-debug')), `非命名空间选择器：${selector}`)
  }
})

// 嵌入契约另行转译真实日志组件，宿主的子树探针不充当日志实现。
function logComponentFixture({ embedded, language = 'zh-TW', search = '?lang=en' } = {}) {
  const path = 'src/renderer/src/components/DebugLogWindow.tsx'
  const compiled = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
    fileName: path, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  })
  assert.equal((compiled.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error).length, 0)
  const document = { documentElement: { lang: language }, title: 'Main app title' }
  const slots = []
  let cursor = 0
  let dirty = true
  let mounted = true
  let tree
  let subscriber
  let retainedSubscriber
  let resolveHistory
  let unsubscribeCount = 0
  let renders = 0
  let pendingLayout = []
  let pendingPassive = []
  const history = new Promise((resolve) => { resolveHistory = resolve })
  const list = { scrollTop: 0, scrollHeight: 120, clientHeight: 120 }
  const slotAt = () => { const index = cursor++; return slots[index] ?? (slots[index] = {}) }
  const same = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const effect = (kind, callback, deps) => {
    const slot = slotAt()
    if (same(slot.deps, deps)) return
    ;(kind === 'layout' ? pendingLayout : pendingPassive).push(() => {
      slot.cleanup?.()
      slot.deps = deps
      slot.cleanup = callback()
    })
  }
  const hooks = {
    useState(initial) {
      const slot = slotAt()
      if (!slot.initialized) { slot.initialized = true; slot.value = typeof initial === 'function' ? initial() : initial }
      return [slot.value, (update) => {
        assert.ok(mounted, '卸载后的日志组件不能写入状态')
        slot.value = typeof update === 'function' ? update(slot.value) : update
        dirty = true
      }]
    },
    useRef(initial) { const slot = slotAt(); return slot.ref ?? (slot.ref = { current: initial }) },
    useEffect: (callback, deps) => effect('passive', callback, deps),
    useLayoutEffect: (callback, deps) => effect('layout', callback, deps)
  }
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
  const module = { exports: {} }
  vm.runInNewContext(compiled.outputText, {
    module, exports: module.exports, document, URLSearchParams,
    navigator: { languages: ['en-US'], language: 'en-US' },
    window: { location: { search }, api: { debug: {
      getLogs: () => history,
      onLog(callback) { subscriber = retainedSubscriber = callback; return () => { unsubscribeCount++; subscriber = undefined } }
    } } },
    require(key) {
      if (key === 'react') return hooks
      if (key === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      throw new Error(`未声明的嵌入日志依赖：${key}`)
    }
  }, { filename: path })
  const Component = module.exports.DebugLogWindow
  const flush = () => {
    let turns = 0
    while (mounted && dirty) {
      assert.ok(++turns <= 20)
      dirty = false
      cursor = 0
      pendingLayout = []
      pendingPassive = []
      tree = embedded === undefined ? Component() : Component({ embedded })
      renders++
      for (const node of walk(tree, (item) => item.props?.ref)) node.props.ref.current = list
      for (const run of pendingLayout) run()
      for (const run of pendingPassive) run()
    }
  }
  flush()
  return {
    document,
    get tree() { return tree },
    get text() { return textOf(tree) },
    get renders() { return renders },
    get unsubscribes() { return unsubscribeCount },
    emit(message) { subscriber?.({ ts: 1, level: 'info', message }); flush() },
    lateEvent() { retainedSubscriber?.({ ts: 1, level: 'info', message: 'late' }) },
    resolve(items) { resolveHistory(items) },
    async settle() { await new Promise((resolve) => setImmediate(resolve)); flush() },
    unmount() { mounted = false; for (const slot of slots) slot.cleanup?.() }
  }
}

await test('真实 embedded 日志沿用文档三语且不改 title/lang，不消费独立窗口参数', async () => {
  for (const [language, title] of [['zh-CN', '启动器日志'], ['zh-TW', '啟動器日誌'], ['en', 'Launcher logs']]) {
    const app = logComponentFixture({ embedded: true, language, search: '?lang=en' })
    assert.equal(app.document.title, 'Main app title')
    assert.equal(app.document.documentElement.lang, language)
    assert.ok(app.text.includes(title))
    assert.ok(app.tree.props.className.includes('hc-mobile-debug__content'))
    app.emit('实时日志')
    assert.ok(app.text.includes('实时日志'))
    app.resolve([])
    await app.settle()
    app.unmount()
    const renders = app.renders
    app.lateEvent()
    assert.equal(app.renders, renders)
    assert.equal(app.unsubscribes, 1)
  }
})

await test('默认独立日志组件仍消费公开 URL 语言并更新 title/lang', () => {
  const app = logComponentFixture({ language: 'zh-TW', search: '?lang=en' })
  assert.equal(app.document.title, 'Launcher logs')
  assert.equal(app.document.documentElement.lang, 'en')
  assert.equal(app.tree.props.className, 'flex h-full flex-col')
  app.unmount()
})

await test('真实 embedded 日志卸载后历史完成和排队事件均不能更新', async () => {
  const app = logComponentFixture({ embedded: true })
  app.unmount()
  const renders = app.renders
  app.lateEvent()
  app.resolve([{ ts: 1, level: 'info', message: 'late history' }])
  await app.settle()
  assert.equal(app.renders, renders)
  assert.equal(app.unsubscribes, 1)
})

// 用实际本地控制器连上真实转译宿主，避免只分别验证两套协议替身。
function realController() {
  const path = 'src/tauri/mobile-debug.ts'
  const compiled = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  })
  const module = { exports: {} }
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, setTimeout, clearTimeout }, { filename: path })
  return module.exports.createTauriMobileDebugController()
}

await test('真实控制器→宿主：仅提交后完成打开，返回后撤页并可再次打开', async () => {
  const controller = realController()
  const app = fixture({ controller })
  try {
    let opened = false
    const opening = controller.open().then(() => { opened = true })
    await Promise.resolve()
    assert.equal(opened, false)
    app.flush()
    await opening
    assert.equal(controller.visible(), true)
    assert.equal(app.dialog.open, true)
    app.back()
    assert.equal(controller.visible(), false)
    app.flush()
    await app.settle()
    assert.equal(app.dialog, null)
    assert.equal(app.priorFocus.focusCalls, 1)
    const next = controller.open()
    app.flush()
    await next
    assert.equal(controller.visible(), true)
  } finally { app.unmount(); controller.dispose() }
})

await test('真实控制器→宿主：同批开关不残留dialog，卸载拒绝未提交打开', async () => {
  const controller = realController()
  const app = fixture({ controller })
  try {
    const opening = controller.open()
    const rejected = assert.rejects(opening, /did not complete/)
    const closing = controller.close()
    app.flush()
    await Promise.all([rejected, closing])
    assert.equal(app.dialog, null)
    assert.equal(controller.visible(), false)
    const pending = controller.open()
    const detached = assert.rejects(pending, /did not complete/)
    app.unmount()
    await detached
    assert.equal(controller.visible(), false)
    await assert.rejects(controller.open(), /not mounted/)
  } finally { app.unmount(); controller.dispose() }
})

console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1