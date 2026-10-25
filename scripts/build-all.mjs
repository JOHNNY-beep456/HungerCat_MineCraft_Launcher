#!/usr/bin/env node
// ---------------------------------------------------------------------------
//  HungerCat MineCraft Launcher - 统一的构建 / 打包脚本
//
//  为什么用 Node 而不是 cmd + bash 两份：两套脚本各自维护「清目录 / 装依赖 / 调
//  electron-builder」的流程，改一处忘另一处就会出现行为分叉；更要紧的是它们都以
//  `rm -rf release` 起步，**打 Windows 包会删掉 Linux 产物，反之亦然**。
//  现在流程只有这一份实现，且**从不删除 release/**：换平台再构建只会在同一个目录里
//  追加产物，不会误删上一次的结果。
//
//  用法：
//    node scripts/build-all.mjs                 构建当前平台的发行包
//    node scripts/build-all.mjs --platform all  依次构建 Windows + Linux（不清理 release）
//    node scripts/build-all.mjs --platform linux
//    node scripts/build-all.mjs --skip-native   跳过 Rust 下载内核（使用 TS 下载器）
//    node scripts/build-all.mjs --skip-easytier 跳过 EasyTier（仅 Windows 有意义）
//    node scripts/build-all.mjs --skip-install  复用已有 node_modules
//    node scripts/build-all.mjs --clean         清理构建缓存（不含 release/）
//    node scripts/build-all.mjs --debug         原生内核调试构建
//    node scripts/build-all.mjs --no-wsl        不在 WSL 里构建 Linux 包
//    node scripts/build-all.mjs -h | --help
//
//  两个入口脚本（都只是转发，真正的默认值差异也在这里说明）：
//    build-all.cmd   Windows：不带参数 = --platform all（Windows + WSL 里的 Linux）
//    build-all.sh    Linux：不带参数 = 只构建 Linux（不会尝试 Windows 目标）
//
//  产物：
//    Windows  release/HCMCL<version>-win-<arch>-portable.exe、...-win-<arch>-setup.exe
//    Linux    release/HCMCL<version>-<arch>.AppImage、hcmcl_<version>_<arch>.deb、
//             hcmcl-<version>-<arch>.rpm
//    macOS    release/HCMCL<version>-mac-<arch>.dmg / .zip（必须在 macOS 上构建）
//    <arch>：win = x64 / ia32 / arm64；linux = x64 / arm64 / armv7l；mac = x64 / arm64
//    每份安装包里只带本架构的 Rust 内核（electron-builder 的 ${arch} 宏过滤）。
//
//  说明：
//    · Windows 上要 Linux 包时自动走 WSL：源码同步到 WSL 原生文件系统
//      ($HOME/.cache/hcmcl-linux-build)，在那边装依赖、构建、打包，最后只把
//      *.AppImage / *.deb / *.rpm 拷回 release/。
//      绝不能直接在 /mnt/f 上构建：Windows 的 node_modules 里是 win32 的 electron
//      和 .node，混用会让两边都跑不起来。
//      WSL 里没有 Node 时会自动下载官方 LTS 到 $HOME/.cache/hcmcl-node（不需要 sudo）。
//      `--no-wsl` 可关掉，退回在 Windows 上直接跑 electron-builder（需要符号链接权限
//      与 fpm，通常都会失败）。
//    · EasyTier 内核只由 Windows 的 PowerShell 脚本构建；Linux 包需要自行放入
//      resources/easytier/easytier-core 与 easytier-cli 才会被打进去。
//    · 原生下载内核按平台分目录（resources/native/<platform>-<arch>），各平台产物互不
//      干扰；打包时会按目标平台过滤，不会把另一平台的 .node 带进去。
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IS_WIN_HOST = process.platform === 'win32'
const IS_LINUX_HOST = process.platform === 'linux'
const IS_MAC_HOST = process.platform === 'darwin'

/** 目标平台：win / linux / mac */
const PLATFORM_LABEL = { win: 'Windows', linux: 'Linux', mac: 'macOS' }

/** 本机可以直接构建哪些平台（mac 目标只能在 macOS 上做，见下方检查）。 */
function hostCanBuild(platform) {
  if (platform === 'mac') return IS_MAC_HOST
  if (platform === 'linux') return IS_LINUX_HOST || (IS_WIN_HOST && !opts.noWsl)
  return IS_WIN_HOST
}

// ---------------------------------------------------------------------------
//  参数解析
// ---------------------------------------------------------------------------
const opts = {
  platforms: [],
  archs: [],
  skipNative: false,
  skipEasytier: false,
  skipInstall: false,
  clean: false,
  debug: false,
  noWsl: false,
  wslNode: 'v24.22.1',
  easytierVersion: 'v2.5.0'
}

