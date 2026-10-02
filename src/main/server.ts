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

/**
 * 解析语义化版本：`1.2.3`、`1.2.3-beta1`、`1.2.3-rc2`、`1.2.3-dev10`。
 * @returns 主版本数字段 + 预发布信息（无预发布时为 null）。
 */
function parseVersion(v: string): { nums: number[]; pre: { tag: string; num: number } | null } {
  const s = v.trim().replace(/^v/i, '')
  const dashAt = s.indexOf('-')
  const core = dashAt >= 0 ? s.slice(0, dashAt) : s
  const nums = core.split('.').map((x) => parseInt(x, 10) || 0)
  if (dashAt < 0) return { nums, pre: null }
  const preRaw = s.slice(dashAt + 1).trim()
  if (!preRaw) return { nums, pre: null }
  // 形如 beta1 / rc2 / dev10：拆出标签与编号；无编号时按 0 处理。
  const m = preRaw.match(/^([A-Za-z]*)[-._]?(\d+)$/)
  return {
    nums,
    pre: { tag: (m?.[1] || preRaw).toLowerCase(), num: m ? parseInt(m[2], 10) : 0 }
  }
}

/**
 * 语义化版本比较：返回 a-b 的正负（a 新于 b 时为正）。
 *
 * 规则（对齐 semver 的预发布语义）：
 *   1. 先比较主版本段（缺位补 0）；
 *   2. 主版本相同时，正式版 > 预发布版（1.0.0 > 1.0.0-rc1）；
 *   3. 同为预发布时，先比标签、再比编号
 *      （0.5.0-beta3 > 0.5.0-beta2、0.5.0-beta10 > 0.5.0-beta9）。
 *
 * 第 3 条是本次修复的关键：旧实现把 `beta2` 解析成 0，
 * 导致 `0.5.0-beta2` 与 `0.5.0-beta3` 被判为相等、检查更新时永远「无更新」。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.nums.length, pb.nums.length)
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] ?? 0
    const y = pb.nums[i] ?? 0
    if (x !== y) return x - y
  }
  if (!pa.pre && !pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  if (pa.pre.tag !== pb.pre.tag) return pa.pre.tag > pb.pre.tag ? 1 : -1
  return pa.pre.num - pb.pre.num
}

/** 判断版本号是否为预发布（测试）版：主版本后带 `-`，如 0.5.0-dev1、0.5.0-beta12。 */
export function isPrerelease(version: string): boolean {
  return /^\s*v?\d+(?:\.\d+)*-\S/.test(version.trim())
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
  // 清掉可能残留的旧临时文件，避免上次中断留下的半截文件被误用。
  await fsp.rm(tmp, { force: true }).catch(() => {})
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
  await moveFile(tmp, dest)
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

/**
 * 把临时文件移动为最终文件，兼容 Windows 上覆盖面已存在文件的各种失败。
 *
 * 背景：`fsp.rename` 在 Windows 上覆盖一个**已存在**的目标时，会走 MoveFileEx 的
 * 「替换已有文件」语义；若目标正被占用（例如上一次已点「下载并运行」、安装程序仍在运行）、
 * 带只读属性，或刚下完的 exe 正被杀软实时扫描持有句柄，就会抛
 * `EPERM / EACCES / EBUSY`（正是用户看到的 `EPERM: operation not permitted, rename`）。
 *
 * 处理：先尽力删除旧目标（并清掉只读属性），再带退避重试几次 rename；
 * 仍失败则给出可操作的中文提示，而不是把裸 EPERM 抛给用户。
 */
async function moveFile(src: string, dest: string): Promise<void> {
  const attempts = 5
  for (let i = 0; i < attempts; i++) {
    try {
      // 先删除旧目标，避开「rename 覆盖已存在文件」在 Windows 上更易失败的问题。
      const st = await fsp.stat(dest).catch(() => null)
      if (st) {
        if (!st.isDirectory() && (st.mode & 0o200) === 0) {
          // 目标只读：先去掉只读位再删，否则删除本身也会失败。
          await fsp.chmod(dest, st.mode | 0o200).catch(() => {})
        }
        await fsp.rm(dest, { force: true }).catch(() => {})
      }
      await fsp.rename(src, dest)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      const retriable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
      if (!retriable || i === attempts - 1) {
        await fsp.rm(src, { force: true }).catch(() => {})
        throw new Error(
          `更新文件写入失败（${code ?? '未知错误'}）：目标文件可能正被占用或处于受保护目录。` +
            `请关闭正在运行的安装程序后重试，或手动删除 ${dest} 后重新下载。`
        )
      }
      // 退避等待：给占用方（安装程序 / 杀软扫描）一点释放句柄的时间。
      await new Promise<void>((r) => setTimeout(r, 300 * (i + 1)))
    }
  }
}

/** 更新文件落盘名（缺省从 URL 推导）。供「已存在则直接运行」的判断复用。 */
export function updateFileName(info: UpdateInfo): string {
  return filenameFrom(info)
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
