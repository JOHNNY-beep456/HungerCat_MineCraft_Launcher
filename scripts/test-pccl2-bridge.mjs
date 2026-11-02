import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { spawn as nativeSpawn } from 'node:child_process'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const scratch = await fs.mkdtemp(join(tmpdir(), 'pccl2-bridge-test-'))
let passed = 0
async function test(name, fn) { await fn(); passed++; console.log(`通过：${name}`) }
// 等待当前事件循环中的异步 handler 和 finally 全部落定。
const settle = () => new Promise(resolve => setImmediate(resolve))

const state = {
  settings: { memoryMb: 4096, language: 'zh-CN', downloadSource: 'auto', versionIsolation: false, selectedVersionId: '1.20.1', mode: 'remote', pccl2ManifestUrl: '', curseForgeApiKey: 'SETTINGS_SECRET', futurePrivateField: 'FUTURE_SECRET' },
  setCalls: [],
  accounts: [{ id: 'acct-1', name: 'Player', uuid: 'uuid-1', authType: 'microsoft', accessToken: 'SECRET', refreshToken: 'SECRET2' }],
  selected: 'acct-1',
  installed: [{ id: '1.20.1' }],
  versions: ['default'],
}
const ipc = new Map()
const navEvents = []
const mainWindow = { hidden: false, destroyed: false, hide() { this.hidden = true }, show() { this.hidden = false }, isDestroyed() { return this.destroyed }, webContents: { send(ch, data) { navEvents.push({ ch, data }) } } }
const app = new EventEmitter()
const nativeTheme = { themeSource: 'dark' }
class FakeInput extends EventEmitter {
  writable = true
  writes = []
  write(v) { this.writes.push(v); return true }
}
class FakeProc extends EventEmitter {
  pid = 7421
  exitCode = null
  killed = false
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = new FakeInput()
  constructor() { super(); this.stderr.resume = () => {} }
  kill() { this.killed = true; this.exitCode = 0 }
}
let proc = null
const spawned = []
let bridgeSource = await fs.readFile('src/main/pccl2/bridge.ts', 'utf8')
// 模拟已发布旧宿主：只认 ready RPC，忽略 native ready 事件。
if (process.env.PCCL2_LEGACY_HOST === '1') bridgeSource = bridgeSource.replace("if (lifecycle.event === 'ui.ready') { readyResolve?.(); continue }", "if (lifecycle.event === 'ui.ready') continue")
const output = join(scratch, 'bridge.cjs')
const virtual = new Map([
  ['electron', `export const app = globalThis.__pccl2App; export const ipcMain = globalThis.__pccl2IpcMain; export const nativeTheme = globalThis.__pccl2NativeTheme; export const utilityProcess = { fork: () => { throw new Error('utilityProcess not available in test'); } };`],
  ['child_process', `export const spawn = (...args) => globalThis.__pccl2Spawn(...args);`],
  ['../handlers/context', `export {};`],
  ['../auth', `export class DeviceCodeSession { cancel() {} async begin() { return {userCode:'ABC',verificationUri:'https://microsoft.com/link',expiresIn:900,message:'login'}; } }`],
  ['../loaders', `export const loaderVersions = async () => [];`],
  ['../handlers/launch', `export const launchGame = async (ctx,opts,emit,progress) => { emit({state:'downloading'}); progress({percent:50}); emit({state:'launching'}); return {pid:12345}; }; export const stopGame = () => true;`],
  ['./resource-metadata', `export const nativeResourceMetadata = async () => ({hits:[],total_hits:0});`],
  ['../secret', `export const getCurseforgeKey = () => ''; export const setCurseforgeKey = () => null;`],
  ['../store', `export const settings = globalThis.__pccl2Settings; export const accounts = globalThis.__pccl2Accounts; export const createOfflineAccount = name => ({id:'offline-'+name,name,authType:'offline'}); export const activeGameDir = () => '/game'; export const allVersionDirs = () => ['default'];`],
  ['../versions', `export const fetchVersionManifest = async () => ({ versions: [] }); export const resolveVersionJson = async (id) => ({ id });`],
  ['../installed', `export const listInstalled = async () => globalThis.__pccl2State.installed;`],
  ['../downloader', `export const installVersion = async () => true;`],
  ['../network-profile', `export const effectiveConcurrency = () => ({ fileConcurrency: 1, connections: 1 });`],
  ['../sources', `export const searchResources = async () => []; export const resolveVersionsFor = async () => []; export const resolveProjectDetail = async () => ({slug:'p',source:'modrinth'});`],
  ['./resources', `export const nativeInstallResource = async (ctx, params, emit) => { globalThis.__pccl2ResourceParams=params; emit({taskId:'resource',percent:100}); return {ok:true,installed:true}; }`],
  ['./component', `export const getComponentStatus = async () => ({ installed: true, version: '1.0.0' }); export const installComponent = async (url) => ({ url }); export const getInstalledExecutable = async () => 'PCCL2.Native.exe'; export const ensureDotNet48 = async () => 'present';`],
  ['@shared/types', `export {};`],
])
await build({
  stdin: { contents: bridgeSource, resolveDir: join(process.cwd(), 'src/main/pccl2'), loader: 'ts', sourcefile: 'bridge.ts' },
  outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  plugins: [{ name: 'pccl2-bridge-test-mocks', setup(b) {
    b.onResolve({ filter: /.*/ }, ({ path }) => virtual.has(path) ? ({ path, namespace: 'pccl2-test' }) : undefined)
    b.onLoad({ filter: /.*/, namespace: 'pccl2-test' }, ({ path }) => ({ contents: virtual.get(path), loader: 'js' }))
  } }],
})

