'use strict'

/**
 * HungerCat MineCraft Launcher 安装程序（自研 Electron 安装器）。
 *
 * 与启动器共用一套视觉语言（深色玻璃 + #0a84ff 强调色），自行完成：
 *   1. 把内置载荷（打包后的启动器目录）复制到用户选择的目录；
 *   2. 创建桌面 / 开始菜单快捷方式；
 *   3. 写入「应用和功能」的卸载项，并生成卸载脚本。
 *
 * 支持两种安装范围：
 *   · user（仅为当前用户）—— 装到 `%LOCALAPPDATA%\Programs`，写 HKCU，无需管理员；
 *   · all （为所有用户）  —— 装到 `%ProgramFiles%`，写 HKLM、建公共快捷方式，
 *                            需要管理员权限（经 UAC 提权后用无界面子进程完成安装）。
 *
 * 与 electron-builder 的 NSIS 安装器不同：安装界面完全由本程序（Electron + HTML/CSS）
 * 绘制，可复刻启动器的玻璃拟态风格；打包时仅用 portable 目标把它封成单文件 exe。
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const { execFile } = require('node:child_process')
const crypto = require('node:crypto')

/** 与启动器打包产物保持一致的产品信息。 */
const APP_NAME = 'HungerCat MineCraft Launcher'
const APP_EXE = 'HungerCat MineCraft Launcher.exe'
const PUBLISHER = 'Hunger Cat'
const UNINSTALL_SCRIPT = 'uninstall.cmd'
/** 快捷方式文件名（不含扩展名）。 */
const SHORTCUT_NAME = APP_NAME
/** 本安装器早期版本使用的卸载项键（保留用于兼容检测与清理）。 */
const LEGACY_REG_KEY_ALL = 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\HungerCatMC'
const LEGACY_REG_KEY_USER = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\HungerCatMC'

/* ---- electron-builder 自带（NSIS）安装器的注册表布局 ----
 * 为让「自动发现」与其一致，这里复刻它的键名算法与位置：
 *   GUID = UUIDv5(appId, 50e065bc-3134-11e6-9bab-38c9862bdaf3)
 *   · 安装信息键：`Software\<GUID>`（内含 InstallLocation 等）
 *   · 卸载项键  ：`Software\Microsoft\Windows\CurrentVersion\Uninstall\<GUID>`
 * 两者都在 SHELL_CONTEXT（单用户 = HKCU，机器级 = HKLM）。
 * appId 必须与 electron-builder.yml 的 `appId` 保持一致。 */
const LAUNCHER_APP_ID = 'com.hungercat.launcher'
const ELECTRON_BUILDER_NS_UUID = '50e065bc-3134-11e6-9bab-38c9862bdaf3'

/** UUID v5（SHA-1 命名空间）实现，与 electron-builder 的生成结果一致。 */
function uuidV5(name, namespace) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const hash = crypto.createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest()
  const b = Buffer.from(hash.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50 // 版本 5
  b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 变体
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const NSIS_APP_GUID = uuidV5(LAUNCHER_APP_ID, ELECTRON_BUILDER_NS_UUID)

let win = null
/** 安装 / 复制过程是否被用户取消。 */
let cancelled = false
/** 载荷内的文件总数与总字节数（首次统计后缓存，用于进度与 EstimatedSize）。 */
let payloadFileCount = 0
let payloadBytes = 0

/* ------------------------------------------------------------------ */
/* 路径与范围工具                                                      */
/* ------------------------------------------------------------------ */

/** 载荷目录：打包后位于 `resources/payload`，开发时位于 `installer/payload`。 */
function payloadDir() {
  const packed = path.join(process.resourcesPath || '', 'payload')
  if (fs.existsSync(packed)) return packed
  return path.join(__dirname, 'payload')
}

/** 当前登录用户名（用于判断单用户安装是否属于本人）。 */
function currentUserName() {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USERNAME || ''
  }
}

/** 归一化范围取值。 */
function normalizeScope(scope) {
  return scope === 'all' ? 'all' : 'user'
}