/**
 * 每个平台可发布的架构 → electron-builder 参数。
 *
 * key 三元组与 native-downloader.ts / 服务端清单完全一致：
 *   win32-<arch> / linux-<arch>（armv7l 是 electron-builder 与 Node 之外的一致写法，
 *   运行时 process.arch 会报 `arm`，client 侧统一归一成 armv7l）。
 */
const ARCHS_BY_PLATFORM = {
  win: ['x64', 'ia32', 'arm64'],
  linux: ['x64', 'arm64', 'armv7l'],
  mac: ['x64', 'arm64']
}
const ARCH_FLAG = { x64: '--x64', ia32: '--ia32', arm64: '--arm64', armv7l: '--armv7l' }

function usage(exitCode = 0) {
  const lines = [
    '',
    'Usage: node scripts/build-all.mjs [options]',
    '',
    '  --platform <win|linux|mac|all>  要打包的目标平台（默认当前平台；build-all.cmd 默认 all）',
    '  --arch <list|all>           目标架构，逗号分隔（x64,ia32,arm64 / x64,arm64,armv7l）',
    '                              默认只构建 x64；--arch all 构建该平台全部架构',
    '                              （build-all.cmd 不带参数 = --platform all --arch all）',
    '  --skip-native               跳过 Rust 原生下载内核',
    '  --skip-easytier             跳过 EasyTier 内核构建（仅 Windows）',
    '  --skip-install              复用已有 node_modules',
    '  --clean                     清理构建缓存（不会删除 release/）',
    '  --debug                     原生内核调试构建',
    '  --no-wsl                    不在 WSL 内构建 Linux 包（Windows 上直接调用 electron-builder）',
    '  --wsl-node <version>        WSL 内自举的 Node 版本（默认 v24.22.1）',
    '  --easytier-version <tag>    EasyTier 版本（默认 v2.5.0）',
    '  -h, --help                  显示帮助',
    ''
  ]
  process.stdout.write(lines.join('\n') + '\n')
  process.exit(exitCode)
}

const argv = process.argv.slice(2)

// 兼容旧 build-all.cmd 的单横线参数（-Linux / -SkipEasytier …），
// 免得维护者按老习惯敲一串参数却得到「未知参数」。
const LEGACY_ARGS = {
  '-linux': ['--platform', 'linux'],
  '-all': ['--platform', 'all'],
  '-skipeasytier': ['--skip-easytier'],
  '-nonative': ['--skip-native'],
  '-skipinstall': ['--skip-install'],
  '-clean': ['--clean'],
  '-debugbuild': ['--debug']
}
const normalized = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  const mapped = LEGACY_ARGS[a.toLowerCase()]
  if (mapped) normalized.push(...mapped)
  else if (a.toLowerCase() === '-easytierversion') {
    normalized.push('--easytier-version', argv[++i] ?? '')
  } else normalized.push(a)
}

for (let i = 0; i < normalized.length; i++) {
  const a = normalized[i]
  if (a === '-h' || a === '--help') usage(0)
  else if (a === '--skip-native') opts.skipNative = true
  else if (a === '--skip-easytier') opts.skipEasytier = true
  else if (a === '--skip-install') opts.skipInstall = true
  else if (a === '--clean') opts.clean = true
  else if (a === '--debug') opts.debug = true
  else if (a === '--no-wsl') opts.noWsl = true
  else if (a === '--arch') {
    const v = normalized[++i]
    if (!v) {
      process.stderr.write('[build] ERROR: --arch 需要一个值（x64,arm64 / all）\n')
      process.exit(1)
    }
    opts.archs.push(...v.split(',').map((s) => s.trim()).filter(Boolean))
  }
  else if (a === '--wsl-node') {
    const v = normalized[++i]
    if (!v) {
      process.stderr.write('[build] ERROR: --wsl-node 需要一个版本号（如 v24.22.1）\n')
      process.exit(1)
    }
    opts.wslNode = v
  }
  else if (a === '--platform' || a === '--platforms') {
    const v = normalized[++i]
    if (!v) {
      process.stderr.write('[build] ERROR: --platform 需要一个值（win / linux / mac / all）\n')
      process.exit(1)
    }
    opts.platforms.push(...v.split(',').map((s) => s.trim()).filter(Boolean))
  } else if (a === '--easytier-version') {
    const v = normalized[++i]
    if (!v) {
      process.stderr.write('[build] ERROR: --easytier-version 需要一个值\n')
      process.exit(1)
    }
    opts.easytierVersion = v
  } else {
    process.stderr.write(`[build] ERROR: 未知参数 ${a}\n`)
    usage(1)
  }
}

