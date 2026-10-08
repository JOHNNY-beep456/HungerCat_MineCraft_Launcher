// ---------------------------------------------------------------------------
// 下载网络档位（Network Profile）。
//
// ── 要解决的问题 ─────────────────────────────────────────────────────
// 并发连接数并非「越大越快」。无线网络（Wi-Fi）对「同时开大量 TCP 连接」极其敏感：
//   * 过多并发连接会让 AP 的队列与空口竞争急剧恶化 → 丢包 → TCP 重传 →
//     有效吞吐反而**下降**（拥塞崩溃），表现为「明明带宽够却越下越慢」；
//   * 高并发还会触发 CDN 的连接数限流。
// 而有线 / 光纤链路能稳定承载高并发，靠多连接才吃得满带宽。
//
// ── 本模块的职责 ─────────────────────────────────────────────────────
// 依据用户选择的「下载加速档位」，把「基础连接数」换算成一套**克制且安全**的
// 实际并发参数（单文件连接数 + 文件并发数），并夹取到不会打爆对端的区间。
// 真正的「实测自适应」在传输层（stream-download.ts）按字节速率动态增减连接，
// 这里只给出**上限基准**，两者配合即可在无线网络上既快又稳。
// ---------------------------------------------------------------------------

import type { LauncherSettings } from '@shared/types'

export type Acceleration = LauncherSettings['downloadAcceleration']

/** 单文件连接数的硬上限：再高对 CDN 只有害无益。 */
const MAX_FILE_CONNECTIONS = 128
/** 文件级并发的硬上限。 */
const MAX_FILE_CONCURRENCY = 48

/**
 * 各档位的基准倍率 / 基数。
 *
 * 设计取舍：
 *   - `balanced` 面向 Wi-Fi：连接数与文件并发都压到较低水平，减少空口竞争；
 *   - `turbo`    面向有线 / 光纤：放大连接数，尽量吃满带宽；
 *   - `auto`     取两者之间的保守基准，随后由传输层按实测吞吐自适应升降。
 */
const PROFILE: Record<Acceleration, { connFactor: number; connFloor: number; concFactor: number }> = {
  // 无线友好：连接数按用户基准的 1/2，至少 4 条；文件并发也压到较低。
  balanced: { connFactor: 0.5, connFloor: 4, concFactor: 0.5 },
  // 有线 / 光纤：充分放大连接数（不超过硬上限）。
  turbo: { connFactor: 2, connFloor: 16, concFactor: 2 },
  // 自适应：以用户基准为准，传输层再按实测抖动收缩。
  auto: { connFactor: 1, connFloor: 8, concFactor: 1 }
}

export interface EffectiveConcurrency {
  /** 单文件分段下载的连接数。 */
  connections: number
  /** 同时下载的文件数（worker 池大小）。 */
  fileConcurrency: number
}

/**
 * 计算实际生效的并发参数。
 *
 * `baseConnections` / `baseConcurrency` 来自设置（用户显式调过就以它为准倍率换算），
 * 最终一律夹取到安全区间，避免异常入参把服务端打爆。
 */
export function effectiveConcurrency(
  acceleration: Acceleration,
  baseConnections: number,
  baseConcurrency: number
): EffectiveConcurrency {
  const p = PROFILE[acceleration] ?? PROFILE.auto
  const connBase = Number.isFinite(baseConnections) && baseConnections > 0 ? baseConnections : 16
  const concBase = Number.isFinite(baseConcurrency) && baseConcurrency > 0 ? baseConcurrency : 8

  const connections = clamp(Math.round(connBase * p.connFactor), p.connFloor, MAX_FILE_CONNECTIONS)
  const fileConcurrency = clamp(Math.round(concBase * p.concFactor), 1, MAX_FILE_CONCURRENCY)
  return { connections, fileConcurrency }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
