// 远程服务端 JSON 请求（about/agreement/update）已迁至网络进程（server:api）；
// 更新文件网络下载走 streamDownload（broker 代理网络进程）。runUpdate/spawn 仍为本进程编排。
import { existsSync, promises as fsp, chmodSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { app } from 'electron'
import { dirname, join } from 'path'
import { spawn } from 'child_process'
import type { AboutGroup, AgreementContent, Announcement, DownloadProgress, UpdateInfo } from '@shared/types'
import { netRequest } from './broker'
import { streamDownload } from './stream-download'
import { isPortable, macAppBundlePath, portableBinaryPath } from './portable'
import { resolveUpdateForIdentity } from './update-resolve'

/**
 * 远程服务端地址。改成你自己的 PHP 服务端部署地址（不带末尾斜杠）。
 * 例如 'https://your-domain.com/hungercat'。
 */
export const SERVER_BASE = 'https://hcmcl.johnnyblog.top'

async function apiGet<T>(path: string, query?: Record<string, string>): Promise<T> {
  // 真实网络执行由网络进程承担（统一 10s 超时在其内部）。
  return netRequest<T>('server:api', { path, query })
}

/**
 * 本机的发布标识（`win32-x64` / `linux-armv7l` …）。
 *
 * 与服务端 `hc_release_targets()`、构建脚本 `--target` 三方必须一致：
 * 客户端用它向服务端要「自己这一份」更新包，避免 x64 用户下到 arm 包。
 * Node 在 32 位 ARM 上 `process.arch` 报 `arm`，发布名却是 armv7l，这里归一。
 */
export function releaseTarget(): string {
  const arch = process.arch === 'arm' ? 'armv7l' : process.arch
  return `${process.platform === 'win32' ? 'win32' : 'linux'}-${arch}`
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

/**
 * 计算协议内容的版本指纹：隐私政策 + 用户协议的 SHA256。
 *
 * 用「内容指纹」而非服务端时间戳，是为了任何一处文字改动都能触发重新同意；
 * 时间戳可能因未更新而漏判。正文全为空时返回空串（视为「无内容」，不强制同意）。
 */
export function agreementVersion(content: AgreementContent | null | undefined): string {
  const privacy = content?.privacy ?? ''
  const terms = content?.terms ?? ''
  if (!privacy.trim() && !terms.trim()) return ''
  return createHash('sha256').update(`${privacy}\u0000${terms}`).digest('hex').slice(0, 32)
}

/** 拉取服务端公告列表（服务端返回 { announcements: [...] } 或直接数组）。 */
export async function fetchAnnouncements(): Promise<Announcement[]> {
  const data = await apiGet<{ announcements?: Announcement[] } | Announcement[]>('announcement')
  if (Array.isArray(data)) return data
  return Array.isArray(data?.announcements) ? data.announcements : []
}

/** 获取服务端发布的最新版本信息（按 平台+架构 与 便携/安装 身份解析出实际下载地址）。 */
export async function fetchUpdateInfo(): Promise<UpdateInfo> {
  const info = await apiGet<UpdateInfo>('update', { target: releaseTarget() })
  // mac 的更新是「zip 就地替换 .app」，所以要拿便携版那份（zip）；取不到会回退到 dmg。
  return resolveUpdateForIdentity(info, isPortable || !!macAppBundlePath())
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

/**
 * 只比较「主版本号」——忽略 `-beta1` / `-rc2` 这类预发布后缀，返回 a-b 的正负。
 * 用于「重要版本」判定：只有当启动器主版本号 <= 重要版本主版本号时才推送，
 * 避免把一条旧的重要版本推给已经升级到更新主版本的用户。
 */
export function compareMainVersions(a: string, b: string): number {
  const pa = parseVersion(a).nums
  const pb = parseVersion(b).nums
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
  // 服务端没给文件名时按平台猜扩展名：Windows 是 exe，Linux 发行包是 AppImage，
  // macOS 是 dmg。
  const fallbackExt = process.platform === 'linux' ? 'AppImage' : process.platform === 'darwin' ? 'dmg' : 'exe'
  const seg = info.url.split(/[?#]/)[0].split('/').filter(Boolean).pop()
  if (!seg || !seg.includes('.')) return `HungerCatLauncher-${info.version}.${fallbackExt}`
  // URL 路径里的中文 / 空格是百分号编码的（网盘外链很常见），落盘前解码，
  // 否则文件夹里会出现 `HungerCat%20MineCraft%20Launcher%20Setup%200.6.17.exe` 这种名字。
  // 解码后仍要去掉路径分隔符：`%2F` 解出来就是 `/`，直接当文件名会写到别的目录去。
  try {
    return decodeURIComponent(seg).replace(/[\\/]/g, '_')
  } catch {
    return seg
  }
}

/**
 * 更新包落盘目录。
 *
 * 便携版（Windows portable / Linux AppImage）放在**可执行文件所在目录**——更新时直接
 * 替换手边这个文件；安装版仍放在游戏目录下的 updates/，由安装程序接管。
 */
export function updateTargetDir(gameDir: string): string {
  // macOS：新 zip 先落在启动器数据目录，替换脚本再搬到 .app 原处。
  // 不直接下到 .app 旁边的原因：/Applications 对普通用户不一定可写，
  // 放这里能保证下载本身不会因为权限失败。
  if (macAppBundlePath()) return join(app.getPath('userData'), 'updates')
  const bin = portableBinaryPath()
  return bin ? dirname(bin) : join(gameDir, 'updates')
}

/**
 * 下载更新文件到指定目录，返回保存路径。
 *
 * `dir` 由 updateTargetDir() 给出：便携版是 exe 所在目录，安装版是 <gameDir>/updates。
 */
export async function downloadUpdate(
  info: UpdateInfo,
  dir: string,
  onProgress: (p: DownloadProgress) => void
): Promise<string> {
  const filename = filenameFrom(info)
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
export function updateFileExists(dir: string, info: UpdateInfo): boolean {
  return existsSync(join(dir, filenameFrom(info)))
}

/**
 * 运行更新程序（Windows 安装包 / 便携版 exe，或 Linux 的 AppImage），分离进程并立即解绑，
 * 不阻塞启动器退出。
 *
 * Linux 的更新包是 AppImage，下载下来默认没有可执行位，必须先 chmod 才能运行；
 * 失败就算了（用户仍可在文件管理器里手动运行）。
 */
export function runUpdate(exePath: string): void {
  try {
    if (process.platform === 'darwin') {
      // macOS 的更新包是 dmg，不能直接 exec（会报 exec format error），交给 open 挂载。
      const child = spawn('open', [exePath], { detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()
      return
    }
    if (process.platform !== 'win32') {
      try {
        chmodSync(exePath, 0o755)
      } catch {
        /* 只读目录等情况：继续尝试运行，失败由 spawn 的 error 事件兜底 */
      }
    }
    const child = spawn(exePath, [], { detached: true, stdio: 'ignore' })
    child.on('error', () => {
      /* 运行失败仅忽略，用户仍可手动打开文件 */
    })
    child.unref()
  } catch {
    /* 运行失败仅忽略 */
  }
}

/** PowerShell 单引号字符串转义 */
function psQuote(p: string): string {
  return `'${p.replace(/'/g, "''")}'`
}

/** POSIX shell 单引号字符串转义 */
function shQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

/**
 * 便携版自替换：下载到同目录的新文件 → 等本进程退出 → 删旧文件 → 启动新程序。
 *
 * 为什么必须借外部进程：Windows 上正在运行的 exe 不能删除/覆盖，Linux 的 AppImage
 * 挂载点也一样。这里起一个脱离的脚本等本进程结束再动手，然后由调用方退出应用。
 *
 * 旧版本删不掉的两个真实原因，这里都堵上了：
 *   1. 便携版 exe 是自解压器，它释放出内层 exe 后**一直持有旧 exe 的映像**直到自己退出，
 *      所以删除要按文件是否解锁来重试（最多 30 秒），而不是只等本进程结束；
 *   2. 「联机中关窗」的确认框可能把 app.quit() 挡下来，进程一直不退，脚本就一直等。
 *      调用方会在 3 秒后强制退出（见 handlers/network.ts）。
 * 万一仍然删不掉（杀软扫描、目录被占用），先落盘的 .pending-delete 标记会让新版本
 * 下次启动时补删（见 portable.ts 的 cleanupPendingPortableDelete）。
 *
 * @returns 是否已安排好自替换（false 表示当前不是便携版，调用方走普通 runUpdate）
 */
export function replacePortableUpdate(newPath: string): boolean {
  // macOS：更新包是 .zip（整个 .app 归档）。等本进程退出后就地替换 .app 再重新打开。
  const bundle = macAppBundlePath()
  if (bundle && /\.zip$/i.test(newPath)) return scheduleMacAppReplace(bundle, newPath)

  const oldPath = portableBinaryPath()
  if (!oldPath) return false
  const dir = dirname(oldPath)
  // 先把「待删除」标记落盘：即使下面的外部脚本没机会执行（被杀软拦、系统策略、
  // 进程被强杀），新版本下次启动也会把旧 exe 补删掉，不会永久留下两个文件。
  try {
    writeFileSync(join(dir, '.pending-delete'), oldPath, 'utf8')
  } catch {
    /* 目录只读等情况：交给外部脚本尽力而为 */
  }
  try {
    if (process.platform === 'win32') {
      const script = [
        `$old = ${psQuote(oldPath)}`,
        `$new = ${psQuote(newPath)}`,
        `$dir = ${psQuote(dir)}`,
        // 先等本进程退出。注意不能用 Wait-Process -Timeout：Windows PowerShell 5.1
        // 没有这个参数，会直接报错（6+ 才有），所以用轮询。
        `$deadline = (Get-Date).AddSeconds(30)`,
        `while ((Get-Date) -lt $deadline -and (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 300 }`,
        // 再等旧 exe 解锁：外层便携启动器要等它自己退出才释放映像，杀软也可能还在扫，
        // 每 300ms 试一次，最多 30 秒。
        `for ($i = 0; $i -lt 100 -and (Test-Path -LiteralPath $old); $i++) { ` +
          `Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue; ` +
          `if (Test-Path -LiteralPath $old) { Start-Sleep -Milliseconds 300 } }`,
        `Start-Process -FilePath $new -WorkingDirectory $dir`
      ].join('; ')
      spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref()
      return true
    }
    if (process.platform === 'linux') {
      const script =
        `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done; ` +
        `rm -f ${shQuote(oldPath)}; chmod +x ${shQuote(newPath)}; ${shQuote(newPath)} >/dev/null 2>&1 &`
      spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref()
      return true
    }
  } catch {
    /* 安排失败就退回普通运行方式 */
  }
  return false
}

/**
 * macOS 就地更新：等本进程退出 → 解压新 zip → 换掉旧 .app → 重新打开。
 *
 * 用 `ditto -x -k` 解压（保留权限与扩展属性，zip 是 electron-builder 打的 .app 归档）。
 * 换包分两步：先把旧包改名占位，再把新包放到原位；两步任意一步失败都还原旧包，
 * 不会出现「旧包已删、新包没放上」导致启动器消失的情况。
 */
function scheduleMacAppReplace(bundle: string, zipPath: string): boolean {
  try {
    const backup = `${bundle}.old`
    const script =
      `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done; ` +
      `tmp=$(mktemp -d) || exit 0; ` +
      `ditto -x -k ${shQuote(zipPath)} "$tmp" || { rm -rf "$tmp"; exit 0; }; ` +
      `newapp=$(/usr/bin/find "$tmp" -maxdepth 2 -name '*.app' -print -quit); ` +
      `[ -n "$newapp" ] || { rm -rf "$tmp"; exit 0; }; ` +
      `rm -rf ${shQuote(backup)}; ` +
      `if ! mv ${shQuote(bundle)} ${shQuote(backup)}; then ` +
      `rm -rf "$tmp"; open ${shQuote(bundle)}; exit 0; fi; ` +
      `if mv "$newapp" ${shQuote(bundle)}; then ` +
      `rm -rf ${shQuote(backup)}; else mv ${shQuote(backup)} ${shQuote(bundle)}; fi; ` +
      `rm -rf "$tmp"; rm -f ${shQuote(zipPath)}; ` +
      `open ${shQuote(bundle)}`
    spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch {
    return false
  }
}
