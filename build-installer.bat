@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title HungerCat 启动器 - 一键打包（生成安装包）

rem ===================================================================
rem  双击即可完成：编译 Rust 原生内核 → 编译前端/主进程 → 打包安装 exe。
rem
rem  中文提示为什么不能乱码？——两点必须同时满足：
rem  1. 控制台代码页与本文件编码一致；
rem  2. 本文件以 UTF-8(无 BOM) 保存，故这里用 chcp 65001。
rem     （若改回 GBK 保存，则必须同时把 chcp 改回 936。）
rem ===================================================================

rem 切到脚本所在目录（本文件在项目根目录，即项目根）。
cd /d "%~dp0"

set "TOTAL_STEPS=5"

echo.
echo ============================================================
echo   HungerCat MineCraft Launcher - 一键打包
echo ============================================================
echo.
echo   流程：检查环境 → 编译 Rust 内核 → 编译 TS/前端 → 打包 exe
echo   产物：release\ 目录下的安装包
echo.

rem ---------- 步骤 1/5：环境检查 ----------
echo [1/%TOTAL_STEPS%] 检查构建环境...

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有找到 Node.js。
  echo          请先从 https://nodejs.org 安装 Node.js 后重试。
  goto :failed
)

set "CARGO_BIN="
where cargo >nul 2>nul
if not errorlevel 1 set "CARGO_BIN=cargo"

if not defined CARGO_BIN (
  if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
    set "CARGO_BIN=%USERPROFILE%\.cargo\bin\cargo.exe"
    set "PATH=%USERPROFILE%\.cargo\bin;!PATH!"
  )
)

if not defined CARGO_BIN (
  echo.
  echo   [错误] 没有找到 Rust 工具链（cargo）。
  echo          请先安装 Rust：https://rustup.rs
  echo          安装后重启本脚本。
  echo.
  echo   另外还需要 MSVC 链接器（Visual Studio Build Tools 的
  echo   「使用 C++ 的桌面开发」工作负载），否则 Rust 无法链接。
  goto :failed
)

rem 链接器检测：Rust 在 Windows 上依赖 VS 的 MSVC 链接器。
set "HAS_VS=0"
for /d %%d in ("C:\Program Files (x86)\Microsoft Visual Studio\2022\*") do set "HAS_VS=1"
for /d %%d in ("C:\Program Files\Microsoft Visual Studio\2022\*") do set "HAS_VS=1"
if "!HAS_VS!"=="0" (
  echo.
  echo   [警告] 未检测到 Visual Studio 2022 / Build Tools。
  echo          Rust 编译很可能失败。解决方法：安装 Build Tools 并勾选
  echo          「使用 C++ 的桌面开发」。
  echo          下载：https://aka.ms/vs/17/release/vs_BuildTools.exe
  echo.
  echo   按任意键继续尝试，或关掉窗口退出。
  pause >nul
)

rem 依赖目录：缺失时自动 npm install，避免打包到一半才报错。
if not exist "node_modules" (
  echo.
  echo   未检测到 node_modules，正在安装依赖（首次较慢）...
  call npm install
  if errorlevel 1 (
    echo.
    echo   [错误] 依赖安装失败。请检查网络后重试。
    goto :failed
  )
)

echo   环境检查通过。
echo.

rem ---------- 步骤 2/5：编译 Rust 原生下载内核 ----------
echo [2/%TOTAL_STEPS%] 编译 Rust 原生下载内核...
echo.
call node "scripts\build-native-downloader.mjs"
if errorlevel 1 (
  echo.
  echo   [错误] Rust 内核编译失败。
  echo          常见原因：缺少 MSVC 链接器，或首次下载 crates.io 依赖超时。
  echo          也可直接运行 scripts\build-native-downloader.bat 单独排查。
  goto :failed
)
echo.

rem ---------- 步骤 3/5：类型检查（提前拦截错误，避免打包出一个坏包） ----------
echo [3/%TOTAL_STEPS%] 类型检查...
call npm run typecheck
if errorlevel 1 (
  echo.
  echo   [错误] 类型检查未通过，已中止打包。
  echo          上面输出的 error TS 行就是具体位置。
  goto :failed
)
echo   类型检查通过。
echo.

rem ---------- 步骤 4/5：编译前端 / 主进程 ----------
echo [4/%TOTAL_STEPS%] 编译前端与主进程...
call npm run build
if errorlevel 1 (
  echo.
  echo   [错误] 编译失败。
  goto :failed
)
echo.

rem ---------- 步骤 5/5：打包安装包 ----------
echo [5/%TOTAL_STEPS%] 打包 Windows 安装包（首次会下载 Electron 二进制，较慢）...
echo.
rem 为什么要 --use-system-ca？
rem electron-builder 需要联网下载 Electron / NSIS 等二进制。本机若使用企业代理或
rem 自签根证书，Node 自带的 CA 列表会验不过，报
rem   "unable to verify the first certificate ... try running Node.js with --use-system-ca"
rem 该参数让 Node 信任系统证书库，从而正常完成下载。加在 node-options 上不影响其它步骤。
call npx --node-options=--use-system-ca electron-builder --win
if errorlevel 1 (
  echo.
  echo   [错误] 打包失败。
  echo          常见原因：
  echo            - 下载 Electron / NSIS 二进制超时或证书校验失败
  echo              （脚本已加 --use-system-ca；若仍失败多为网络问题，
  echo                可配置镜像后重试）；
  echo            - release 目录被占用：关掉正在运行的启动器或资源管理器后重试。
  goto :failed
)
echo.

echo ============================================================
echo   打包成功
echo ============================================================
echo.
echo   安装包位于 release\ 目录，文件名形如：
echo     HungerCat MineCraft Launcher Setup ^<版本号^>.exe
echo.
echo   下面列出该目录中的安装包文件：
echo.
for %%f in ("release\*Setup*.exe") do echo     %%~nxf   ^(%%~zf 字节^)
echo.
echo   双击该 exe 即可安装。
echo.
pause
exit /b 0

:failed
echo.
echo ============================================================
echo   构建中止
echo ============================================================
echo.
echo   已完成的步骤不受影响，修复上面的问题后重新双击本脚本即可。
echo   若某一步骤反复失败，可单独运行对应命令排查：
echo     编译 Rust 内核：scripts\build-native-downloader.bat
echo     类型检查　　　：npm run typecheck
echo     仅编译　　　　：npm run build
echo     仅打包　　　　：npx --node-options=--use-system-ca electron-builder --win
echo.
pause
exit /b 1