/** 该范围对应的注册表根（机器级 = HKLM，单用户 = HKCU）。 */
function hiveFor(scope) {
  return scope === 'all' ? 'HKLM' : 'HKCU'
}

/** 卸载项键（遵循 electron-builder 布局）。 */
function uninstallKeyFor(scope) {
  return `${hiveFor(scope)}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${NSIS_APP_GUID}`
}

/** 安装信息键（遵循 electron-builder 布局，存 InstallLocation 等）。 */
function installKeyFor(scope) {
  return `${hiveFor(scope)}\\Software\\${NSIS_APP_GUID}`
}

/** 默认安装目录：机器级 → Program Files；单用户 → LocalAppData\Programs。 */
function defaultDirFor(scope) {
  if (scope === 'all') {
    const pf = process.env.ProgramFiles || process.env.ProgramW6432 || process.env['ProgramFiles(x86)'] || 'C:\\Program Files'
    return path.join(pf, APP_NAME)
  }
  const base = process.env.LOCALAPPDATA || app.getPath('home')
  return path.join(base, 'Programs', APP_NAME)
}

/** 桌面快捷方式目录：机器级 → 公共桌面；单用户 → 当前用户桌面。 */
function desktopDirFor(scope) {
  if (scope === 'all') return path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop')
  return app.getPath('desktop')
}

/** 开始菜单目录：机器级 → ProgramData；单用户 → 当前用户 AppData。 */
function startMenuDirFor(scope) {
  if (scope === 'all') {
    return path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  }
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
}

/* ------------------------------------------------------------------ */
/* 文件工具                                                            */
/* ------------------------------------------------------------------ */

/**
 * 临时关闭 Electron 的 asar 拦截后执行文件系统操作。
 *
 * 启动器载荷里含 `resources\app.asar`。Electron 会拦截**路径中含 `.asar`** 的 fs 调用，
 * 把它当成「asar 归档」去解析，于是对普通文件 `app.asar` 的 stat / 复制会误报
 * `ENOENT`（普通 Node 没有该拦截，所以同样的代码在 Node 下正常）。
 * 复制期间临时置 `process.noAsar = true` 即可绕开；复制结束立刻恢复，
 * 以免影响其它可能依赖 asar 的读取。
 */
async function withNoAsar(fn) {
  const prev = process.noAsar
  process.noAsar = true
  try {
    return await fn()
  } finally {
    process.noAsar = prev
  }
}

/** 递归统计目录下的文件数量与总字节数（用于进度与 EstimatedSize）。 */
async function measure(dir) {
  return withNoAsar(() => measureRaw(dir))
}

async function measureRaw(dir) {
  let count = 0
  let bytes = 0
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const ent of entries) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      const sub = await measureRaw(p)
      count += sub.count
      bytes += sub.bytes
    } else {
      count += 1
      try {
        bytes += (await fsp.stat(p)).size
      } catch {
        /* 单个文件 stat 失败不影响整体统计 */
      }
    }
  }
  return { count, bytes }
}

/**
 * 递归复制目录，按「已复制文件数 / 总数」回报进度。
 * 用 fs.copyFile 而非 fs.cp，以便统计并上报进度。
 */
async function copyTree(src, dest, onProgress) {
  return withNoAsar(() => copyTreeRaw(src, dest, onProgress))
}

async function copyTreeRaw(src, dest, onProgress) {
  await fsp.mkdir(dest, { recursive: true })
  const entries = await fsp.readdir(src, { withFileTypes: true })
  for (const ent of entries) {
    if (cancelled) throw new Error('CANCELLED')
    const s = path.join(src, ent.name)
    const d = path.join(dest, ent.name)
    if (ent.isDirectory()) {
      await copyTreeRaw(s, d, onProgress)
    } else {
      await fsp.copyFile(s, d)
      onProgress(ent.name)
    }
  }
}

/** 向渲染层推送进度。 */
function sendProgress(phase, percent, detail) {
  if (win && !win.isDestroyed()) win.webContents.send('installer:progress', { phase, percent, detail })
}

/* ------------------------------------------------------------------ */
/* 注册表读写                                                          */
/* ------------------------------------------------------------------ */

