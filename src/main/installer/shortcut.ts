import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { shell } from 'electron'
import {
  APP_EXE,
  APP_NAME,
  LEGACY_REG_KEY_ALL,
  LEGACY_REG_KEY_USER,
  UNINSTALL_SCRIPT,
  installKeyFor,
  uninstallKeyFor,
  type InstallScope
} from './paths'

/** 快捷方式与卸载脚本。 */

/** 在指定路径创建指向启动器的快捷方式（Electron 原生 API，无需 PowerShell）。 */
export function createShortcut(lnkPath: string, exePath: string, workDir: string): boolean {
  try {
    return shell.writeShortcutLink(lnkPath, 'create', {
      target: exePath,
      cwd: workDir,
      description: APP_NAME,
      icon: exePath,
      iconIndex: 0
    })
  } catch {
    return false
  }
}

/**
 * 生成卸载脚本内容。
 *
 * 关键点：
 *   1. 脚本先把自己复制到 `%TEMP%` 再从那里执行删除 —— 直接删除「正在运行的脚本
 *      所在的目录」会被文件占用。安装目录**直接以字面量写进脚本**（不用 `%~dp0`），
 *      这样无论从安装目录还是临时副本运行都指向同一目标；
 *   2. 快捷方式路径读取安装时写入注册表的实际值（DesktopShortcut /
 *      StartMenuShortcut）—— OneDrive 重定向桌面等情况下也能删干净；
 *   3. 机器级安装（HKLM / Program Files / 公共快捷方式）需要管理员权限，
 *      故先 UAC 提权再执行删除。
 *   4. **安全底线**：若安装目录与用户数据目录（%APPDATA%）
 *      重叠，脚本**不得**执行 `rmdir /s /q "%DIR%"`，以免把
 *      settings、账号、实例、壁纸等用户数据一并删除。
 *
 * 卸载**不依赖安装器 exe 仍然存在**：目标目录以字面量写死，脚本可独立运行。
 */
export function uninstallScriptText(
  scope: InstallScope,
  installDir: string,
  userDataDir?: string
): string {
  const uKey = uninstallKeyFor(scope)
  const iKey = installKeyFor(scope)
  const legacyKey = scope === 'all' ? LEGACY_REG_KEY_ALL : LEGACY_REG_KEY_USER
  const query = `reg query "${uKey}"`
  const dir = String(installDir).replace(/"/g, '')
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    `set "DIR=${dir}"`,
    'if "%DIR:~-1%"=="\\" set "DIR=%DIR:~0,-1%"',
    'if /i "%~1"=="__hc_run" goto run',
    'copy /y "%~f0" "%TEMP%\\HungerCat-Uninstall.cmd" >nul 2>nul'
  ]
  if (scope === 'all') {
    // 机器级：删除 Program Files / HKLM / 公共快捷方式都需要管理员，先提权
    lines.push(
      'powershell -NoProfile -Command "Start-Process -FilePath \'%TEMP%\\HungerCat-Uninstall.cmd\' -ArgumentList \'__hc_run\' -Verb RunAs" >nul 2>nul'
    )
  } else {
    lines.push('start "" /min cmd /c ""%TEMP%\\HungerCat-Uninstall.cmd" __hc_run"')
  }
  lines.push(
    'exit /b',
    ':run',
    'ping 127.0.0.1 -n 2 >nul',
    'set "DESK="',
    'set "MENU="',
    `for /f "tokens=2,*" %%A in ('${query} /v DesktopShortcut 2^>nul ^| findstr /i DesktopShortcut') do set "DESK=%%B"`,
    `for /f "tokens=2,*" %%A in ('${query} /v StartMenuShortcut 2^>nul ^| findstr /i StartMenuShortcut') do set "MENU=%%B"`,
    'if defined DESK del /f /q "%DESK%" >nul 2>nul',
    'if defined MENU del /f /q "%MENU%" >nul 2>nul'
  )
  // 安装目录与用户数据目录重叠时，绝不执行整目录 rmdir，避免误删用户数据。
  if (
    !userDataDir ||
    !(installDir.toLowerCase() === userDataDir.toLowerCase() ||
      installDir.toLowerCase().startsWith(userDataDir.toLowerCase() + '\\') ||
      userDataDir.toLowerCase().startsWith(installDir.toLowerCase() + '\\'))
  ) {
    lines.push('rmdir /s /q "%DIR%" >nul 2>nul')
  } else {
    lines.push(':: 安装目录与用户数据目录重叠，跳过整目录删除，以保护用户数据')
  }
  lines.push(
    `reg delete "${uKey}" /f >nul 2>nul`,
    `reg delete "${iKey}" /f >nul 2>nul`,
    `reg delete "${legacyKey}" /f >nul 2>nul`,
    'del /f /q "%~f0" >nul 2>nul'
  )
  return lines.join('\r\n') + '\r\n'
}

/** 写入卸载脚本到安装目录。 */
export async function writeUninstallScript(
  scope: InstallScope,
  installDir: string,
  userDataDir: string
): Promise<void> {
  await writeFile(
    join(installDir, UNINSTALL_SCRIPT),
    uninstallScriptText(scope, installDir, userDataDir),
    'utf8'
  )
}

/** 供自检使用：确保安装目录存在（createShortcut 前置）。 */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/** 目标 exe 路径。 */
export function installedExePath(installDir: string): string {
  return join(installDir, APP_EXE)
}