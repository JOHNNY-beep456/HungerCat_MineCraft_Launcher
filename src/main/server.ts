// 远程服务端 JSON 请求（about/agreement/update）已迁至网络进程（server:api）；
// 更新文件网络下载走 streamDownload（broker 代理网络进程）。runUpdate/spawn 仍为本进程编排。
import { existsSync, promises as fsp } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import type { AboutGroup, AgreementContent, DownloadProgress, UpdateInfo } from '@shared/types'
import { netRequest } from './broker'
import { streamDownload } from './stream-download'

/**
 * 远程服务端地址。改成你自己的 PHP 服务端部署地址（不带末尾斜杠）。
 * 例如 'https://your-domain.com/hungercat'。
 */
export const SERVER_BASE = 'https://adhc.johnnyblog.top'

async function apiGet<T>(path: string): Promise<T> {
  // 真实网络执行由网络进程承担（统一 10s 超时在其内部）。
  return netRequest<T>('server:api', { path })
}

/** 获取关于页分组与人物（服务端返回 { groups: [...] }，这里解出数组）。 */
export async function fetchAbout(): Promise<AboutGroup[]> {
  const data = await apiGet<{ groups?: AboutGroup[] } | AboutGroup[]>('about')
  if (Array.isArray(data)) return data
  return Array.isArray(data.groups) ? data.groups : []
}

/** 获取隐私政策与用户协议（服务端下发）。 */
export function fetchAgreement(): Promise<AgreementContent> {
  return apiGet<AgreementContent>('agreement')
}

/** 获取服务端发布的最新版本信息。 */
export function fetchUpdateInfo(): Promise<UpdateInfo> {
  return apiGet<UpdateInfo>('update')
}

/** 简单语义化版本比较：返回 a-b 的正负。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((s) => parseInt(s, 10) || 0)
  const pb = b.split(/[.+-]/).map((s) => parseInt(s, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

function filenameFrom(info: UpdateInfo): string {
  if (info.filename && info.filename.trim()) return info.filename.trim()
  const seg = info.url.split(/[?#]/)[0].split('/').filter(Boolean).pop()
  return seg && seg.includes('.') ? seg : `HungerCatLauncher-${info.version}.exe`
}

/** 下载更新文件到 `<gameDir>/updates/`，返回保存路径。 */
export async function downloadUpdate(
  info: UpdateInfo,
  gameDir: string,
  onProgress: (p: DownloadProgress) => void
): Promise<string> {
  const filename = filenameFrom(info)
  const dir = join(gameDir, 'updates')
  await fsp.mkdir(dir, { recursive: true })
  const dest = join(dir, filename)

  // 更新文件的真实下载委托给网络进程（stream:download），进度经 onBytes/onSize 回流。
  const tmp = dest + '.part'
  let received = 0
  let total = 0
  await streamDownload(info.url, tmp, {
    onBytes: (n) => {
      received += n
      onProgress({
        taskId: 'update',
        task: filename,
        current: 0,
        total: 1,
        currentBytes: received,
        totalBytes: total,
        phase: 'mod',
        percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0
      })
    },
    onSize: (s) => {
      total = s
    }
  })
  await fsp.rename(tmp, dest)
  onProgress({
    taskId: 'update',
    task: filename,
    current: 1,
    total: 1,
    currentBytes: received,
    totalBytes: total,
    phase: 'done',
    percent: 100
  })
  return dest
}

/** 当前是否已存在更新文件（用于避免重复下载）。 */
export function updateFileExists(gameDir: string, info: UpdateInfo): boolean {
  return existsSync(join(gameDir, 'updates', filenameFrom(info)))
}

/** 运行更新程序（安装包 / 便携版 exe），分离进程并立即解绑，不阻塞启动器退出。 */
export function runUpdate(exePath: string): void {
  try {
    const child = spawn(exePath, [], { detached: true, stdio: 'ignore' })
    child.on('error', () => {
      /* 运行失败仅忽略，用户仍可手动打开文件 */
    })
    child.unref()
  } catch {
    /* 运行失败仅忽略 */
  }
}