/** 读取某个卸载项注册表值；不存在返回 null。 */
function regQuery(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], (err, stdout) => {
      if (err) return resolve(null)
      const safe = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const m = new RegExp('^\\s+' + safe + '\\s+REG_\\w+\\s+(.*)$', 'im').exec(String(stdout))
      resolve(m ? m[1].trim() : null)
    })
  })
}

/** 逐项写入注册表值（用 reg.exe，最省事且系统自带）；返回是否成功。 */
function regAdd(key, name, type, value) {
  return new Promise((resolve) => {
    execFile('reg', ['add', key, '/v', name, '/t', type, '/d', value, '/f'], (err) => resolve(!err))
  })
}

/** 删除注册表键（不存在也不报错）。 */
function regDelete(key) {
  return new Promise((resolve) => {
    execFile('reg', ['delete', key, '/f'], () => resolve())
  })
}

/**
 * 检测指定范围是否已安装；返回安装信息或 null。检测顺序：
 *   1. **electron-builder 布局**（`Software\<GUID>` 的 InstallLocation、`...\Uninstall\<GUID>`
 *      的 DisplayName/DisplayVersion）——自带安装器与本安装器都写这里，故能**双向发现**；
 *   2. 兼容本安装器早期版本的键（`...\Uninstall\HungerCatMC`）；
 *   3. 该范围的默认安装目录里是否已有启动器（其它安装器 / 旧版 / 记录丢失等情况）。
 */
async function detectInstall(scope) {
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
  try {
    if (fs.existsSync(path.join(def, APP_EXE))) {
      return { scope, source: 'filesystem', installDir: def, version: '', installUser: '' }
    }
  } catch {
    /* 忽略 */
  }
  return null
}

/**
 * 注册卸载项 —— **遵循 electron-builder 自带安装器的注册表布局**，实现双向可发现：
 *   · 安装信息键 `Software\<GUID>`：`InstallLocation` / `KeepShortcuts` / `ShortcutName`
 *   · 卸载项键 `...\Uninstall\<GUID>`：`DisplayName` / `DisplayVersion` / `UninstallString` 等
 * 另写入本安装器自有的 `InstallScope` / `InstallUser` / 快捷方式实际路径（electron-builder 会忽略未知值）。
 * 返回是否确实写入成功。
 */
async function registerUninstall(scope, installDir, sizeBytes, desktopLnk, startMenuLnk) {
  const uKey = uninstallKeyFor(scope)
  const iKey = installKeyFor(scope)
  const exePath = path.join(installDir, APP_EXE)
  const uninstallCmd = `cmd /c "${path.join(installDir, UNINSTALL_SCRIPT)}"`
  const user = currentUserName()
  const installDate = new Date().toISOString().slice(0, 10).replace(/-/g, '')

  // 安装信息键（electron-builder 据此判断「已安装 / 安装位置」）
  await regAdd(iKey, 'InstallLocation', 'REG_SZ', installDir)
  await regAdd(iKey, 'KeepShortcuts', 'REG_SZ', 'true')
  await regAdd(iKey, 'ShortcutName', 'REG_SZ', SHORTCUT_NAME)
  await regAdd(iKey, 'InstallScope', 'REG_SZ', scope)
  await regAdd(iKey, 'InstallUser', 'REG_SZ', user)

  // 卸载项键
  await regAdd(uKey, 'DisplayName', 'REG_SZ', APP_NAME)
  await regAdd(uKey, 'DisplayVersion', 'REG_SZ', app.getVersion())
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
  if (sizeBytes > 0) await regAdd(uKey, 'EstimatedSize', 'REG_DWORD', String(Math.round(sizeBytes / 1024)))

  // 清理本安装器早期版本的键，避免「应用和功能」出现重复项
  await regDelete(scope === 'all' ? LEGACY_REG_KEY_ALL : LEGACY_REG_KEY_USER)

  // 回读校验（机器级安装若未真正提权会失败）
  const back = await regQuery(iKey, 'InstallLocation')
  const named = await regQuery(uKey, 'DisplayName')
  return !!back && back === installDir && !!named
}

/* ------------------------------------------------------------------ */
/* 快捷方式 / 卸载脚本                                                 */
/* ------------------------------------------------------------------ */

