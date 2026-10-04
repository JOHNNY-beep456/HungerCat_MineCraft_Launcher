// ---------------------------------------------------------------------------
// 下载编排的共享工具（供 downloader.ts / modpack.ts 共用）。
//
// 抽出的动机（对应审查反模式 D）：两个模块此前各自复制了一份「worker 池 + 速度计算 +
// 80ms 节流上报」，逐行重复且容易漂移。这里收敛成单一实现，行为改动只需改一处。
//
// 构成：
//   1. runWorkerPool —— 共享整数游标的固定并发工作池；
//   2. ProgressReporter —— 速度统计 + 节流上报（含结束态强制 emit、结束后丢弃）。
// ---------------------------------------------------------------------------

/** 固定并发工作池：每个 worker 反复用原子（此处为 JS 单线程递增）领取下一个下标。 */
export async function runWorkerPool(
  total: number,
  concurrency: number,
  worker: (index: number) => Promise<void>
): Promise<void> {
  let next = 0
  const n = Math.max(1, Math.min(Math.floor(concurrency) || 1, Math.max(1, total)))
  const runners = Array.from({ length: n }, async () => {
    for (;;) {
      const i = next++
      if (i >= total) return
      await worker(i)
    }
  })
  await Promise.all(runners)
}

export interface ProgressReporterOptions {
  /** 节流窗口（毫秒）。默认 80ms：兼顾进度条流畅与 IPC 压力。 */
  intervalMs?: number
  /** 组装并派发一次进度事件。 */
  emit: (snapshot: ProgressSnapshot) => void
}

export interface ProgressSnapshot {
  doneBytes: number
  totalBytes: number
  done: number
  total: number
  speed: number
}

/**
 * 速度统计 + 节流上报。
 *
 * 语义：
 *   - `report(force)`：非强制时按 intervalMs 合并；强制时立即上报（用于阶段切换/收尾）。
 *   - 速度按「上次上报至今的字节增量 / 时间差」估算，无增量时平滑衰减而非骤降。
 *   - `finish()` 后一切上报被丢弃，避免下载结束后残留定时器「复活」渲染端进度条。
 */
export class ProgressReporter {
  private readonly intervalMs: number
  private readonly emit: (s: ProgressSnapshot) => void
  private doneBytes = 0
  private totalBytes = 0
  private done = 0
  private total = 0
  private speed = 0
  private lastSpeedAt = Date.now()
  private lastSpeedBytes = 0
  private lastEmitAt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private finished = false

  constructor(opts: ProgressReporterOptions) {
    this.intervalMs = opts.intervalMs ?? 80
    this.emit = opts.emit
  }

  setTotals(done: number, total: number): void {
    this.done = done
    this.total = total
  }

  addDoneBytes(delta: number): void {
    this.doneBytes += delta
  }

  setDoneBytes(v: number): void {
    this.doneBytes = v
  }

  getDoneBytes(): number {
    return this.doneBytes
  }

  addTotalBytes(delta: number): void {
    this.totalBytes += delta
  }

  incDone(n = 1): void {
    this.done += n
  }

  private snapshot(): ProgressSnapshot {
    const now = Date.now()
    const delta = now - this.lastSpeedAt
    const bytes = this.doneBytes - this.lastSpeedBytes
    this.lastSpeedAt = now
    this.lastSpeedBytes = this.doneBytes
    if (delta > 0) {
      const inst = bytes / delta // 字节/毫秒
      this.speed = inst > 0 ? Math.max(0, Math.min(inst * 1000, 1024 * 1024 * 1024)) : this.speed * 0.5
    }
    this.lastEmitAt = now
    return {
      doneBytes: this.doneBytes,
      totalBytes: this.totalBytes,
      done: this.done,
      total: this.total,
      speed: Math.round(this.speed)
    }
  }

  /** 派发一次进度；force=true 时绕过节流窗口。 */
  report(force = false): void {
    if (this.finished) return
    if (force) {
      if (this.timer != null) {
        clearTimeout(this.timer)
        this.timer = null
      }
      this.emit(this.snapshot())
      return
    }
    const now = Date.now()
    if (now - this.lastEmitAt >= this.intervalMs) {
      this.emit(this.snapshot())
    } else if (this.timer == null) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.report()
      }, this.intervalMs)
    }
  }

  /** 结束：丢弃所有尚未派发的上报。 */
  finish(): void {
    this.finished = true
    if (this.timer != null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

/** 由 doneBytes/totalBytes（优先）或 done/total（大小未知时）推导百分比。 */
export function computePercent(s: ProgressSnapshot): number {
  if (s.totalBytes > 0) return Math.min(100, Math.round((s.doneBytes / s.totalBytes) * 100))
  if (s.total > 0) return Math.min(100, Math.round((s.done / s.total) * 100))
  return 0
}