const hostPlatform = IS_WIN_HOST ? 'win' : IS_LINUX_HOST ? 'linux' : IS_MAC_HOST ? 'mac' : null
if (!hostPlatform) {
  process.stderr.write(`[build] ERROR: 当前平台 ${process.platform} 不受支持（只支持 Windows / Linux / macOS）\n`)
  process.exit(1)
}

/** `all` 的含义：本机能构建的全部平台（mac 绝不会被塞给 WSL 去编译）。 */
function allTargets() {
  return ['win', 'linux', 'mac'].filter((p) => hostCanBuild(p))
}

const requested = opts.platforms.length > 0 ? opts.platforms : [hostPlatform]
const targets = requested.includes('all') ? allTargets() : [...new Set(requested)]
for (const t of targets) {
  if (!PLATFORM_LABEL[t]) {
    process.stderr.write(`[build] ERROR: 未知目标平台 ${t}（只支持 win / linux / mac / all）\n`)
    process.exit(1)
  }
}
if (targets.includes('mac') && !IS_MAC_HOST) {
  process.stderr.write(
    '[build] ERROR: macOS 包只能在 macOS 上构建（dmg 依赖 hdiutil，签名/公证依赖 codesign）。\n' +
      '[build]        electron-builder 在非 macOS 上会直接拒绝，WSL / 交叉编译也绕不过去。\n' +
      '[build]        两条路：\n' +
      '[build]          1) 推送到 GitHub 后手动触发 .github/workflows/build-mac.yml（macOS runner 出 dmg + zip）\n' +
      '[build]          2) 在任意 Mac 上执行 ./build-all.sh --platform mac --arch all\n'
  )
  process.exit(1)
}

/** 某平台实际要构建的架构列表：默认本机架构，`--arch all` 才是全架构。 */
function archsFor(platform) {
  const valid = ARCHS_BY_PLATFORM[platform]
  if (opts.archs.length === 0) {
    // 默认编本机架构：在 Apple Silicon 上应当出 arm64，而不是想当然的 x64。
    return valid.includes(hostArch()) ? [hostArch()] : ['x64']
  }
  if (opts.archs.includes('all')) return [...valid]
  const want = opts.archs.map((a) => (a === 'armv7' ? 'armv7l' : a))
  const picked = valid.filter((a) => want.includes(a))
  const unknown = want.filter((a) => !valid.includes(a))
  if (unknown.length > 0) {
    warn(`${platform} 不支持架构 ${unknown.join(', ')}（可用：${valid.join(', ')}），已忽略`)
  }
  return picked.length > 0 ? picked : ['x64']
}

/** 本机架构（Node 在 armv7 上报 `arm`，与发布名 armv7l 不同）。 */
function hostArch() {
  return process.arch === 'arm' ? 'armv7l' : process.arch
}

// ---------------------------------------------------------------------------
//  小工具
// ---------------------------------------------------------------------------
function step(msg) {
  process.stdout.write(`[build] ${msg}\n`)
}
function warn(msg) {
  process.stderr.write(`[build] WARNING: ${msg}\n`)
}

/** 同步跑一条命令；失败时抛出带命令行的错误。 */
function run(cmd, args, { shell = false, allowFail = false } = {}) {
  step(`${cmd} ${args.join(' ')}`)
  // Windows 上 npm / npx 是 .cmd 垫片，必须经 shell；但 Node 24 起
  // `shell: true` + args 数组会报 DEP0190，所以这类情况自己拼好命令行再交给 shell。
  const r = shell
    ? spawnSync([cmd, ...args].map(shellQuote).join(' '), {
        cwd: ROOT,
        stdio: 'inherit',
        shell: true,
        env: process.env
      })
    : spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env })
  if (r.error) {
    if (allowFail) return false
    throw new Error(`${cmd} 启动失败：${r.error.message}`)
  }
  if (r.status !== 0) {
    if (allowFail) return false
    throw new Error(`${cmd} ${args.join(' ')} 退出码 ${r.status}`)
  }
  return true
}

/** 只在含空格/引号时才加引号，保持命令行可读。 */
function shellQuote(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg
}

/** npm / npx 在 Windows 上是 .cmd 垫片，必须经 shell 才能被找到。 */
const npm = (args) => run(IS_WIN_HOST ? 'npm.cmd' : 'npm', args, { shell: IS_WIN_HOST })
const npx = (args) => run(IS_WIN_HOST ? 'npx.cmd' : 'npx', args, { shell: IS_WIN_HOST })