/** 在指定路径创建指向启动器的快捷方式（Electron 原生 API，无需 PowerShell）。 */
function createShortcut(lnkPath, exePath, workDir) {
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
 *   1. 脚本先把自身复制到 `%TEMP%` 再从那里执行删除 —— 直接删除「正在运行的脚本
 *      所在的目录」会被文件占用。安装目录**直接以字面量写进脚本**（不靠 `%~dp0`），
 *      这样无论从安装目录还是临时副本运行都指向同一目标。
 *   2. 快捷方式路径读取安装时写入注册表的实际值（DesktopShortcut / StartMenuShortcut），
 *      OneDrive 重定向桌面等情况下也能删干净。
 *   3. 机器级安装（HKLM / Program Files / 公共快捷方式）需要管理员权限，
 *      故先经 UAC 提权再执行删除。
 */
function uninstallScriptText(scope, installDir) {
  const uKey = uninstallKeyFor(scope)
  const iKey = installKeyFor(scope)
  const legacyKey = scope === 'all' ? LEGACY_REG_KEY_ALL : LEGACY_REG_KEY_USER
  const query = 'reg query "' + uKey + '"'
  const dir = String(installDir).replace(/"/g, '')
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    'set "DIR=' + dir + '"',
    'if "%DIR:~-1%"=="\\" set "DIR=%DIR:~0,-1%"',
    'if /i "%~1"=="__hc_run" goto run',
    'copy /y "%~f0" "%TEMP%\\HungerCat-Uninstall.cmd" >nul 2>nul'
  ]
  if (scope === 'all') {
    // 机器级：删除 Program Files / HKLM / 公共快捷方式都需要管理员，先提权。
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
    'for /f "tokens=2,*" %%A in (\'' + query + ' /v DesktopShortcut 2^>nul ^| findstr /i DesktopShortcut\') do set "DESK=%%B"',
    'for /f "tokens=2,*" %%A in (\'' + query + ' /v StartMenuShortcut 2^>nul ^| findstr /i StartMenuShortcut\') do set "MENU=%%B"',
    'if defined DESK del /f /q "%DESK%" >nul 2>nul',
    'if defined MENU del /f /q "%MENU%" >nul 2>nul',
    'rmdir /s /q "%DIR%" >nul 2>nul',
    'reg delete "' + uKey + '" /f >nul 2>nul',
    'reg delete "' + iKey + '" /f >nul 2>nul',
    'reg delete "' + legacyKey + '" /f >nul 2>nul',
    'del /f /q "%~f0" >nul 2>nul'
  )
  return lines.join('\r\n') + '\r\n'
}

/** 写入卸载脚本到安装目录。 */
async function writeUninstallScript(scope, installDir) {
  await fsp.writeFile(path.join(installDir, UNINSTALL_SCRIPT), uninstallScriptText(scope, installDir), 'utf8')
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

function createWindow() {
  win = new BrowserWindow({
    width: 820,
    height: 620,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    backgroundColor: '#0b0c14',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.setMenuBarVisibility(false)
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    win = null
  })
}

/* ------------------------------------------------------------------ */
/* 安装流程                                                            */
/* ------------------------------------------------------------------ */

/** 把错误整理成可读文本（含 code / path），并追加到诊断日志。 */
function describeError(err) {
  const e = err || {}
  const parts = []
  if (e.code) parts.push(e.code)
  parts.push(e.message || String(err))
  if (e.path) parts.push('path=' + e.path)
  if (e.dest) parts.push('dest=' + e.dest)
  if (e.syscall) parts.push('syscall=' + e.syscall)
  const text = parts.join(' | ')
  try {
    fs.appendFileSync(
      path.join(app.getPath('temp'), 'HungerCat-Install-Error.log'),
      `[${new Date().toISOString()}] ${text}\n${e.stack || ''}\n`
    )
  } catch {
    /* 忽略日志写入失败 */
  }
  return text
}

/** 执行安装（供 IPC、提权子进程与自检复用）。opts = { dir, scope, desktopShortcut, startMenuShortcut }。 */
async function runInstall(opts) {
  const scope = normalizeScope(opts?.scope)
  const installDir = String(opts?.dir || '').trim()
  if (!installDir) return { ok: false, error: '安装目录为空' }
  const src = payloadDir()
  if (!fs.existsSync(path.join(src, APP_EXE))) {
    return { ok: false, error: '安装载荷缺失，请重新运行安装程序' }
  }
  cancelled = false
  try {
    // 1. 复制载荷
    sendProgress('copy', 0, '正在准备文件…')
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
        sendProgress('copy', percent, done === payloadFileCount ? '文件复制完成' : '正在复制 ' + name)
      }
    })

    // 2. 快捷方式（按范围选择目标目录）
    sendProgress('shortcut', 100, '正在创建快捷方式…')
    const exePath = path.join(installDir, APP_EXE)
    let desktopLnk = ''
    let startMenuLnk = ''
    if (opts?.desktopShortcut !== false) {
      desktopLnk = path.join(desktopDirFor(scope), SHORTCUT_NAME + '.lnk')
      createShortcut(desktopLnk, exePath, installDir)
    }
    if (opts?.startMenuShortcut !== false) {
      const startMenuDir = startMenuDirFor(scope)
      await fsp.mkdir(startMenuDir, { recursive: true })
      startMenuLnk = path.join(startMenuDir, SHORTCUT_NAME + '.lnk')
      createShortcut(startMenuLnk, exePath, installDir)
    }

    // 3. 卸载脚本 + 注册表
    sendProgress('register', 100, '正在注册卸载信息…')
    await writeUninstallScript(scope, installDir)
    const registered = await registerUninstall(scope, installDir, payloadBytes, desktopLnk, startMenuLnk)
    if (!registered) {
      return {
        ok: false,
        error:
          scope === 'all'
            ? '写入机器级卸载信息失败：需要管理员权限，请允许 UAC 提权后重试。'
            : '写入卸载信息失败，请稍后重试。'
      }
    }

    sendProgress('done', 100, '安装完成')
    return { ok: true, scope, installDir, exePath }
  } catch (err) {
    if (err && err.message === 'CANCELLED') return { ok: false, cancelled: true }
    return { ok: false, error: describeError(err) }
  }
}

