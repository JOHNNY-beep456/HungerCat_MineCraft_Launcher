import { createWriteStream, promises as fsp } from 'fs'
import { dirname } from 'path'

/**
 * 共享的流式/并行下载实现。大文件使用 HTTP Range 多连接分块下载以提升速度，
 * 小文件单连接下载；统一支持 AbortSignal 取消。
 */

const UA = { 'User-Agent': 'HungerCatLauncher/0.1' }
export const PARALLEL_THRESHOLD = 8 * 1024 * 1024 // 8 MB
export const PARALLEL_CHUNKS = 8
/** 连续多少毫秒未收到任何字节即判定「网络连接超时」。 */
const STALL_TIMEOUT_MS = 30_000

export interface StreamDownloadOptions {
  signal?: AbortSignal
  /** 每收到一块数据时回调（累计字节数由调用方统计）。 */
  onBytes?: (n: number) => void
  /** 已知总大小（可跳过 HEAD 探测）。 */
  onSize?: (size: number) => void
  /** 已知总大小提示（用于跳过 HEAD 探测）。 */
  sizeHint?: number
  /** 附加请求头（会覆盖默认 User-Agent，例如 CurseForge 需要浏览器 UA）。 */
  headers?: Record<string, string>
}

/** 下载 `url` 到 `dest`，自动在单连接与并行分块之间选择。 */
export async function streamDownload(url: string, dest: string, opts: StreamDownloadOptions = {}): Promise<void> {
  const { signal, onBytes, onSize, sizeHint } = opts
  await fsp.mkdir(dirname(dest), { recursive: true })

  let size = sizeHint ?? 0
  if (size <= 0) {
    try {
      const head = await fetch(url, { method: 'HEAD', headers: { ...UA, ...(opts.headers ?? {}) }, signal })
      const cl = Number(head.headers.get('content-length') ?? 0)
      if (cl > 0) size = cl
    } catch {
      /* server may not support HEAD; fall through */
    }
  }
  if (size > 0) onSize?.(size)

  // 组合外部取消信号与内部无进度超时信号。下载数据阶段若连续 STALL_TIMEOUT_MS
  // 未收到任何字节（速度始终为 0），判定为连接假死/挂起，强制中断并上报超时。
  const controller = new AbortController()
  let lastBytesAt = Date.now()
  const watchdog = setInterval(() => {
    if (Date.now() - lastBytesAt >= STALL_TIMEOUT_MS) {
      controller.abort(new Error('网络连接超时'))
    }
  }, 1000)
  const forwardAbort = (): void => controller.abort()
  signal?.addEventListener('abort', forwardAbort, { once: true })
  if (signal?.aborted) forwardAbort()

  const combined: StreamDownloadOptions = {
    ...opts,
    signal: controller.signal,
    onBytes: (n) => {
      lastBytesAt = Date.now()
      onBytes?.(n)
    }
  }

  try {
    if (size >= PARALLEL_THRESHOLD) {
      const ok = await parallelDownload(url, dest, size, combined)
      if (ok) return
    }
    await singleDownload(url, dest, combined)
  } catch (err) {
    // 用户主动取消优先；其次若因内部超时中断，统一报告网络连接超时。
    if (signal?.aborted) throw new Error('下载已取消')
    if (controller.signal.aborted) throw new Error('网络连接超时')
    throw err
  } finally {
    clearInterval(watchdog)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

async function singleDownload(url: string, dest: string, opts: StreamDownloadOptions): Promise<void> {
  const { signal, onBytes, headers } = opts
  const res = await fetch(url, { headers: { ...UA, ...(headers ?? {}) }, signal })
  if (!res.ok || !res.body) throw new Error(`下载失败 (HTTP ${res.status})`)
  const reader = res.body.getReader()
  const out = createWriteStream(dest)
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('下载已取消')
      const { done, value } = await reader.read()
      if (done) break
      onBytes?.(value.byteLength)
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((r) => out.once('drain', r))
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })
  } finally {
    out.destroy()
  }
}

/** 并行分块下载；服务器不支持 Range 时返回 false，由调用方回退单连接。 */
async function parallelDownload(
  url: string,
  dest: string,
  size: number,
  opts: StreamDownloadOptions
): Promise<boolean> {
  const { signal, onBytes, headers } = opts
  const tmp = `${dest}.part`
  const handle = await fsp.open(tmp, 'w')
  let succeeded = false
  try {
    const chunkSize = Math.ceil(size / PARALLEL_CHUNKS)
    const tasks: Array<Promise<boolean>> = []
    for (let start = 0; start < size; start += chunkSize) {
      const end = Math.min(start + chunkSize, size)
      tasks.push(
        (async (): Promise<boolean> => {
          if (signal?.aborted) throw new Error('下载已取消')
          const res = await fetch(url, {
            headers: { ...UA, ...(headers ?? {}), Range: `bytes=${start}-${end - 1}` },
            signal
          })
          if (res.status === 200) {
            // 服务器忽略了 Range，回退单连接
            return false
          }
          if (res.status !== 206 || !res.body) throw new Error(`下载失败 (HTTP ${res.status})`)
          const reader = res.body.getReader()
          let pos = start
          for (;;) {
            if (signal?.aborted) throw new Error('下载已取消')
            const { done, value } = await reader.read()
            if (done) break
            onBytes?.(value.byteLength)
            await handle.write(Buffer.from(value), 0, value.byteLength, pos)
            pos += value.byteLength
          }
          return true
        })()
      )
    }
    const results = await Promise.all(tasks)
    if (!results.every(Boolean)) {
      return false
    }
    await fsp.rename(tmp, dest)
    succeeded = true
    return true
  } finally {
    await handle.close().catch(() => {})
    if (!succeeded) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
    }
  }
}