function hasCommand(cmd) {
  const probe = IS_WIN_HOST ? 'where' : 'which'
  const r = spawnSync(probe, [cmd], { stdio: 'ignore' })
  return r.status === 0
}

/**
 * rpm 6 上给 electron-builder 内置的 fpm 1.9.3 垫一层 rpmbuild 转发。
 *
 * rpm 6 既不再认 `--define buildroot X`，又会在 %install 前清空 buildroot；而 fpm 1.9.3
 * 的做法正是「自己把文件铺进 buildroot + spec 的 %install 留空」，于是 %files 里每个
 * 路径都 File not found。兼容脚本本身有完整注释（scripts/rpm6-buildroot-shim.sh）。
 *
 * 只有 rpm >= 6 才需要；rpm 4/5 上行为不变，不引入任何转发。
 */
function setupRpmShim() {
  if (!IS_LINUX_HOST) return
  const probe = spawnSync('rpm', ['--eval', '%{rpmversion}'], { encoding: 'utf8' })
  const major = Number((probe.stdout || '').trim().split('.')[0])
  if (!Number.isFinite(major) || major < 6) return

  const dir = join(tmpdir(), 'hcmcl-rpm-shim')
  mkdirSync(dir, { recursive: true })
  const shim = join(dir, 'rpmbuild')
  copyFileSync(join(ROOT, 'scripts', 'rpm6-buildroot-shim.sh'), shim)
  chmodSync(shim, 0o755)
  process.env.PATH = `${dir}:${process.env.PATH}`
  step(`rpm ${major}.x：已为 fpm 1.9.3 挂上 rpmbuild buildroot 兼容层。`)
}

/** 列出 release/ **顶层**的产物文件。
 *  不递归：`win-unpacked/`、`linux-unpacked/`、`__appImage-x64/` 都是 electron-builder 的
 *  中间目录，里面的 exe / 二进制不是发行产物，混进汇总会让人误以为打出了多余的包。 */
function listArtifacts(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isFile()) out.push({ path: p, size: st.size })
  }
  return out
}

// ---------------------------------------------------------------------------
//  WSL 桥接（Windows 上构建 Linux 包）
// ---------------------------------------------------------------------------
const WSL_BUILD_DIR = '$HOME/.cache/hcmcl-linux-build'
const WSL_NODE_DIR = '$HOME/.cache/hcmcl-node'

