// ---------------------------------------------------------------------------
// 原生下载内核的加载与调用封装（网络进程侧）。
//
// 设计要点：
//   1. **可选依赖**：原生库是「加速器」而非必需品。加载失败（未编译 / 平台不匹配 /
//      ABI 问题）时返回 null，调用方自动回退到 stream-download.ts 的 TS 实现，
//      功能完全一致，只是速度不同。这样任何环境都能跑、打包也不会因缺库而崩。
//   2. **按平台目录定位**：产物位于 resources/native/<platform>-<arch>/，
//      开发态从仓库 resources/ 取，打包态从 process.resourcesPath/native/ 取。
//   3. **只做传输层**：这里只负责「URL → 文件」的多连接下载与进度/取消上报，
//      任务收集、SHA-1 校验、镜像回退仍留在 TS 侧。
// ---------------------------------------------------------------------------

import { existsSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'

/**
 * 传给原生内核的选项（与 Rust 侧 `NativeDownloadOptions` 字段一一对应）。
 *
 * 注意回调**不在**这里：napi 的 ThreadsafeFunction 不能作为 object 字段，
 * Rust 侧把 onBytes/onSize 拆成了 `download()` 的独立位置参数。
 */
interface NativeDownloadOptions {
  url: string
  dest: string
  sizeHint?: number | bigint
  connections?: number
  headers?: string[][]
}

interface NativeDownloadHandle {
  cancel: () => void
}

/**
 * 原生模块的导出面（与 native/downloader/src/lib.rs 对应）。
 *
 * 注意 `DownloadHandle` 是 napi 生成的**类**，必须用 `new` 创建才能拿到带
 * `cancel()` 的实例——早先用的是 `createHandle()` 工厂函数，改用构造函数后
 * 这个字段名也随之变化，这里必须同步，否则校验会一直失败、
 * 原生内核被静默降级成 TS（下载变慢且没有任何报错）。
 */
interface NativeModule {
  DownloadHandle: new () => NativeDownloadHandle
  download: (
    opts: NativeDownloadOptions,
    onBytes: ((n: number) => void) | undefined,
    onSize: ((size: bigint) => void) | undefined,
    handle: NativeDownloadHandle | undefined
  ) => Promise<{ bytes: bigint; parallel: boolean }>
}

/** 判断一个已加载的模块是否符合预期接口。 */
function isValidModule(mod: unknown): mod is NativeModule {
  const m = mod as Partial<NativeModule> | null
  return typeof m?.download === 'function' && typeof m?.DownloadHandle === 'function'
}

let cached: NativeModule | null | undefined

/** 当前平台的产物目录名，与 scripts/build-native-downloader.mjs 保持一致。 */
function platformDir(): string {
  const os =
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  return `${os}-${process.arch}`
}

/** 依次尝试「打包态 → 开发态」两处路径，返回第一个存在的 .node。 */
function resolveNativePath(): string | null {
  const filename = 'hungercat_downloader.node'
  const candidates: string[] = []
  // 打包态：electron-builder 的 extraResources 把 resources/native 拷到 resourcesPath/native。
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) candidates.push(join(resourcesPath, 'native', platformDir(), filename))
  // 开发态：直接从仓库根目录的 resources/native 读。
  candidates.push(join(process.cwd(), 'resources', 'native', platformDir(), filename))
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/**
 * 获取原生模块；不可用时返回 null 并只提示一次。
 *
 * 加载失败在预期之内（未编译该平台），因此用 info 级日志而非 error，
 * 避免在没装 Rust 工具链的开发机上刷出无意义的报错。
 */
export function loadNativeDownloader(): NativeModule | null {
  if (cached !== undefined) return cached

  const path = resolveNativePath()
  if (!path) {
    cached = null
    return cached
  }

  try {
    const require = createRequire(import.meta.url)
    const mod = require(path) as NativeModule
    if (!isValidModule(mod)) throw new Error('导出接口不符合预期')
    console.log(`[原生下载] 已加载加速内核：${path}`)
    cached = mod
  } catch (err) {
    console.warn('[原生下载] 加载失败，回退到 TS 下载器：', err)
    cached = null
  }
  return cached
}

/** 挂载在当前下载上的取消句柄：供 AbortSignal 触发原生侧取消。 */
export interface NativeCanceller {
  handle: NativeDownloadHandle
}

/**
 * 原生内核的可用性快照（供「进度」页展示当前实际使用的下载器）。
 *
 * 注意主进程与网络进程是两个独立的进程，各自持有自己的模块缓存，
 * 因此这里在主进程侧单独探测一次——结果用于界面展示，不影响真实下载路径。
 */
export interface NativeDownloaderStatus {
  /** 是否成功加载原生内核。 */
  available: boolean
  /** 解析到的 .node 绝对路径（未找到时为 null）。 */
  path: string | null
  /** 当前平台目录名，如 win32-x64；用于说明「为何没有该平台产物」。 */
  platform: string
}

export function nativeDownloaderStatus(): NativeDownloaderStatus {
  const path = resolveNativePath()
  let available = false
  if (path) {
    try {
      const require = createRequire(import.meta.url)
      available = isValidModule(require(path))
    } catch {
      available = false
    }
  }
  return { available, path, platform: platformDir() }
}

/**
 * 用原生内核下载 `url` 到 `dest`。
 *
 * @returns 成功时返回落盘字节数与是否走了多连接；**原生库不可用时返回 null**，
 *          由调用方回退到 TS 实现（这是唯一需要调用方处理的返回值）。
 */
export async function nativeStreamDownload(
  url: string,
  dest: string,
  opts: {
    signal?: AbortSignal
    onBytes?: (n: number) => void
    onSize?: (size: number) => void
    sizeHint?: number
    headers?: Record<string, string>
    connections?: number
  } = {}
): Promise<{ bytes: number; parallel: boolean } | null> {
  const native = loadNativeDownloader()
  if (!native) return null

  const handle = new native.DownloadHandle()

  // AbortSignal → 原生取消。取消是「尽力而为」：原生侧在最近的检查点退出。
  const onAbort = (): void => handle.cancel()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  if (opts.signal?.aborted) onAbort()

  try {
    const headers = opts.headers ? Object.entries(opts.headers) : undefined
    // 原生接口是位置参数：download(opts, onBytes, onSize, handle)。
    // 回调单独传（而非放进 opts）——ThreadsafeFunction 无法作为 napi object 字段。
    const res = await native.download(
      {
        url,
        dest,
        sizeHint: opts.sizeHint && opts.sizeHint > 0 ? opts.sizeHint : undefined,
        connections: opts.connections,
        headers
      },
      opts.onBytes,
      opts.onSize ? (size: bigint) => opts.onSize?.(Number(size)) : undefined,
      handle
    )
    return { bytes: Number(res.bytes), parallel: res.parallel }
  } catch (err) {
    // 原生侧抛出的消息与 TS 侧约定一致（含「下载已取消」「下载失败 (HTTP xxx)」），
    // 上层（downloader.ts）的镜像回退与重试逻辑可直接复用。
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
