import { app } from 'electron'
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

/** 折叠换行 / 控制字符：单条外部日志绝不能伪造成多行（见 F-14 / D07）。 */
function fold(text: string): string {
  return String(text)
    .replace(/[\r\n\u2028\u2029]+/g, ' ⏎ ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, 8000)
}

/**
 * 追加一条「外部来源」日志（渲染层转发 / 主页脚本等）。
 *
 * 主进程只 monkey-patch 了本进程的 console；渲染层的 console 与运行时错误不会自动进入
 * 缓冲。调试密钥上传时需要完整的现场，因此渲染层经 IPC 把日志转发到这里统一入库。
 * `source` 会作为前缀标注来源（如「渲染层」），`fold()` 折叠换行避免伪造多行。
 */
export function appendExternalLog(
  level: DebugLogEntry['level'],
  message: string,
  source = '渲染层'
): void {
  push({ ts: Date.now(), level, message: `[${source}] ${fold(message)}` })
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
  // 环境头：任何一次日志上传都能从首行拿到运行环境，省去来回追问。
  push({
    ts: Date.now(),
    level: 'info',
    message:
      `[logger] 采集已启用 · 启动器 ${app.getVersion()} · ${process.platform} ${process.arch} · ` +
      `Electron ${process.versions.electron} · Chrome ${process.versions.chrome} · Node ${process.versions.node}`
  })
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