/** bash 单引号转义。 */
function shq(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** F:\code\Foo Bar -> /mnt/f/code/Foo Bar（WSL 里的 drvfs 挂载点）。 */
function toWslPath(p) {
  return `/mnt/${p[0].toLowerCase()}${p.slice(2).replace(/\\/g, '/')}`
}

/** 本机是否有可用的 WSL 发行版。wsl.exe -l -q 输出是 UTF-16LE。 */
function wslAvailable() {
  if (!IS_WIN_HOST || opts.noWsl) return false
  const r = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer' })
  if (r.error || r.status !== 0 || !r.stdout) return false
  return (
    r.stdout
      .toString('utf16le')
      .replace(/\0/g, '')
      .trim().length > 0
  )
}

/**
 * 在 WSL 里构建 Linux 包。
 *
 * 复制一份源码到 WSL 原生文件系统再构建，而不是就地跑：
 *   · /mnt/f 上跑 npm install 会覆盖 Windows 的 node_modules（electron 的二进制是
 *     按平台下载的，覆盖后 Windows 侧连 `electron .` 都起不来）；
 *   · /mnt 跨文件系统 IO 极慢，vite / electron-builder 会慢好几倍。
 * 构建目录跨次保留（含 node_modules 与 npm 缓存），之后的增量构建只同步源码。
 */
function buildLinuxInWsl() {
  const src = toWslPath(ROOT)
  const innerFlags = ['--platform', 'linux']
  if (opts.skipNative) innerFlags.push('--skip-native')
  if (opts.skipEasytier) innerFlags.push('--skip-easytier')
  if (opts.clean) innerFlags.push('--clean')
  if (opts.debug) innerFlags.push('--debug')
  if (opts.archs.length > 0) innerFlags.push('--arch', opts.archs.join(','))

  // 首次同步时 WSL 侧还没有 node_modules，此时 --skip-install 不能带过去，
  // 否则内层会直接对着空目录跑 electron-builder。
  const installGuard = opts.skipInstall
    ? `if [ -d "$BUILD_DIR/node_modules" ]; then SKIP_INSTALL=1; else
  echo "[wsl] $BUILD_DIR 还没有 node_modules，本次仍执行 npm install"; SKIP_INSTALL=0; fi`
    : 'SKIP_INSTALL=0'

  const script = `set -euo pipefail
BUILD_DIR=${WSL_BUILD_DIR}
NODE_DIR=${WSL_NODE_DIR}
SRC=${shq(src)}

echo "[wsl] 同步源码：$SRC -> $BUILD_DIR"
mkdir -p "$BUILD_DIR"
rsync -a --delete \\
  --exclude node_modules --exclude release --exclude out --exclude .git \\
  --exclude resources/native --exclude native/downloader/target \\
  "$SRC"/ "$BUILD_DIR"/

# ---- 国内镜像 ------------------------------------------------------------
# rustup 分发包（rustup target add 拉的 std）、cargo 索引、electron 与
# electron-builder 的二进制都走镜像，避免 GitHub / crates.io 直连超时。
export RUSTUP_DIST_SERVER=https://rsproxy.cn
export RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

if [ ! -x "$NODE_DIR/bin/node" ]; then
  echo "[wsl] WSL 内没有 Node，自举 ${opts.wslNode} 到 $NODE_DIR"
  TMP_DIR="$(mktemp -d)"
  NODE_TGZ="node-${opts.wslNode}-linux-x64.tar.xz"
  # 优先 npmmirror（国内快），失败再回官方源
  if ! curl -fL --retry 3 --connect-timeout 20 -o "$TMP_DIR/node.tar.xz" \\
      "https://npmmirror.com/mirrors/node/${opts.wslNode}/$NODE_TGZ"; then
    echo "[wsl] npmmirror 不可用，回退 nodejs.org"
    curl -fL --retry 3 --connect-timeout 20 -o "$TMP_DIR/node.tar.xz" \\
      "https://nodejs.org/dist/${opts.wslNode}/$NODE_TGZ"
  fi
  mkdir -p "$NODE_DIR"
  tar -xJf "$TMP_DIR/node.tar.xz" -C "$NODE_DIR" --strip-components=1
  rm -rf "$TMP_DIR"
fi
export PATH="$NODE_DIR/bin:$PATH"
echo "[wsl] node $(node -v) / npm $(npm -v)"

# crates.io 在国内基本拉不动（transfer too slow 反复重试），沿用 Windows 侧同款
# rsproxy 镜像。用构建目录自己的 CARGO_HOME，不动 ~/.cargo 里的用户配置，
# registry 缓存也留在构建目录里，下次增量构建不用重新下载。
export CARGO_HOME="$BUILD_DIR/.cargo-home"
mkdir -p "$CARGO_HOME"
if [ ! -f "$CARGO_HOME/config.toml" ]; then
  cat > "$CARGO_HOME/config.toml" <<'CARGO_EOF'
[source.crates-io]
replace-with = 'rsproxy-sparse'

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"

[net]
git-fetch-with-cli = true
CARGO_EOF
fi

cd "$BUILD_DIR"
# 交叉编译器缺失时给出准确提示：对应架构只是没有 Rust 内核，包仍会正常产出
for pair in aarch64-linux-gnu-gcc:linux-arm64 arm-linux-gnueabihf-gcc:linux-armv7l; do
  bin="\${pair%%:*}"
  key="\${pair##*:}"
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[wsl] 提示：未安装 $bin，$key 的 Rust 内核会降级为 TS 下载器"
    echo "[wsl]       安装（apt 已在用清华镜像）：sudo apt install -y gcc-aarch64-linux-gnu gcc-arm-linux-gnueabihf"
  fi
done
# 内层的 release/ 只是这轮构建的中间产物，先清掉：
# 否则上一轮（可能是旧版本号）的包会被当成「本轮已产出」拷回 Windows 的 release/。
rm -rf "$BUILD_DIR/release"
${installGuard}
INNER_FLAGS="${innerFlags.join(' ')}"
if [ "$SKIP_INSTALL" -eq 1 ]; then INNER_FLAGS="$INNER_FLAGS --skip-install"; fi

# 内层失败（比如缺 rpmbuild）时，已经打出来的 AppImage / deb 仍然要拷回去，
# 否则每改一个格式就得重跑整条链路。
set +e
./build-all.sh $INNER_FLAGS
INNER_STATUS=$?
set -e

mkdir -p "$SRC/release"
shopt -s nullglob
copied=0
for f in "$BUILD_DIR"/release/*.AppImage "$BUILD_DIR"/release/*.deb "$BUILD_DIR"/release/*.rpm; do
  cp -f "$f" "$SRC/release/"
  copied=$((copied + 1))
done
echo "[wsl] 已拷回 $copied 个产物到 $SRC/release"

if [ "$INNER_STATUS" -ne 0 ]; then
  echo "[wsl] 内层构建失败（退出码 $INNER_STATUS），已产出的格式仍然保留" >&2
  exit "$INNER_STATUS"
fi
if [ "$copied" -eq 0 ]; then
  echo "[wsl] ERROR: Linux 打包没有产出任何文件" >&2
  exit 1
fi
`

  step(`wsl.exe -e bash -lc <由 ${src} 同步后在 WSL 内构建> `)
  const r = spawnSync('wsl.exe', ['-e', 'bash', '-lc', script], { stdio: 'inherit' })
  if (r.error) throw new Error(`wsl.exe 启动失败：${r.error.message}`)
  if (r.status !== 0) throw new Error(`WSL 内 Linux 构建失败（退出码 ${r.status}）`)
}

// ---------------------------------------------------------------------------
//  构建步骤
// ---------------------------------------------------------------------------
step('HungerCat MineCraft Launcher - build')
step(`Root:     ${ROOT}`)
step(`Host:     ${process.platform}-${process.arch}`)
step(`Targets:  ${targets.map((p) => `${p}[${archsFor(p).join(',')}]`).join('  ')}`)
step(
  `Options:  skipNative=${opts.skipNative} skipEasytier=${opts.skipEasytier} ` +
    `skipInstall=${opts.skipInstall} clean=${opts.clean} debug=${opts.debug} easytier=${opts.easytierVersion}`
)

// ---- 前置检查 -------------------------------------------------------------
step('Checking prerequisites...')
for (const bin of ['node', 'npm']) {
  if (!hasCommand(bin)) {
    process.stderr.write(`[build] ERROR: 未找到 '${bin}'，请先安装 Node.js 20+\n`)
    process.exit(1)
  }
}
if (targets.includes('win') && !opts.skipEasytier && IS_WIN_HOST && !hasCommand('7z')) {
  process.stderr.write('[build] ERROR: EasyTier 构建需要 7z，请安装 7-Zip 后重试（或加 --skip-easytier）\n')
  process.exit(1)
}
if (targets.includes('linux') && !IS_WIN_HOST) {
  // deb 不需要 fakeroot（fpm 直接写包）；只有 rpm 依赖宿主机的 rpmbuild。
  if (!hasCommand('rpmbuild')) warn("未安装 'rpmbuild'，rpm 目标会失败（sudo apt install rpm）")
  else setupRpmShim()
}
step('Prerequisites OK.')

// ---- 可选：清理缓存（绝不碰 release/）-------------------------------------
if (opts.clean) {
  step('=== Cleaning build caches (release/ 保留) ===')
  for (const rel of ['out', 'resources/native', 'native/downloader/target']) {
    const p = join(ROOT, rel)
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true })
      step(`cleaned ${rel}`)
    }
  }
  step('Caches cleaned.')
}