globalThis.__pccl2App = app
globalThis.__pccl2IpcMain = { handle(name, fn) { ipc.set(name, fn) } }
globalThis.__pccl2NativeTheme = nativeTheme
globalThis.__pccl2State = state
globalThis.__pccl2Settings = {
  get: () => ({ ...state.settings }),
  set: (patch) => { state.setCalls.push(patch); Object.assign(state.settings, patch); return { ...state.settings } },
}
globalThis.__pccl2Accounts = {
  all: () => ({ accounts: state.accounts, selectedId: state.selected }),
  selected: () => state.accounts.find(a => a.id === state.selected),
  list: () => state.accounts,
  upsert: account => { state.accounts.push(account); return state.accounts },
  remove: id => { state.accounts = state.accounts.filter(a => a.id !== id) },
  select: (id) => { if (!state.accounts.some(a => a.id === id)) return false; state.selected = id; return true },
}
globalThis.__pccl2Spawn = () => { proc = new FakeProc(); spawned.push(proc); return proc }
const mod = createRequire(import.meta.url)(output)
const ctx = { mainWindow: () => mainWindow, gameProcess: () => null, activeInstalls: new Map(), downloadAborts: new Map() }
const bridge = mod.registerPccl2Handlers(ctx)
const invoke = (name, event = {}, args) => ipc.get(name)(event, args)
const frame = (value) => Buffer.from(`${JSON.stringify(value)}\n`)
const waitFor = async (fn, timeout = 1000) => { const started = Date.now(); while (!fn()) { if (Date.now() - started > timeout) throw new Error('wait timeout'); await new Promise(r => setTimeout(r, 2)) } }
const lastReply = () => JSON.parse(proc.stdin.writes.at(-1))

