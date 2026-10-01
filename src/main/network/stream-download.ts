import { createWriteStream, promises as fsp } from 'fs'
import type { FileHandle } from 'fs/promises'
import { dirname } from 'path'

/**
 * 共享的流式/并行下载实现（网络进程侧）。
 *
 * 从主进程迁入：主进程 `src/main/stream-download.ts` 现为 broker 代理，把下载执行委托
 * 到此处的传输层。**大文件动态分段多连接、小文件单连接、AbortSignal 取消、
 * 10s 停滞看门狗** 全部在本进程生效，由网络进程统一油断，不再占用后端事件循环。
 *
 * 大文件采用「动态分段」策略（思路参考 Neat Download Manager 一类下载器的分段调度，
 * 本实现为独立编写）：
 *   1. 把文件切成比连接数更多的「小段」，放入共享队列；
 *   2. 一组连接从中领取并下载，快连接下载完立刻领下一段，不会像固定分块那样空等慢连接；
 *   3. 每段自带重试与「从已写入位置续传」，单条连接假死/断流只影响本段，不再整文件重下。
 */

const UA = { 'User-Agent': 'HungerCatLauncher/0.1' }
export const PARALLEL_THRESHOLD = 2 * 1024 * 1024 // 2 MB：模组 / 资源包多为 1–8 MB，阈值过高会让它们只能单连接慢速下载
/** 单个文件的最大并发连接数（动态分段下的「连接池」大小）。 */
export const PARALLEL_CHUNKS = 8
/**
 * 动态分段参数：目标段数远多于连接数，空闲连接总能立刻领到下一段。
 * 段大小再按文件大小自适应并夹在 [MIN, MAX] 之间——请求数量与单段大小都不失控。
 */
const TARGET_SEGMENTS = PARALLEL_CHUNKS * 4
const MIN_SEGMENT_SIZE = 1 * 1024 * 1024 // 1 MB
const MAX_SEGMENT_SIZE = 16 * 1024 * 1024 // 16 MB
/** 单个分段的最大尝试次数：每次失败都从已写入位置续传，而非从头再来。 */
const SEGMENT_ATTEMPTS = 3
/** 连续多少毫秒未收到任何字节即判定「网络连接超时」。统一为 10s，防止下载线程永久挂起。 */
const STALL_TIMEOUT_MS = 10_000

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

/* ---------- 瞬时 HTTP 错误（429 限流 / 408 / 5xx）自动重试 ---------- */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

/** 错误响应正文的读取上限：只取一小段，够透出服务端的中文说明即可。 */
const ERROR_BODY_LIMIT = 4 * 1024

/** 压缩成单行，避免把多行正文塞进错误消息后难以阅读。 */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 读取错误响应正文（最多 ERROR_BODY_LIMIT 字节）。
 * 服务端（如 script.php）在 4xx 时会用正文写中文原因，这里取回来附到错误消息上，
 * 让上层（主进程 / 渲染层）能透出具体说明，而不是只剩一个 HTTP 状态码。
 */
async function readErrorBody(res: Response): Promise<string> {
  try {
    const reader = res.body?.getReader()
    if (!reader) return ''
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      chunks.push(Buffer.from(value))
      if (total >= ERROR_BODY_LIMIT) {
        await reader.cancel().catch(() => {})
        break
      }
    }
    return Buffer.concat(chunks).subarray(0, ERROR_BODY_LIMIT).toString('utf-8')
  } catch {
    return ''
  }
}

async function httpError(
  status: number,
  res: Response
): Promise<Error & { status: number; retryAfter?: string }> {
  const e = new Error(`下载失败 (HTTP ${status})`) as Error & { status: number; retryAfter?: string }
  e.status = status
  const ra = res.headers.get('retry-after')
  if (ra) e.retryAfter = ra
  // 把服务端正文里的说明拼进消息：跨进程只传 message，附加字段会丢失，必须放进 message。
  const body = oneLine(await readErrorBody(res))
  if (body) e.message = `下载失败 (HTTP ${status})：${body}`
  return e
}
function retryDelayMs(err: { status?: number; retryAfter?: string }, attempt: number): number {
  // 优先尊重服务器返回的 Retry-After（429 限流时服务器常给出等待秒数）
  if (err.retryAfter) {
    const m = Number(err.retryAfter)
    if (Number.isFinite(m) && m > 0) return Math.min(m * 1000, 30_000)
  }
  const base = err.status === 429 ? 3000 : 1200
  return Math.min(base * Math.pow(2, attempt), 20_000)
}