// ---- 原生下载内核（只能为本机平台构建）------------------------------------
if (opts.skipNative) {
  step('Step native skipped (--skip-native); 使用 TS 下载器。')
} else if (targets.length === 1 && targets[0] !== hostPlatform) {
  step(`Step native skipped：原生内核不能跨平台编译，请目标平台（${PLATFORM_LABEL[targets[0]]}）上单独构建。`)
} else if (!hasCommand('cargo')) {
  step('Step native skipped：未找到 cargo（安装 Rust: https://rustup.rs），将使用 TS 下载器。')
} else if (!IS_WIN_HOST && !hasCommand('cc')) {
  // 只有 rustc 不够：napi / reqwest(ring) 都要链接 C 运行时，缺 cc 时报的是
  // 「linker `cc` not found」，藏在几百行 cargo 输出里很难定位。
  process.stderr.write(
    '[build] ERROR: 有 cargo 但没有 C 链接器（cc），Rust 内核无法编译。\n' +
      '[build]        WSL / Debian / Ubuntu: wsl -d Ubuntu -e sudo apt install -y build-essential pkg-config\n'
  )
  process.exit(1)
} else {
  // 本机平台的每个架构各编一份（交叉架构缺工具链时只降级该架构，不拖垮整次构建）。
  const prefix = hostPlatform === 'win' ? 'win32' : hostPlatform === 'mac' ? 'darwin' : 'linux'
  for (const arch of archsFor(hostPlatform)) {
    const key = `${prefix}-${arch}`
    const args = ['scripts/build-native-downloader.mjs', '--target', key]
    if (opts.debug) args.push('--debug')
    try {
      run('node', args)
    } catch (err) {
      if (arch === hostArch()) throw err
      // 交叉架构缺工具链是常态（典型：Windows 上编 ARM64 需要「MSVC ARM64 生成工具」
      // + LLVM/clang —— ring 的汇编必须走 clang）。只降级这一架，别拖垮整次构建，
      // 并把「装什么」直接写进提示，省得下次再去猜。
      const hint =
        key === 'win32-arm64'
          ? '\n[build]        需要 Visual Studio 勾选「MSVC v143 - ARM64 生成工具」并安装 LLVM(clang)；' +
            '\n[build]        两者齐备后重跑即可，缺任一项该架构只能用 TS 下载器（功能相同，下载略慢）。'
          : ''
      warn(
        `原生内核 ${key} 编译失败，该架构将回退 TS 下载器：` +
          `${err instanceof Error ? err.message : String(err)}${hint}`
      )
    }
  }
}