try {
  await test('真实 WPF ui.ready 事件帧被接受（含分块与 CRLF）', async () => {
    const opening = invoke('pccl2:open')
    await waitFor(() => proc)
    proc.stdout.emit('data', Buffer.from('{"event":"ui.'))
    assert.equal(mainWindow.hidden, false)
    proc.stdout.emit('data', Buffer.from('ready"}\r\n'))
    if (process.env.PCCL2_LEGACY_HOST === '1') proc.stdout.emit('data', frame({id:'legacy-ready',method:'ui.ready',params:null}))
    await opening
    assert.equal(mainWindow.hidden, true)
  })
  await test('状态接口保留空 manifest URL 且不泄露凭据', async () => {
    const result = await invoke('pccl2:status')
    assert.equal(result.running, true)
    assert.equal(result.installed, true)
    const stateResult = await new Promise((resolve, reject) => { proc.stdin.writes.length = 0; proc.stdout.emit('data', frame({ id: 7, method: 'state.get' })); setTimeout(() => { try { resolve(lastReply().result) } catch (e) { reject(e) } }, 5) })
    assert.equal(stateResult.settings.selectedVersionId, '1.20.1')
    assert.equal('pccl2ManifestUrl' in stateResult.settings, false)
    assert.equal(JSON.stringify(stateResult).includes('SECRET'), false)
  })
  await test('ready 之前不会隐藏宿主窗口', async () => {
    bridge.stop(); mainWindow.hidden = false
    const opening = invoke('pccl2:open'); await waitFor(() => proc && proc !== spawned[0])
    assert.equal(mainWindow.hidden, false)
    proc.stdout.emit('data', frame({ id: 2, method: 'ui.ready' })); await opening
    assert.equal(mainWindow.hidden, true)
  })
  await test('进程提前退出会拒绝 open 并显示宿主窗口', async () => {
    bridge.stop(); mainWindow.hidden = false
    const opening = invoke('pccl2:open'); await waitFor(() => proc && proc !== spawned[1])
    proc.emit('exit', 1)
    await assert.rejects(opening, /closed before readiness|process exited/)
    assert.equal(mainWindow.hidden, false)
  })
  await test('NDJSON 有效请求必须以真实换行写出', async () => {
    const opening = invoke('pccl2:open'); await waitFor(() => proc && proc !== spawned[2]); proc.stdout.emit('data', frame({ id: 3, method: 'ui.ready' })); await opening
    proc.stdin.writes.length = 0; proc.stdout.emit('data', frame({ id: 8, method: 'state.get' })); await waitFor(() => proc.stdin.writes.length)
    assert.equal(proc.stdin.writes[0].endsWith('\n'), true)
    assert.equal(proc.stdin.writes[0].includes('\\n'), false)
  })
  await test('settings.set 只返回确认，不返回完整 settings', async () => {
    proc.stdin.writes.length = 0; proc.stdout.emit('data', frame({ id: 9, method: 'settings.set', params: { patch: { memoryMb: 4096 } } })); await waitFor(() => proc.stdin.writes.length)
    assert.deepEqual(lastReply().result, { ok: true })
    assert.equal(JSON.stringify(lastReply()).includes('pccl2ManifestUrl'), false)
  })
  await test('不支持的方法仍关联原 id 返回错误', async () => {
    proc.stdin.writes.length = 0; proc.stdout.emit('data', frame({ id: 'bad-1', method: 'nope' })); await waitFor(() => proc.stdin.writes.length)
    assert.equal(lastReply().id, 'bad-1'); assert.match(lastReply().error, /not allowed/)
  })
  await test('重复 id 与超过 32 个 inFlight 请求都被拒绝', async () => {
    proc.stdin.writes.length = 0; proc.stdout.emit('data', frame({ id: 10, method: 'state.get' })); proc.stdout.emit('data', frame({ id: 10, method: 'state.get' })); await waitFor(() => proc.stdin.writes.length >= 1)
    assert.equal(lastReply().error, 'duplicate request id')
    await settle()
    proc.stdin.writes.length = 0
    for (let i = 0; i < 33; i++) proc.stdout.emit('data', frame({ id: 100 + i, method: 'state.get' }))
    await waitFor(() => proc.stdin.writes.some(x => x.includes('too many requests')))
    assert.equal(proc.stdin.writes.filter(x => x.includes('too many requests')).length, 1)
    await settle()
    assert.equal(proc.stdin.writes.length, 33)
  })
  await test('restore 清理后恢复原主题并清除导航状态', async () => {
    nativeTheme.themeSource = 'light'; navEvents.length = 0
    proc.stdout.emit('data', frame({ id: 200, method: 'instances.manage', params: { versionId: '1.20.1' } })); await waitFor(() => navEvents.length)
    await invoke('pccl2:restore'); assert.equal(nativeTheme.themeSource, 'dark'); assert.equal(mainWindow.hidden, false)
  })
  await test('资源安装走真实下载编排并回传完成，不伪造页面导航', async () => {
    const previous = proc
    const opening = invoke('pccl2:open'); await waitFor(() => proc && proc !== previous); proc.stdout.emit('data', frame({ id: 201, method: 'ui.ready' })); await opening
    navEvents.length = 0
    proc.stdin.writes.length = 0
    proc.stdout.emit('data', frame({ id: 202, method: 'resources.install', params: { projectId: 'p', versionId: 'v', instanceId: 'i', type: 'mod' } }))
    try { await waitFor(() => proc.stdin.writes.some(x => x.includes('"installed":true'))) }
    catch (e) { console.error('资源安装未返回，当前输出：', proc.stdin.writes); throw e }
    assert.deepEqual(globalThis.__pccl2ResourceParams, { projectId: 'p', versionId: 'v', instanceId: 'i', type: 'mod' })
    assert.equal(navEvents.length, 0)
    assert.equal(lastReply().result.ok, true)
  })
  await test('运行中禁止 install，即使 manifest URL 为空', async () => {
    state.settings.pccl2ManifestUrl = ''
    const previous = proc
    const opening = invoke('pccl2:open')
    await new Promise(r => setTimeout(r, 15))
    assert.throws(() => invoke('pccl2:install'), /关闭原生界面/)
    proc.stdout.emit('data', frame({ id: 203, method: 'ui.ready', params: null })); await opening
    assert.throws(() => invoke('pccl2:install'), /关闭原生界面/)
  })
  await test('三个标题栏 Check 事件绑定独立 HCMCL 原生数据页', async () => {
    const root = 'PCCL2-PAK/src/PclFrontend/upstream/Plain Craft Launcher 2/'
    const form = await fs.readFile(root + 'FormMain.xaml.vb', 'utf8')
    for (const name of ['Accounts', 'Downloads', 'Instances']) assert.ok(form.includes(`BtnTitleHcmcl${name}.Check`))
    for (const mode of ['accounts', 'downloads', 'instances']) assert.ok(form.includes(`New PageHcmcl("${mode}")`))
    assert.ok(form.includes('FirstOrDefault(Function(b) Val(b.Tag) = CInt(Stack.Page))'))
    assert.equal(form.includes('PanTitleSelect.Children(Stack)'), false)
  })
  await test('原生账号接口真实增删选择且不返回凭据', async () => {
    const rpc = async (id, method, params) => {
      proc.stdin.writes.length = 0
      proc.stdout.emit('data', frame({id, method, params}))
      await waitFor(() => proc.stdin.writes.some(s => JSON.parse(s).id === id))
      return proc.stdin.writes.map(JSON.parse).find(r => r.id === id)
    }
    const add = await rpc(301, 'accounts.addOffline', {name:'PlayerTwo'})
    assert.equal(add.result.name, 'PlayerTwo')
    assert.equal('accessToken' in add.result, false)
    assert.equal(state.selected, add.result.id)
    const invalid = await rpc(302, 'accounts.addOffline', {name:'invalid name'})
    assert.ok(invalid.error)
    const remove = await rpc(303, 'accounts.remove', {accountId:add.result.id})
    assert.equal(remove.result.ok, true)
    assert.equal(state.accounts.some(a => a.id === add.result.id), false)
  })
  await test('下载任务页查询宿主队列且可取消指定下载', async () => {
    const controller = new AbortController()
    ctx.downloadAborts.set('download-a', controller)
    proc.stdin.writes.length = 0
    proc.stdout.emit('data', frame({id:310,method:'downloads.list'}))
    await waitFor(() => proc.stdin.writes.length)
    assert.ok(lastReply().result.some(t => t.id === 'download-a' && t.cancellable))
    proc.stdout.emit('data', frame({id:311,method:'downloads.cancel',params:{taskId:'download-a'}}))
    await waitFor(() => controller.signal.aborted)
    ctx.downloadAborts.clear()
  })
  if (process.env.PCCL2_REAL_NATIVE === '1') {
    for (const page of ['accounts', 'downloads', 'instances', 'launch']) {
      await test(`真实 WPF → 宿主握手 → ${page} 页面数据渲染`, async () => {
        bridge.stop(); mainWindow.hidden = false
        state.accounts = [{id:'test-account',name:'NativeTest',authType:'offline',offline:true}]
        state.selected = 'test-account'
        state.installed = [{id:'NativeTest-1.20.1',mcVersion:'1.20.1',loader:'fabric'}]
        ctx.downloadAborts.set('verification-task', new AbortController())
        const exe = resolve('PCCL2-PAK/src/artifacts/win-x64/PCCL2.Native.exe')
        const frames = []; let real = null; let incomplete = ''
        globalThis.__pccl2Spawn = () => {
          real = nativeSpawn(exe, ['--bridge-stdio'], {stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,HCMCL_VERIFY_PAGE:page}})
          real.stdout.on('data', chunk => {
            incomplete += chunk.toString('utf8')
            let end
            while ((end = incomplete.indexOf('\n')) >= 0) {
              const line = incomplete.slice(0,end); incomplete = incomplete.slice(end+1)
              try { frames.push(JSON.parse(line)) } catch {}
            }
          })
          return real
        }
        const start = Date.now()
        try {
          await invoke('pccl2:open')
          assert.equal(mainWindow.hidden, true)
          await waitFor(() => frames.some(f => f.event === 'ui.page' && f.page === page), 20000)
          const frame = frames.find(f => f.event === 'ui.page' && f.page === page)
          assert.ok(frame.rows > 0, '页面未渲染宿主数据行')
          if (page === 'accounts') assert.equal(frames.some(f => f.method === 'launch'), false, '选择账号页面不得自动启动游戏')
          if (page === 'launch') assert.ok(frames.some(f => f.method === 'launch'), '实例启动没有进入宿主启动链路')
          console.log(`  实测：ready ${Date.now()-start}ms 内完成，${frame.rows} 行数据`)
          if (page === 'accounts' && process.env.PCCL2_SOAK === '1') {
            await new Promise(r => setTimeout(r, 32000))
            assert.equal(real.exitCode, null, '原生窗口在握手完成后意外退出')
            assert.equal((await invoke('pccl2:status')).running, true)
            assert.equal(mainWindow.hidden, true, '宿主在超时后错误恢复，说明握手没有真正完成')
            assert.ok(frames.some(f => f.method === 'ui.ready'), '缺少旧宿主兼容 ready RPC')
            console.log('  存活验证：握手完成后 32 秒仍运行，宿主仍处于已连接状态')
          }
          if (process.env.PCCL2_KEEP_NATIVE === page) await new Promise(r => setTimeout(r, 90000))
        } finally {
          const exited = real && new Promise(r => real.once('exit', r))
          bridge.stop()
          if (exited && real.exitCode === null) await Promise.race([exited,new Promise(r => setTimeout(r,5000))])
          ctx.downloadAborts.clear()
        }
      })
    }
  }
  console.log(`结果：${passed} 通过 / 0 失败`)
} finally {
  try { bridge.stop() } catch {}
  await fs.rm(scratch, { recursive: true, force: true })
  for (const key of ['__pccl2App', '__pccl2IpcMain', '__pccl2NativeTheme', '__pccl2State', '__pccl2Settings', '__pccl2Accounts', '__pccl2Spawn']) delete globalThis[key]
}