/** 下载 `url` 到 `dest`，自动在单连接与动态分段之间选择；瞬时 HTTP 限流自动退避重试。 */
export async function streamDownload(url: string, dest: string, opts: StreamDownloadOptions = {}): Promise<void> {
  await fsp.mkdir(dirname(dest), { recursive: true })
  let attempt = 0
  for (;;) {
    try {
      await streamOnce(url, dest, opts)
      return
    } catch (err) {
      const status = (err as { status?: number } | null)?.status
      const transient = status != null && TRANSIENT_STATUS.has(status) && attempt + 1 < 4
      // 用户主动取消时直接透传
      if (opts.signal?.aborted) throw err
      if (!transient) throw err
      // 重试前清掉上次可能残留的部分文件（单连接写 dest，并行分块写 dest.part）
      await fsp.rm(dest, { force: true }).catch(() => {})
      await fsp.rm(`${dest}.part`, { force: true }).catch(() => {})
      await new Promise<void>((r) => setTimeout(r, retryDelayMs(err as { status?: number; retryAfter?: string }, attempt)))
      attempt++
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 解析 `Content-Range: bytes <start>-<end>/<total>` 的起始偏移；解析不出返回 null。 */
function parseContentRangeStart(value: string | null): number | null {
  if (!value) return null
  const m = /bytes\s+(\d+)\s*-/i.exec(value)
  return m ? Number(m[1]) : null
}

/** 按文件大小推导分段大小：目标段数 = 连接数 × 4，再夹在 [1MB, 16MB]。 */
function segmentSizeFor(size: number): number {
  const ideal = Math.ceil(size / TARGET_SEGMENTS)
  return Math.min(MAX_SEGMENT_SIZE, Math.max(MIN_SEGMENT_SIZE, ideal))
}

/** 分段重试退避：复用瞬时错误的退避策略，但封顶更短，避免单段长时间空等。 */
function segmentDelayMs(err: { status?: number; retryAfter?: string } | null, attempt: number): number {
  return Math.min(retryDelayMs(err ?? {}, attempt), 8_000)
}

async function streamOnce(url: string, dest: string, opts: StreamDownloadOptions): Promise<void> {
  const { signal, onSize, sizeHint } = opts
  await fsp.mkdir(dirname(dest), { recursive: true })

  let size = sizeHint ?? 0
  // 分段下载必须打在「真正提供 Range 的那台主机」上：CurseForge 的 edge.forgecdn.net
  // 会 302 到 mediafilez.forgecdn.net，而前者对带 Range 的请求直接回 404（后者才回 206）。
  // 因此跟随一次重定向拿到最终地址。
  let direct = url
  // 只有「大小未知」或「要走分段」时才探测：
  //   * 大小未知：HEAD 顺便取 content-length；
  //   * 已知且要走分段：仍需 HEAD 解析重定向。
  // 已知大小且是小文件时**完全跳过 HEAD**——这一步在重定向 CDN 上要约 1s，
  // 而模组/资源包绝大多数都是小文件，逐个 HEAD 是下载慢的主因。
  if (size <= 0 || size >= PARALLEL_THRESHOLD) {
    try {
      const head = await fetch(url, { method: 'HEAD', headers: { ...UA, ...(opts.headers ?? {}) }, signal })
      const cl = Number(head.headers.get('content-length') ?? 0)
      if (size <= 0 && cl > 0) size = cl
      if (head.url && head.url !== url) direct = head.url
    } catch {
      /* 服务器不支持 HEAD 时忽略，退化为单连接 */
    }
  }
  if (size > 0) onSize?.(size)

  // 大文件优先动态分段；服务器不支持 Range（返回 200）时并行流程返回 false，回退单连接。
  if (size >= PARALLEL_THRESHOLD) {
    const ok = await parallelDownload(direct, dest, size, opts)
    if (ok) {
      // 防御：若 sizeHint 与实际文件不符（服务端换了同名的另一个文件），分段下载会按
      // sizeHint 截断。这里核对落盘大小，不符则丢弃并回退单连接完整重下。
      const st = await fsp.stat(dest).catch(() => null)
      if (st && st.size === size) return
      await fsp.rm(dest, { force: true }).catch(() => {})
    }
  }
  await singleDownload(direct, dest, opts)
}

/**
 * 单连接下载（小文件，或服务器不支持 Range 时的回退）。
 * 自带停滞看门狗：连续 STALL_TIMEOUT_MS 无字节即中断并报告「网络连接超时」。
 */
async function singleDownload(url: string, dest: string, opts: StreamDownloadOptions): Promise<void> {
  const { signal, onBytes, headers } = opts
  // 只中断本次尝试：外部取消经 forwardAbort 转发，停滯由 watchdog 触发。
  const attempt = new AbortController()
  let lastBytesAt = Date.now()
  const watchdog = setInterval(() => {
    if (Date.now() - lastBytesAt >= STALL_TIMEOUT_MS) attempt.abort()
  }, 1000)
  const forwardAbort = (): void => attempt.abort()
  signal?.addEventListener('abort', forwardAbort, { once: true })
  if (signal?.aborted) forwardAbort()

  try {
    const res = await fetch(url, { headers: { ...UA, ...(headers ?? {}) }, signal: attempt.signal })
    if (!res.ok || !res.body) throw await httpError(res.status, res)
    const reader = res.body.getReader()
    const out = createWriteStream(dest)
    try {
      for (;;) {
        if (signal?.aborted) throw new Error('下载已取消')
        const { done, value } = await reader.read()
        if (done) break
        lastBytesAt = Date.now()
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
  } catch (err) {
    // 用户主动取消优先；其次若因内部超时中断，统一报告网络连接超时。
    if (signal?.aborted) throw new Error('下载已取消')
    if (attempt.signal.aborted) throw new Error('网络连接超时')
    throw err
  } finally {
    clearInterval(watchdog)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

/**
 * 动态分段下载核心：把 `[start, end)` 区间下满，失败时从已写入位置 `pos` 续传重试。
 * 返回值：true 表示本段完成；false 表示服务器忽略了 Range（返回 200），需回退单连接。
 */
async function downloadSegment(
  url: string,
  start: number,
  end: number,
  handle: FileHandle,
  opts: StreamDownloadOptions,
  markRangeUnsupported: () => void
): Promise<boolean> {
  const { signal, onBytes, headers } = opts
  let pos = start
  let lastErr: Error | null = null

  for (let attempt = 0; attempt < SEGMENT_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new Error('下载已取消')

    // 每次尝试独立的中断控制器 + 停滯看门狗：单条连接假死只中断本次尝试，
    // 其余分段继续跑；本段随后从 pos 续传，不再整文件重下。
    const attemptController = new AbortController()
    let lastBytesAt = Date.now()
    const watchdog = setInterval(() => {
      if (Date.now() - lastBytesAt >= STALL_TIMEOUT_MS) attemptController.abort()
    }, 1000)
    const forwardAbort = (): void => attemptController.abort()
    signal?.addEventListener('abort', forwardAbort, { once: true })
    if (signal?.aborted) forwardAbort()

    try {
      const res = await fetch(url, {
        headers: { ...UA, ...(headers ?? {}), Range: `bytes=${pos}-${end - 1}` },
        signal: attemptController.signal
      })
      // 服务器忽略 Range：交给调用方回退单连接。
      if (res.status === 200) {
        markRangeUnsupported()
        return false
      }
      // 416：请求区间越界（通常意味着服务器不支持 Range 或文件比预期短），同样回退单连接。
      if (res.status === 416) {
        markRangeUnsupported()
        return false
      }
      // 404 / 405 / 403：部分 CDN（典型如 CurseForge 的 edge.forgecdn.net）对「带 Range 的
      // 请求」直接回 404，而**不带 Range 时正常**。这类情况必须回退单连接，否则整个文件下载失败。
      // 注意 404 不在 TRANSIENT_STATUS 里，若不在此拦截会被当成硬错误直接上抛。
      if (res.status === 404 || res.status === 405 || res.status === 403) {
        markRangeUnsupported()
        return false
      }
      if (res.status !== 206 || !res.body) throw await httpError(res.status, res)

      // 校验返回区间的起点，避免服务器给错区间导致错位写入。
      const rangeStart = parseContentRangeStart(res.headers.get('content-range'))
      if (rangeStart != null && rangeStart !== pos) {
        throw new Error(`分段响应区间不符（期望 ${pos}，实际 ${rangeStart}）`)
      }

      const reader = res.body.getReader()
      for (;;) {
        if (signal?.aborted) throw new Error('下载已取消')
        const { done, value } = await reader.read()
        if (done) break
        lastBytesAt = Date.now()
        // 防御：服务器多发了超出本段的字节时，只写到段尾，绝不越界覆盖下一段。
        const room = end - pos
        const chunk = value.byteLength > room ? Buffer.from(value).subarray(0, room) : Buffer.from(value)
        await handle.write(chunk, 0, chunk.byteLength, pos)
        pos += chunk.byteLength
        onBytes?.(chunk.byteLength)
        if (pos >= end) {
          await reader.cancel().catch(() => {})
          return true
        }
      }
      // 短读：连接提前结束但本段未写满，抛错以触发「从 pos 续传」。
      if (pos >= end) return true
      throw new Error(`分段下载不完整（${pos - start}/${end - start} 字节）`)
    } catch (err) {
      if (signal?.aborted) throw new Error('下载已取消')
      const status = (err as { status?: number } | null)?.status
      // 硬错误（4xx 等非瞬时状态）不重试，直接上抛，让上层走镜像回退等逻辑。
      if (status != null && !TRANSIENT_STATUS.has(status)) throw err
      lastErr = attemptController.signal.aborted ? new Error('网络连接超时') : (err as Error)
      if (attempt + 1 < SEGMENT_ATTEMPTS) await sleep(segmentDelayMs(err as { status?: number }, attempt))
    } finally {
      clearInterval(watchdog)
      signal?.removeEventListener('abort', forwardAbort)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('分段下载失败')
}

/**
 * 大文件「动态分段」下载：切成比连接数更多的小段放入共享队列，由连接池并发领取。
 * 快连接下载完立即领下一段，避免固定分块下「快连接空等慢连接」；每段各自续传重试。
 * 服务器不支持 Range 时返回 false，由调用方回退单连接。
 */
async function parallelDownload(
  url: string,
  dest: string,
  size: number,
  opts: StreamDownloadOptions
): Promise<boolean> {
  const { signal } = opts
  const tmp = `${dest}.part`
  // 从头开始：以全新文件为底，各段按绝对偏移写入。
  await fsp.rm(tmp, { force: true }).catch(() => {})
  const handle = await fsp.open(tmp, 'w')
  let succeeded = false
  // 内部取消信号：任一连接失败即中断其余连接，等它们全部退场后再关闭文件句柄。
  const inner = new AbortController()
  const forwardAbort = (): void => inner.abort()
  signal?.addEventListener('abort', forwardAbort, { once: true })
  if (signal?.aborted) forwardAbort()
  const workerOpts: StreamDownloadOptions = { ...opts, signal: inner.signal }
  try {
    const segSize = segmentSizeFor(size)
    const total = Math.ceil(size / segSize)
    let next = 0
    let rangeUnsupported = false
    let failure: unknown = null

    // 连接池：每个 worker 反复领取下一段，直到队列取空或发现服务器不支持 Range。
    // 捕获自身错误（记录首个失败并中断其余连接）后正常返回，保证 handle 关闭前无人再写。
    const runWorker = async (): Promise<void> => {
      try {
        for (;;) {
          if (inner.signal.aborted) throw new Error('下载已取消')
          if (rangeUnsupported) return
          const i = next++
          if (i >= total) return
          const start = i * segSize
          const end = Math.min(start + segSize, size)
          const ok = await downloadSegment(url, start, end, handle, workerOpts, () => {
            rangeUnsupported = true
          })
          if (!ok) return
        }
      } catch (err) {
        if (failure === null) failure = err
        inner.abort()
      }
    }

    await Promise.all(Array.from({ length: Math.min(PARALLEL_CHUNKS, total) }, runWorker))
    if (failure !== null) throw failure
    if (rangeUnsupported) return false
    await fsp.rename(tmp, dest)
    succeeded = true
    return true
  } finally {
    signal?.removeEventListener('abort', forwardAbort)
    await handle.close().catch(() => {})
    if (!succeeded) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
    }
  }
}