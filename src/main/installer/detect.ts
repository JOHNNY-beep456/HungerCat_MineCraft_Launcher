import { dirname } from 'node:path'

/**
 * 安装模式判定。
 *
 * `Setup.exe` 现在**就是启动器自身**（electron-builder 的 portable 目标）：
 * 便携包启动时会把应用解包到临时目录并注入三个环境变量，其中
 * `PORTABLE_EXECUTABLE_FILE` 指向那个单文件 exe。据此判断「用户正在跑安装包」
 * 而不是已安装的启动器。
 *
 * 判定凭据有两条，缺一不可：
 *   · **环境变量** —— 自动更新走 `runUpdate()`（server.ts），那里是
 *     `spawn(exePath, [])` **不带任何参数**地拉起下载下来的 Setup.exe，
 *     靠参数判定不行；
 *   · **显式开关** —— 机器级安装要走 UAC 提权子进程（`installElevated` →
 *     `Start-Process -Verb RunAs`），而**提权后的进程拿不到父进程的环境变量**，
 *     `PORTABLE_EXECUTABLE_FILE` 会丢。只认环境变量的话，子进程会判定「不是安装
 *     模式」而直接打开正常启动器界面，什么也不装。
 *
 * 已安装的启动器是普通目录副本：既没有这些变量、也没有这些开关，因此不会误判。
 */

/** electron-builder 的 portable 目标注入的全部环境变量（当前 exe / 所在目录 / 原 exe 名）。 */
const PORTABLE_ENVS = [
  'PORTABLE_EXECUTABLE_FILE',
  'PORTABLE_EXECUTABLE_DIR',
  'PORTABLE_EXECUTABLE_APP_FILENAME'
]

/** electron-builder 的 portable 目标注入的环境变量（判定的第一条凭据）。 */
const PORTABLE_ENV = PORTABLE_ENVS[0]

/**
 * 显式进入安装器的开关。
 *
 * `installer/`（旧方案）里这些开关只被安装在安装器自己的进程上，所以无条件生效。
 * 并进启动器之后**必须在这里显式识别**：机器级安装要走 UAC 提权子进程
 * （`installElevated` → `Start-Process -Verb RunAs`），而**提权后的进程拿不到父进程的
 * 环境变量**，`PORTABLE_EXECUTABLE_FILE` 会丢 —— 于是子进程判定「不是安装模式」，
 * 直接打开正常启动器界面，什么也不装。这正是「点击安装后直接打开启动器」的成因。
 *
 * 把这些开关本身当作「按安装器身份运行」的凭据，任何调用方 spawn 安装器相关进程时
 * 都不必再记得额外补 `--hc-install`。
 */
const INSTALLER_FLAGS = ['--hc-install', '--hc-info', '--hc-selftest', '--hc-elevated-install']

/** 当前进程是否应当以「安装程序」身份启动。 */
export function isInstallerMode(): boolean {
  if (process.env[PORTABLE_ENV]) return true
  return process.argv.some((a) => INSTALLER_FLAGS.includes(a))
}

/**
 * 便携包解包出来的应用根目录 —— 也就是「启动器自身的文件所在处」。
 *
 * 安装模式要把这套文件复制到用户选择的目录，所以源就是进程所在目录
 * （win-unpacked 布局下主 exe 与 locales/、resources/ 同级）。
 *
 * 注意：直接从源码目录（`npm run dev`）用 `--hc-install` 启动时，这个值指向
 * node_modules/electron/dist，并不是可安装的载荷 —— 自检要对打包后的产物跑。
 */
export function installerPayloadDir(): string {
  return dirname(process.execPath)
}

/** 便携包本体（单文件 exe）的路径；非便携运行时为 null。 */
export function portableExePath(): string | null {
  return process.env[PORTABLE_ENV] || null
}

/**
 * 给**已安装的启动器**准备子进程环境：剥掉 portable 变量。
 *
 * 必须剥：安装器自己就是从 `Setup.exe` 解包出来的，进程环境里带着
 * `PORTABLE_EXECUTABLE_FILE`。而 `shell.openPath` / `spawn` 起的子进程会**继承**
 * 父进程环境，于是「完成」按钮拉起已安装的启动器时，它看到那个变量、判定自己是
 * 安装器，弹出来的又是安装向导 —— 表现为「点完成打开的还是安装器，关掉再手动打开
 * 才正常」（手动打开时环境是干净的，所以正常）。
 *
 * 快捷方式、开始菜单项不走这里，不受本函数影响；只有安装器主动拉起的那一次需要处理。
 * 其余环境变量（PATH / APPDATA / SystemRoot …）原样保留。
 */
export function childEnvWithoutPortable(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of PORTABLE_ENVS) delete env[k]
  return env
}