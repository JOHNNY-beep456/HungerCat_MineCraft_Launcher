/** PCCL2 native WPF stdio bridge. The wire is deliberately tiny and allow-listed. */
import { app, ipcMain, nativeTheme } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { StringDecoder } from 'string_decoder'
import type { IpcContext } from '../handlers/context'
import { launchGame, stopGame } from '../handlers/launch'
import { settings, accounts, createOfflineAccount, activeGameDir, allVersionDirs } from '../store'
import { DeviceCodeSession } from '../auth'
import { fetchVersionManifest, resolveVersionJson } from '../versions'
import { listInstalled } from '../installed'
import { installVersion } from '../downloader'
import { loaderVersions } from '../loaders'
import { effectiveConcurrency } from '../network-profile'
import { searchResources, resolveVersionsFor, resolveProjectDetail } from '../sources'
import { getComponentStatus, installComponent, getInstalledExecutable, ensureDotNet48 } from './component'
import { nativeInstallResource } from './resources'
import { nativeResourceMetadata } from './resource-metadata'
import { getCurseforgeKey, setCurseforgeKey } from '../secret'
import type { LaunchOptions, LauncherSettings } from '@shared/types'

const MAX_FRAME = 1024 * 1024
const READY_TIMEOUT = 10_000
const METHODS = new Set([
  'ui.ready', 'state.get', 'installed.list', 'versions.manifest', 'versions.install',
  'launch', 'launch.stop', 'accounts.select', 'settings.set', 'shell.restore',
  'loaders.versions', 'accounts.addOffline', 'accounts.remove', 'auth.begin', 'auth.status', 'auth.cancel', 'downloads.list',
  'downloads.cancel', 'resources.search', 'resources.versions', 'resources.project', 'resources.install',
  'instances.manage', 'accounts.manage', 'downloads.manage', 'resources.metadata', 'resources.keyStatus', 'resources.setKey'
])
const SOURCE_VALUES = new Set(['auto', 'mirror-first', 'official-first'])
const LANGUAGE_VALUES = new Set(['zh-CN', 'zh-TW', 'en'])
const VERSION_ID = /^[A-Za-z0-9_.+-]+$/

type NativeRequest = { id?: unknown; method?: unknown; params?: unknown }
type NativeNavigation = { page: string; versionId?: string; projectId?: string; resourceVersionId?: string; instanceId?: string }

function stringField(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 512) throw new Error(`invalid ${name}`)
  return v.trim()
}
function optionalString(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  return stringField(v, name)
}
function finiteInt(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw new Error(`invalid ${name}`)
  return v
}
function manifestUrl(): string {
  const url = (settings.get() as LauncherSettings).pccl2ManifestUrl
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) throw new Error('PCCL2 manifest URL is not configured')
  return url
}
function safeAccount(a: any): unknown {
  if (!a || typeof a !== 'object') return null
  return {
    id: typeof a.id === 'string' ? a.id : '',
    name: typeof a.name === 'string' ? a.name : '',
    uuid: typeof a.uuid === 'string' ? a.uuid : typeof a.id === 'string' ? a.id : '',
    skinUrl: typeof a.skinUrl === 'string' ? a.skinUrl : undefined,
    offline: a.offline === true || a.authType === 'offline',
    authType: typeof a.authType === 'string' ? a.authType : (a.offline === true ? 'offline' : 'microsoft')
  }
}
async function projectedState(): Promise<unknown> {
  const s = settings.get() as LauncherSettings
  const f = accounts.all()
  const installed = await listInstalled(activeGameDir(s), s.versionIsolation, s.isolatedVersions)
  return {
    settings: {
      memoryMb: s.memoryMb,
      language: s.language,
      downloadSource: s.downloadSource,
      versionIsolation: s.versionIsolation,
      selectedVersionId: s.selectedVersionId
    },
    accounts: f.accounts.map(safeAccount),
    selectedAccount: safeAccount(accounts.selected()),
    selectedAccountId: f.selectedId,
    installed,
    versionDirs: allVersionDirs(s),
    gameDir: activeGameDir(s)
  }
}

export interface Pccl2Bridge {
  open(): Promise<{ pid: number }>
  stop(): void
}

