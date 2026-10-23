// 编译原生下载内核（Rust → .node），并放入 resources/native/<key>/。
//
// 为什么需要这个脚本：
//   Rust 侧产物叫 libhungercat_downloader.{so,dylib} / hungercat_downloader.dll，
//   而 Node 只认 .node。手工改名 + 拷贝容易漏平台、漏架构，所以统一由本脚本处理。
//
// 6 个发布目标（key 与运行时 native-downloader.ts、服务端清单、electron-builder 的
// ${arch} 完全一致，任何一处改名都要三处一起改）：
//   win32-x64     x86_64-pc-windows-msvc
//   win32-ia32    i686-pc-windows-msvc
//   win32-arm64   aarch64-pc-windows-msvc
//   linux-x64     x86_64-unknown-linux-gnu
//   linux-arm64   aarch64-unknown-linux-gnu
//   linux-armv7l  armv7-unknown-linux-gnueabihf
//
// 用法：
//   node scripts/build-native-downloader.mjs                       # 当前平台
//   node scripts/build-native-downloader.mjs --target win32-arm64  # 交叉编译
//   node scripts/build-native-downloader.mjs --target node18-win-x64   # 别名也认
//   node scripts/build-native-downloader.mjs --debug               # 调试构建（带符号）
//   node scripts/build-native-downloader.mjs --skip-cargo          # 只做改名拷贝
//
// 交叉编译的前置条件（缺了 cargo 会报 linker 错误，不会静默成功）：
//   win32-ia32 / win32-arm64  VS Build Tools 需勾选对应的 C++ 生成工具
//   linux-arm64               sudo apt install gcc-aarch64-linux-gnu
//   linux-armv7l              sudo apt install gcc-arm-linux-gnueabihf
//   之后还要 rustup target add <三元组>（build-all.mjs 会自动补）

import { execFileSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const crateDir = join(root, 'native', 'downloader')

/** key → Rust target 三元组 + cargo 产物文件名。 */
const TARGETS = {
  'win32-x64': { rust: 'x86_64-pc-windows-msvc', lib: 'hungercat_downloader.dll' },
  'win32-ia32': { rust: 'i686-pc-windows-msvc', lib: 'hungercat_downloader.dll' },
  'win32-arm64': { rust: 'aarch64-pc-windows-msvc', lib: 'hungercat_downloader.dll' },
  'linux-x64': { rust: 'x86_64-unknown-linux-gnu', lib: 'libhungercat_downloader.so' },
  'linux-arm64': { rust: 'aarch64-unknown-linux-gnu', lib: 'libhungercat_downloader.so' },
  'linux-armv7l': { rust: 'armv7-unknown-linux-gnueabihf', lib: 'libhungercat_downloader.so' },
  'darwin-x64': { rust: 'x86_64-apple-darwin', lib: 'libhungercat_downloader.dylib' },
  'darwin-arm64': { rust: 'aarch64-apple-darwin', lib: 'libhungercat_downloader.dylib' }
}

/** 别名：`win-x64` / `node18-win-x64` / `linux-armv7` / `win32-x86` 都能落到同一个 key。 */
const ALIASES = {
  'win-x64': 'win32-x64',
  'win-x86': 'win32-ia32',
  'win-ia32': 'win32-ia32',
  'win-arm64': 'win32-arm64',
  'linux-armv7': 'linux-armv7l',
  'mac-x64': 'darwin-x64',
  'mac-arm64': 'darwin-arm64',
  'osx-x64': 'darwin-x64',
  'osx-arm64': 'darwin-arm64'
}

const argv = process.argv.slice(2)
const debug = argv.includes('--debug')
const skipCargo = argv.includes('--skip-cargo')
const targetArg = readOption(argv, '--target')

/** 读取 `--name value` 形式的值。 */
function readOption(list, name) {
  const i = list.indexOf(name)
  return i >= 0 ? list[i + 1] : undefined
}

function out(msg) {
  process.stdout.write(msg + '\n')
}

/** 把任意写法归一成 6 个 key 之一；无法识别返回 null。 */
function normalizeKey(raw) {
  if (!raw) return hostKey()
  let s = raw.trim().toLowerCase()
  if (s.startsWith('node18-')) s = s.slice('node18-'.length)
  s = ALIASES[s] || s
  if (TARGETS[s]) return s
  // 单独一个 arch 时按宿主平台补全
  const withHost = `${hostPlatform()}-${s === 'armv7' ? 'armv7l' : s}`
  return TARGETS[withHost] ? withHost : null
}

function hostPlatform() {
  return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
}

function hostKey() {
  const arch = process.arch === 'arm' ? 'armv7l' : process.arch
  return `${hostPlatform()}-${arch}`
}

function cargoBin() {
  const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
  // cargo 常装在 ~/.cargo/bin 而未被当前 shell 的 PATH 收录，这里显式兜底。
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const candidate = home ? join(home, '.cargo', 'bin', exe) : ''
  if (candidate && existsSync(candidate)) return candidate
  return 'cargo'
}

function run(cmd, cmdArgs, cwd, env) {
  out(`[native] ${cmd} ${cmdArgs.join(' ')}`)
  execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit', env: env ? { ...process.env, ...env } : process.env })
}

/**
 * 交叉编译时的链接器。
 *
 * cargo 不会自己去找 `aarch64-linux-gnu-gcc`，必须通过
 * `CARGO_TARGET_<TRIPLE>_LINKER` 指定；否则报的还是那句含糊的
 * 「linker `cc` not found」。Windows 目标交给 MSVC 工具链自己解析。
 */
function linkerEnv(key, target) {
  if (process.platform === 'win32') return {}
  if (key === 'linux-arm64') {
    return { CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER: 'aarch64-linux-gnu-gcc' }
  }
  if (key === 'linux-armv7l') {
    return { CARGO_TARGET_ARMV7_UNKNOWN_LINUX_GNUEABIHF_LINKER: 'arm-linux-gnueabihf-gcc' }
  }
  void target
  return {}
}

/** rustup 可执行文件（与 cargo 同目录，常不在 PATH 上）。 */
function rustupBin() {
  const exe = process.platform === 'win32' ? 'rustup.exe' : 'rustup'
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const candidate = home ? join(home, '.cargo', 'bin', exe) : ''
  return candidate && existsSync(candidate) ? candidate : 'rustup'
}

/**
 * 交叉编译前补装 rustup target。
 *
 * 缺 target 时 cargo 只会报一句 `target may not be installed`，很容易被误当成
 * 缺链接器；这里直接装上，失败也不阻断（下面的 cargo 会给出真实原因）。
 */
function ensureRustTarget(triple) {
  try {
    const installed = execFileSync(rustupBin(), ['target', 'list', '--installed'], { encoding: 'utf8' })
    if (installed.split('\n').map((s) => s.trim()).includes(triple)) return
    out(`[native] rustup target add ${triple}`)
    execFileSync(rustupBin(), ['target', 'add', triple], { stdio: 'inherit' })
  } catch (err) {
    out(`[native] 无法自动安装 target ${triple}：${err instanceof Error ? err.message : err}`)
  }
}

function main() {
  const key = normalizeKey(targetArg)
  if (!key) {
    out(`[native] 未知目标：${targetArg}`)
    out(`[native] 可用目标：${Object.keys(TARGETS).join(' / ')}`)
    process.exit(1)
  }
  const target = TARGETS[key]

  if (!skipCargo) {
    if (!existsSync(crateDir)) {
      out(`[native] 找不到 crate 目录：${crateDir}`)
      process.exit(1)
    }
    const profileArgs = debug ? [] : ['--release']
    ensureRustTarget(target.rust)
    run(cargoBin(), ['build', ...profileArgs, '--target', target.rust], crateDir, linkerEnv(key, target))
  }

  const profile = debug ? 'debug' : 'release'
  // 指定 --target 后 cargo 的产物在 target/<三元组>/<profile>/ 下。
  const built = join(crateDir, 'target', target.rust, profile, target.lib)
  if (!existsSync(built)) {
    out(`[native] 未找到构建产物：${built}`)
    out('[native] 请先确认 cargo build 成功；交叉编译还需要对应平台的链接器。')
    process.exit(1)
  }

  const outDir = join(root, 'resources', 'native', key)
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, 'hungercat_downloader.node')
  copyFileSync(built, outFile)

  const size = (statSync(outFile).size / 1024).toFixed(0)
  out(`[native] 已生成 ${outFile} (${size} KB, ${profile})`)
  out('[native] 未编译该架构的机器会自动降级到 TS 下载器，不影响功能。')
}

main()
