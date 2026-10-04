// ---------------------------------------------------------------------------
// 网络进程桥（broker）—— 主进程侧。
//
// 职责：
//   - 用 utilityProcess.fork 拉起网络进程（out/main/network.js），经其原生 parentPort
//     通道双向收发，执行 shared/net-protocol.ts 里的通用 request/progress 协议。
//   - 为其他主进程模块提供 `netRequest`：把网络型操作委托给网络进程，按 ref 并发匹
//     配结果；网络进程崩溃/超时/取消都能正确回传到调用方，绝不让渲染层永久 pending。
//   - 崩溃恢复：网络进程退出后带退避自动重启，超阈值（连续 3 次崩溃）才停用并报错。
//   - 下载/长任务进度由网络进程 → broker → 渲染层对应通道转发（renderer 侧转发由各
//     IPC handler 负责，broker 仅提供 onProgress 回调挂载点）。
// ---------------------------------------------------------------------------

import { utilityProcess } from 'electron'
import { join } from 'path'
import type { NetErrorPayload, NetRequestMessage, NetResponseMessage } from '@shared/net-protocol'

/** 带结构化字段的错误：跨进程的 code/status/retryAfter 原样带到调用方。 */
export class NetError extends Error {
  readonly code: NetErrorPayload['code']
  readonly status?: number
  readonly retryAfter?: string
  constructor(message: string, code: NetErrorPayload['code'], status?: number, retryAfter?: string) {
    super(message)
    this.name = 'NetError'
    this.code = code
    this.status = status
    this.retryAfter = retryAfter
  }
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  onProgress?: (taskId: string, data: unknown) => void
  /** 绝对超时兜底（仅非流式请求使用）。 */
  timer: ReturnType<typeof setTimeout> | null
  /** 空闲看门狗（流式长任务使用）：超时后级联取消远端。 */
  idleTimer: ReturnType<typeof setTimeout> | null
  /** 流式任务的空闲阈值；0 表示不启用空闲看门狗。 */
  idleTimeoutMs: number
  signal?: AbortSignal
  onAbort?: () => void
  ref: number
  method: string
}

let child: Electron.UtilityProcess | null = null
let running = false
let stopped = false
let restartTimer: ReturnType<typeof setTimeout> | null = null
let seq = 0
const pending = new Map<number, Pending>()

/**
 * 请求级兜底超时（**仅用于短请求**，如元数据 JSON / sidecar / 认证）。
 * 网络操作自身已有 10s AbortSignal；这一层防止网络进程整体挂起时调用方永久 pending。
 */
const REQUEST_TIMEOUT_MS = 45_000

/**
 * 流式下载的空闲超时阈值。
 *
 * 下载类长任务**不能**用「请求级绝对超时」：client.jar / 慢网模组包超过阈值是常态，
 * 绝对超时会把正常下载判死（旧实现的 45s 绝对超时正是如此）。业界标准是 **idle timeout**
 * ——只要进度还在推进就永不超时，连续 N 秒没有任何字节才判失败。
 * 传输层已有 10s 停滞看门狗，这里留更宽的冗余，专门兜「网络进程整体卡死」。
 */
const DEFAULT_IDLE_TIMEOUT_MS = 90_000
/** 崩溃恢复的连续崩溃阈值：10s 窗口内崩溃超过该次数则停用自动恢复。 */
const MAX_CRASH = 3
const RESPAWN_DELAY_MS = 800

let crashCount = 0
let lastCrashAt = 0

function log(...args: unknown[]): void {
  console.log('[网络桥]', ...args)
}
function logErr(...args: unknown[]): void {
  console.error('[网络桥]', ...args)
}

function clearPendingTimers(p: Pending): void {
  if (p.timer) {
    clearTimeout(p.timer)
    p.timer = null
  }
  if (p.idleTimer) {
    clearTimeout(p.idleTimer)
    p.idleTimer = null
  }
}

function detach(p: Pending): void {
  clearPendingTimers(p)
  if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort)
}

function rejectAllPending(message: string): void {
  const list = [...pending.values()]
  pending.clear()
  for (const p of list) {
    detach(p)
    p.reject(new NetError(message, 'network'))
  }
}

function handleMessage(msg: NetResponseMessage): void {
  if (msg.type === 'result') {
    const p = pending.get(msg.ref)
    if (!p) return
    detach(p)
    pending.delete(msg.ref)
    if (msg.ok) p.resolve(msg.data)
    else p.reject(new NetError(msg.error, msg.code ?? 'unknown', msg.status, msg.retryAfter))
  } else if (msg.type === 'progress') {
    const p = pending.get(msg.ref)
    if (!p) return
    // 进度到达即刷新空闲看门狗：长任务只要还在推进就永不超时。
    if (p.idleTimer && p.idleTimeoutMs > 0) {
      clearTimeout(p.idleTimer)
      p.idleTimer = setTimeout(() => onIdleTimeout(p.ref, p.method, p.idleTimeoutMs), p.idleTimeoutMs)
    }
    p.onProgress?.(msg.taskId, msg.data)
  }
}

/** 空闲超时：级联向网络进程发 abort，消灭「本地已 reject、远端仍在下载」的孤儿任务。 */
function onIdleTimeout(ref: number, method: string, idleMs: number): void {
  const p = pending.get(ref)
  if (!p) return
  detach(p)
  pending.delete(ref)
  logErr(`网络请求空闲超时: ${method} (ref=${ref}, ${idleMs}ms 无进度)，已级联取消`)
  try {
    child?.postMessage({ type: 'abort', ref } satisfies NetRequestMessage)
  } catch {
    /* 忽略 */
  }
  p.reject(new NetError(`下载长时间无进展（${Math.round(idleMs / 1000)}s），已取消`, 'timeout'))
}