export function registerPccl2Handlers(ctx: IpcContext): Pccl2Bridge {
  let child: ChildProcessWithoutNullStreams | null = null
  let oldTheme: typeof nativeTheme.themeSource = nativeTheme.themeSource
  let readyResolve: (() => void) | null = null
  let readyReject: ((e: Error) => void) | null = null
  let openPromise: Promise<{ pid: number }> | null = null
  let restored = false
  let shuttingDown = false
  const inFlight = new Set<unknown>()
  let decoder = new StringDecoder('utf8')
  let buffer = ''
  let navigation: NativeNavigation | null = null
  let login: DeviceCodeSession | null = null
  let loginStatus: Record<string, unknown> = { state: 'idle' }

  const showElectron = (): void => {
    const w = ctx.mainWindow()
    if (w && !w.isDestroyed()) w.show()
  }
  const sendNavigation = (n: NativeNavigation): void => {
    const w = ctx.mainWindow()
    if (w && !w.isDestroyed()) w.webContents.send('pccl2:navigate', n)
  }
  const cleanup = (show = true): void => {
    if (restored && !child) { if (show && !shuttingDown) showElectron(); return }
    restored = true
    const proc = child
    child = null
    login?.cancel(); login = null; loginStatus = { state: 'idle' }
    readyReject?.(new Error('PCCL2 bridge closed before readiness'))
    readyResolve = null
    readyReject = null
    decoder.end()
    buffer = ''
    if (proc) { try { proc.removeAllListeners(); proc.kill() } catch { /* already exited */ } }
    nativeTheme.themeSource = oldTheme
    if (show && !shuttingDown) showElectron()
    navigation = null
  }
  const send = (value: unknown): void => {
    const proc = child
    if (!proc || !proc.stdin.writable) return
    const line = JSON.stringify(value)
    if (Buffer.byteLength(line, 'utf8') > MAX_FRAME) return
    proc.stdin.write(`${line}\n`)
  }
  const reply = (id: unknown, result?: unknown, error?: string): void => {
    if (error === undefined) send({ id, result })
    else send({ id, error: error.slice(0, 1000) })
  }
  const waitReady = (): Promise<void> => new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })

  const handle = async (req: NativeRequest): Promise<unknown> => {
    if (!req || typeof req !== 'object' || typeof req.method !== 'string' || !METHODS.has(req.method)) throw new Error('method not allowed')
    const p = req.params == null ? {} : req.params
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('invalid params')
    switch (req.method) {
      case 'ui.ready': readyResolve?.(); return { ok: true }
      case 'state.get': return projectedState()
      case 'installed.list': {
        const s = settings.get(); return listInstalled(activeGameDir(s), s.versionIsolation, s.isolatedVersions)
      }
      case 'versions.manifest': return fetchVersionManifest()
      case 'versions.install': {
        const id = stringField((p as any).versionId, 'versionId')
        if (!VERSION_ID.test(id)) throw new Error('invalid versionId')
        const s = settings.get(); const dir = activeGameDir(s)
        const key = ctx.installKey(id)
        if (ctx.activeInstalls.has(key) || ctx.downloadAborts.has(id)) throw new Error('install already running')
        const c = new AbortController(); ctx.downloadAborts.set(id, c)
        const owner = child
        const eff = effectiveConcurrency(s.downloadAcceleration, s.downloadConnections, s.maxDownloadConcurrency)
        const job = (async () => {
          const json = await resolveVersionJson(id, dir)
          const result = await installVersion(json, dir, eff.fileConcurrency, (x) => {
            if (child === owner) send({ event: 'progress', data: { ...x, taskId: id } })
          }, c.signal, eff.connections)
          ctx.installedCache.invalidateAll()
          return result
        })().finally(() => ctx.downloadAborts.delete(id))
        ctx.activeInstalls.set(key, job); try { return await job } finally { ctx.activeInstalls.delete(key) }
      }
      case 'launch': {
        if (ctx.gameProcess() && ctx.gameProcess()!.exitCode === null && !ctx.gameProcess()!.killed) throw new Error('game already running')
        const versionId = stringField((p as any).versionId, 'versionId'); const accountId = stringField((p as any).accountId, 'accountId')
        const s = settings.get(); const installed = await listInstalled(activeGameDir(s), s.versionIsolation, s.isolatedVersions)
        if (!installed.some((v) => v.id === versionId)) throw new Error('version is not installed')
        if (!accounts.list().some((a) => a.id === accountId)) throw new Error('account does not exist')
        const memoryMb = (p as any).memoryMb === undefined ? s.memoryMb : finiteInt((p as any).memoryMb, 'memoryMb', 512, 65536)
        const opts: LaunchOptions = { versionId, accountId, gameDir: activeGameDir(s), memoryMb }
        return launchGame(ctx, opts, (x) => send({ event: 'progress', data: x }), (x) => send({ event: 'progress', data: x }))
      }
      case 'launch.stop': return stopGame(ctx)
      case 'loaders.versions': {
        const kind = stringField((p as any).kind, 'kind')
        if (!['fabric', 'neoforge', 'forge'].includes(kind)) throw new Error('unsupported loader kind')
        return loaderVersions(kind as any, stringField((p as any).mcVersion, 'mcVersion'))
      }
      case 'accounts.addOffline': {
        const name = stringField((p as any).name, 'name')
        if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error('玩家名须为 3–16 位英文字母、数字或下划线')
        const account = createOfflineAccount(name)
        accounts.upsert(account); accounts.select(account.id)
        return safeAccount(account)
      }
      case 'accounts.remove': {
        const id = stringField((p as any).accountId, 'accountId')
        if (!accounts.list().some(a => a.id === id)) throw new Error('account does not exist')
        accounts.remove(id); return { ok: true }
      }
      case 'auth.begin': {
        login?.cancel()
        const session = new DeviceCodeSession(); login = session
        loginStatus = { state: 'starting' }
        try {
          const info = await session.begin(status => {
            if (login !== session) return
            if (status.state === 'success') {
              accounts.upsert(status.account); accounts.select(status.account.id)
              loginStatus = { state: 'success', account: safeAccount(status.account) }
            } else loginStatus = { ...status }
          })
          return { userCode: info.userCode, verificationUri: info.verificationUri, expiresIn: info.expiresIn, message: info.message }
        } catch (e) {
          loginStatus = { state: 'error', error: e instanceof Error ? e.message : String(e) }; throw e
        }
      }
      case 'auth.status': return loginStatus
      case 'auth.cancel': login?.cancel(); login = null; loginStatus = { state: 'idle' }; return { ok: true }
      case 'downloads.list': {
        const ids = new Set([...ctx.activeInstalls.keys(), ...ctx.downloadAborts.keys()])
        return [...ids].map(id => ({ id, title: id, state: 'running', cancellable: ctx.downloadAborts.has(id) }))
      }
      case 'accounts.select': {
        const accountId = stringField((p as any).accountId, 'accountId'); if (!accounts.select(accountId)) throw new Error('account does not exist'); return true
      }
      case 'settings.set': {
        const patch = (p as any).patch
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('invalid patch')
        const allowed: Record<string, (v: unknown) => unknown> = {
          memoryMb: (v) => finiteInt(v, 'memoryMb', 512, 65536),
          selectedVersionId: (v) => stringField(v, 'selectedVersionId'),
          versionIsolation: (v) => { if (typeof v !== 'boolean') throw new Error('invalid versionIsolation'); return v },
          language: (v) => { if (typeof v !== 'string' || !LANGUAGE_VALUES.has(v)) throw new Error('invalid language'); return v },
          downloadSource: (v) => { if (typeof v !== 'string' || !SOURCE_VALUES.has(v)) throw new Error('invalid downloadSource'); return v }
        }
        const clean: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(patch)) {
          const fn = allowed[k]; if (!fn) throw new Error(`unsupported setting: ${k}`)
          clean[k] = fn(v)
        }
        if (clean.selectedVersionId !== undefined) {
          const s = settings.get()
          const installed = await listInstalled(activeGameDir(s), s.versionIsolation, s.isolatedVersions)
          if (!installed.some((v) => v.id === clean.selectedVersionId)) throw new Error('version is not installed')
        }
        settings.set(clean)
        return { ok: true }
      }
      case 'shell.restore': cleanup(true); return true
      case 'downloads.cancel': {
        const taskId = optionalString((p as any).taskId, 'taskId')
        if (taskId) ctx.downloadAborts.get(taskId)?.abort(); else for (const c of ctx.downloadAborts.values()) c.abort()
        return true
      }
      case 'resources.search': return searchResources({ source: 'all', query: stringField((p as any).query, 'query'), limit: 24, type: (p as any).type ?? 'mod', gameVersion: optionalString((p as any).mcVersion, 'mcVersion'), loader: optionalString((p as any).loader, 'loader'), offset: Math.max(0, Number((p as any).offset) || 0) })
      case 'resources.versions': {
        const slug = stringField((p as any).projectId, 'projectId')
        const detail = await resolveProjectDetail(slug, (p as any).type ?? 'mod') as { slug?: string; source?: 'curseforge' | 'modrinth'; project_type?: string }
        if (!detail || typeof detail.slug !== 'string') throw new Error('project not found')
        return resolveVersionsFor(detail.slug, detail.source, (p as any).type ?? 'mod', (p as any).loader ? [stringField((p as any).loader, 'loader')] : [], (p as any).mcVersion ? [stringField((p as any).mcVersion, 'mcVersion')] : [])
      }
      case 'resources.keyStatus': return { configured: !!getCurseforgeKey() || !!process.env.HCMCL_CURSEFORGE_API_KEY }
      case 'resources.setKey': {
        const key = (p as any).key
        if (typeof key !== 'string' || key.length > 512) throw new Error('invalid CurseForge key')
        const error = setCurseforgeKey(key)
        if (error) throw new Error(error)
        return { configured: !!key.trim() }
      }
      case 'resources.metadata': return nativeResourceMetadata(p as { url?: unknown; method?: unknown; content?: unknown })
      case 'resources.project': return resolveProjectDetail(stringField((p as any).projectId, 'projectId'), (p as any).type ?? 'mod')
      case 'resources.install': {
        const owner = child
        return nativeInstallResource(ctx, {
          projectId: (p as any).projectId,
          versionId: (p as any).versionId ?? (p as any).resourceVersionId,
          instanceId: (p as any).instanceId,
          type: (p as any).type
        }, (progress) => { if (child === owner) send({ event: 'progress', data: progress }) })
      }
      case 'instances.manage': case 'accounts.manage': case 'downloads.manage': {
        const target = req.method === 'accounts.manage' ? 'accounts' : req.method === 'downloads.manage' ? 'downloads' : 'instances'
        navigation = { page: target, ...(optionalString((p as any).versionId, 'versionId') ? { versionId: String((p as any).versionId) } : {}) }
        sendNavigation(navigation); cleanup(true); return { handledByHost: true, status: 'navigated' }
      }
      default: throw new Error('method not allowed')
    }
  }
  const onData = (chunk: Buffer): void => {
    buffer += decoder.write(chunk)
    if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME * 2) { cleanup(true); return }
    let i = -1
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, ''); buffer = buffer.slice(i + 1)
      if (!line) continue
      if (Buffer.byteLength(line, 'utf8') > MAX_FRAME) continue
      let req: NativeRequest
      try { req = JSON.parse(line) as NativeRequest } catch { continue }
      const lifecycle = req as unknown as { event?: unknown }
      // 完整 VB/WPF 前端发送事件帧；兼容旧版的 ui.ready RPC 请求。
      if (lifecycle.event === 'ui.ready') { readyResolve?.(); continue }
      if (lifecycle.event === 'exit' || lifecycle.event === 'error') { cleanup(true); continue }
      if (lifecycle.event !== undefined) continue
      if (req.id === undefined || inFlight.has(req.id)) { if (req.id !== undefined) reply(req.id, undefined, 'duplicate request id'); continue }
      if (inFlight.size >= 32) { reply(req.id, undefined, 'too many requests'); continue }
      inFlight.add(req.id)
      const owner = child
      void handle(req).then((r) => { if (child === owner) reply(req.id, r) }).catch((e) => {
        if (child === owner) reply(req.id, undefined, e instanceof Error ? e.message : String(e))
      }).finally(() => inFlight.delete(req.id))
    }
  }
  const open = async (): Promise<{ pid: number }> => {
    if (openPromise) return openPromise
    if (child) return { pid: child.pid ?? 0 }
    openPromise = (async () => {
      await ensureDotNet48()
      const exe = await getInstalledExecutable()
      oldTheme = nativeTheme.themeSource; restored = false; shuttingDown = false
      decoder = new StringDecoder('utf8'); buffer = ''; inFlight.clear()
      const wait = waitReady()
      const proc = spawn(exe, ['--bridge-stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      child = proc; proc.stdout.on('data', onData)
      proc.stderr.resume()
      proc.stdin.on('error', () => { if (child === proc) cleanup(true) })
      proc.once('error', () => { if (child === proc) cleanup(true) }); proc.once('exit', () => { if (child === proc) cleanup(true) })
      const timer = setTimeout(() => readyReject?.(new Error('PCCL2 native UI readiness timeout')), READY_TIMEOUT)
      try {
        await wait; clearTimeout(timer)
        if (child !== proc) throw new Error('PCCL2 process exited')
        readyResolve = null; readyReject = null
        ctx.mainWindow()?.hide(); return { pid: proc.pid ?? 0 }
      }
      catch (e) { clearTimeout(timer); cleanup(true); throw e }
    })().finally(() => { openPromise = null })
    return openPromise
  }
  ipcMain.handle('pccl2:status', async () => ({ ...await getComponentStatus(), running: !!child }))
  ipcMain.handle('pccl2:install', () => {
    if (child || openPromise) throw new Error('请先关闭原生界面再更新组件')
    if (settings.get().mode === 'local') throw new Error('本地模式不允许联网下载组件')
    return installComponent(manifestUrl(), (progress) => {
      const w = ctx.mainWindow()
      if (w && !w.isDestroyed()) w.webContents.send('pccl2:progress', progress)
    })
  })
  ipcMain.handle('pccl2:open', open)
  ipcMain.handle('pccl2:restore', () => { cleanup(true); return true })
  app.once('before-quit', () => { shuttingDown = true; cleanup(false) })
  return { open, stop: () => cleanup(true) }
}
