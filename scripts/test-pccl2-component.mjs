import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { deflateRawSync } from 'node:zlib'
import { build } from 'esbuild'

const scratch = await fs.mkdtemp(join(tmpdir(), 'pccl2-test-'))
const originalFetch = globalThis.fetch
const platform = Object.getOwnPropertyDescriptor(process, 'platform')
const arch = Object.getOwnPropertyDescriptor(process, 'arch')
const hash = (data) => createHash('sha256').update(data).digest('hex')
const base = 'https://updates.example/manifest.json'
let passed = 0
async function test(name, fn) {
  await fn()
  passed++
  console.log(`通过：${name}`)
}
// 构造最小 ZIP32；独立变异本地头和中央目录，实际调用生产校验器。
function zip(entries) {
  const locals = [], central = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const localName = Buffer.from(e.localName ?? e.name)
    const raw = Buffer.from(e.data ?? (e.name.endsWith('/') ? '' : 'MZ-native-test'))
    const method = e.method ?? 0
    const payload = method === 8 ? deflateRawSync(raw) : raw
    const flags = e.flags ?? 0x800
    const expanded = e.expanded ?? raw.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(e.localFlags ?? flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(expanded, 22)
    local.writeUInt16LE(localName.length, 26)
    locals.push(local, localName, payload)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50)
    cd.writeUInt16LE(0x0314, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(flags, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(payload.length, 20)
    cd.writeUInt32LE(expanded, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(e.attrs ?? 0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)
    offset += local.length + localName.length + payload.length
  }
  const c = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(c.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, c, end])
}
let extractionCalls = 0
try {
  globalThis.__pccl2TestRoot = scratch
  globalThis.__pccl2Extract = async (file, dest) => {
    extractionCalls++
    const bytes = await fs.readFile(file)
    let p = 0
    while (bytes.readUInt32LE(p) === 0x04034b50) {
      const size = bytes.readUInt32LE(p + 18)
      const length = bytes.readUInt16LE(p + 26)
      const name = bytes.subarray(p + 30, p + 30 + length).toString()
      const start = p + 30 + length
      if (name.endsWith('/')) await fs.mkdir(join(dest, name), { recursive: true })
      else await fs.writeFile(join(dest, name), bytes.subarray(start, start + size))
      p = start + size
    }
  }
  const source = await fs.readFile('src/main/pccl2/component.ts', 'utf8')
  const output = join(scratch, 'component.cjs')
  await build({
    stdin: { contents: source + '\nexport { parseManifest, validRelativeEntry, safeChild, validateZipArchive, readManifest, receive };', resolveDir: join(process.cwd(), 'src/main/pccl2'), loader: 'ts' },
    outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{ name: '隔离 Electron 与解压依赖', setup(b) {
      b.onResolve({ filter: /^(electron|\.\.\/archive)$/ }, ({ path }) => ({ path, namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents: path === 'electron'
        ? 'export const app = { getPath: () => globalThis.__pccl2TestRoot };'
        : 'export const extractArchive = (...args) => globalThis.__pccl2Extract(...args);' }))
    } }]
  })
  const mod = createRequire(import.meta.url)(output)
  const goodZip = zip([{ name: 'PCCL2.Native.exe' }])
  const manifest = { schemaVersion: 1, component: 'pccl2', version: '1.2.3', platform: 'win32', arch: 'x64', bridgeVersion: 1, entry: 'PCCL2.Native.exe', url: './package.zip', size: goodZip.length, sha256: hash(goodZip) }
  await test('接受 PCCL2.Native.exe 与相对 HTTPS 下载地址', () => {
    assert.equal(mod.validRelativeEntry('PCCL2.Native.exe'), true)
    assert.equal(mod.parseManifest(manifest, base).url, 'https://updates.example/package.zip')
  })
  for (const entry of ['badexe', 'bad\\.exe', 'dir/x.exe', '../x.exe', '/x.exe', 'C:x.exe', 'NUL.exe', 'NUL .exe', 'CONIN$.exe', 'com¹.exe', 'x.exe:ads', 'x.exe.', 'x.exe ', 'x\u0000.exe', 'x?.exe']) {
    await test(`拒绝非法入口 ${JSON.stringify(entry)}`, () => assert.throws(() => mod.parseManifest({ ...manifest, entry }, base)))
  }
  for (const patch of [{ url: undefined }, { url: 'http://host/a' }, { url: 'https://user:pass@host/a' }, { size: 0 }, { size: 1.2 }, { sha256: 'bad' }, { arch: 'arm64' }]) {
    await test(`拒绝非法 manifest ${JSON.stringify(patch)}`, () => assert.throws(() => mod.parseManifest({ ...manifest, ...patch }, base)))
  }
  const archive = join(scratch, 'check.zip')
  async function validate(entries) { await fs.writeFile(archive, zip(entries)); await mod.validateZipArchive(archive) }
  await test('接受 ZIP32 根目录原生程序', () => validate([{ name: 'PCCL2.Native.exe' }]))
  await test('接受普通目录与 deflate 文件', () => validate([{ name: 'lib/' }, { name: 'lib/data', method: 8 }]))
  for (const name of ['../bad', '..\\bad', 'lib\\bad', '/bad', 'C:/bad', 'x:ads', 'NUL.txt', 'aux/a', 'a./b', 'a /b', './bad', 'a//b', '.pccl2.json']) {
    await test(`拒绝 ZIP 路径 ${JSON.stringify(name)}`, () => assert.rejects(validate([{ name }])))
  }
  for (const entries of [
    [{ name: 'a', localName: 'b' }], [{ name: 'a', localFlags: 0 }],
    [{ name: 'a', flags: 1 }], [{ name: 'a', flags: 0x808 }],
    [{ name: 'link', attrs: 0xa1ff0000 }], [{ name: 'fifo', attrs: 0x11ff0000 }],
    [{ name: 'a', expanded: 512 * 1024 * 1024 + 1 }],
    [{ name: 'a', method: 8, expanded: 1, data: 'x'.repeat(100000) }],
    [{ name: 'a', method: 8, expanded: 1000 }],
    [{ name: 'a' }, { name: 'A' }], [{ name: 'lib/' }, { name: 'LIB/' }],
    [{ name: 'lib' }, { name: 'lib/a' }], [{ name: 'lib/a' }, { name: 'LIB' }],
    [{ name: 'lib/a' }, { name: 'LIB/b' }]
  ]) await test(`拒绝 ZIP 元数据或重复路径 ${JSON.stringify(entries).slice(0, 100)}`, () => assert.rejects(validate(entries)))
  await test('拒绝 ZIP 中央目录长度不一致', async () => {
    const broken = Buffer.from(goodZip)
    broken.writeUInt32LE(1, broken.length - 10)
    await fs.writeFile(archive, broken)
    await assert.rejects(mod.validateZipArchive(archive))
  })
  await test('HTTPS 跳转拒绝降级且不请求 HTTP', async () => {
    let calls = 0
    globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://unsafe/package.zip' } }) }
    await assert.rejects(mod.readManifest(base), /HTTPS/)
    assert.equal(calls, 1)
  })
  await test('HTTPS 相对重定向按最终 manifest 地址解析', async () => {
    globalThis.fetch = async (url) => url === base ? new Response(null, { status: 302, headers: { location: '/release/manifest.json' } }) : Response.json(manifest)
    assert.equal((await mod.readManifest(base)).url, 'https://updates.example/release/package.zip')
  })
  await test('流式超限时中止，超限块不写入', async () => {
    let consumed = 0, cancelled = false
    globalThis.fetch = async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(4)) }, cancel() { cancelled = true } }))
    await assert.rejects(mod.receive(base, 5, 1000, async (b) => { consumed += b.length }), /大小限制/)
    assert.equal(consumed, 4)
    assert.equal(cancelled, true)
  })
  await test('下载超时中止请求', async () => {
    globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    await assert.rejects(mod.receive(base, 10, 10, async () => {}), /超时/)
  })
  Object.defineProperty(process, 'platform', { value: 'win32' })
  Object.defineProperty(process, 'arch', { value: 'x64' })
  const serve = (m = manifest, bytes = goodZip) => { globalThis.fetch = async (url) => url.endsWith('manifest.json') ? Response.json(m) : new Response(bytes) }
  serve()
  await test('安装正常 EXE 并校验已安装入口 SHA-256', async () => {
    const exe = await mod.installComponent(base)
    assert.equal(exe, join(scratch, 'components/pccl2/PCCL2.Native.exe'))
    assert.equal(await mod.getInstalledExecutable(), exe)
    assert.equal((await mod.getComponentStatus()).installed, true)
    await fs.writeFile(exe, 'tampered')
    assert.equal((await mod.getComponentStatus()).installed, false)
    await assert.rejects(mod.getInstalledExecutable(), /完整性/)
    await mod.installComponent(base)
  })
  await test('错误包校验和在解压前失败', async () => {
    const before = extractionCalls
    serve({ ...manifest, sha256: '0'.repeat(64) })
    await assert.rejects(mod.installComponent(base), /SHA-256/)
    assert.equal(extractionCalls, before)
    assert.equal((await mod.getComponentStatus()).installed, true)
  })
  await test('并发安装拒绝且首个安装可完成', async () => {
    let release, started
    const gate = new Promise((r) => { release = r })
    const ready = new Promise((r) => { started = r })
    globalThis.fetch = async (url) => { if (url.endsWith('manifest.json')) { started(); await gate; return Response.json(manifest) } return new Response(goodZip) }
    const first = mod.installComponent(base)
    await ready
    await assert.rejects(mod.installComponent(base), /正在进行/)
    release()
    await first
  })
  await test('跨进程安装锁拒绝且保留他人锁', async () => {
    const lock = join(scratch, 'components/pccl2.install.lock')
    await fs.writeFile(lock, 'other')
    await assert.rejects(mod.installComponent(base), /EEXIST/)
    assert.equal(await fs.readFile(lock, 'utf8'), 'other')
    await fs.unlink(lock)
  })
  await test('发布失败成功回滚旧组件', async () => {
    serve()
    const rename = fs.rename
    fs.rename = async (from, to) => { if (from.endsWith('payload')) throw new Error('publish failed'); return rename(from, to) }
    try { await assert.rejects(mod.installComponent(base), /publish failed/) } finally { fs.rename = rename }
    assert.equal((await mod.getComponentStatus()).installed, true)
  })
  await test('回滚失败明确报告并保留旧组件供恢复', async () => {
    serve()
    const rename = fs.rename
    fs.rename = async (from, to) => { if (from.endsWith('payload') || from.endsWith('previous')) throw new Error('rename failed'); return rename(from, to) }
    let error
    try { await mod.installComponent(base) } catch (e) { error = e } finally { fs.rename = rename }
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors.length, 2)
    const dirs = await fs.readdir(join(scratch, 'components'))
    const recovery = dirs.find((n) => n.startsWith('.pccl2-install-'))
    assert.ok(recovery)
    assert.equal(await fs.readFile(join(scratch, 'components', recovery, 'previous/PCCL2.Native.exe'), 'utf8'), 'MZ-native-test')
  })
  console.log(`结果：${passed} 通过 / 0 失败`)
} finally {
  globalThis.fetch = originalFetch
  Object.defineProperty(process, 'platform', platform)
  Object.defineProperty(process, 'arch', arch)
  delete globalThis.__pccl2TestRoot
  delete globalThis.__pccl2Extract
  await fs.rm(scratch, { recursive: true, force: true })
}