// ---- EasyTier（仅 Windows）-----------------------------------------------
if (!targets.includes('win') || !IS_WIN_HOST || opts.skipEasytier) {
  step('Step easytier skipped。')
} else if (hasEasyTier()) {
  step('Step easytier: 已存在且不依赖 Npcap，复用现有产物。')
} else {
  step('=== Building EasyTier core (no Npcap) ===（首次约 10-30 分钟）')
  run('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(ROOT, 'scripts', 'build-easytier-npcap-free.ps1'),
    '-Version',
    opts.easytierVersion
  ])
  step('EasyTier core built.')
}

/**
 * 现有 EasyTier 二进制是否可直接复用。
 *
 * 官方发行版静态导入了 packet.dll，装上就得让所有用户装 Npcap；仓库里这份是改造过的
 * 「无 Npcap」版本。这里按字节扫一下导入表特征，避免把官方版误当可用产物打进去。
 */
function hasEasyTier() {
  const dir = join(ROOT, 'resources', 'easytier')
  const files = ['easytier-core.exe', 'easytier-cli.exe'].map((f) => join(dir, f))
  for (const f of files) {
    if (!existsSync(f)) return false
    const buf = readFileSync(f)
    const ascii = buf.toString('latin1')
    const utf16 = buf.toString('utf16le')
    if (ascii.includes('packet.dll') || utf16.includes('packet.dll')) return false
    if (ascii.includes('PacketGetAdapterNames')) return false
  }
  return true
}

// ---- 依赖 + 前端构建（与平台无关，只做一次）-------------------------------
if (opts.skipInstall) {
  step('Skipping npm install (--skip-install).')
} else {
  step('=== npm install ===')
  npm(['install'])
}

step('=== electron-vite build ===')
npm(['run', 'build'])

// ---- 打包（每个平台单独一次；release/ 只增不减）--------------------------
const failures = []
const useWsl = targets.includes('linux') && wslAvailable()
if (targets.includes('linux') && IS_WIN_HOST) {
  if (opts.noWsl) step('Linux 构建：--no-wsl，直接在 Windows 上调用 electron-builder。')
  else if (useWsl) step('Linux 构建：在 WSL 内完成（不影响 Windows 的 node_modules）。')
  else warn('未检测到可用的 WSL 发行版，退回在 Windows 上直接打包 Linux（通常因符号链接 / fpm 失败）。')
}

const errText = (err) => (err instanceof Error ? err.message : String(err))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 清掉上一轮 NSIS 打包残留的卸载器。
 *
 * electron-builder 打 NSIS 安装器的流程是「先编一个临时安装器 → 执行它，让它写出
 * __uninstaller-nsis-<name>.exe → 再把它嵌进最终安装器」。这一段跑的是**刚编出来的
 * 安装器**：上一轮留下的同名卸载器还在被扫描 / 句柄没放时，WriteUninstaller 写不进去，
 * 安装器就带着错误码（实测 exit code 2）退出，整个架构的 setup 包就没了。
 * 实测就是这一条：清掉残留后 x64 / ia32 / arm64 三个安装器全部一次成功。
 * 每次调用 electron-builder 前先删干净。
 */
function cleanStaleNsisUninstaller() {
  const dir = join(ROOT, 'release')
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('__uninstaller-nsis-') && name.endsWith('.exe')) {
        rmSync(join(dir, name), { force: true })
      }
    }
  } catch {
    // release/ 还不存在（首次构建）：无需清理
  }
}

