/**
 * Tauri AI HUD 的离线回归：转译真实 TSX 与 main 入口，仅模拟 Hooks/DOM 提交。
 * 不复制状态投影，不执行桥接/网络/录音；不替代真实 React/Webview、透明窗与游戏验证。
 * 运行：node scripts/test-tauri-ai-hud.mjs
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
const paths = {
  hud: 'src/renderer/src/components/TauriAiHud.tsx',
  host: 'src/renderer/src/components/TauriAiHudHost.tsx',
  main: 'src/renderer/src/main.tsx',
  forwarding: 'src/renderer/src/log-forwarding.ts'
}
const sources = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')]))
const compiled = Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, ts.transpileModule(source, {
  fileName: paths[key], reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }
})]))
const childrenOf = (node) => [node?.props?.children].flat(Infinity).filter((item) => item !== null && item !== undefined && typeof item !== 'boolean')
function walk(node, predicate) {
  if (Array.isArray(node)) return node.flatMap((item) => walk(item, predicate))
  if (!node || typeof node !== 'object') return []
  return [...(predicate(node) ? [node] : []), ...childrenOf(node).flatMap((item) => walk(item, predicate))]
}
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return String(node)
  return childrenOf(node).map(textOf).join('')
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const hudState = (patch = {}) => ({ enabled: true, active: true, opacity: 0.8, status: 'idle', text: 'Assistant reply', lastUser: 'User question', ...patch })
const sameDeps = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
const jsx = (type, props, key) => ({ type, props: props ?? {}, key })

function fixture({ host = false, embedded = false, tauri = true, platform = 'win32', language = 'en', languages = ['en-US'], nativeLocale, search = '?window=ai-hud', classes = [], synchronous, subscribeThrows = false, snapshotThrows = false, offThrows = false } = {}) {
  const bodyClasses = new Set(classes)
  const document = { documentElement: { lang: language }, title: 'Launcher title', body: { classList: {
    contains: (name) => bodyClasses.has(name), add: (name) => bodyClasses.add(name), remove: (name) => bodyClasses.delete(name)
  } } }
  const requests = []
  const retained = []
  const active = new Set()
  const order = []
  const records = new Map()
  let dispatcher, dirty = true, mounted = true, tree, setters = 0, lateSetters = 0, offCount = 0, renders = 0
  let layouts = [], effects = []
  const slotAt = () => {
    assert.ok(dispatcher, 'Hooks 必须在真实组件渲染中调用')
    const index = dispatcher.cursor++
    return dispatcher.slots[index] ?? (dispatcher.slots[index] = {})
  }
  function effect(kind, callback, deps) {
    const slot = slotAt()
    slot.kind = kind
    slot.create = callback
    if (sameDeps(slot.deps, deps)) return
    slot.deps = deps
    ;(kind === 'layout' ? layouts : effects).push(() => { slot.cleanup?.(); slot.cleanup = callback() })
  }
  const hooks = {
    useState(initial) {
      const slot = slotAt()
      if (!slot.initialized) { slot.initialized = true; slot.value = typeof initial === 'function' ? initial() : initial; slot.queue = [] }
      for (const update of slot.queue.splice(0)) slot.value = typeof update === 'function' ? update(slot.value) : update
      if (!slot.setter) slot.setter = (update) => {
        setters++
        if (!mounted) { lateSetters++; return }
        slot.queue.push(update)
        dirty = true
      }
      return [slot.value, slot.setter]
    },
    useEffect: (callback, deps) => effect('passive', callback, deps),
    useLayoutEffect: (callback, deps) => effect('layout', callback, deps)
  }
  const ai = new Proxy({
    onHudState(callback) {
      order.push('subscribe')
      if (subscribeThrows) throw new Error('private subscribe error')
      active.add(callback); retained.push(callback)
      if (synchronous !== undefined) callback(synchronous)
      return () => { offCount++; active.delete(callback); if (offThrows) throw new Error('private off error') }
    },
    hudState(...args) {
      order.push('snapshot'); assert.equal(args.length, 0, 'hudState 必须无参')
      if (snapshotThrows) throw new Error('private snapshot error')
      const request = deferred(); requests.push(request); return request.promise
    }
  }, { get(target, name) { assert.ok(name in target, `不得访问 AI 业务方法 ${String(name)}`); return target[name] } })
  const api = new Proxy({ ai, platform }, { get(target, name) { assert.ok(name in target, `只读卡片不得访问 ${String(name)}`); return target[name] } })
  const window = { api, location: { search }, __HC_AI_HUD_LOCALE__: nativeLocale }
  if (tauri) window.__TAURI_INTERNALS__ = {}
  const cache = new Map()
  function load(key) {
    if (cache.has(key)) return cache.get(key)
    const module = { exports: {} }; cache.set(key, module.exports)
    vm.runInNewContext(compiled[key].outputText, {
      module, exports: module.exports, document, window, URLSearchParams,
      navigator: { languages, language: languages[0] ?? '', mediaDevices: new Proxy({}, { get() { throw new Error('不得访问麦克风') } }) },
      require(name) {
        if (name === 'react') return hooks
        if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
        if (key === 'host' && name === './TauriAiHud') return load('hud')
        throw new Error(`未声明的消费者依赖 ${name}`)
      }
    }, { filename: paths[key] })
    return module.exports
  }
  const Component = host ? load('host').TauriAiHudHost : load('hud').TauriAiHud
  function render(node, path) {
    if (Array.isArray(node)) return node.map((item, index) => render(item, `${path}.${index}`))
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      let record = records.get(path)
      if (!record) { record = { slots: [], cursor: 0 }; records.set(path, record) }
      record.cursor = 0
      const previous = dispatcher; dispatcher = record
      let result
      try { result = node.type(node.props) } finally { dispatcher = previous }
      return render(result, `${path}.child`)
    }
    return { ...node, props: { ...node.props, children: render(node.props.children, `${path}.children`) } }
  }
  function flush() {
    let rounds = 0
    while (mounted && dirty) {
      assert.ok(++rounds <= 30, '组件不能无限刷新')
      dirty = false; layouts = []; effects = []
      tree = render(jsx(Component, host ? {} : { embedded }), 'root'); renders++
      for (const callback of layouts) callback()
      for (const callback of effects) callback()
    }
  }
  flush()
  return {
    document, classes: bodyClasses, order, requests, retained,
    get tree() { return tree }, get text() { return textOf(tree) },
    get activeSubscriptions() { return active.size }, get unsubscribes() { return offCount },
    get setters() { return setters }, get lateSetters() { return lateSetters }, get renders() { return renders },
    emit(value, commit = true) { for (const callback of [...active]) callback(value); if (commit) flush() },
    late(value) { for (const callback of retained) callback(value) },
    flush,
    async settle() { await new Promise((resolve) => setImmediate(resolve)); flush() },
    replayEffects() {
      const slots = [...records.values()].flatMap((record) => record.slots).filter((slot) => slot.kind)
      for (const slot of slots) slot.cleanup?.()
      for (const slot of slots) slot.cleanup = slot.create()
      flush()
    },
    unmount() {
      if (!mounted) return
      mounted = false
      for (const record of records.values()) for (const slot of record.slots) slot.cleanup?.()
    }
  }
}

// 执行真实 main.tsx 的动态导入路由；只替换模块宿主，不另写入口选择算法。
async function entryFixture({ tauri = true, platform = 'win32', search = '?window=ai-hud' } = {}) {
  const imports = [], eventNames = [], reports = [], renders = [], errors = []
  const container = { textContent: '' }
  const ready = deferred()
  const marker = (name) => Object.assign(function Marker() {}, { displayName: name })
  const components = Object.fromEntries(['App', 'TauriAiHud', 'TauriAiHudDesktop', 'TauriAiHudHost', 'TauriMobileDebugHost', 'GameHud', 'DebugLogWindow', 'DevToolsWindow', 'DanmakuOverlay', 'AiBall'].map((name) => [name, marker(name)]))
  const strict = Symbol('StrictMode')
  const react = { StrictMode: strict }
  const readonlyPage = tauri && ['win32', 'darwin', 'linux'].includes(platform) && search.includes('window=ai-hud')
  const api = { platform }
  Object.defineProperty(api, 'debug', { get() {
    if (readonlyPage) throw new Error('只读ai-hud入口不得访问debug API')
    return { reportLog: (...args) => { reports.push(args) } }
  } })
  const window = { location: { search }, addEventListener(name) { eventNames.push(name) } }
  if (tauri) window.__TAURI_INTERNALS__ = {}
  else window.api = api
  const document = { getElementById(name) { assert.equal(name, 'root'); return container } }
  const testConsole = { warn() {}, error(...args) { errors.push(args) }, info() {} }
  // 日志 helper 与入口共用 window/console 和 realm，实际执行旁路安装而不复制实现。
  const context = vm.createContext({ window, document, URLSearchParams, console: testConsole })
  const cache = new Map()
  function load(key) {
    if (cache.has(key)) return cache.get(key).exports
    assert.ok(Object.hasOwn(compiled, key), `未声明的真实入口模块 ${key}`)
    const module = vm.runInContext('({ exports: {} })', context)
    cache.set(key, module)
    const require = (name) => {
      imports.push(name)
      if (key === 'main' && name === './log-forwarding') return load('forwarding')
      assert.equal(key, 'main', `未声明的日志 helper 依赖 ${name}`)
      if (name === 'react') return { __esModule: true, default: react }
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === 'react-dom/client') return { __esModule: true, default: { createRoot(node) { assert.equal(node, container); return { render(tree) { renders.push(tree) } } } } }
      if (name === './index.css') return {}
      if (name === '../../tauri/bridge') return { installTauriApi() { window.api = api; return { ready: ready.promise } } }
      if (name === './App') return { __esModule: true, default: components.App }
      if (name.startsWith('./components/')) {
        const component = name.slice('./components/'.length)
        assert.ok(component in components, `未声明的入口组件 ${component}`)
        return { [component]: components[component] }
      }
      throw new Error(`未声明的入口依赖 ${name}`)
    }
    const execute = new vm.Script(`(function(require, module, exports) {\n${compiled[key].outputText}\n})`, { filename: paths[key] }).runInContext(context)
    execute(require, module, module.exports)
    return module.exports
  }
  load('main')
  await new Promise((resolve) => setImmediate(resolve))
  if (tauri) { assert.equal(renders.length, 0, 'bridge ready之前不得挂载'); ready.resolve() }
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(container.textContent, '', '入口不得落入初始化错误')
  assert.equal(errors.length, 0, '入口不得有未捕获初始化错误')
  const renderedNames = () => walk(renders.at(-1), (node) => typeof node.type === 'function').map((node) => node.type.displayName)
  return { imports, renders, reports, eventNames, renderedNames, warn: () => testConsole.warn('fixture warning'), strict }
}

await test('实际三个TSX文件语法诊断无错误', () => {
  for (const [key, output] of Object.entries(compiled)) {
    const errors = (output.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error)
    assert.equal(errors.length, 0, `${paths[key]}: ${errors.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('; ')}`)
  }
})
for (const [language, labels] of Object.entries({
  'zh-CN': ['AI 助手', '待命', '思考中', '播报中', '聆听中', '等待下一条助手回复。'],
  'zh-TW': ['AI 助手', '待命', '思考中', '播報中', '聆聽中', '等待下一則助手回覆。'],
  en: ['AI assistant', 'Ready', 'Thinking', 'Speaking', 'Listening', 'Waiting for the next assistant reply.']
})) {
  await test(`只读卡片${language}四状态、空回复和无交互元素`, () => {
    const app = fixture({ language })
    for (const [index, status] of ['idle', 'thinking', 'speaking', 'listening'].entries()) {
      app.emit(hudState({ status, text: '', lastUser: '' }))
      assert.ok(app.text.includes(labels[0]) && app.text.includes(labels[index + 1]) && app.text.includes(labels[5]))
      assert.equal(app.tree.props['data-status'], status)
    }
    assert.equal(walk(app.tree, (node) => ['button', 'input', 'textarea', 'a', 'dialog'].includes(node.type) || node.props.tabIndex !== undefined || node.props.autoFocus).length, 0)
    assert.equal(app.document.title, 'Launcher title'); assert.equal(app.document.documentElement.lang, language)
    app.unmount()
  })
}
await test('文档语言优先、navigator后备，不消费URL语言或修改全局语言', () => {
  for (const [language, languages, expected] of [['zh-Hant-HK', ['en'], '播報中'], ['', ['fr-FR', 'en-US'], 'Speaking'], ['fr', ['zh_CN'], '播报中']]) {
    const app = fixture({ language, languages, search: '?window=ai-hud&lang=zh-CN' })
    app.emit(hudState({ status: 'speaking' })); assert.ok(app.text.includes(expected))
    assert.equal(app.document.documentElement.lang, language); app.unmount()
  }
})
await test('原生语言脚本可在根元素创建之前执行，解析后独立页使用该语言', () => {
  const source = readFileSync(new URL('../src-tauri/src/ai_hud_window.rs', import.meta.url), 'utf8')
  const pattern = /format!\("([^"\\]*(?:\\.[^"\\]*)*)",\s*serde_json::to_string\(&language\)\.map_err\(\|_\|\s*unavailable\(\)\)\?\)/g
  const templates = [...source.matchAll(pattern)].map((match) => JSON.parse(`"${match[1]}"`))
  const template = templates.find((value) => value.includes('__HC_AI_HUD_LOCALE__'))
  assert.equal(template, 'window.__HC_AI_HUD_LOCALE__ = {};')
  for (const [language, expected] of [['zh-CN', '播报中'], ['zh-TW', '播報中'], ['en', 'Speaking']]) {
    const context = { window: {}, document: { documentElement: null } }
    // 受限的三种 ASCII 语言在 JSON.stringify 与 serde_json 中序列化一致。
    vm.runInNewContext(template.replace('{}', JSON.stringify(language)), context)
    assert.equal(context.document.documentElement, null)
    assert.equal(context.window.__HC_AI_HUD_LOCALE__, language)
    const app = fixture({ language: 'zh-CN', nativeLocale: context.window.__HC_AI_HUD_LOCALE__ })
    app.emit(hudState({ status: 'speaking' })); assert.ok(app.text.includes(expected)); app.unmount()
  }
})
await test('共享 HUD 透明窗口禁用系统阴影，避免圆角外出现投影', () => {
  const source = readFileSync(new URL('../src-tauri/src/ai_hud_window.rs', import.meta.url), 'utf8')
  assert.equal(source.match(/\.shadow\(false\)/gu)?.length ?? 0, 1)
  assert.match(source, /\.decorations\(false\)\.transparent\(true\)[\s\S]*?\.shadow\(false\)/u)
})
await test('独立窗口只接受原生三语注入，内嵌卡片保留文档语言', () => {
  for (const [nativeLocale, expected] of [['zh-CN', '播报中'], ['zh-TW', '播報中'], ['en', 'Speaking']]) {
    const app = fixture({ language: 'zh-CN', nativeLocale })
    app.emit(hudState({ status: 'speaking' })); assert.ok(app.text.includes(expected)); app.unmount()
  }
  for (const options of [
    { nativeLocale: 'en-US' }, { nativeLocale: { toString: () => 'en' } },
    { nativeLocale: 'en', embedded: true }, { nativeLocale: 'en', tauri: false },
    { nativeLocale: 'en', platform: 'android' }, { nativeLocale: 'en', search: '?window=other' }
  ]) {
    const app = fixture({ language: 'zh-TW', ...options })
    app.emit(hudState({ status: 'speaking' })); assert.ok(app.text.includes('播報中')); app.unmount()
  }
})
await test('先订阅再无参快照，同步事件不能被旧快照覆盖', async () => {
  const app = fixture({ synchronous: hudState({ text: 'Synchronous event' }) })
  assert.deepEqual(app.order, ['subscribe', 'snapshot']); assert.ok(app.text.includes('Synchronous event'))
  app.requests[0].resolve(hudState({ text: 'Old snapshot' })); await app.settle()
  assert.ok(app.text.includes('Synchronous event')); assert.ok(!app.text.includes('Old snapshot')); app.unmount()
})
await test('等待中的实时状态及未提交event都优先于late snapshot', async () => {
  const app = fixture()
  app.emit(hudState({ text: 'Latest live' }), false)
  app.requests[0].resolve(hudState({ text: 'Late snapshot' })); await app.settle()
  assert.ok(app.text.includes('Latest live')); assert.ok(!app.text.includes('Late snapshot')); app.unmount()
})
await test('无event时快照显示且之后live更新；即使坏事件先到也不回滚到旧快照', async () => {
  const app = fixture()
  app.emit({ ...hudState(), opacity: NaN })
  app.requests[0].resolve(hudState({ text: 'Stale snapshot' })); await app.settle()
  assert.equal(app.tree, null)
  app.emit(hudState({ text: 'Then live' })); assert.ok(app.text.includes('Then live')); app.unmount()
})
await test('snapshot拒绝或同步抛错后仍接受live且不回显底层错误', async () => {
  for (const snapshotThrows of [false, true]) {
    const app = fixture({ snapshotThrows })
    if (!snapshotThrows) app.requests[0].reject(new Error('private snapshot token'))
    await app.settle(); app.emit(hudState({ text: 'Recovered live' }))
    assert.ok(app.text.includes('Recovered live')); assert.ok(!app.text.includes('private')); app.unmount()
  }
})
await test('live先到再snapshot拒绝不能清空当前状态', async () => {
  const app = fixture(); app.emit(hudState({ text: 'Still here' }))
  app.requests[0].reject(new Error('private')); await app.settle()
  assert.ok(app.text.includes('Still here')); app.unmount()
})
await test('enabled独立决定隐藏，settings事件更新opacity且active不伪造显示', async () => {
  const app = fixture(); app.emit(hudState({ enabled: false, active: true })); assert.equal(app.tree, null)
  app.requests[0].resolve(hudState()); await app.settle(); assert.equal(app.tree, null)
  app.emit(hudState({ enabled: true, active: false, opacity: 0.25 })); assert.equal(app.tree.props.style.opacity, 0.25)
  app.emit(hudState({ enabled: false, active: false })); assert.equal(app.tree, null); app.unmount()
})
await test('坏类型/非finite/超长载荷拒绝；额外字段不投影到DOM', () => {
  const app = fixture(); app.emit(hudState({ text: 'Validated' }))
  const invalid = [null, [], 'wrong', {}, { enabled: 1 }, { active: 'true' }, { status: 'unknown' }, { text: 12 }, { lastUser: false }, { opacity: '0.8' }, { opacity: NaN }, { opacity: Infinity }, { text: 'x'.repeat(65_537) }, { lastUser: 'y'.repeat(65_537) }]
  for (const bad of invalid) {
    const payload = bad && !Array.isArray(bad) && typeof bad === 'object' && Object.keys(bad).length ? hudState(bad) : bad
    app.emit(payload); assert.ok(app.text.includes('Validated'))
  }
  app.emit({ ...hudState({ text: 'Projected' }), token: 'must-not-render', settings: { private: true } })
  assert.ok(app.text.includes('Projected')); assert.ok(!JSON.stringify(app.tree).includes('must-not-render')); app.unmount()
})
await test('合法长回复可接收，180/700字符展示截断保留UTF8且HTML仅文本', () => {
  const app = fixture(); const html = '<img src=x onerror=alert(1)> & <script>bad</script>'
  app.emit(hudState({ text: html, lastUser: '字😀' })); assert.ok(app.text.includes(html))
  assert.equal(walk(app.tree, (node) => node.props.dangerouslySetInnerHTML !== undefined || node.type === 'img' || node.type === 'script').length, 0)
  app.emit(hudState({ text: '😀'.repeat(16_000), lastUser: '字'.repeat(65_536) }))
  const reply = walk(app.tree, (node) => node.props.className === 'hc-tauri-ai-hud__reply')[0]
  const user = walk(app.tree, (node) => node.props.className === 'hc-tauri-ai-hud__user')[0]
  assert.equal(Array.from(textOf(reply)).length, 701); assert.ok(textOf(reply).endsWith('…'))
  assert.equal(Array.from(textOf(user)).length, 186); assert.ok(textOf(user).endsWith('…'))
  app.emit(hudState({ opacity: -4 })); assert.equal(app.tree.props.style.opacity, 0)
  app.emit(hudState({ opacity: 4 })); assert.equal(app.tree.props.style.opacity, 1); app.unmount()
})
await test('卸载off一次，late event与snapshot完成/拒绝不能调用setState', async () => {
  for (const reject of [false, true]) {
    const app = fixture(); app.unmount(); const count = app.setters
    app.late(hudState({ text: 'late' }))
    if (reject) app.requests[0].reject(new Error('late private'))
    else app.requests[0].resolve(hudState({ text: 'late snapshot' }))
    await app.settle(); assert.equal(app.setters, count); assert.equal(app.lateSetters, 0)
    assert.equal(app.unsubscribes, 1); assert.equal(app.activeSubscriptions, 0)
  }
})
await test('StrictMode式effect重放隔离旧请求与监听器，cleanup异常不复活', async () => {
  const app = fixture({ offThrows: true }); app.replayEffects()
  assert.equal(app.unsubscribes, 1); assert.equal(app.activeSubscriptions, 1); assert.equal(app.requests.length, 2)
  app.retained[0](hudState({ text: 'Old listener' })); app.requests[0].resolve(hudState({ text: 'Old setup' }))
  app.requests[1].resolve(hudState({ text: 'Current setup' })); await app.settle()
  assert.ok(app.text.includes('Current setup')); assert.ok(!app.text.includes('Old setup')); app.unmount()
  assert.equal(app.unsubscribes, 2); assert.equal(app.activeSubscriptions, 0)
})
await test('订阅失败仍可安全显示有效快照，无业务API回退', async () => {
  const app = fixture({ subscribeThrows: true }); app.requests[0].resolve(hudState({ text: 'Snapshot only' })); await app.settle()
  assert.ok(app.text.includes('Snapshot only')); assert.equal(app.activeSubscriptions, 0); app.unmount()
})
await test('真实mobile Host仅包含一个embedded消费者，Android/iOS不改body或全局语言', () => {
  for (const platform of ['android', 'ios']) {
    const app = fixture({ host: true, platform, language: 'zh-TW', search: '' })
    assert.deepEqual(app.order, ['subscribe', 'snapshot']); assert.equal(app.activeSubscriptions, 1)
    app.emit(hudState()); assert.ok(app.tree.props.className.includes('--embedded')); assert.ok(app.text.includes('僅在啟動器內顯示'))
    assert.equal(app.classes.size, 0); assert.equal(app.document.title, 'Launcher title'); app.unmount(); assert.equal(app.unsubscribes, 1)
  }
  for (const options of [{ tauri: false, platform: 'android' }, { platform: 'win32' }]) {
    const app = fixture({ host: true, ...options }); assert.equal(app.tree, null); assert.deepEqual(app.order, []); app.unmount()
  }
})
await test('透明body class仅独立Tauri ai-hud挂载期间拥有，保留原有类', () => {
  const app = fixture({ classes: ['existing'] }); assert.ok(app.classes.has('hc-tauri-ai-hud--page'))
  app.unmount(); assert.deepEqual([...app.classes], ['existing'])
  const prior = fixture({ classes: ['hc-tauri-ai-hud--page'] }); prior.unmount(); assert.ok(prior.classes.has('hc-tauri-ai-hud--page'))
  for (const options of [{ embedded: true }, { tauri: false }, { search: '?window=hud' }]) {
    const other = fixture(options); assert.equal(other.classes.size, 0); other.unmount()
  }
})
await test('实际main仅Windows独立HUD加载语音包装，卡片与其它平台保持只读且不装主业务日志旁路', async () => {
  for (const [platform, expected] of [['win32', 'TauriAiHudDesktop'], ['linux', 'TauriAiHud'], ['darwin', 'TauriAiHud']]) {
    const app = await entryFixture({ platform }); assert.deepEqual(app.renderedNames(), [expected])
    assert.ok(!app.imports.includes('./App') && !app.imports.includes('./components/GameHud'))
    assert.equal(app.eventNames.length, 0); app.warn(); assert.equal(app.reports.length, 0)
  }
})
await test('实际main移动主树旁挂单个AI宿主，桌面主树和Electron不挂', async () => {
  for (const platform of ['android', 'ios']) {
    for (const search of ['', '?window=ai-hud']) {
      const app = await entryFixture({ platform, search })
      assert.deepEqual(app.renderedNames(), ['App', 'TauriMobileDebugHost', 'TauriAiHudHost'])
      assert.equal(app.renderedNames().filter((name) => name === 'TauriAiHudHost').length, 1)
      app.warn(); assert.equal(app.reports.length, 1)
    }
  }
  for (const options of [{ platform: 'win32' }, { tauri: false, platform: 'android' }]) {
    const app = await entryFixture({ search: '', ...options }); assert.deepEqual(app.renderedNames(), ['App'])
  }
})
await test('实际Electron原hud/GameHud入口与日志旁路保持，不加载Tauri卡片', async () => {
  const app = await entryFixture({ tauri: false, search: '?window=hud' })
  assert.deepEqual(app.renderedNames(), ['GameHud']); assert.ok(!app.imports.includes('./components/TauriAiHud'))
  assert.ok(app.eventNames.includes('error')); app.warn(); assert.equal(app.reports.length, 1)
})
await test('新增CSS严格HUD命名空间、透明页限定、安全区、小屏与无动效/穿透', () => {
  const css = readFileSync(new URL('../src/renderer/src/index.css', import.meta.url), 'utf8')
  const start = css.indexOf('/* Tauri 专用 AI HUD：')
  assert.ok(start >= 0); const tail = css.slice(start)
  for (const line of tail.split(/\r?\n/).filter((value) => value.includes('{') && !value.trim().startsWith('@') && !value.trim().startsWith('/*'))) assert.ok(line.includes('.hc-tauri-ai-hud'), `越界CSS选择器：${line}`)
  assert.match(tail, /body\.hc-tauri-ai-hud--page/); assert.match(tail, /background: transparent !important/)
  assert.match(tail, /pointer-events: none/); assert.match(tail, /safe-area-inset-(?:top|bottom|left|right)/)
  assert.match(tail, /max-width: 480px/); assert.match(tail, /overflow: hidden/)
  assert.match(tail, /animation: none !important/); assert.match(tail, /transition: none !important/); assert.doesNotMatch(tail, /@keyframes|animation:\s*(?!none)\w+/)
})

console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1
