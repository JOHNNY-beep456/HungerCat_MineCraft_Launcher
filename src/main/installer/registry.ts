import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  APP_EXE,
  APP_NAME,
  LEGACY_REG_KEY_ALL,
  LEGACY_REG_KEY_USER,
  PUBLISHER,
  UNINSTALL_SCRIPT,
  currentUserName,
  defaultDirFor,
  installKeyFor,
  uninstallKeyFor,
  type InstallScope
} from './paths'

/**
 * 注册表读写与「是否已安装」探测。
 *
 * 全部走 `reg.exe`（系统自带、最省事、无需 PowerShell），并且**每步都回读校验** ——
 * 机器级安装在没真正拿到提权的情况下，reg add 会「成功」但实际什么也没写，
 * 只看返回值会把这种情况误报成安装完成。
 */

/** 读取某个卸载项注册表值；不存在返回 null。 */
export function regQuery(key: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], (err, stdout) => {
      if (err) return resolve(null)
      const safe = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const m = new RegExp(`^\\s+${safe}\\s+REG_\\w+\\s+(.*)$`, 'im').exec(String(stdout))
      resolve(m ? m[1].trim() : null)
    })
  })
}

/** 逐项写入注册表值（`reg add`）；返回是否成功。 */
export function regAdd(key: string, name: string, type: string, value: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('reg', ['add', key, '/v', name, '/t', type, '/d', value, '/f'], () =>
      resolve(true)
    )
  })
}

/** 删除注册表键（不存在也不报错）。 */
export function regDelete(key: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('reg', ['delete', key, '/f'], () => resolve(true))
  })
}

/** 探测到的既有安装记录。 */
export interface DetectedInstall {
  scope: InstallScope
  /** registry = 从注册表读到；filesystem = 只在默认目录里找到了 exe。 */
  source: 'registry' | 'filesystem'
  installDir: string
  version: string
  installUser: string
}

/**
 * 检测指定范围是否已安装。检测顺序：
 *   1. **electron-builder 布局**（`Software\<GUID>` 的 InstallLocation、
 *      `...\Uninstall\<GUID>` 的 DisplayName/DisplayVersion）—— 自带安装器与本安装器
 *      都写这里，故能**双向发现**；
 *   2. 兼容本安装器早期版本的键（`...\Uninstall\HungerCatMC`）；
 *   3. 该范围的默认安装目录里是否已有启动器（其它安装器 / 旧版 / 记录丢失）。
 */
export async function detectInstall(scope: InstallScope): Promise<DetectedInstall | null> {
  // 1) electron-builder 布局
  const uKey = uninstallKeyFor(scope)
  const iKey = installKeyFor(scope)
  const name = await regQuery(uKey, 'DisplayName')
  const dir = (await regQuery(iKey, 'InstallLocation')) || (await regQuery(uKey, 'InstallLocation')) || ''
  if (name || dir) {
    return {
      scope,
      source: 'registry',
      installDir: dir,
      version: (await regQuery(uKey, 'DisplayVersion')) || '',
      installUser: (await regQuery(iKey, 'InstallUser')) || (await regQuery(uKey, 'InstallUser')) || ''
    }
  }

  // 2) 兼容本安装器早期版本的键
  const legacy = scope === 'all' ? LEGACY_REG_KEY_ALL : LEGACY_REG_KEY_USER
  if (await regQuery(legacy, 'DisplayName')) {
    return {
      scope,
      source: 'registry',
      installDir: (await regQuery(legacy, 'InstallLocation')) || '',
      version: (await regQuery(legacy, 'DisplayVersion')) || '',
      installUser: (await regQuery(legacy, 'InstallUser')) || ''
    }
  }

  // 3) 目录回退
  const def = defaultDirFor(scope)
  if (existsSync(join(def, APP_EXE))) {
    return { scope, source: 'filesystem', installDir: def, version: '', installUser: '' }
  }
  return null
}

/**
 * 注册卸载项。
 *
 * **遵循 electron-builder 自带安装器的注册表布局**，实现双向可发现：
 *   · 安装信息键 `Software\<GUID>`：InstallLocation / KeepShortcuts / ShortcutName
 *   · 卸载项键 `...\Uninstall\<GUID>`：DisplayName / DisplayVersion / UninstallString
 * 另写入本安装器自有的 InstallScope / InstallUser / 快捷方式实际路径
 * （electron-builder 会忽略未知值）。返回是否确实写入成功。
 */
export async function registerUninstall(
  scope: InstallScope,
  installDir: string,
  version: string,
  sizeBytes: number,
  desktopLnk: string,
  startMenuLnk: string
): Promise<boolean> {
  const uKey = uninstallKeyFor(scope)
  const iKey = installKeyFor(scope)
  const exePath = join(installDir, APP_EXE)
  const uninstallCmd = `cmd /c "${join(installDir, UNINSTALL_SCRIPT)}"`
  const user = currentUserName()
  const installDate = new Date().toISOString().slice(0, 10).replace(/-/g, '')

  // 安装信息键（electron-builder 据此判断「已安装 / 安装位置」）
  await regAdd(iKey, 'InstallLocation', 'REG_SZ', installDir)
  await regAdd(iKey, 'KeepShortcuts', 'REG_SZ', 'true')
  await regAdd(iKey, 'ShortcutName', 'REG_SZ', APP_NAME)
  await regAdd(iKey, 'InstallScope', 'REG_SZ', scope)
  await regAdd(iKey, 'InstallUser', 'REG_SZ', user)

  // 卸载项键
  await regAdd(uKey, 'DisplayName', 'REG_SZ', APP_NAME)
  await regAdd(uKey, 'DisplayVersion', 'REG_SZ', version)
  await regAdd(uKey, 'Publisher', 'REG_SZ', PUBLISHER)
  await regAdd(uKey, 'DisplayIcon', 'REG_SZ', exePath)
  await regAdd(uKey, 'UninstallString', 'REG_SZ', uninstallCmd)
  await regAdd(uKey, 'QuietUninstallString', 'REG_SZ', uninstallCmd)
  await regAdd(uKey, 'InstallDate', 'REG_SZ', installDate)
  await regAdd(uKey, 'InstallScope', 'REG_SZ', scope)
  await regAdd(uKey, 'InstallUser', 'REG_SZ', user)
  if (desktopLnk) await regAdd(uKey, 'DesktopShortcut', 'REG_SZ', desktopLnk)
  if (startMenuLnk) await regAdd(uKey, 'StartMenuShortcut', 'REG_SZ', startMenuLnk)
  await regAdd(uKey, 'NoModify', 'REG_DWORD', '1')
  await regAdd(uKey, 'NoRepair', 'REG_DWORD', '1')
  if (sizeBytes > 0) {
    await regAdd(uKey, 'EstimatedSize', 'REG_DWORD', String(Math.round(sizeBytes / 1024)))
  }

  // 清理本安装器早期版本的键，避免「应用和功能」出现重复项
  await regDelete(scope === 'all' ? LEGACY_REG_KEY_ALL : LEGACY_REG_KEY_USER)

  // 回读校验（机器级安装若未真正提权会失败）
  const back = await regQuery(iKey, 'InstallLocation')
  const named = await regQuery(uKey, 'DisplayName')
  return !!back && back === installDir && !!named
}