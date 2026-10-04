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
  /**
   * 文件夹扫描（可选）。
   *
   * **必须标记为可选**：老版本编译出的 .node 不含这两个导出，若这里当成必需，
   * `isValidModule` 会把整个原生模块判为不可用 → 下载也会一起降级到 TS，
   * 造成「升级后下载反而变慢」的倒退。扫描能力缺失时只让扫描走 TS 回退即可。
   */
  scanFiles?: (
    dir: string,
    extensions: string[],
    handleDisabled: boolean
  ) => Promise<NativeScannedFile[]>
  scanDirs?: (parent: string, marker: string) => Promise<string[]>
  /**
   * 主页脚本静态安全检测（可选，同上：老 .node 缺失该导出只让检测回退 TS，不影响下载）。
   * `library` 表示分析的是取回的第三方脚本库正文。
   */
  analyzeHomepage?: (source: string, library: boolean) => Promise<NativeScannedRisk>
}

/** 原生扫描返回的文件条目（与 Rust `ScannedFile` 对应）。 */
export interface NativeScannedFile {
  name: string
  path: string
  /** napi 侧为 BigInt，这里由调用方转 number。 */
  size: bigint
  enabled: boolean
}

/** 原生主页检测返回的外链条目（与 Rust `ScannedExternal` 对应）。 */
export interface NativeScannedExternal {
  url: string
  kind: string
  /** 是否为「外链脚本」（内容需上层取回后再核对）。 */
  code: boolean
}

/** 原生主页检测结果（与 Rust `ScannedRisk` 对应）。 */
export interface NativeScannedRisk {
  /** safe | warn | reject */
  level: string
  blocks: string[]
  externals: NativeScannedExternal[]
}

/** 判断一个已加载的模块是否符合预期接口。 */
function isValidModule(mod: unknown): mod is NativeModule {
  const m = mod as Partial<NativeModule> | null
  // 只校验「传输层」必需项；扫描是可选增强，缺失不视为无效（见 NativeModule 注释）。
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
    // napi 的 `Option<BigInt>` 只接受 JS bigint，传 number 会在转换阶段直接抛
    // 「Error: on NativeDownloadOptions.sizeHint」。这里统一转成 bigint 再传。
    const sizeHint =
      opts.sizeHint && opts.sizeHint > 0 ? BigInt(Math.floor(opts.sizeHint)) : undefined
    // 原生接口是位置参数：download(opts, onBytes, onSize, handle)。
    // 回调单独传（而非放进 opts）——ThreadsafeFunction 无法作为 napi object 字段。
    const res = await native.download(
      {
        url,
        dest,
        sizeHint,
        connections: opts.connections,
        headers
      },
      opts.onBytes,
      opts.onSize ? (size: bigint) => opts.onSize?.(Number(size)) : undefined,
      handle
    )
    return { bytes: Number(res.bytes), parallel: res.parallel }
  } catch (err) {
    // 原生侧抛出的「网络类」错误（含「下载已取消」「下载失败 (HTTP xxx)」）语义与 TS 侧
    // 一致，上层 downloader.ts 的镜像回退与重试逻辑可直接复用，必须原样上抛。
    //
    // 但原生内核是「加速器」，任何**调用边界**上的故障（napi 参数转换失败、ABI 不匹配、
    // 模块内部 panic 等）都不应让整次下载失败——那会把用户可见的「安装失败」暴露出来，
    // 而实际只是加速器不可用。这类错误按「原生不可用」处理，返回 null 让调用方回退 TS。
    const decoded = decodeNativeError(err instanceof Error ? err.message : String(err))
    if (!isNativeFallbackError(decoded)) throw decoded
    console.warn('[原生下载] 调用失败，本次回退到 TS 下载器：', decoded.message)
    cached = null
    return null
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 原生侧错误的结构化解码。
 *
 * Rust 传输层把错误编码成 `message\u{1}code=..;status=..;retryAfter=..`（见 lib.rs
 * `NativeError::encode`）。这里还原成带 code/status/retryAfter 的 `Error`，
 * 让上层（downloader.ts）能按 **结构** 而非中文文案正则做镜像回退 / 退避决策。
 */
interface DecodedNativeError extends Error {
  code?: string
  status?: number
  retryAfter?: string
}

/** 分隔符：U+0001（控制字符），正常错误文案里不会出现。 */
const ERR_SEP = '\u0001'

function decodeNativeError(msg: string): DecodedNativeError {
  const idx = msg.lastIndexOf(ERR_SEP)
  const err = new Error(msg) as DecodedNativeError
  if (idx < 0) return err
  err.message = msg.slice(0, idx)
  for (const part of msg.slice(idx + 1).split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq)
    const v = part.slice(eq + 1)
    if (k === 'code') err.code = v
    else if (k === 'status') {
      const n = Number(v)
      if (Number.isFinite(n)) err.status = n
    } else if (k === 'retryAfter') err.retryAfter = v
  }
  return err
}

