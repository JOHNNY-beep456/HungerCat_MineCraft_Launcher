/**
 * 日志旁路与 Tauri transport 离线行为回归。
 * 转译真实生产模块；console、事件、原生 Promise 和参数均在同一 VM realm 内构造。
 * fakeWindow 在目标阶段先执行 capture 再执行 bubble，支持 once 与按 capture 匹配移除。
 * 仅使用合成日志和内存夹具，不加载原生能力、不访问网络或真实用户数据。
 * 运行：node scripts/test-tauri-log-forwarding.mjs
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
  forwarding: 'src/renderer/src/log-forwarding.ts',
  transport: 'src/tauri/transport.ts',
  native: 'src/tauri/native-invoke.ts',
  types: 'src/tauri/types.ts'
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
    if (error.category === ts.DiagnosticCategory.Error) {
      syntaxErrors.push(`${fileName}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`)
    }
  }
  compiled.set(key, output.outputText)
}

function fixture() {
  // 不把 Node console 注入被测 realm，避免测试中的替换影响脚本自己的结果输出。
  const context = vm.createContext({ assert, Headers })
  const cache = new Map()
  function load(key) {
    if (cache.has(key)) return cache.get(key).exports
    assert.ok(compiled.has(key), `未声明的真实模块：${key}`)
    const module = vm.runInContext('({ exports: {} })', context)
    cache.set(key, module)
    const require = (name) => {
      if (Object.prototype.hasOwnProperty.call(context.__stubs, name)) return context.__stubs[name]
      const local = { './native-invoke': 'native', './types': 'types' }[name]
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
    run(fn) { return vm.runInContext(`(${fn.toString()})()`, context, { timeout: 2000 }) }
  }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

// 此函数的全部对象、Error、Promise 和回调都在被测模块的 realm 内创建。
function setup() {
  const state = {
    consoleCalls: [], reports: [], errors: [], removals: [], registrations: [], dispatches: [],
    listenCalls: [], listenJobs: [], unlistenCalls: 0, nativeCalls: [], invokeJobs: [],
    listenMode: 'resolve', invokeMode: 'resolve', unlistenMode: 'resolve', tauri: true,
    invokeResult: { fixture: true }, reportOverflow: false, nativeOverflow: false
  }
  const original = {}
  const fakeConsole = {}
  for (const method of ['warn', 'error', 'log', 'info', 'debug']) {
    fakeConsole[method] = original[method] = function (...args) {
      state.consoleCalls.push({ method, args, receiver: this })
    }
  }
  globalThis.console = fakeConsole

  const listeners = []
  const captureOf = (options) => typeof options === 'boolean' ? options : !!options?.capture
  const window = {
    __HC_NATIVE_DOCUMENT__: 'a'.repeat(64),
    addEventListener(type, callback, options) {
      const capture = captureOf(options)
      if (!callback || listeners.some((item) => item.active && item.type === type && item.callback === callback && item.capture === capture)) return
      const item = { type, callback, capture, once: !!(typeof options === 'object' && options?.once), active: true }
      listeners.push(item)
      state.registrations.push(item)
    },
    removeEventListener(type, callback, options) {
      const capture = captureOf(options)
      state.removals.push({ type, callback, capture })
      for (const item of listeners) {
        if (item.type === type && item.callback === callback && item.capture === capture) item.active = false
      }
    },
    listenerCount(type, capture) {
      return listeners.filter((item) => item.active && item.type === type && (capture === undefined || item.capture === capture)).length
    },
    dispatch(type, fields = {}) {
      let immediate = false
      const event = {
        ...fields, type, target: window, currentTarget: window, eventPhase: 2, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true },
        stopImmediatePropagation() { immediate = true }
      }
      // Window 为目标：先执行目标 capture 组，再执行目标非 capture 组，各组保持注册顺序。
      const snapshot = listeners.filter((item) => item.active && item.type === type)
      for (const capture of [true, false]) {
        for (const item of snapshot) {
          if (!item.active || item.capture !== capture) continue
          if (item.once) item.active = false
          state.dispatches.push({ type, capture, callback: item.callback })
          if (typeof item.callback === 'function') item.callback.call(window, event)
          else item.callback.handleEvent(event)
          if (immediate) return event
        }
      }
      return event
    }
  }
  window.top = window
  globalThis.window = window
  function unlisten() {
    state.unlistenCalls++
    if (state.unlistenMode === 'throw') throw new Error('夹具解除监听失败')
    if (state.unlistenMode === 'reject') return Promise.reject(new Error('夹具异步解除监听失败'))
  }
  globalThis.__stubs = {
    '@tauri-apps/api/core': {
      isTauri: () => state.tauri,
      invoke(command, args, options) {
        state.nativeCalls.push({ command, args, options })
        // 若生产回归为异步报告回路，有限夹具会终止回路并使次数断言失败，而非永远挂住 Node。
        if (state.nativeCalls.length > 32) { state.nativeOverflow = true; return Promise.resolve(null) }
        if (state.invokeMode === 'throw') throw new Error('夹具原生同步失败')
        if (state.invokeMode === 'reject') return Promise.reject(new Error('夹具原生拒绝'))
        if (state.invokeMode === 'pending') return new Promise((resolve, reject) => state.invokeJobs.push({ resolve, reject }))
        return Promise.resolve(state.invokeResult)
      }
    },
    '@tauri-apps/api/event': {
      listen(name, callback) {
        state.listenCalls.push({ name, callback })
        if (state.listenMode === 'reject') return Promise.reject(new Error('夹具注册拒绝'))
        if (state.listenMode === 'pending') return new Promise((resolve, reject) => state.listenJobs.push({ resolve, reject }))
        return Promise.resolve(unlisten)
      }
    },
    '@tauri-apps/api/webview': {
      getCurrentWebview() { throw new Error('本夹具不应安装拖放监听器') }
    }
  }
  globalThis.host = {
    state, original, unlisten,
    install(implementation) {
      const dispose = __load('forwarding').installRendererLogForwarding(window, (level, message) => {
        state.reports.push({ level, message })
        if (state.reports.length > 32) { state.reportOverflow = true; return }
        return implementation?.(level, message)
      })
      host.disposeForwarding = dispose
      return dispose
    },
    transport(options = {}) {
      const transport = __load('transport').createTauriTransport(options)
      host.t = transport
      return transport
    },
    onError(failure) { state.errors.push(failure) },
    assertBounded() { assert.equal(state.reportOverflow, false); assert.equal(state.nativeOverflow, false) }
  }
}

const unhandled = []
const onUnhandled = (reason) => unhandled.push(reason)
process.on('unhandledRejection', onUnhandled)

await test('四个真实 TS 模块可转译，加载模块不自动发送或安装监听', () => {
  assert.deepEqual(syntaxErrors, [])
  fixture().run(() => {
    assert.equal(typeof __load('forwarding').installRendererLogForwarding, 'function')
    assert.equal(typeof __load('transport').createTauriTransport, 'function')
    assert.equal(typeof __load('native').nativeInvoke, 'function')
    assert.ok(__load('types').launcherSendChannels.includes('debug:rendererLog'))
    assert.equal(host.state.nativeCalls.length, 0)
    assert.equal(host.state.listenCalls.length, 0)
    assert.equal(host.state.registrations.length, 0)
  })
})
await test('console warn/error 保留原始参数和 receiver，单次调用仅旁路一份', () => {
  fixture().run(() => {
    const untouched = { log: console.log, info: console.info, debug: console.debug }
    host.install()
    const value = { fixture: 7 }
    console.warn('warning', value)
    console.error('failure', 42)
    console.log('ordinary'); console.info('information'); console.debug('details')
    assert.equal(host.state.consoleCalls.length, 5)
    assert.equal(host.state.consoleCalls[0].args[1], value)
    assert.equal(host.state.consoleCalls[0].receiver, console)
    assert.equal(host.state.consoleCalls[1].receiver, console)
    assert.deepEqual(host.state.reports, [
      { level: 'warn', message: 'warning {"fixture":7}' },
      { level: 'error', message: 'failure 42' }
    ])
    for (const [key, fn] of Object.entries(untouched)) assert.equal(console[key], fn)
    host.disposeForwarding(); host.assertBounded()
  })
})
await test('日志格式化处理同 realm Error、循环对象和 undefined 而不改变原始 console 参数', () => {
  fixture().run(() => {
    host.install()
    const error = new Error('合成错误')
    const cyclic = {}; cyclic.self = cyclic
    console.error(error, cyclic, undefined, null)
    assert.equal(host.state.consoleCalls.length, 1)
    assert.equal(host.state.consoleCalls[0].args[0], error)
    assert.equal(host.state.consoleCalls[0].args[1], cyclic)
    assert.equal(host.state.reports.length, 1)
    assert.equal(host.state.reports[0].message, `${error.stack} [object Object] undefined null`)
    host.disposeForwarding()
  })
})
await test('report 同步抛错不外泄、不反向 console，后续日志仍独立发送一次', () => {
  fixture().run(() => {
    host.install(() => { throw new Error('合成旁路失败') })
    assert.doesNotThrow(() => console.warn('first'))
    assert.doesNotThrow(() => console.warn('second'))
    assert.equal(host.state.reports.length, 2)
    assert.deepEqual(host.state.consoleCalls.map((item) => item.method), ['warn', 'warn'])
    host.disposeForwarding(); host.assertBounded()
  })
})
await test('report 内同步写 console 保留输出但不会递归发送', () => {
  fixture().run(() => {
    host.install(() => console.warn('report 内合成日志'))
    console.error('outer')
    assert.equal(host.state.reports.length, 1)
    assert.deepEqual(host.state.consoleCalls.map((item) => item.method), ['error', 'warn'])
    assert.equal(host.state.reports[0].message, 'outer')
    host.disposeForwarding(); host.assertBounded()
  })
})
await test('report 返回 rejected Promise 被吸收，不递归且不阻止后续发送', async () => {
  const f = fixture()
  f.run(() => {
    host.install(() => Promise.reject(new Error('合成异步旁路失败')))
    console.warn('first'); console.error('second')
  })
  await settle()
  f.run(() => {
    assert.equal(host.state.reports.length, 2)
    assert.deepEqual(host.state.consoleCalls.map((item) => item.method), ['warn', 'error'])
    host.disposeForwarding(); host.assertBounded()
  })
})
await test('全局 error 与 rejection 各转发一次，保留默认事件行为', () => {
  fixture().run(() => {
    host.install()
    const error = new Error('合成全局错误')
    const first = window.dispatch('error', { error })
    const fallback = window.dispatch('error', { message: '合成脚本错误', filename: 'fixture.js', lineno: 3, colno: 9 })
    const rejected = window.dispatch('unhandledrejection', { reason: { fixture: 'rejected' } })
    const errorRejected = window.dispatch('unhandledrejection', { reason: error })
    assert.deepEqual(host.state.reports.map((item) => item.level), ['error', 'error', 'error', 'error'])
    assert.deepEqual(host.state.reports.map((item) => item.message), [
      error.stack, '合成脚本错误 (fixture.js:3:9)', '未处理的 Promise 拒绝: {"fixture":"rejected"}', `未处理的 Promise 拒绝: ${error.stack}`
    ])
    for (const event of [first, fallback, rejected, errorRejected]) assert.equal(event.defaultPrevented, false)
    assert.equal(host.state.consoleCalls.length, 0)
    host.disposeForwarding()
  })
})
await test('重复 dispose 幂等，恢复 console 并移除全部全局监听', () => {
  fixture().run(() => {
    const dispose = host.install()
    assert.notEqual(console.warn, host.original.warn)
    assert.equal(window.listenerCount('error'), 1)
    assert.equal(window.listenerCount('unhandledrejection'), 1)
    assert.equal(window.listenerCount('pagehide', true), 1)
    dispose()
    assert.equal(console.warn, host.original.warn)
    assert.equal(console.error, host.original.error)
    for (const type of ['error', 'unhandledrejection', 'pagehide']) assert.equal(window.listenerCount(type), 0)
    assert.deepEqual(host.state.removals.map(({ type, capture }) => [type, capture]), [
      ['error', false], ['unhandledrejection', false], ['pagehide', true]
    ])
    dispose(); window.dispatch('pagehide'); dispose()
    assert.equal(host.state.removals.length, 3)
  })
})
await test('dispose 后 console、旧 wrapper 和 error/rejection 均不再发送', () => {
  fixture().run(() => {
    const dispose = host.install()
    const staleWarn = console.warn
    const staleError = console.error
    console.warn('before')
    dispose()
    console.warn('after'); console.error('after error')
    staleWarn('stale warn'); staleError('stale error')
    window.dispatch('error', { error: new Error('after') })
    window.dispatch('unhandledrejection', { reason: 'after' })
    assert.equal(host.state.reports.length, 1)
    assert.deepEqual(host.state.consoleCalls.map((item) => item.method), ['warn', 'warn', 'error', 'warn', 'error'])
    host.assertBounded()
  })
})
await test('dispose 不覆盖后来安装的其它 console wrapper', () => {
  fixture().run(() => {
    const dispose = host.install()
    const priorWarn = console.warn
    const priorError = console.error
    let otherCalls = 0
    const laterWarn = (...args) => { otherCalls++; priorWarn(...args) }
    const laterError = (...args) => { otherCalls++; priorError(...args) }
    console.warn = laterWarn; console.error = laterError
    dispose(); dispose()
    assert.equal(console.warn, laterWarn)
    assert.equal(console.error, laterError)
    console.warn('later warn'); console.error('later error')
    assert.equal(otherCalls, 2)
    assert.equal(host.state.consoleCalls.length, 2)
    assert.equal(host.state.reports.length, 0)
  })
})
await test('pagehide capture 先于先注册的 bridge bubble，停用转发后才执行清理日志', () => {
  fixture().run(() => {
    let bubbles = 0
    window.addEventListener('pagehide', () => {
      bubbles++
      assert.equal(console.warn, host.original.warn)
      assert.equal(console.error, host.original.error)
      assert.equal(window.listenerCount('error'), 0)
      assert.equal(window.listenerCount('unhandledrejection'), 0)
      console.error('合成 bridge 清理日志')
      window.dispatch('error', { error: new Error('合成清理错误') })
      window.dispatch('unhandledrejection', { reason: '合成清理拒绝' })
    }, { once: true })
    const dispose = host.install()
    assert.deepEqual(host.state.registrations.filter((item) => item.type === 'pagehide').map((item) => [item.capture, item.once]), [[false, true], [true, true]])
    window.dispatch('pagehide')
    assert.deepEqual(host.state.dispatches.filter((item) => item.type === 'pagehide').map((item) => item.capture), [true, false])
    assert.equal(bubbles, 1)
    assert.equal(host.state.reports.length, 0)
    assert.equal(host.state.consoleCalls.length, 1)
    assert.equal(window.listenerCount('pagehide'), 0)
    const removed = host.state.removals.length
    window.dispatch('pagehide'); dispose()
    assert.equal(host.state.removals.length, removed)
    assert.equal(bubbles, 1)
  })
})
await test('真实 transport 正常调用保留返回结果，使用 native-invoke 标记且只注册一次监听', async () => {
  await fixture().run(async () => {
    const t = host.transport({ onError: host.onError })
    await t.ready
    const result = await t.call('app:version', { count: 1 }, undefined)
    t.send('hud:setInteractive', true)
    await Promise.resolve(); await Promise.resolve()
    assert.equal(result, host.state.invokeResult)
    assert.equal(host.state.listenCalls.length, 1)
    assert.equal(host.state.listenCalls[0].name, 'launcher:event')
    assert.equal(host.state.nativeCalls.length, 2)
    assert.equal(host.state.nativeCalls[0].command, 'launcher_call')
    assert.equal(host.state.nativeCalls[0].args.channel, 'app:version')
    assert.equal(Object.getPrototypeOf(host.state.nativeCalls[0].args.args[0]), null)
    assert.equal(host.state.nativeCalls[0].args.args[0].count, 1)
    assert.equal(host.state.nativeCalls[0].args.args[1], null)
    assert.equal(host.state.nativeCalls[1].command, 'launcher_send')
    assert.equal(host.state.nativeCalls[1].args.channel, 'hud:setInteractive')
    for (const call of host.state.nativeCalls) {
      assert.equal(Object.getPrototypeOf(call.options.headers), Object.prototype)
      assert.equal(call.options.headers['x-hcmcl-document'], window.__HC_NATIVE_DOCUMENT__)
    }
    t.dispose(); t.dispose()
    assert.equal(host.state.unlistenCalls, 1)
    assert.equal(host.state.errors.length, 0)
  })
})
await test('pending ready 后 dispose，排队及释放后 debug 日志不发送、不 onError', async () => {
  const f = fixture()
  f.run(() => {
    host.state.listenMode = 'pending'
    const t = host.transport({ onError: host.onError })
    host.readyOutcome = t.ready.then(() => 'resolved', (error) => error)
    t.send('debug:rendererLog', 'warn', 'queued')
  })
  await settle()
  f.run(() => {
    assert.equal(host.state.listenJobs.length, 1)
    host.t.dispose(); host.t.dispose()
    host.t.send('debug:rendererLog', 'error', 'after dispose')
    host.state.listenJobs[0].resolve(host.unlisten)
  })
  await settle()
  await f.run(async () => {
    const outcome = await host.readyOutcome
    assert.ok(outcome instanceof Error)
    assert.match(outcome.message, /已释放/)
    assert.equal(host.state.nativeCalls.length, 0)
    assert.equal(host.state.errors.length, 0)
    assert.equal(host.state.consoleCalls.length, 0)
    assert.equal(host.state.unlistenCalls, 1)
    host.assertBounded()
  })
})
await test('pending ready 释放后注册 Promise 拒绝，debug 仍静默且没有假成功', async () => {
  const f = fixture()
  f.run(() => {
    host.state.listenMode = 'pending'
    const t = host.transport({ onError: host.onError })
    host.readyOutcome = t.ready.then(() => 'resolved', (error) => error)
    t.send('debug:rendererLog', 'error', 'queued')
  })
  await settle()
  f.run(() => {
    host.t.dispose()
    host.t.send('debug:rendererLog', 'error', 'after')
    host.state.listenJobs[0].reject(new Error('合成注册失败'))
  })
  await settle()
  await f.run(async () => {
    assert.match((await host.readyOutcome).message, /合成注册失败/)
    assert.equal(host.state.nativeCalls.length, 0)
    assert.equal(host.state.errors.length, 0)
    assert.equal(host.state.consoleCalls.length, 0)
    assert.equal(host.state.unlistenCalls, 0)
  })
})
await test('debug 参数不可编码时静默丢弃，不反向报告到 onError 或 console', async () => {
  const f = fixture()
  await f.run(async () => {
    const t = host.transport({ onError: host.onError })
    await t.ready
    const cyclic = {}; cyclic.self = cyclic
    t.send('debug:rendererLog', 'error', cyclic)
    t.send('debug:rendererLog', 'error', () => {})
  })
  await settle()
  f.run(() => {
    assert.equal(host.state.nativeCalls.length, 0)
    assert.equal(host.state.errors.length, 0)
    assert.equal(host.state.consoleCalls.length, 0)
    host.t.dispose()
  })
})
await test('debug 原生 Promise 拒绝不回写 console，不形成日志发送回路', async () => {
  const f = fixture()
  await f.run(async () => {
    const t = host.transport()
    await t.ready
    host.state.invokeMode = 'reject'
    host.install((level, message) => t.send('debug:rendererLog', level, message))
    console.error('合成原始日志')
  })
  await settle()
  f.run(() => {
    assert.equal(host.state.consoleCalls.length, 1)
    assert.equal(host.state.reports.length, 1)
    assert.equal(host.state.nativeCalls.length, 1)
    assert.equal(host.state.nativeCalls[0].args.channel, 'debug:rendererLog')
    assert.deepEqual(host.state.nativeCalls[0].args.args, ['error', '合成原始日志'])
    host.disposeForwarding(); host.t.dispose(); host.assertBounded()
  })
})
await test('debug 原生同步抛错与异步拒绝均不触发 onError', async () => {
  const f = fixture()
  await f.run(async () => {
    const t = host.transport({ onError: host.onError })
    await t.ready
    host.state.invokeMode = 'throw'
    t.send('debug:rendererLog', 'error', 'synchronous')
  })
  await settle()
  f.run(() => {
    host.state.invokeMode = 'reject'
    host.t.send('debug:rendererLog', 'error', 'asynchronous')
  })
  await settle()
  f.run(() => {
    assert.equal(host.state.nativeCalls.length, 2)
    assert.equal(host.state.errors.length, 0)
    assert.equal(host.state.consoleCalls.length, 0)
    host.t.dispose(); host.assertBounded()
  })
})
await test('普通非法 send 与编码失败仍通过 onError 报告，不触发原生调用', async () => {
  const f = fixture()
  await f.run(async () => {
    const t = host.transport({ onError: host.onError })
    await t.ready
    const cyclic = {}; cyclic.self = cyclic
    t.send('fixture:not-public')
    t.send('hud:setInteractive', cyclic)
    t.send('hud:setInteractive', Infinity)
    assert.deepEqual(host.state.errors.map((item) => item.operation), ['send', 'send:hud:setInteractive', 'send:hud:setInteractive'])
    assert.match(host.state.errors[0].error.message, /未公开/)
    assert.match(host.state.errors[1].error.message, /循环引用/)
    assert.match(host.state.errors[2].error.message, /不可序列化/)
  })
  await settle()
  f.run(() => {
    assert.equal(host.state.nativeCalls.length, 0)
    assert.equal(host.state.consoleCalls.length, 0)
    host.t.dispose()
  })
})
await test('普通 send 的原生失败仍报告 onError，不能被 debug 静默规则吞掉', async () => {
  const f = fixture()
  await f.run(async () => {
    const t = host.transport({ onError: host.onError })
    await t.ready
    host.state.invokeMode = 'reject'
    t.send('hud:setInteractive', true)
  })
  await settle()
  f.run(() => {
    assert.equal(host.state.nativeCalls.length, 1)
    assert.equal(host.state.errors.length, 1)
    assert.equal(host.state.errors[0].operation, 'send:hud:setInteractive')
    assert.match(host.state.errors[0].error.message, /夹具原生拒绝/)
    host.t.dispose()
  })
})
await test('普通业务失败默认 console 报告一次，派生 debug 失败不再递归', async () => {
  const f = fixture()
  await f.run(async () => {
    const t = host.transport()
    await t.ready
    host.state.invokeMode = 'reject'
    host.install((level, message) => t.send('debug:rendererLog', level, message))
    t.send('hud:setInteractive', true)
  })
  await settle()
  f.run(() => {
    assert.deepEqual(host.state.nativeCalls.map((item) => item.args.channel), ['hud:setInteractive', 'debug:rendererLog'])
    assert.equal(host.state.consoleCalls.length, 1)
    assert.equal(host.state.consoleCalls[0].method, 'error')
    assert.equal(host.state.consoleCalls[0].args[0], 'Tauri 桥接失败：send:hud:setInteractive')
    assert.equal(host.state.reports.length, 1)
    host.disposeForwarding(); host.t.dispose(); host.assertBounded()
  })
})
await test('pagehide 真实 transport 清理失败仍保留 console，但 capture 已禁止再发 debug', async () => {
  const f = fixture()
  await f.run(async () => {
    const t = host.transport()
    await t.ready
    host.state.unlistenMode = 'throw'
    window.addEventListener('pagehide', () => t.dispose(), { once: true })
    host.install((level, message) => t.send('debug:rendererLog', level, message))
    console.warn('before pagehide')
  })
  await settle()
  f.run(() => {
    assert.equal(host.state.nativeCalls.length, 1)
    window.dispatch('pagehide')
    console.error('after pagehide')
    window.dispatch('unhandledrejection', { reason: 'after pagehide' })
  })
  await settle()
  f.run(() => {
    assert.deepEqual(host.state.dispatches.filter((item) => item.type === 'pagehide').map((item) => item.capture), [true, false])
    assert.equal(host.state.nativeCalls.length, 1)
    assert.equal(host.state.reports.length, 1)
    assert.equal(host.state.unlistenCalls, 1)
    assert.equal(host.state.consoleCalls.length, 3)
    assert.equal(host.state.consoleCalls[1].args[0], 'Tauri 桥接失败：event:unlisten')
    assert.equal(console.error, host.original.error)
    host.disposeForwarding(); host.t.dispose(); host.assertBounded()
  })
})
await test('释放后普通 send 报告失败，call 仍明确拒绝而非假成功', async () => {
  const f = fixture()
  await f.run(async () => {
    const t = host.transport({ onError: host.onError })
    await t.ready
    t.dispose()
    t.send('hud:setInteractive', true)
    t.send('debug:rendererLog', 'error', 'silently dropped')
    await assert.rejects(t.call('app:version'), /已释放/)
    await assert.rejects(t.call('fixture:not-public'), /未公开/)
  })
  await settle()
  f.run(() => {
    assert.equal(host.state.nativeCalls.length, 0)
    assert.equal(host.state.errors.length, 1)
    assert.equal(host.state.errors[0].operation, 'send:hud:setInteractive')
    assert.match(host.state.errors[0].error.message, /已释放/)
    assert.equal(host.state.unlistenCalls, 1)
    assert.equal(host.state.consoleCalls.length, 0)
  })
})
await test('等待 ready 的普通 send 与 call 在释放后都不执行，call 拒绝且 send 报告', async () => {
  const f = fixture()
  f.run(() => {
    host.state.listenMode = 'pending'
    const t = host.transport({ onError: host.onError })
    host.callState = 'pending'
    host.callOutcome = t.call('app:version').then((value) => { host.callState = 'resolved'; return value }, (error) => { host.callState = 'rejected'; return error })
    t.send('hud:setInteractive', false)
  })
  await settle()
  f.run(() => {
    assert.equal(host.callState, 'pending')
    assert.equal(host.state.nativeCalls.length, 0)
    host.t.dispose()
    host.state.listenJobs[0].resolve(host.unlisten)
  })
  await settle()
  await f.run(async () => {
    assert.equal(host.callState, 'rejected')
    assert.match((await host.callOutcome).message, /已释放/)
    assert.equal(host.state.nativeCalls.length, 0)
    assert.equal(host.state.errors.length, 1)
    assert.equal(host.state.errors[0].operation, 'send:hud:setInteractive')
    assert.equal(host.state.unlistenCalls, 1)
  })
})
await test('普通 call 的非法通道、编码错误及原生拒绝保留 Promise 拒绝语义', async () => {
  await fixture().run(async () => {
    const t = host.transport({ onError: host.onError })
    await t.ready
    const cyclic = {}; cyclic.self = cyclic
    await assert.rejects(t.call('fixture:not-public'), /未公开/)
    await assert.rejects(t.call('app:version', cyclic), /循环引用/)
    assert.equal(host.state.nativeCalls.length, 0)
    host.state.invokeMode = 'reject'
    await assert.rejects(t.call('app:version'), /夹具原生拒绝/)
    assert.equal(host.state.nativeCalls.length, 1)
    assert.equal(host.state.errors.length, 0)
    t.dispose()
  })
})
await test('活动 transport 的注册失败仍报告普通业务错误，但 debug 不额外报告', async () => {
  const f = fixture()
  f.run(() => {
    host.state.listenMode = 'reject'
    const t = host.transport({ onError: host.onError })
    host.readyOutcome = t.ready.then(() => 'resolved', (error) => error)
    host.callOutcome = t.call('app:version').then(() => 'resolved', (error) => error)
    t.send('debug:rendererLog', 'error', 'debug')
    t.send('hud:setInteractive', true)
  })
  await settle()
  await f.run(async () => {
    assert.match((await host.readyOutcome).message, /夹具注册拒绝/)
    assert.match((await host.callOutcome).message, /夹具注册拒绝/)
    assert.deepEqual(host.state.errors.map((item) => item.operation), ['event:listen', 'send:hud:setInteractive'])
    assert.equal(host.state.nativeCalls.length, 0)
    assert.equal(host.state.consoleCalls.length, 0)
    host.t.dispose()
  })
})
await test('onError 自身异常保留 console 错误，旁路 debug 拒绝仍不递归', async () => {
  const f = fixture()
  await f.run(async () => {
    const t = host.transport({ onError() { throw new Error('合成处理器错误') } })
    await t.ready
    host.state.invokeMode = 'reject'
    host.install((level, message) => t.send('debug:rendererLog', level, message))
    t.send('hud:setInteractive', true)
  })
  await settle()
  f.run(() => {
    assert.deepEqual(host.state.nativeCalls.map((item) => item.args.channel), ['hud:setInteractive', 'debug:rendererLog'])
    assert.equal(host.state.consoleCalls.length, 1)
    assert.equal(host.state.consoleCalls[0].args[0], 'Tauri 桥接错误处理器异常')
    assert.equal(host.state.reports.length, 1)
    host.disposeForwarding(); host.t.dispose(); host.assertBounded()
  })
})
await test('所有合成 rejected Promise 都已被处理，没有泄漏 unhandledRejection', async () => {
  await settle()
  assert.deepEqual(unhandled, [])
})

process.removeListener('unhandledRejection', onUnhandled)
console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exitCode = 1
