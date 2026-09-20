// 简单的结果缓存 + 并发去抖，用于高频、重复的 IPC 读取通道。
//
// 背景：多个页面（Home/Instances/Mods/Resources/ResourceDownload/Versions…）各自挂载时都会
// 独立调用 versions:list / installed:list，导致并发向网络进程发请求、或并发重复扫描本地磁盘
// （listInstalled 是重 IO），日志里表现为 versions:list×2 / installed:list×2 且耗时翻倍。
//
// 方案：同一 key 在 TTL 内返回同一个（已缓存）Promise——并发重复调用直接合并为一次底层执行，
// TTL 过期后下一次调用重新执行；执行失败不缓存，以便下次重试。对会改变结果的变更点（装版本/
// 删/改/导入）显式 invalidate，保证即时刷新。
interface Entry {
  promise: unknown
  expiresAt: number
}

export class DedupCache {
  private readonly map = new Map<string, Entry>()

  constructor(private readonly ttlMs: number) {}

  get<K>(key: string, loader: () => Promise<K>): Promise<K> {
    const now = Date.now()
    const hit = this.map.get(key)
    if (hit && now < hit.expiresAt) return hit.promise as Promise<K>

    const promise = loader()
    const entry: Entry = { promise, expiresAt: now + this.ttlMs }
    this.map.set(key, entry)

    // 成功后才真正起算 TTL（避免 load 耗时长的请求过早失效）；
    // 失败则移除缓存，下次调用重试，同时失败仍原样传播给本次调用方。
    promise
      .then(() => {
        entry.expiresAt = Date.now() + this.ttlMs
      })
      .catch(() => {
        if (this.map.get(key) === entry) this.map.delete(key)
      })

    return promise
  }

  /** 使某 key 下次调用失效重新执行。 */
  invalidate(key: string): void {
    this.map.delete(key)
  }

  /** 清空全部缓存。 */
  invalidateAll(): void {
    this.map.clear()
  }
}