/**
 * 判断原生侧的报错是否属于「应回退 TS」的调用边界故障（而非真实下载错误）。
 *
 * 真实下载错误带有**结构化 code**（http / cancelled / timeout / network），
 * 语义与 TS 侧一致，必须原样上抛给上层做镜像回退与重试。
 * 其余（尤其 napi 转换错误 `on NativeDownloadOptions.*`、`Failed to convert`、
 * `panic` 等）一律视为原生不可用，回退 TS。
 *
 * 旧实现靠中文文案白名单（'取消' / 'HTTP ' / '超时' …）判断，改一个字就误判。
 */
function isNativeFallbackError(err: DecodedNativeError): boolean {
  if (err.code === 'http' || err.code === 'cancelled' || err.code === 'timeout' || err.code === 'network') {
    return false
  }
  // 没有结构化 code：可能是 napi 转换 / ABI / panic，一律回退。
  return true
}

/* ------------------------------------------------------------------ */
/* 文件夹扫描（可选增强；不可用时返回 null，由调用方回退到 TS 实现）        */
/* ------------------------------------------------------------------ */

/**
 * 用原生内核列出目录下的文件（可选按扩展名过滤、识别 `.disabled`）。
 *
 * @returns 成功返回条目数组（`size` 已转为 number）；**原生库不可用 / 不含该导出 /
 *          调用失败时返回 null**，调用方据此回退到 `fs.readdir` 的 TS 实现。
 *          注意：目录不存在时原生侧返回**空数组**（非 null），与 TS `catch → []` 一致。
 */
export async function nativeScanFiles(
  dir: string,
  extensions: string[],
  handleDisabled = false
): Promise<Array<{ name: string; path: string; size: number; enabled: boolean }> | null> {
  const native = loadNativeDownloader()
  if (!native || typeof native.scanFiles !== 'function') return null
  try {
    const files = await native.scanFiles(dir, extensions, handleDisabled)
    return files.map((f) => ({
      name: f.name,
      path: f.path,
      // BigInt → number：文件大小远小于 2^53，安全。
      size: Number(f.size),
      enabled: f.enabled
    }))
  } catch (err) {
    // 扫描失败（ABI 不匹配 / panic 等）按「原生不可用」处理，回退 TS。
    console.warn('[原生扫描] 调用失败，本次回退到 TS 实现：', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * 用原生内核列出「含标记文件的子目录」。
 *
 * `marker` 支持占位符 `{name}`（替换为子目录名），用于「版本目录须有 `<目录名>.json`」；
 * 否则按固定文件名匹配（用于「存档须有 `level.dat`」）。
 *
 * @returns 成功返回目录名数组；原生不可用 / 无该导出 / 调用失败时返回 null（回退 TS）。
 */
export async function nativeScanDirs(parent: string, marker: string): Promise<string[] | null> {
  const native = loadNativeDownloader()
  if (!native || typeof native.scanDirs !== 'function') return null
  try {
    return await native.scanDirs(parent, marker)
  } catch (err) {
    console.warn('[原生扫描] 调用失败，本次回退到 TS 实现：', err instanceof Error ? err.message : err)
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 主页脚本静态安全检测（可选增强；不可用时返回 null，由调用方回退到 TS）    */
/* ------------------------------------------------------------------ */

/**
 * 用原生内核做主页脚本的静态安全检测（危险规则扫描 + 外链采集）。
 *
 * @returns 成功返回检测结果；原生库不可用 / 不含该导出 / 调用失败时返回 null，
 *          调用方据此回退到 `homepage-analyzer.ts` 的 TS 实现。
 */
export async function nativeAnalyzeHomepage(
  source: string,
  library: boolean
): Promise<NativeScannedRisk | null> {
  const native = loadNativeDownloader()
  if (!native || typeof native.analyzeHomepage !== 'function') return null
  try {
    return await native.analyzeHomepage(source, library)
  } catch (err) {
    console.warn('[原生检测] 调用失败，本次回退到 TS 实现：', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * 主页安全检测是否由原生（Rust）内核承担。
 *
 * 供界面在**未使用 Rust**（未编译该平台产物 / 旧版 .node 不含该导出 / 加载失败）时
 * 给出非侵入式提示。只做能力探测，不触发任何检测。
 */
export function homepageSecurityUsesNative(): boolean {
  const native = loadNativeDownloader()
  return !!native && typeof native.analyzeHomepage === 'function'
}
