import { isTauri } from '@tauri-apps/api/core'
import { nativeInvoke as invoke } from './native-invoke'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { localizeBackendError, resolveBackendValue } from '@shared/backend-text'
import {
  launcherCallChannels, launcherEventChannels, launcherSendChannels,
  type LauncherCallChannel, type LauncherEventChannel, type LauncherEventMap,
  type LauncherSendChannel, type TauriBridgeOptions
} from './types'

const calls: ReadonlySet<string> = new Set(launcherCallChannels)
const sends: ReadonlySet<string> = new Set(launcherSendChannels)
const events: ReadonlySet<string> = new Set(launcherEventChannels)
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

function bridgeError(cause: unknown): Error {
  const localized = localizeBackendError(cause)
  if (localized instanceof Error) return localized
  return new Error(typeof localized === 'string' ? localized : 'Tauri 原生操作失败')
}

/** 嵌套 Uint8Array 不能按对象索引发给 Rust；音频在通用 JSON 协议里使用字节数组。 */
function encode(value: unknown, ancestors = new Set<object>(), depth = 0): JsonValue {
  if (depth > 64) throw new Error('原生调用参数嵌套过深')
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Uint8Array) return Array.from(value)
  if (typeof value !== 'object') throw new Error('原生调用参数不可序列化')
  if (ancestors.has(value)) throw new Error('原生调用参数含循环引用')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => encode(item, ancestors, depth + 1))
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error('原生调用只接受普通 JSON 对象')
    const result: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue }
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = encode(item, ancestors, depth + 1)
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}

export interface TauriTransport {
  readonly ready: Promise<void>
  call: <T>(channel: LauncherCallChannel, ...args: unknown[]) => Promise<T>
  send: (channel: LauncherSendChannel, ...args: unknown[]) => void
  subscribe: <K extends LauncherEventChannel>(channel: K) => (callback: (payload: LauncherEventMap[K]) => void) => () => void
  report: (operation: string, cause: unknown) => void
  dispose: () => void
}

/** 单一原生监听器；订阅同步生效，请求等到 listen 的异步注册完成后再发送。 */
export function createTauriTransport(options: TauriBridgeOptions = {}): TauriTransport {
  const listeners = new Map<LauncherEventChannel, Set<(payload: unknown) => void>>()
  let disposed = false
  let nativeUnlisten: UnlistenFn | undefined
  const report = (operation: string, cause: unknown): void => {
    const error = bridgeError(cause)
    if (options.onError) {
      try { options.onError({ operation, error }) } catch (handlerError: unknown) {
        console.error('Tauri 桥接错误处理器异常', bridgeError(handlerError))
      }
    } else console.error(`Tauri 桥接失败：${operation}`, error)
  }
  const release = (unlisten: UnlistenFn): void => {
    try { void Promise.resolve(unlisten()).catch((error: unknown) => report('event:unlisten', error)) }
    catch (error: unknown) { report('event:unlisten', error) }
  }
  const ready = Promise.resolve().then(async () => {
    if (disposed) throw new Error('Tauri 桥接已释放')
    if (!isTauri()) throw new Error('当前页面不在 Tauri 原生环境中')
    const unlisten = await listen<unknown>('launcher:event', ({ payload }) => {
      if (disposed || typeof payload !== 'object' || payload === null) return
      if (!('channel' in payload) || typeof payload.channel !== 'string' || !events.has(payload.channel)) return
      const channel = payload.channel as LauncherEventChannel
      // 事件负载里的三语文案（进度 / 状态 / 风险提示）按当前界面语言解析后再投递。
      const data: unknown = resolveBackendValue('payload' in payload ? payload.payload : undefined)
      // 快照仅用于稳定遍历；回调中的退订仍会立即阻止后面的投递。
      for (const callback of [...(listeners.get(channel) ?? [])]) {
        if (disposed || !listeners.get(channel)?.has(callback)) continue
        try { callback(data) } catch (error: unknown) { report(`event:${channel}:callback`, error) }
      }
    })
    if (disposed) {
      release(unlisten)
      throw new Error('Tauri 桥接在事件注册期间已释放')
    }
    nativeUnlisten = unlisten
  })
  // onX 的契约不能返回 Promise；其注册错误通过此专用通道报告，调用方仍可 await ready。
  void ready.catch((error: unknown) => { if (!disposed) report('event:listen', error) })
  return {
    ready,
    async call<T>(channel: LauncherCallChannel, ...args: unknown[]): Promise<T> {
      if (!calls.has(channel)) throw new Error('未公开的启动器调用通道')
      const encodedArgs = args.map((arg) => encode(arg))
      await ready
      if (disposed) throw new Error('Tauri 桥接已释放')
      // 未指定的可选位置参数编码为 null；Rust 端应按 Option/默认值解析，不得移动参数位置。
      try {
        // 返回值里的三语文案（错误以外的状态文本）同样按当前界面语言解析。
        return resolveBackendValue(await invoke<T>('launcher_call', { channel, args: encodedArgs }))
      } catch (cause: unknown) {
        // Rust 拒绝值统一为「简体 / 繁體 / English」三语串，这里取出当前语言那段。
        throw localizeBackendError(cause)
      }
    },
    send(channel, ...args) {
      if (!sends.has(channel)) { report('send', new Error('未公开的启动器发送通道')); return }
      // 日志是旁路，不得把它自己的拒绝再打印并重新送进 console 转发链。
      const debugLog = channel === 'debug:rendererLog'
      if (disposed && debugLog) return
      let encodedArgs: JsonValue[]
      try { encodedArgs = args.map((arg) => encode(arg)) }
      catch (error: unknown) { if (!debugLog) report(`send:${channel}`, error); return }
      void ready.then(async () => {
        if (disposed) { if (debugLog) return; throw new Error('Tauri 桥接已释放') }
        await invoke<void>('launcher_send', { channel, args: encodedArgs })
      }).catch((error: unknown) => { if (!debugLog) report(`send:${channel}`, error) })
    },
    subscribe<K extends LauncherEventChannel>(channel: K) {
      if (!events.has(channel)) throw new Error('未公开的启动器事件通道')
      return (callback: (payload: LauncherEventMap[K]) => void): (() => void) => {
        if (disposed) throw new Error('Tauri 桥接已释放')
        let active = true
        const handler = (payload: unknown): void => { if (active) callback(payload as LauncherEventMap[K]) }
        const bucket = listeners.get(channel) ?? new Set<(payload: unknown) => void>()
        listeners.set(channel, bucket)
        bucket.add(handler)
        return () => {
          if (!active) return
          active = false
          bucket.delete(handler)
          if (bucket.size === 0) listeners.delete(channel)
        }
      }
    },
    report,
    dispose() {
      if (disposed) return
      disposed = true
      listeners.clear()
      const unlisten = nativeUnlisten
      nativeUnlisten = undefined
      if (unlisten) release(unlisten)
    }
  }
}

