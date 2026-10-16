import { appendFileSync, existsSync } from 'node:fs'
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { app } from 'electron'
import {
  APP_EXE,
  APP_NAME,
  SHORTCUT_NAME,
  desktopDirFor,
  defaultDirFor,
  normalizeScope,
  startMenuDirFor,
  type InstallScope
} from './paths'
import { copyTree, measure } from './fsops'
import { detectInstall, registerUninstall } from './registry'
import { createShortcut, writeUninstallScript } from './shortcut'

/**
 * 安装流程本体：复制载荷 → 建快捷方式 → 写卸载脚本 + 注册表。
 *
 * 与原独立安装器（installer/main.js）的唯一结构差异：**载荷源从
 * `resources/payload` 变成了应用自身所在目录** —— 安装模式跑的就是启动器自身，
 * 不再套第二层运行时。
 */

/** 安装进度回调（由 index.ts 接到渲染层）。 */
export type ProgressFn = (phase: string, percent: number, detail: string) => void

/** 载荷内的文件总数与总字节数（首次统计后缓存，供进度与 EstimatedSize 使用）。 */
let payloadFileCount = 0
let payloadBytes = 0
/** 用户是否取消了安装。 */
let cancelled = false

/** 把错误整理成可读文本（含 code / path / dest），并追加到诊断日志。 */
export function describeError(err: unknown): string {
  // fs 的复制错误会带 dest（目标路径），比 message 更有用 —— 拷贝中断时能直接看出
  // 卡在哪个文件上。ErrnoException 上没有这个字段，故在此扩展。
  const e = (err || {}) as NodeJS.ErrnoException & { dest?: string }
  const parts: string[] = []
  if (e.code) parts.push(e.code)
  parts.push(e.message || String(err))
  if (e.path) parts.push(`path=${e.path}`)
  if (e.dest) parts.push(`dest=${e.dest}`)
  if (e.syscall) parts.push(`syscall=${e.syscall}`)
  const text = parts.join(' | ')
  try {
    appendFileSync(
      join(tmpdir(), 'HungerCat-Install-Error.log'),
      `[${new Date().toISOString()}] ${text}\n${e.stack || ''}\n`
    )
  } catch {
    /* 忽略日志写入失败 */
  }
  return text
}

/** 安装参数。 */
export interface InstallOptions {
  dir: string
  scope: string
  desktopShortcut?: boolean
  startMenuShortcut?: boolean
}

/** 安装结果。 */
export interface InstallResult {
  ok: boolean
  scope?: InstallScope
  installDir?: string
  exePath?: string
  error?: string
  cancelled?: boolean
}

/** 供 UI 调用 `reg.exe` / PowerShell 的包装。 */
export function runPowerShell(command: string): Promise<number> {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], (err) => {
      resolve(err && typeof err.code === 'number' ? err.code : err ? 1 : 0)
    })
  })
}

/** 执行一次安装。 */
export async function runInstall(
  src: string,
  opts: InstallOptions,
  onProgress: ProgressFn
): Promise<InstallResult> {
  const scope = normalizeScope(opts?.scope)
  const installDir = String(opts?.dir || '').trim()
  if (!installDir) return { ok: false, error: '安装目录为空' }

  cancelled = false
  try {
    // === 硬守护：安装目录绝不能与用户数据目录重叠 ===
    // 安装/升级时只会把程序文件复制到 installDir，绝不能碰
    // %APPDATA%\HungerCat MineCraft Launcher（userData）里的 settings、账号、实例、壁纸等用户数据。
    // 若用户（或脚本）把安装目录选成了 userData 本身或其祖先/子目录，直接拒绝安装。
    const userDataDir = app.getPath('userData')
    const normInstall = resolve(installDir).toLowerCase()
    const normUserData = resolve(userDataDir).toLowerCase()
    const normSrc = resolve(src).toLowerCase()
    if (
      normInstall === normUserData ||
      normInstall.startsWith(normUserData + sep) ||
      normUserData.startsWith(normInstall + sep)
    ) {
      return {
        ok: false,
        error:
          '安装目录与用户数据目录重叠，安装会覆盖/删除 %APPDATA%\\HungerCat MineCraft Launcher 下的用户数据（设置、账号、实例、壁纸等），请改为其它目录'
      }
    }
    // 载荷源（Setup.exe 所在目录）不得位于用户数据目录内，否则复制载荷时会把
    // userData 里的文件（settings、账号、实例、壁纸等）混入安装目录。
    if (
      normSrc === normUserData ||
      normSrc.startsWith(normUserData + sep) ||
      normUserData.startsWith(normSrc + sep)
    ) {
      return {
        ok: false,
        error:
          '安装程序（Setup.exe）位于用户数据目录内，复制载荷会误碰 %APPDATA%\\HungerCat MineCraft Launcher 下的用户数据，请将安装程序移出该目录后再运行'
      }
    }
    // 1. 复制载荷
    onProgress('copy', 0, '正在准备文件…')
    if (payloadFileCount === 0) {
      const m = await measure(src)
      payloadFileCount = m.count
      payloadBytes = m.bytes
    }
    let done = 0
    await copyTree(src, installDir, (name) => {
      done += 1
      const percent = Math.min(100, Math.round((done / payloadFileCount) * 100))
      if (done % 20 === 0 || done === payloadFileCount) {
        onProgress('copy', percent, done === payloadFileCount ? '文件复制完成' : `正在复制 ${name}`)
      }
    }, () => cancelled)

    // 2. 快捷方式（按范围选择目标目录）
    onProgress('shortcut', 100, '正在创建快捷方式…')
    const exePath = join(installDir, APP_EXE)
    let desktopLnk = ''
    let startMenuLnk = ''
    if (opts?.desktopShortcut !== false) {
      const dir = desktopDirFor(scope)
      await mkdir(dir, { recursive: true })
      desktopLnk = join(dir, `${SHORTCUT_NAME}.lnk`)
      createShortcut(desktopLnk, exePath, installDir)
    }
    if (opts?.startMenuShortcut !== false) {
      const dir = startMenuDirFor(scope)
      await mkdir(dir, { recursive: true })
      startMenuLnk = join(dir, `${SHORTCUT_NAME}.lnk`)
      createShortcut(startMenuLnk, exePath, installDir)
    }

    // 3. 卸载脚本 + 注册
    onProgress('register', 100, '正在注册卸载信息…')
    await writeUninstallScript(scope, installDir, app.getPath('userData'))
    const registered = await registerUninstall(
      scope,
      installDir,
      app.getVersion(),
      payloadBytes,
      desktopLnk,
      startMenuLnk
    )
    if (!registered) {
      return {
        ok: false,
        error:
          scope === 'all'
            ? '写入机器级卸载信息失败：需要管理员权限，请允许 UAC 提权后重试'
            : '写入卸载信息失败，请稍后重试'
      }
    }

    onProgress('done', 100, '安装完成')
    return { ok: true, scope, installDir, exePath }
  } catch (err) {
    if (err && (err as Error).message === 'CANCELLED') return { ok: false, cancelled: true }
    return { ok: false, error: describeError(err) }
  }
}

