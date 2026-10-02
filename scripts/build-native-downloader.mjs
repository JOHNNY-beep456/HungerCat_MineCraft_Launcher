// 编译原生下载内核（Rust → .node），并放入 resources/native/。
//
// 为什么需要这个脚本：
//   Rust 侧产物叫 libhungercat_downloader.{dll,so,dylib}，而 Node 只认 .node。
//   手工改名 + 拷贝容易漏平台、漏架构，所以统一由本脚本处理。
//
// 产物落点：resources/native/<platform>-<arch>/hungercat_downloader.node
//   运行时由 src/main/native-downloader.ts 按 process.platform + process.arch 定位；
//   随 electron-builder 的 extraResources 原样打包（原生库不能进 asar）。
//
// 用法：
//   node scripts/build-native-downloader.mjs            # 当前平台 release
//   node scripts/build-native-downloader.mjs --debug    # 调试构建（带符号，便于排查）
//   node scripts/build-native-downloader.mjs --skip-cargo  # 只做拷贝改名（cargo 已构建过）
//
// 前置条件：rustc / cargo 可用；Windows 需要 MSVC 链接器（VS Build Tools 的 C++ 工作负载）。

import { execFileSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const crateDir = join(root, 'native', 'downloader')

const args = new Set(process.argv.slice(2))
const debug = args.has('--debug')
const skipCargo = args.has('--skip-cargo')

/**
 * 统一输出出口。
 *
 * 本脚本会被 build-native-downloader.bat 调用，而该 bat 已把控制台切到 UTF-8
 * （`chcp 65001`），因此这里按 UTF-8 写就是正确的，不会乱码。
 * 单独用 `node scripts/build-native-downloader.mjs` 直接跑也一致。
 */
function out(msg) {
  process.stdout.write(msg + '\n')
}

/** 当前平台 → 目标目录名（与运行时 main/native-downloader.ts 的解析规则一致）。 */
function platformDir() {
  const os = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  return `${os}-${process.arch}`
}

/** cargo 产物文件名（按平台不同）。 */
function artifactName() {
  if (process.platform === 'win32') return 'hungercat_downloader.dll'
  if (process.platform === 'darwin') return 'libhungercat_downloader.dylib'
  return 'libhungercat_downloader.so'
}

function cargoBin() {
  const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
  // cargo 常装在 ~/.cargo/bin 而未被当前 shell 的 PATH 收录，这里显式兜底。
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const candidate = home ? join(home, '.cargo', 'bin', exe) : ''
  if (candidate && existsSync(candidate)) return candidate
  return 'cargo'
}

function run(cmd, cmdArgs, cwd) {
  out(`[native] ${cmd} ${cmdArgs.join(' ')}`)
  execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit' })
}

function main() {
  if (!skipCargo) {
    if (!existsSync(crateDir)) {
      out(`[native] 找不到 crate 目录：${crateDir}`)
      process.exit(1)
    }
    const profileArgs = debug ? [] : ['--release']
    run(cargoBin(), ['build', ...profileArgs], crateDir)
  }

  const profile = debug ? 'debug' : 'release'
  const built = join(crateDir, 'target', profile, artifactName())
  if (!existsSync(built)) {
    out(`[native] 未找到构建产物：${built}`)
    out('[native] 请先确认 cargo build 成功（Windows 需要 MSVC 链接器）。')
    process.exit(1)
  }

  const outDir = join(root, 'resources', 'native', platformDir())
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, 'hungercat_downloader.node')
  copyFileSync(built, outFile)

  const size = (statSync(outFile).size / 1024).toFixed(0)
  out(`[native] 已生成 ${outFile} (${size} KB, ${profile})`)
  out('[native] 未编译该平台的机器会自动降级到 TS 下载器，不影响功能。')
}

main()

// 保留引用，避免部分打包器把 readdirSync 视为未使用而摇掉（本文件不打包，仅作显式意图）。
void readdirSync
