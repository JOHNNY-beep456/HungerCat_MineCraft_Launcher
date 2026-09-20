// 主进程侧的 stream 下载代理。
//
// 传输层（分块下载、10s 停滞看门狗、AbortSignal 取消）已迁到网络进程：
//   src/main/network/stream-download.ts + broker.netRequest('stream:download')。
// 本模块保留与旧实现完全一致的公开签名，使 downloader / modpack / modrinth / server
// 等全部调用方零改动地自动走网络进程。进度经通用 {type:'progress', ref, taskId, data}
// 协议回流，由 broker 转发回本代理的 onBytes/onSize 回调。
import { netRequest } from './broker'

export const PARALLEL_THRESHOLD = 8 * 1024 * 1024 // 8 MB
export const PARALLEL_CHUNKS = 8

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

interface StreamProgress {
  kind: 'bytes' | 'size'
  n?: number
  s?: number
}

/** 下载 `url` 到 `dest`（委托网络进程执行网络 IO，进度/看门狗/取消由网络进程负责）。 */
export async function streamDownload(url: string, dest: string, opts: StreamDownloadOptions = {}): Promise<void> {
  await netRequest<{ ok: boolean }>(
    'stream:download',
    { url, dest, sizeHint: opts.sizeHint, headers: opts.headers },
    {
      signal: opts.signal,
      onProgress: (_taskId, raw) => {
        const m = raw as StreamProgress
        if (m.kind === 'bytes') opts.onBytes?.(m.n ?? 0)
        else if (m.kind === 'size') opts.onSize?.(m.s ?? 0)
      }
    }
  )
}