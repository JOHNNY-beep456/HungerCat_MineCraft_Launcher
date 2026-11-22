// 每份已授权文档持有独立会话。窗口代理可跨导航复用，不能单凭 contentWindow 判定旧回复有效。
export class FrameSession {
  private active = true
  private readonly pending = new Set<number>()
  private probeChars = 0
  private probeBatches = 0

  constructor(readonly generation: string) {}

  current(generation: unknown): boolean {
    return this.active && generation === this.generation
  }

  close(): void {
    this.active = false
    this.pending.clear()
  }

  beginCall(id: unknown): boolean {
    if (!this.active || !Number.isSafeInteger(id) || Number(id) < 1 || this.pending.has(Number(id)) || this.pending.size >= 32) return false
    this.pending.add(Number(id))
    return true
  }

  endCall(id: number): void { this.pending.delete(id) }

  reserveProbe(chars: number): boolean {
    if (!this.active || !Number.isSafeInteger(chars) || chars < 0 || chars > 2 * 1024 * 1024 || this.probeChars + chars > 4 * 1024 * 1024 || this.probeBatches >= 64) return false
    this.probeChars += chars
    this.probeBatches++
    return true
  }

  releaseProbe(chars: number): void {
    this.probeChars = Math.max(0, this.probeChars - chars)
    this.probeBatches = Math.max(0, this.probeBatches - 1)
  }
}

/** 先有界遍历，再序列化。拒绝循环、过深结构和异常类型，不截断待扫描内容。 */
export function boundedParams(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  const seen = new Set<object>()
  let nodes = 0
  let chars = 0
  while (queue.length) {
    const item = queue.pop()!
    if (++nodes > 2048 || item.depth > 16) return false
    if (typeof item.value === 'string') chars += item.value.length
    else if (typeof item.value === 'number') { if (!Number.isFinite(item.value)) return false }
    else if (item.value === null || typeof item.value === 'boolean') { /* JSON 标量 */ }
    else if (typeof item.value === 'object') {
      if (seen.has(item.value)) return false
      seen.add(item.value)
      const proto = Object.getPrototypeOf(item.value)
      if (!Array.isArray(item.value) && proto !== Object.prototype && proto !== null) return false
      const keys = Object.keys(item.value)
      if (keys.length > 2048 || queue.length + keys.length > 2048) return false
      for (const key of keys) {
        chars += key.length
        queue.push({ value: (item.value as Record<string, unknown>)[key], depth: item.depth + 1 })
      }
    } else return false
    if (chars > 65536) return false
  }
  return true
}
