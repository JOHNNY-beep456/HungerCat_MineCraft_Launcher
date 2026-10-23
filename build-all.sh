#!/usr/bin/env bash
# ===========================================================================
#  HungerCat MineCraft Launcher - 一键构建（Linux 入口）
# ===========================================================================
#
#  真正的构建 / 打包流程只有一份实现：scripts/build-all.mjs（Node，跨平台）。
#  本文件只做转发，避免与 build-all.cmd 各维护一套流程 —— 两份实现迟早会分叉，
#  而且都以删除 release/ 起步：打 Linux 包会顺手删掉 Windows 产物。
#
#  在 Windows 上运行时，Linux 目标会自动交给 WSL 构建（见 scripts/build-all.mjs），
#  因此同一套参数在两边行为一致。
#
#  用法：
#    ./build-all.sh                         构建 Linux 发行包（AppImage + deb + rpm）
#    ./build-all.sh --platform all          构建本机能做的全部平台（macOS 上即 mac）
#    ./build-all.sh --platform mac --arch all   macOS 上产出 x64 + arm64 的 dmg / zip
#    ./build-all.sh --platform win          只构建 Windows 发行包（需要 wine）
#    ./build-all.sh --skip-native           跳过 Rust 原生下载内核
#    ./build-all.sh --skip-install          复用已有 node_modules
#    ./build-all.sh --clean                 清理构建缓存（不会删除 release/）
#    ./build-all.sh --debug                 原生内核调试构建
#    ./build-all.sh -h | --help             查看帮助
#
#  macOS 的包只能在 macOS 上构建（dmg 依赖 hdiutil、签名依赖 codesign），
#  构建脚本不会把它丢给 WSL / 交叉编译去硬凑。
#
#  产物：release/HCMCL<version>-<arch>.AppImage
#        release/hcmcl_<version>_<arch>.deb
#        release/hcmcl-<version>-<arch>.rpm
# ===========================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "[build] ERROR: 未找到 node，请先安装 Node.js 20+" >&2
  exit 1
fi

exec node "$ROOT/scripts/build-all.mjs" "$@"
