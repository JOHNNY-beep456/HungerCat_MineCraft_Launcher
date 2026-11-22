/** 真实语音 helper 的离线回归；设备、录音器和时间由测试替身控制，不访问麦克风或网络。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const file = 'src/renderer/src/components/ai-voice-toggle.ts'
const output = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), {
  fileName: file, reportDiagnostics: true,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
})
assert.equal(output.diagnostics.filter((item) => item.category === ts.DiagnosticCategory.Error).length, 0)
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes }); return { promise, resolve } }
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)) }
let passed = 0, failed = 0
async function test(name, run) {
  try { await run(); passed++; console.log(`  ok   ${name}`) }
  catch (error) { failed++; console.error(`  FAIL ${name}: ${error.stack ?? error}`) }
}
function fixture({ permission, stt, constructorFailure = false } = {}) {
  const records = [], timers = new Map(), page = new Map(), logs = [], sent = [], transcriptions = []
  const track = { stops: 0, stop() { this.stops++ } }
  const stream = { getTracks: () => [track] }
  let enabled = true, requests = 0, nextTimer = 0
  class Recorder {
    constructor() {
      if (constructorFailure) throw new Error('synthetic constructor failure')
      this.state = 'inactive'; this.mimeType = 'audio/webm;codecs=opus'; records.push(this)
    }
    start(interval) { assert.equal(interval, 250); this.state = 'recording' }
    stop() { this.stopCalls = (this.stopCalls ?? 0) + 1; this.state = 'inactive' }
    data(size = 2048) { this.ondataavailable?.({ data: new Blob([new Uint8Array(size)]) }) }
    finish() { this.onstop?.() }
  }
  const window = {
    api: { platform: 'win32' }, __TAURI_INTERNALS__: {},
    addEventListener: (name, run) => page.set(name, run),
    removeEventListener: (name, run) => { if (page.get(name) === run) page.delete(name) },
  }
  const module = { exports: {} }
  vm.runInNewContext(output.outputText, {
    module, exports: module.exports, window, Blob, Uint8Array,
    navigator: { mediaDevices: { getUserMedia: () => { requests++; return permission?.promise ?? Promise.resolve(stream) } } },
    MediaRecorder: Recorder,
    setTimeout: (run, milliseconds) => { const id = ++nextTimer; timers.set(id, { run, milliseconds }); return id },
    clearTimeout: (id) => timers.delete(id),
    require() { throw new Error('录音路径不得加载 Tauri 或网络模块') },
  }, { filename: file })
  const voice = module.exports.createAiVoiceRecorder(() => ({
    canStart: () => enabled,
    recording: (value) => logs.push(['recording', value]), status: (value) => logs.push(['status', value]),
    notice: (kind) => logs.push(['notice', kind]),
    transcribe: async (bytes, mime) => { transcriptions.push([bytes.byteLength, mime]); return stt?.promise ?? { ok: true, text: '离线合成测试文本' } },
    send: async (text, current) => { if (current()) sent.push(text) },
  }))
  return { voice, records, timers, track, stream, logs, sent, transcriptions, page,
    get requests() { return requests }, disable() { enabled = false; voice.cancel() },
  }
}
await test('不自动请求设备；停止重复调用不丢录音，先释放音轨再提交一次', async () => {
  const app = fixture(); assert.equal(app.requests, 0)
  await app.voice.toggle(); assert.equal(app.requests, 1)
  const rec = app.records[0]; rec.data(); app.voice.stop(); app.voice.stop(); await app.voice.toggle()
  assert.equal(rec.stopCalls, 1); assert.ok(app.track.stops > 0); assert.equal(app.timers.size, 0)
  rec.finish(); await settle()
  assert.equal(app.transcriptions.length, 1); assert.deepEqual(app.sent, ['离线合成测试文本'])
  app.voice.dispose(); assert.equal(app.page.size, 0)
})
await test('取消未决权限请求会释放迟到音轨且不创建录音器', async () => {
  const permission = deferred(), app = fixture({ permission })
  const start = app.voice.start(); await app.voice.toggle(); permission.resolve(app.stream); await start
  assert.equal(app.records.length, 0); assert.ok(app.track.stops > 0); assert.equal(app.sent.length, 0)
  app.voice.dispose()
})
await test('关闭语音及卸载会丢弃迟到转写，页面结束释放采集资源', async () => {
  const stt = deferred(), app = fixture({ stt }); await app.voice.start()
  const rec = app.records[0]; rec.data(); app.voice.stop(); rec.finish(); await settle()
  assert.equal(app.transcriptions.length, 1); app.disable(); stt.resolve({ ok: true, text: '不能提交' }); await settle()
  assert.equal(app.sent.length, 0)
  app.voice.dispose()
  const second = fixture(); await second.voice.start(); const lateStop = second.records[0].onstop
  second.page.get('pagehide')(); lateStop(); await settle()
  assert.ok(second.track.stops > 0); assert.equal(second.transcriptions.length, 0); assert.equal(second.page.size, 0)
})
await test('60秒与12MiB边界实际终止录音，构造失败也释放设备', async () => {
  const timed = fixture(); await timed.voice.start()
  const timeout = [...timed.timers.values()][0]; assert.equal(timeout.milliseconds, 60000)
  timed.records[0].data(); timeout.run(); assert.ok(timed.track.stops > 0); timed.records[0].finish(); await settle()
  assert.equal(timed.transcriptions.length, 1); timed.voice.dispose()
  const capped = fixture(); await capped.voice.start(); capped.records[0].data(12 * 1024 * 1024 + 1)
  assert.ok(capped.track.stops > 0); assert.equal(capped.transcriptions.length, 0); assert.equal(capped.timers.size, 0); capped.voice.dispose()
  const broken = fixture({ constructorFailure: true }); await broken.voice.start()
  assert.ok(broken.track.stops > 0); assert.equal(broken.transcriptions.length, 0); broken.voice.dispose()
})
await test('监听先于快照，新事件胜过旧快照，迟到退订与卸载无回写', async () => {
  async function watchFixture(lateListen = false) {
    const snapshot = deferred(), ready = deferred(), values = [], order = []; let receive, offs = 0
    const module = { exports: {} }
    vm.runInNewContext(output.outputText, {
      module, exports: module.exports,
      require(name) {
        if (name === '@tauri-apps/api/event') return { listen: async (event, callback) => {
          assert.equal(event, 'launcher:event'); order.push('listen'); receive = callback
          if (lateListen) await ready.promise
          return () => { offs++ }
        } }
        if (name === '../../../tauri/native-invoke') return { nativeInvoke(command, args) {
          assert.equal(command, 'launcher_call'); assert.equal(args.channel, 'ai:voiceState'); assert.equal(args.args.length, 0)
          order.push('snapshot'); return snapshot.promise
        } }
        throw new Error(name)
      },
    }, { filename: file })
    const off = module.exports.watchAiVoiceEnabled((value) => values.push(value)); await settle()
    return { off, snapshot, ready, values, order, get offs() { return offs }, emit: (value) => receive({ payload: { channel: 'ai:voiceState', payload: value } }) }
  }
  const first = await watchFixture(); assert.deepEqual(first.order, ['listen', 'snapshot'])
  first.emit(false); first.snapshot.resolve(true); await settle(); assert.deepEqual(first.values, [false]); first.off(); first.emit(true)
  assert.deepEqual(first.values, [false]); assert.equal(first.offs, 1)
  const second = await watchFixture(true); second.off(); second.ready.resolve(); await settle()
  assert.equal(second.offs, 1); assert.deepEqual(second.order, ['listen']); assert.deepEqual(second.values, [])
})

console.log(`结果：${passed} 通过 / ${failed} 失败`)
if (failed) process.exitCode = 1