/**
 * 机器级安装：走 UAC 提权，用**无界面子进程**（本程序自身 +
 * `--hc-elevated-install`）完成，子进程把结果写入临时文件后退出，父进程读取结果。
 */
export async function installElevated(
  src: string,
  opts: InstallOptions,
  onProgress: ProgressFn
): Promise<InstallResult> {
  const stamp = Date.now()
  const reqPath = join(tmpdir(), `hc-elev-${stamp}.json`)
  const resPath = `${reqPath}.result`
  const req = {
    dir: opts.dir,
    scope: 'all',
    desktopShortcut: opts.desktopShortcut,
    startMenuShortcut: opts.startMenuShortcut,
    resultPath: resPath
  }
  // 同 runInstall 的硬守护：机器级安装也不得把程序文件写进用户数据目录。
  const userDataDir = app.getPath('userData')
  const normInstall = resolve(String(opts?.dir || '')).toLowerCase()
  const normUserData = resolve(userDataDir).toLowerCase()
  const normSrc = resolve(src).toLowerCase()
  if (
    normInstall === normUserData ||
    normInstall.startsWith(normUserData + sep) ||
    normUserData.startsWith(normInstall + sep)
  ) {
    return {
      ok: false,
      error:
        '安装目录与用户数据目录重叠，安装会覆盖/删除 %APPDATA%\\HungerCat MineCraft Launcher 下的用户数据（设置、账号、实例、壁纸等），请改为其它目录'
    }
  }
  // 载荷源（Setup.exe 所在目录）不得位于用户数据目录内，否则复制载荷时会把
  // userData 里的文件（settings、账号、实例、壁纸等）混入安装目录。
  if (
    normSrc === normUserData ||
    normSrc.startsWith(normUserData + sep) ||
    normUserData.startsWith(normSrc + sep)
  ) {
    return {
      ok: false,
      error:
        '安装程序（Setup.exe）位于用户数据目录内，复制载荷会误碰 %APPDATA%\\HungerCat MineCraft Launcher 下的用户数据，请将安装程序移出该目录后再运行'
    }
  }
  await writeFile(reqPath, JSON.stringify(req), 'utf8')
  onProgress('elevate', 0, '正在请求管理员权限…')
  const ps = (s: string): string => `'${String(s).replace(/'/g, "''")}'`
  const cmd =
    `try { Start-Process -FilePath ${ps(process.execPath)} ` +
    `-ArgumentList '--hc-elevated-install',${ps(reqPath)} -Verb RunAs -Wait } catch { exit 3 }`
  const code = await runPowerShell(cmd)
  let res: InstallResult = { ok: false, error: '未获得管理员授权，已取消「为所有用户安装」' }
  try {
    res = JSON.parse(await readFile(resPath, 'utf8')) as InstallResult
  } catch {
    if (code === 3) res = { ok: false, error: '已取消管理员授权（UAC），未进行安装' }
  }
  await rm(reqPath, { force: true }).catch(() => {})
  await rm(resPath, { force: true }).catch(() => {})
  return res
}

/** 供 UI 展示的安装器信息（两个范围的既有安装 + 默认目录）。 */
export async function buildInfo(src: string, currentUser: string): Promise<unknown> {
  return {
    appName: APP_NAME,
    appVersion: app.getVersion(),
    currentUser,
    payloadReady: existsSync(join(src, APP_EXE)),
    platform: process.platform,
    scopes: {
      all: {
        label: '为所有用户安装',
        defaultDir: defaultDirFor('all'),
        install: await detectInstall('all')
      },
      user: {
        label: `仅为当前用户安装（${currentUser}）`,
        defaultDir: defaultDirFor('user'),
        install: await detectInstall('user')
      }
    }
  }
}

/** 用户取消安装。 */
export function requestCancel(): boolean {
  cancelled = true
  return true
}