import { createWriteStream, existsSync, promises as fsp } from 'fs'
import { join } from 'path'
import type { AboutGroup, AgreementContent, DownloadProgress, UpdateInfo } from '@shared/types'

/**
 * 远程服务端地址。改成你自己的 PHP 服务端部署地址（不带末尾斜杠）。
 * 例如 'https://your-domain.com/hungercat'。
 */
export const SERVER_BASE = 'https://adhc.johnnyblog.top'

const UA = 'HungerCatLauncher/0.1'

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${SERVER_BASE}/api.php?action=${path}`, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`请求失败 (HTTP ${res.status})`)
  return (await res.json()) as T
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

  const res = await fetch(info.url, { headers: { 'User-Agent': UA } })
  if (!res.ok || !res.body) throw new Error(`下载更新失败 (HTTP ${res.status})`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const reader = res.body.getReader()
  const tmp = dest + '.part'
  const out = createWriteStream(tmp)
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
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