/** 用 PowerShell 执行命令，返回退出码。 */
function runPowerShell(command) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], (err) => {
      resolve(err && typeof err.code === 'number' ? err.code : err ? 1 : 0)
    })
  })
}

/**
 * 机器级安装：经 UAC 提权，用**无界面子进程**（本程序自身 + `--hc-elevated-install`）完成，
 * 子进程把结果写入临时文件后退出；父进程等待并读取结果。
 */
async function installElevated(opts) {
  const stamp = Date.now()
  const reqPath = path.join(app.getPath('temp'), `hc-elev-${stamp}.json`)
  const resPath = reqPath + '.result'
  const req = {
    dir: opts.dir,
    scope: 'all',
    desktopShortcut: opts.desktopShortcut,
    startMenuShortcut: opts.startMenuShortcut,
    resultPath: resPath
  }
  await fsp.writeFile(reqPath, JSON.stringify(req), 'utf8')
  sendProgress('elevate', 0, '正在请求管理员权限…')
  const ps = (s) => "'" + String(s).replace(/'/g, "''") + "'"
  const cmd =
    `try { Start-Process -FilePath ${ps(process.execPath)} ` +
    `-ArgumentList '--hc-elevated-install',${ps(reqPath)} -Verb RunAs -Wait } catch { exit 3 }`
  const code = await runPowerShell(cmd)
  let res = { ok: false, error: '未获得管理员授权，已取消「为所有用户安装」' }
  try {
    res = JSON.parse(await fsp.readFile(resPath, 'utf8'))
  } catch {
    if (code === 3) res = { ok: false, error: '已取消管理员授权（UAC），未进行安装' }
  }
  await fsp.rm(reqPath, { force: true }).catch(() => {})
  await fsp.rm(resPath, { force: true }).catch(() => {})
  return res
}

/* ------------------------------------------------------------------ */
/* 信息 / IPC                                                          */
/* ------------------------------------------------------------------ */

/** 汇总安装器信息（供界面与自检使用）。 */
async function buildInfo() {
  const payload = payloadDir()
  const user = currentUserName()
  return {
    appName: APP_NAME,
    appVersion: app.getVersion(),
    currentUser: user,
    payloadReady: fs.existsSync(path.join(payload, APP_EXE)),
    platform: process.platform,
    scopes: {
      all: { label: '为所有用户安装', defaultDir: defaultDirFor('all'), install: await detectInstall('all') },
      user: { label: `仅为当前用户安装（${user}）`, defaultDir: defaultDirFor('user'), install: await detectInstall('user') }
    }
  }
}

function registerIpc() {
  ipcMain.handle('installer:info', () => buildInfo())

  ipcMain.handle('installer:chooseDir', async (_e, scope) => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择安装目录',
      defaultPath: defaultDirFor(normalizeScope(scope)),
      properties: ['openDirectory', 'createDirectory']
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle('installer:start', async (_e, opts) => {
    const scope = normalizeScope(opts?.scope)
    if (scope === 'all') return installElevated({ ...opts, scope })
    return runInstall({ ...opts, scope })
  })

  ipcMain.handle('installer:cancel', () => {
    cancelled = true
    return true
  })

  ipcMain.handle('installer:launch', async (_e, exePath) => {
    if (!exePath || !fs.existsSync(exePath)) return { ok: false }
    await shell.openPath(exePath)
    return { ok: true }
  })

  ipcMain.handle('installer:openFolder', (_e, dir) => {
    if (dir && fs.existsSync(dir)) void shell.openPath(dir)
    return true
  })

  ipcMain.handle('installer:quit', () => {
    app.quit()
    return true
  })

  ipcMain.handle('installer:minimize', () => {
    win?.minimize()
    return true
  })
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

/** 自检 / 提权子进程：无界面执行一次安装并把结果写入日志或结果文件。 */
function bootstrapHeadless() {
  const args = process.argv
  const selftestIdx = args.indexOf('--hc-selftest')
  const infoIdx = args.indexOf('--hc-info')
  const elevIdx = args.indexOf('--hc-elevated-install')

  if (infoIdx >= 0) {
    void buildInfo().then((data) => {
      try {
        fs.appendFileSync(path.join(app.getPath('temp'), 'HungerCat-Info.log'), JSON.stringify(data) + '\n')
      } catch {
        /* 忽略 */
      }
      app.exit(0)
    })
    return true
  }

  if (elevIdx >= 0) {
    const reqPath = args[elevIdx + 1]
    void (async () => {
      let result = { ok: false, error: '提权子进程参数错误' }
      try {
        const raw = await fsp.readFile(reqPath, 'utf8')
        const req = JSON.parse(raw.replace(/^\uFEFF/, ''))
        result = await runInstall({
          dir: req.dir,
          scope: 'all',
          desktopShortcut: req.desktopShortcut,
          startMenuShortcut: req.startMenuShortcut
        })
        if (req.resultPath) await fsp.writeFile(req.resultPath, JSON.stringify(result), 'utf8')
      } catch (err) {
        result = { ok: false, error: describeError(err) }
      }
      app.exit(result.ok ? 0 : 1)
    })()
    return true
  }

  if (selftestIdx >= 0) {
    const target = args[selftestIdx + 1] || path.join(app.getPath('temp'), 'hc-selftest-target')
    const scopeIdx = args.indexOf('--scope')
    const scope = normalizeScope(scopeIdx >= 0 ? args[scopeIdx + 1] : 'user')
    void runInstall({ dir: target, scope, desktopShortcut: false, startMenuShortcut: false }).then((r) => {
      try {
        fs.appendFileSync(
          path.join(app.getPath('temp'), 'HungerCat-Selftest.log'),
          `[${new Date().toISOString()}] ${JSON.stringify(r)}\n`
        )
      } catch {
        /* 忽略日志写入失败 */
      }
      app.exit(r.ok ? 0 : 1)
    })
    return true
  }

  return false
}

app.whenReady().then(() => {
  registerIpc()
  if (bootstrapHeadless()) return
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
