/**
 * 真实日志组件的离线回归：转译生产 TSX，仅模拟 Hooks 调度与列表几何。
 * 不复制 mergeSnapshot、不加载 Electron/Tauri、不访问网络或启动浏览器。
 * 运行：node scripts/test-debug-log-window.mjs
 * 边界：不替代真实 React/浏览器的布局、滚动锚定与事件时序验证。
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
function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const entry = (message, ts = 1730000000000, level = 'info') => ({ ts, level, message })
const batch = (count, prefix = 'log') => Array.from({ length: count }, (_, index) => entry(`${prefix}-${index}`, 1730000000000 + index))
const childrenOf = (node) => [node?.props?.children].flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true)
function walk(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((child) => walk(child, predicate))
  return [...(predicate(node) ? [node] : []), ...childrenOf(node).flatMap((child) => walk(child, predicate))]
}
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node !== 'object') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return childrenOf(node).map(textOf).join('')
}

const sourcePath = 'src/renderer/src/components/DebugLogWindow.tsx'
const source = readFileSync(new URL(`../${sourcePath}`, import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  fileName: sourcePath,
  reportDiagnostics: true,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX
  }
})
const syntaxErrors = (compiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)

function fixture({ language = 'en', documentLanguage = '', browserLanguage = 'en-US', subscribeError = false, synchronous = [] } = {}) {
  const history = deferred()
  const order = []
  const slots = []
  let cursor = 0
  let dirty = true
  let mounted = true
  let tree
  let listNode
  let activeListener
  let retainedListener
  let unsubscribeCount = 0
  let setterCalls = 0
  let lateSetterCalls = 0
  let renderCount = 0
  let pendingLayout = []
  let pendingPassive = []
  const document = { documentElement: { lang: documentLanguage }, title: '' }
  const list = {
    clientHeight: 120,
    scrollHeight: 120,
    position: 0,
    writes: 0,
    get scrollTop() { return this.position },
    set scrollTop(value) {
      this.writes++
      this.position = Math.max(0, Math.min(Number(value), this.scrollHeight - this.clientHeight))
    }
  }
  const sameDeps = (left, right) => left !== undefined && right !== undefined && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  function useState(initial) {
    const index = cursor++
    if (!slots[index]) {
      const slot = { kind: 'state', value: typeof initial === 'function' ? initial() : initial, queue: [] }
      slot.set = (update) => {
        setterCalls++
        if (!mounted) { lateSetterCalls++; return }
        slot.queue.push(update)
        dirty = true
      }
      slots[index] = slot
    }
    const slot = slots[index]
    assert.equal(slot.kind, 'state')
    return [slot.value, slot.set]
  }
  function useRef(initial) {
    const index = cursor++
    if (!slots[index]) slots[index] = { kind: 'ref', value: { current: initial } }
    assert.equal(slots[index].kind, 'ref')
    return slots[index].value
  }
  function effect(kind, callback, dependencies) {
    const index = cursor++
    if (!slots[index]) slots[index] = { kind, dependencies: undefined, cleanup: undefined }
    const slot = slots[index]
    assert.equal(slot.kind, kind)
    if (sameDeps(slot.dependencies, dependencies)) return
    const run = () => {
      slot.cleanup?.()
      slot.dependencies = dependencies
      slot.cleanup = callback()
    }
    ;(kind === 'layout' ? pendingLayout : pendingPassive).push(run)
  }
  const hooks = {
    useState, useRef,
    useEffect: (callback, dependencies) => effect('passive', callback, dependencies),
    useLayoutEffect: (callback, dependencies) => effect('layout', callback, dependencies)
  }
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key })
  const modules = {
    react: hooks,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }
  }
  const module = { exports: {} }
  const window = {
    location: { search: language === null ? '' : `?lang=${encodeURIComponent(language)}` },
    api: {
      debug: {
        onLog(callback) {
          order.push('subscribe')
          if (subscribeError) throw new Error('private fixture subscription detail')
          activeListener = retainedListener = callback
          for (const item of synchronous) callback(item)
          return () => { unsubscribeCount++; activeListener = undefined }
        },
        getLogs() { order.push('snapshot'); return history.promise }
      }
    }
  }
  vm.runInNewContext(compiled.outputText, {
    module, exports: module.exports, window, document,
    navigator: { languages: [browserLanguage], language: browserLanguage },
    URLSearchParams, console,
    require(key) {
      if (!Object.hasOwn(modules, key)) throw new Error(`未声明的组件测试依赖：${key}`)
      return modules[key]
    }
  }, { filename: sourcePath })
  const Component = module.exports.DebugLogWindow
  assert.equal(typeof Component, 'function')
  function flush() {
    let passes = 0
    while (dirty && mounted) {
      assert.ok(++passes <= 20, '组件产生未收敛的重渲染')
      for (const slot of slots) {
        if (slot.kind !== 'state') continue
        for (const update of slot.queue.splice(0)) slot.value = typeof update === 'function' ? update(slot.value) : update
      }
      dirty = false
      cursor = 0
      pendingLayout = []
      pendingPassive = []
      tree = Component()
      renderCount++
      const lists = walk(tree, (node) => node.type === 'div' && node.props.ref && typeof node.props.onScroll === 'function')
      assert.equal(lists.length, 1, '真实组件需要一个可观察的日志滚动容器')
      listNode = lists[0]
      listNode.props.ref.current = list
      // 只模拟 DOM 提交后的几何变化，不在此实现组件的跟随判断。
      const rows = childrenOf(listNode).filter((node) => node?.props?.className === 'whitespace-pre-wrap break-all')
      list.scrollHeight = Math.max(list.clientHeight, rows.length * 24 + 24)
      list.position = Math.min(list.position, list.scrollHeight - list.clientHeight)
      for (const run of pendingLayout) run()
      for (const run of pendingPassive) run()
    }
  }
  flush()
  const current = {
    document, list, order,
    flush,
    emit(item) { activeListener?.(item) },
    lateEvent(item) { retainedListener?.(item) },
    resolve(items) { history.resolve(items) },
    reject() { history.reject(new Error('private fixture history detail')) },
    async settle() {
      // 跨 VM 的 await 会先同化宿主 Promise；固定两次微任务不足以等到续体。
      // 让本轮所有 Promise 工作完成后再提交一次模拟渲染，不引入计时休眠。
      await new Promise((resolve) => setImmediate(resolve))
      flush()
    },
    click(index) {
      const buttons = walk(tree, (node) => node.type === 'button')
      assert.equal(buttons.length, 2)
      buttons[index].props.onClick()
      flush()
    },
    scrollTo(value) {
      list.scrollTop = value
      listNode.props.onScroll({ currentTarget: list })
    },
    unmount() {
      if (!mounted) return
      mounted = false
      for (const slot of slots) if (slot.kind === 'layout' || slot.kind === 'passive') slot.cleanup?.()
      if (listNode) listNode.props.ref.current = null
    },
    get messages() {
      return childrenOf(listNode)
        .filter((node) => node?.props?.className === 'whitespace-pre-wrap break-all')
        .map((node) => textOf(childrenOf(node).at(-1)))
    },
    get alerts() { return walk(tree, (node) => node.props?.role === 'alert').map(textOf) },
    get buttons() { return walk(tree, (node) => node.type === 'button').map(textOf) },
    get text() { return textOf(tree) },
    get renderCount() { return renderCount },
    get setterCalls() { return setterCalls },
    get lateSetterCalls() { return lateSetterCalls },
    get unsubscribeCount() { return unsubscribeCount },
    get atBottom() { return list.scrollHeight - list.scrollTop - list.clientHeight === 0 }
  }
  return current
}

await test('生产 TSX 可转译，夹具只加载真实组件和 Hook/JSX 依赖', () => {
  assert.equal(syntaxErrors.length, 0, ts.formatDiagnosticsWithColorAndContext(syntaxErrors, {
    getCanonicalFileName: (name) => name, getCurrentDirectory: () => '.', getNewLine: () => '\n'
  }))
})

for (const [language, title, clear, pause, paused, empty, loadError, subscribeError] of [
  ['zh-CN', '启动器日志', '清空', '暂停滚动', '已暂停', '暂无日志。', '历史日志加载失败，仍会接收新日志。', '实时日志订阅失败。'],
  ['zh-TW', '啟動器日誌', '清空', '暫停捲動', '已暫停', '暫無日誌。', '歷史日誌載入失敗，仍會接收新日誌。', '即時日誌訂閱失敗。'],
  ['en', 'Launcher logs', 'Clear', 'Pause scrolling', 'Paused', 'No logs yet.', 'Log history could not be loaded. New logs will still appear.', 'Live log subscription failed.']
]) {
  await test(`三语文案、固定错误且日志仅为文本：${language}`, async () => {
    const current = fixture({ language, documentLanguage: 'en', browserLanguage: 'en-US' })
    assert.equal(current.document.documentElement.lang, language)
    assert.equal(current.document.title, title)
    assert.deepEqual(current.buttons, [clear, pause])
    assert.ok(current.text.includes(empty))
    current.click(1)
    assert.equal(current.buttons[1], paused)
    current.emit(entry('<img src=x onerror=alert(1)>'))
    current.flush()
    assert.deepEqual(current.messages, ['<img src=x onerror=alert(1)>'])
    current.reject()
    await current.settle()
    assert.deepEqual(current.alerts, [loadError])
    assert.ok(!current.text.includes('private fixture'))
    current.unmount()
    const broken = fixture({ language, subscribeError: true })
    broken.resolve([])
    await broken.settle()
    assert.deepEqual(broken.alerts, [subscribeError])
    broken.unmount()
  })
}

await test('无有效公开语言参数时沿用文档及系统语言回退', () => {
  for (const [language, documentLanguage, browserLanguage, expected] of [
    [null, 'zh-Hant-TW', 'en-US', 'zh-TW'],
    ['invalid', '', 'en-GB', 'en'],
    [null, '', 'zh-CN', 'zh-CN']
  ]) {
    const current = fixture({ language, documentLanguage, browserLanguage })
    assert.equal(current.document.documentElement.lang, expected)
    current.unmount()
  }
})

await test('先订阅后快照；同步事件及等待中的增量即时显示', async () => {
  const first = entry('同步日志')
  const current = fixture({ synchronous: [first] })
  assert.deepEqual(current.order, ['subscribe', 'snapshot'])
  assert.deepEqual(current.messages, ['同步日志'])
  current.emit(entry('后续日志'))
  current.flush()
  assert.deepEqual(current.messages, ['同步日志', '后续日志'])
  current.resolve([entry('历史'), first])
  await current.settle()
  assert.deepEqual(current.messages, ['历史', '同步日志', '后续日志'])
  current.unmount()
})

await test('队列中的旧事件、clear、新事件和迟到快照按顺序收敛', async () => {
  const current = fixture()
  current.emit(entry('清空前尚未提交'))
  current.click(0)
  current.emit(entry('清空后 A'))
  current.emit(entry('清空后 B'))
  current.resolve([entry('不能复活的旧历史'), entry('清空前尚未提交')])
  await current.settle()
  assert.deepEqual(current.messages, ['清空后 A', '清空后 B'])
  assert.equal(current.atBottom, true)
  current.unmount()
})

await test('快照失败不丢实时日志，后续订阅事件仍可显示', async () => {
  const current = fixture()
  current.emit(entry('失败前'))
  current.reject()
  await current.settle()
  current.emit(entry('失败后'))
  current.flush()
  assert.deepEqual(current.messages, ['失败前', '失败后'])
  assert.deepEqual(current.alerts, ['Log history could not be loaded. New logs will still appear.'])
  current.click(0)
  assert.deepEqual(current.messages, [])
  current.emit(entry('清空后继续接收'))
  current.flush()
  assert.deepEqual(current.messages, ['清空后继续接收'])
  current.unmount()
})

for (const completion of ['resolve', 'reject']) {
  await test(`卸载后迟到事件和快照${completion}不写状态，退订仅一次`, async () => {
    const current = fixture()
    current.unmount()
    current.unmount()
    const before = { renders: current.renderCount, setters: current.setterCalls }
    current.lateEvent(entry('已退订但已排队的事件'))
    if (completion === 'resolve') current.resolve([entry('迟到历史')])
    else current.reject()
    await current.settle()
    assert.equal(current.unsubscribeCount, 1)
    assert.equal(current.renderCount, before.renders)
    assert.equal(current.setterCalls, before.setters)
    assert.equal(current.lateSetterCalls, 0)
  })
}

await test('真实组件边界重叠合并不吞两侧内部重复，签名包含时间和级别', async () => {
  const a = entry('A')
  const b = entry('B')
  const c = entry('C')
  const current = fixture()
  for (const item of [b, b, c]) current.emit(item)
  current.resolve([a, a, b, b])
  await current.settle()
  assert.deepEqual(current.messages, ['A', 'A', 'B', 'B', 'C'])
  current.unmount()
  const distinct = fixture()
  distinct.emit(entry('same', 2000, 'warn'))
  distinct.emit(entry('same', 2001, 'warn'))
  distinct.resolve([entry('same', 2000, 'info')])
  await distinct.settle()
  assert.equal(distinct.messages.length, 3)
  distinct.unmount()
})

await test('3000 上限同时覆盖快照、等待中增量及加载完成后的事件', async () => {
  const current = fixture()
  for (const item of batch(3050, 'pending')) current.emit(item)
  current.flush()
  assert.equal(current.messages.length, 3000)
  assert.equal(current.messages[0], 'pending-50')
  current.resolve(batch(3100, 'history'))
  await current.settle()
  assert.equal(current.messages.length, 3000)
  assert.equal(current.messages[0], 'pending-50')
  current.emit(entry('loaded-tail'))
  current.flush()
  assert.equal(current.messages.length, 3000)
  assert.equal(current.messages[0], 'pending-51')
  assert.equal(current.messages.at(-1), 'loaded-tail')
  current.unmount()
  const snapshotOnly = fixture()
  snapshotOnly.resolve(batch(3005, 'only'))
  await snapshotOnly.settle()
  assert.equal(snapshotOnly.messages.length, 3000)
  assert.equal(snapshotOnly.messages[0], 'only-5')
  snapshotOnly.unmount()
})

await test('原来贴底时超过 60px 的批量追加仍在提交后跟随到底', async () => {
  const current = fixture()
  current.resolve(batch(20))
  await current.settle()
  assert.equal(current.atBottom, true)
  const oldHeight = current.list.scrollHeight
  for (const item of batch(80, 'large')) current.emit(item)
  current.flush()
  assert.ok(current.list.scrollHeight - oldHeight > 60)
  assert.equal(current.atBottom, true)
  assert.equal(current.messages.at(-1), 'large-79')
  current.unmount()
})

await test('用户上翻后批量追加不强拉；滚回底部后恢复跟随', async () => {
  const current = fixture()
  current.resolve(batch(40))
  await current.settle()
  current.scrollTo(48)
  const oldTop = current.list.scrollTop
  const writes = current.list.writes
  for (const item of batch(30, 'while-up')) current.emit(item)
  current.flush()
  assert.equal(current.list.scrollTop, oldTop)
  assert.equal(current.list.writes, writes)
  assert.equal(current.atBottom, false)
  current.scrollTo(current.list.scrollHeight)
  current.emit(entry('follow-again'))
  current.flush()
  assert.equal(current.atBottom, true)
  current.unmount()
})

await test('暂停保存位置且不丢日志；恢复明确跳底并持续跟随', async () => {
  const current = fixture()
  current.resolve(batch(30))
  await current.settle()
  current.click(1)
  const pausedTop = current.list.scrollTop
  const writes = current.list.writes
  for (const item of batch(100, 'paused')) current.emit(item)
  current.flush()
  assert.equal(current.messages.length, 130)
  assert.equal(current.list.scrollTop, pausedTop)
  assert.equal(current.list.writes, writes)
  current.scrollTo(24)
  current.click(1)
  assert.equal(current.buttons[1], 'Pause scrolling')
  assert.equal(current.atBottom, true)
  current.emit(entry('after-resume'))
  current.flush()
  assert.equal(current.atBottom, true)
  current.unmount()
})

await test('上翻且暂停时清空会解除暂停，后续大批日志重新跟随', async () => {
  const current = fixture()
  current.resolve(batch(30))
  await current.settle()
  current.scrollTo(24)
  current.click(1)
  current.click(0)
  assert.equal(current.messages.length, 0)
  assert.equal(current.buttons[1], 'Pause scrolling')
  for (const item of batch(40, 'after-clear')) current.emit(item)
  current.flush()
  assert.equal(current.atBottom, true)
  current.unmount()
})

console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1