for (const platform of targets) {
  step(`=== Packaging: ${PLATFORM_LABEL[platform]} ===`)
  // WSL 那一趟内部已经是「逐架构串起来 + 失败即停」，整趟作为一个整体记录。
  if (platform === 'linux' && IS_WIN_HOST && useWsl) {
    try {
      buildLinuxInWsl()
      step(`${PLATFORM_LABEL[platform]} 打包完成。`)
    } catch (err) {
      failures.push(`${PLATFORM_LABEL[platform]}: ${errText(err)}`)
      process.stderr.write(`[build] ERROR: ${PLATFORM_LABEL[platform]} 打包失败\n`)
    }
    continue
  }

  if (platform !== hostPlatform) {
    warn(
      `正在 ${process.platform} 上打包 ${PLATFORM_LABEL[platform]}：` +
        (platform === 'linux'
          ? 'AppImage 需要符号链接权限（开发者模式/管理员），deb 与 rpm 需要 fpm / rpmbuild。建议在 Linux 上构建。'
          : '需要 wine 支持。建议在 Windows 上构建。')
    )
  }
  const flag = platform === 'win' ? '--win' : platform === 'mac' ? '--mac' : '--linux'
  const archList = archsFor(platform)
  let done = 0
  // 一次只给 electron-builder 传一个架构：多架构一起传时，portable / nsis 会额外
  // 产出一个把三个架构打包在一起的「合并包」（实测 211MB，而单架构包只有 72MB）。
  // 每个架构**单独** catch：一个架构失败不应该连带跳过后面的架构 ——
  // 一架失败只损失那一架，其余照旧出包，最后在「失败项」里逐条列出。
  for (const arch of archList) {
    const args = ['electron-builder', flag, ARCH_FLAG[arch]]
    // 兜底重试一次：清理残留卸载器已经解决了实测到的那次失败，但这一步毕竟要
    // **执行一个刚写出来的程序**（杀软 / 索引服务随时可能插手），失败一次就丢掉整个
    // 架构太亏。隔 10 秒重来一次，代价只有 10 秒。
    for (let attempt = 1; ; attempt++) {
      try {
        if (platform === 'win') cleanStaleNsisUninstaller()
        npx(args)
        done += 1
        break
      } catch (err) {
        if (attempt === 1) {
          warn(
            `${PLATFORM_LABEL[platform]} ${arch} 打包失败（${errText(err)}），10 秒后重试一次`
          )
          await sleep(10000)
          continue
        }
        failures.push(`${PLATFORM_LABEL[platform]} ${arch}: ${errText(err)}`)
        process.stderr.write(
          `[build] ERROR: ${PLATFORM_LABEL[platform]} ${arch} 打包失败（继续下一个架构）\n`
        )
        break
      }
    }
  }
  if (done > 0) step(`${PLATFORM_LABEL[platform]} 打包完成（${done}/${archList.length} 个架构）。`)
}

// ---- 汇总（扫描整个 release/，因此能同时看到其它平台的旧产物）------------
const EXT_BY_PLATFORM = {
  win: ['.exe'],
  linux: ['.AppImage', '.deb', '.rpm'],
  mac: ['.dmg', '.zip']
}
const all = listArtifacts(join(ROOT, 'release'))
const wanted = targets.flatMap((p) => EXT_BY_PLATFORM[p])

process.stdout.write('\n')
step('=== Artifacts in release/ ===')
for (const platform of targets) {
  const exts = EXT_BY_PLATFORM[platform]
  const found = all.filter((f) => exts.some((e) => f.path.endsWith(e)))
  step(`${PLATFORM_LABEL[platform]}（${exts.join(' / ')}）：`)
  if (found.length === 0) {
    process.stdout.write('  (none)\n')
  } else {
    for (const f of found) {
      const name = f.path.slice(f.path.lastIndexOf('\\') + 1).split('/').pop()
      process.stdout.write(`  ${name}  --  ${(f.size / 1048576).toFixed(1)} MB\n`)
    }
  }
}
// 其它平台的产物也列一下，方便确认没有被误删。
const others = all.filter(
  (f) => (f.path.endsWith('.exe') || f.path.endsWith('.AppImage') || f.path.endsWith('.deb') || f.path.endsWith('.rpm')) && !wanted.some((e) => f.path.endsWith(e))
)
if (others.length > 0) {
  step('其它平台已有产物（未改动）：')
  for (const f of others) {
    const name = f.path.slice(f.path.lastIndexOf('\\') + 1).split('/').pop()
    process.stdout.write(`  ${name}  --  ${(f.size / 1048576).toFixed(1)} MB\n`)
  }
}

process.stdout.write('\n')
if (failures.length > 0) {
  process.stderr.write('[build] 失败项：\n')
  for (const f of failures) process.stderr.write(`  - ${f}\n`)
  process.exit(1)
}
// 权限位修复：统一收敛归档产物里不该出现的执行位，避免下游解包后
// 出现「资源文件可执行」这类告警。它不改变包内容，失败也不影响产物本身。
try {
  step('修复产物完整性（权限位）')
  run('node', ['scripts/fix-artifact-integrity.mjs'])
} catch {
  warn('产物完整性修复失败（不影响产物本身，可手动执行 npm run fix:integrity）')
}
step('All done.')