export function detectTauriPlatform(): string {
  if (typeof navigator === 'undefined') return 'unknown'
  const agent = `${navigator.userAgent} ${navigator.platform}`.toLowerCase()
  if (/android/.test(agent)) return 'android'
  if (/iphone|ipad|ipod/.test(agent) || (/mac/.test(agent) && navigator.maxTouchPoints > 1)) return 'ios'
  if (/windows|win32|win64/.test(agent)) return 'win32'
  if (/mac/.test(agent)) return 'darwin'
  if (/linux|x11/.test(agent)) return 'linux'
  return 'unknown'
}
export function isTauriMobile(platform = detectTauriPlatform()): boolean { return platform === 'android' || platform === 'ios' }

function nativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 1 && value.length <= 32768 && !/[\u0000-\u001f]/.test(value) &&
    (/^\/(?!\/)/.test(value) || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value)) &&
    !/^\\\\[?.][\\/]/.test(value) && !/^[a-z]:[\\/]fakepath[\\/]/i.test(value) &&
    !value.split(/[\\/]/).some((part) => part === '..')
}
function basename(path: string): string { return path.replace(/\\/g, '/').split('/').pop() ?? '' }

/**
 * File 没有标准的本机路径 API。这里只返回原生 drop 30 秒内的唯一同名提示或非标准 File.path，
 * 不推导 fakepath、不发同步 IPC、不把提示当作文件授权。Rust 仍须验证路径与用户选择范围。
 * 原生 drop 开启时部分 Webview 不再产生 DOM File/drop；这种情况现有 React 拖放需另行接入。
 */
export function createNativeDropPathCache(report: TauriTransport['report']): { getPathForFile: (file: File) => string; dispose: () => void } {
  let disposed = false
  let unlisten: UnlistenFn | undefined
  let expires = 0
  let paths: string[] = []
  const release = (callback: UnlistenFn): void => {
    try { void Promise.resolve(callback()).catch((error: unknown) => report('drop:unlisten', error)) }
    catch (error: unknown) { report('drop:unlisten', error) }
  }
  void Promise.resolve().then(async () => {
    if (disposed || !isTauri()) return
    const listener = await getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (disposed) return
      if (payload.type === 'drop') {
        paths = payload.paths.filter(nativePath).slice(0, 256)
        expires = Date.now() + 30000
      } else if (payload.type === 'enter' || payload.type === 'leave') { paths = []; expires = 0 }
    })
    if (disposed) release(listener)
    else unlisten = listener
  }).catch((error: unknown) => { if (!disposed) report('drop:listen（文件路径提示不可用）', error) })
  return {
    getPathForFile(file) {
      if (disposed) return ''
      // 某些桌面 Webview 扩展仍提供 path；只作提示，不能越过后端的选择/路径校验。
      const hint: unknown = 'path' in file ? file.path : undefined
      if (nativePath(hint) && basename(hint) === file.name) return hint
      if (Date.now() > expires) return ''
      const matches = paths.filter((path) => basename(path) === file.name)
      return matches.length === 1 ? matches[0] : ''
    },
    dispose() {
      if (disposed) return
      disposed = true
      paths = []
      expires = 0
      if (unlisten) release(unlisten)
      unlisten = undefined
    }
  }
}
