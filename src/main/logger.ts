import type { DebugLogEntry } from '@shared/types'

/** 滚动缓冲上限（条）。 */
const MAX_LOGS = 2000

/** console 方法池，仅拦截写入级别的日志。 */
const METHODS: Array<'log' | 'info' | 'warn' | 'error'> = ['log', 'info', 'warn', 'error']

const buffer: DebugLogEntry[] = []
const subscribers = new Set<(entry: DebugLogEntry) => void>()
let patched = false

/**
 * 派发重入保护。console 在 patch 后可能被任意代码路径调用，而万一某个订阅者（如
 * debug 窗口的回调）在中继日志时又同步触发了 console 输出，就会在 `push` 内部再次
 * 进入 `push`，形成同步自递归导致主进程栈溢出 / 事件循环卡死（表现为界面无响应）。
 * 用一个 dispatching 标志位：派发期间再收到的日志先暂存到 pending，等当前派发完成
 * 后再以微任务异步补发，既保证日志不丢、顺序不乱，又彻底阻断同步递归。
 */
let dispatching = false
let pending: DebugLogEntry[] = []

function fmtArg(v: unknown): string {
  if (v instanceof Error) return v.stack ?? v.message
  if (typeof v === 'string') return v
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'object' && v !== null) {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return String(v)
}

function format(args: unknown[]): string {
  return args.map(fmtArg).join(' ')
}

function push(entry: DebugLogEntry): void {
  buffer.push(entry)
  if (buffer.length > MAX_LOGS) buffer.splice(0, buffer.length - MAX_LOGS)
  // 派发中再次进入 push（重入 / 循环）时，先把本次日志排入 pending，避免同步递归。
  if (dispatching) {
    pending.push(entry)
    return
  }
  dispatching = true
  try {
    for (const cb of subscribers) {
      try {
        cb(entry)
      } catch {
        /* 订阅方异常不影响采集 */
      }
    }
  } finally {
    dispatching = false
  }
  // 派发结束再补发派发期内积压的日志；用微任务异步执行，保证顺序且不阻塞当前调用栈。
  if (pending.length > 0) {
    const rest = pending
    pending = []
    queueMicrotask(() => {
      for (const e of rest) push(e)
    })
  }
}

/**
 * 全局捕获主进程的 console 输出（monkey-patch），
 * 写入滚动缓冲并广播给订阅者（调试日志窗口）。幂等，可多次调用。
 */
export function initLogger(): void {
  if (patched) return
  patched = true
  const c = console as unknown as Record<(typeof METHODS)[number], (...args: unknown[]) => void>
  for (const m of METHODS) {
    const orig = c[m].bind(console)
    c[m] = (...args: unknown[]) => {
      push({ ts: Date.now(), level: m === 'log' ? 'info' : m, message: format(args) })
      orig(...args)
    }
  }
  push({ ts: Date.now(), level: 'info', message: '[logger] 主进程日志采集已启用' })
}

/** 读取当前滚动缓冲的快照。 */
export function getLogBuffer(): DebugLogEntry[] {
  return [...buffer]
}

/** 订阅增量日志，返回退订函数。 */
export function subscribeLogs(cb: (entry: DebugLogEntry) => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}