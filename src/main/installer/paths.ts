import { createHash } from 'node:crypto'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

/**
 * 安装相关的路径与注册表键名。
 *
 * 键名布局刻意**复刻 electron-builder 自带 NSIS 安装器**：GUID 用 UUIDv5 对
 * appId + NSIS 命名空间求值，与 electron-builder 的生成结果一致。这样两种安装器
 * 写的是同一套键，`detectInstall()` 才能双向发现 —— 互相覆盖升级都不会出现
 * 「应用和功能」里两条记录、或旧记录指向已删目录。
 */

/** 与启动器打包产物保持一致的产品信息（App 名 / exe 名 / 发布者 / 卸载脚本名）。 */
export const APP_NAME = 'HungerCat MineCraft Launcher'
export const APP_EXE = 'HungerCat MineCraft Launcher.exe'
export const INSTALLER_APP_NAME = 'HungerCat Installer'
export const PUBLISHER = 'Hunger Cat'
export const UNINSTALL_SCRIPT = 'uninstall.cmd'
/** 快捷方式文件名（不含扩展名）。 */
export const SHORTCUT_NAME = APP_NAME
/** 本安装器早期版本使用的卸载项键（保留用于兼容检测与清理）。 */
export const LEGACY_REG_KEY_ALL =
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\HungerCatMC'
export const LEGACY_REG_KEY_USER =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\HungerCatMC'

/* ---- electron-builder 的 NSIS 布局 ---- */
/** appId 必须与 electron-builder.yml 的 appId 保持一致，否则两套安装器互相看不见。 */
const LAUNCHER_APP_ID = 'com.hungercat.launcher'
const ELECTRON_BUILDER_NS_UUID = '50e065bc-3134-11e6-9bab-38c9862bdaf3'

/** UUID v5（SHA-1 命名空间）实现，与 electron-builder 的生成结果一致。 */
function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const hash = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest()
  const b = Buffer.from(hash.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50 // 版本 5
  b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 变体
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** 与 electron-builder NSIS 安装器一致的卸载项 GUID。 */
export const NSIS_APP_GUID = uuidV5(LAUNCHER_APP_ID, ELECTRON_BUILDER_NS_UUID)

/** 安装范围：仅为当前用户 / 为所有用户。 */
export type InstallScope = 'user' | 'all'

/** 归一化范围取值（外部传参一律经此收口）。 */
export function normalizeScope(scope: string | undefined): InstallScope {
  return scope === 'all' ? 'all' : 'user'
}

/** 该范围对应的注册表根（机器级 = HKLM，单用户 = HKCU）。 */
export function hiveFor(scope: InstallScope): 'HKLM' | 'HKCU' {
  return scope === 'all' ? 'HKLM' : 'HKCU'
}

/** 卸载项键（遵循 electron-builder 布局，存 DisplayName / DisplayVersion / UninstallString）。 */
export function uninstallKeyFor(scope: InstallScope): string {
  return `${hiveFor(scope)}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${NSIS_APP_GUID}`
}

/** 安装信息键（遵循 electron-builder 布局，存 InstallLocation 等）。 */
export function installKeyFor(scope: InstallScope): string {
  return `${hiveFor(scope)}\\Software\\${NSIS_APP_GUID}`
}

/** 当前登录用户名（用于判断单用户安装是否属于本人）。 */
export function currentUserName(): string {
  try {
    return userInfo().username
  } catch {
    return process.env.USERNAME || ''
  }
}

/** 默认安装目录：机器级 → Program Files；单用户 → LocalAppData\Programs。 */
export function defaultDirFor(scope: InstallScope): string {
  if (scope === 'all') {
    const pf = process.env.ProgramFiles || process.env.ProgramW6432 || process.env['ProgramFiles(x86)']
    return join(pf || 'C:\\Program Files', APP_NAME)
  }
  return join(process.env.LOCALAPPDATA || homedir(), 'Programs', APP_NAME)
}

/** 桌面快捷方式目录：机器级 → 公共桌面；单用户 → 当前用户桌面。 */
export function desktopDirFor(scope: InstallScope): string {
  if (scope === 'all') {
    return join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop')
  }
  return join(process.env.USERPROFILE || homedir(), 'Desktop')
}

/** 开始菜单目录：机器级 → ProgramData；单用户 → 当前用户 AppData。 */
export function startMenuDirFor(scope: InstallScope): string {
  if (scope === 'all') {
    return join(
      process.env.ProgramData || 'C:\\ProgramData',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs'
    )
  }
  return join(process.env.APPDATA || homedir(), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
}