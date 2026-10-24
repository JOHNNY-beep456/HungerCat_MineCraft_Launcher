import { app } from 'electron'
import { accessSync, constants, mkdirSync } from 'fs'
import { basename, isAbsolute, join } from 'path'

/**
 * 便携版判定与数据目录。
 *
 * electron-builder 的 portable 目标在启动时会注入 `PORTABLE_EXECUTABLE_DIR`
 * （便携 exe 所在目录）与 `PORTABLE_EXECUTABLE_FILE`（exe 全路径）。
 * 该变量只由 portable 启动器设置，NSIS 安装版不会有，因此可以据此精确区分两种身份。
 *
 * 便携版约定（相对便携 exe 所在目录）：
 *   ./HCMCL        —— 启动器设置、账号、主页脚本、壁纸等（即 Electron 的 userData）
 *   ./.minecraft   —— 游戏目录：版本、存档、mods、资源等
 *
 * 目的：整包可以拷到 U 盘 / 任意目录，数据跟着走，不污染 %APPDATA% 与「文档」。
 */
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR ?? ''

/** 是否以便携版身份运行。 */
export const isPortable = portableDir.length > 0

/** 便携版的启动器数据目录：<exe 目录>/HCMCL */
export function portableDataDir(): string {
  return join(portableDir, 'HCMCL')
}

/**
 * 便携版默认版本目录在设置里的**写法**：永远是相对路径。
 *
 * 早期版本在首次启动时把它解析成绝对路径写进 settings.json，结果是：
 * 换个目录 / 换个盘符启动，旧路径就失效；界面里也显示一长串绝对路径。
 * 现在设置里只存这一串相对写法，用的时候再按启动器所在目录解析。
 */
export const PORTABLE_GAME_DIR = './.minecraft'

/** 相对路径按启动器所在目录解析；已是绝对路径或非便携版时原样返回。 */
export function resolvePortablePath(p: string): string {
  if (!p || !portableDir || isAbsolute(p)) return p
  return join(portableDir, p)
}

/**
 * 便携版可执行文件本身的路径；安装版返回空串。
 *
 * Windows portable：electron-builder 把自解压后的 exe 放在临时目录运行，
 * `process.execPath` 指向那份临时文件，真正要替换的是 `PORTABLE_EXECUTABLE_FILE`。
 * Linux AppImage：运行的是挂载点里的可执行文件，真正要替换的是 `$APPIMAGE`。
 *
 * 更新流程用它决定「下载到哪、删哪个、启动哪个」。
 */
export function portableBinaryPath(): string {
  const file = (process.env.PORTABLE_EXECUTABLE_FILE ?? '').trim()
  if (file) return file
  if (portableDir) return join(portableDir, basename(process.execPath))
  const appImage = (process.env.APPIMAGE ?? '').trim()
  return appImage
}

/**
 * 把 Electron 的 userData 重定向到便携目录。
 *
 * 必须在任何代码读取 `app.getPath('userData')` **之前**调用——本模块由入口
 * `src/main/index.ts` 最先加载并立即执行。重定向后 store / secret / homepage /
 * wallpaper / 联机运行时目录等全都自动跟随，无需逐处改动。
 *
 * 若便携目录不可写（典型场景：exe 被放在只读的 Program Files 或只读介质上），
 * 放弃重定向并退回系统默认位置——总比启动即崩好。此时会打印一条警告，
 * 便于排查「为什么数据没落在 HCMCL 里」。
 */
export function applyPortablePaths(): void {
  if (!isPortable) return
  const dir = portableDataDir()
  try {
    mkdirSync(dir, { recursive: true })
    accessSync(dir, constants.W_OK)
  } catch (err) {
    console.warn(`[portable] 无法写入 ${dir}，回退到系统默认数据目录：`, err)
    return
  }
  app.setPath('userData', dir)
}