function spawn(): void {
  if (stopped) return
  const modulePath = join(__dirname, 'network.js')
  let childTmp: Electron.UtilityProcess
  try {
    childTmp = utilityProcess.fork(modulePath, [], { stdio: 'pipe' })
  } catch (err) {
    logErr('网络进程启动失败:', err)
    running = false
    return
  }
  child = childTmp

  // 把网络进程的 stdout/stderr 汇入主进程日志系统，让网络侧日志进入 debug 窗口。
  childTmp.stdout?.on('data', (d: Buffer) => log(d.toString()))
  childTmp.stderr?.on('data', (d: Buffer) => logErr(d.toString()))

  // 网络进程经其原生 parentPort 回传 结果/进度 到此。
  childTmp.on('message', (e) => {
    if (e && typeof e === 'object' && 'type' in e) handleMessage(e as unknown as NetResponseMessage)
  })

  childTmp.on('spawn', () => log(`网络进程已启动 (pid=${childTmp.pid})`))
  childTmp.on('error', (type) => logErr('网络进程 error:', type))
  childTmp.on('exit', (code) => {
    logErr(`网络进程已退出 (code=${code})`)
    if (child === childTmp) child = null
    rejectAllPending(`网络进程已退出(code=${code})，请重试`)

    // 崩溃恢复：带退避自动重启；连续崩溃超阈值则停用并报错（交给渲染层兜底超时）。
    if (!running || stopped) return
    const now = Date.now()
    if (now - lastCrashAt > 10_000) crashCount = 0
    lastCrashAt = now
    crashCount++
    if (crashCount > MAX_CRASH) {
      logErr('网络进程连续崩溃，已停用自动恢复')
      running = false
      return
    }
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      restartTimer = null
      spawn()
    }, RESPAWN_DELAY_MS)
  })
}

/** 确保网络进程存活；首次调用（含崩溃后）在此拉起。 */
function ensureNetworkWorker(): void {
  if (stopped) return
  if (child) return
  if (restartTimer) return
  running = true
  spawn()
}

/**
 * 发起一次网络进程调用。
 * @param method  网络进程侧已注册的方法名。
 * @param params  序列化到网络进程的参数。
 * @param opts.taskId    进度按 taskId 汇总时的标识。
 * @param opts.signal    取消信号：取消时会向网络进程发 abort 并立刻 reject 本地。
 * @param opts.onProgress 进度事件回调（taskId, data）。
 * @param opts.stream    流式长任务（下载）：启用「空闲看门狗」而非绝对超时。
 * @param opts.idleTimeoutMs 空闲阈值（仅 stream=true 时生效）。
 * @param opts.timeoutMs 绝对超时（仅 stream=false 时生效；下载类请勿使用）。
 */
export function netRequest<T = unknown>(
  method: string,
  params?: unknown,
  opts?: {
    signal?: AbortSignal
    taskId?: string
    onProgress?: (taskId: string, data: unknown) => void
    timeoutMs?: number
    /** 长任务模式：不设绝对超时，只在「连续无进度」达到 idleTimeoutMs 时失败并级联取消。 */
    stream?: boolean
    idleTimeoutMs?: number
  }
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    ensureNetworkWorker()
    if (!child) {
      reject(new NetError('网络进程不可用，请稍后重试', 'network'))
      return
    }

    const ref = ++seq
    const isStream = opts?.stream === true
    const idleTimeoutMs = isStream ? (opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS) : 0

    const item: Pending = {
      resolve: resolve as (v: unknown) => void,
      reject,
      onProgress: opts?.onProgress,
      timer: null,
      idleTimer: null,
      idleTimeoutMs,
      ref,
      method
    }

    // 长任务用空闲看门狗；短请求用绝对超时。二者互斥，绝不对下载叠加绝对超时。
    if (isStream) {
      item.idleTimer = setTimeout(() => onIdleTimeout(ref, method, idleTimeoutMs), idleTimeoutMs)
    } else {
      item.timer = setTimeout(() => {
        const p = pending.get(ref)
        if (!p) return
        detach(p)
        pending.delete(ref)
        logErr(`网络请求超时: ${method} (ref=${ref})`)
        reject(new NetError(`网络请求超时 (${method})，请重试`, 'timeout'))
      }, opts?.timeoutMs ?? REQUEST_TIMEOUT_MS)
    }

    pending.set(ref, item)

    const onAbort = (): void => {
      detach(item)
      pending.delete(ref)
      try {
        child?.postMessage({ type: 'abort', ref } satisfies NetRequestMessage)
      } catch {
        /* 忽略 */
      }
      reject(new NetError('网络请求已取消', 'cancelled'))
    }
    if (opts?.signal) {
      item.signal = opts.signal
      item.onAbort = onAbort
      if (opts.signal.aborted) {
        onAbort()
        return
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      child.postMessage({ type: 'request', ref, method, params, taskId: opts?.taskId } satisfies NetRequestMessage)
    } catch (err) {
      detach(item)
      pending.delete(ref)
      reject(new NetError(`网络请求发送失败: ${err instanceof Error ? err.message : String(err)}`, 'network'))
    }
  })
}

/** 应用启动时主动拉起网络进程（也用于把其日志汇入主进程 debug 系统）。 */
export function startNetworkWorker(): void {
  ensureNetworkWorker()
}

/** 应用退出/关闭时分发前回收网络进程并拒绝所有在途请求。 */
export function stopNetworkWorker(): void {
  stopped = true
  running = false
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  if (child) {
    const c = child
    child = null
    try {
      c.kill()
    } catch {
      /* 忽略 */
    }
  }
  rejectAllPending('网络进程已停止')
}