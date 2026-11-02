import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

// 真正启动 WPF 进程，模拟宿主握手并验证 EOF 生命周期。
const root = dirname(fileURLToPath(import.meta.url))
const child = spawn(join(root, process.argv[2] === '--self-contained' ? 'artifacts/win-x64/PCCL2.Native.exe' : 'artifacts/framework-dependent/PCCL2.Native.exe'), ['--bridge-stdio'], { stdio: ['pipe', 'pipe', 'pipe'] })
let ready = 0
let state = 0
let errors = ''
let failed = false
const timeout = setTimeout(() => { failed = true; child.kill(); }, 15000)
child.stderr.on('data', data => { errors += data.toString() })
child.stdin.on('error', () => {})
const lines = createInterface({ input: child.stdout })
lines.on('line', line => {
  try {
    const request = JSON.parse(line)
    assert.equal(typeof request.id, 'string')
    assert.equal(typeof request.method, 'string')
    let result = {}
    if (request.method === 'ui.ready') ready++
    else if (request.method === 'state.get') {
      state++
      result = { settings: { language: 'zh-CN', memoryMb: 4096, downloadSource: 'auto' }, accounts: [{ id: 'smoke', name: 'Smoke Player', uuid: '', offline: true, authType: 'offline' }], installed: [{ id: '1.21.4', mcVersion: '1.21.4', loader: null }], versionDirs: [] }
    } else throw new Error('Unexpected method: ' + request.method)
    child.stdin.write(JSON.stringify({ id: request.id, result }) + '\n')
    if (state) {
      child.stdin.write(JSON.stringify({ event: 'progress', data: { taskId: 'smoke', message: '桥接验证', progress: 0.5 } }) + '\n')
      setTimeout(() => child.stdin.end(), 800)
    }
  } catch (error) { failed = true; console.error(error.message); child.kill() }
})
child.on('error', error => { failed = true; console.error(error.message) })
child.on('exit', code => {
  clearTimeout(timeout)
  try {
    assert.equal(failed, false, 'Process timed out or protocol failed')
    assert.equal(code, 0, errors)
    assert.equal(ready, 1, 'ui.ready must occur exactly once')
    assert.equal(state, 1, 'Native UI must request state')
    assert.equal(errors.includes('PCCL2 UI:'), false, errors)
    console.log('PASS: native WPF Loaded handshake, JSON-only stdout, state hydration, progress input, EOF clean exit')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
})
