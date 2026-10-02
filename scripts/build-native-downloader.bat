@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title HungerCat 原生下载内核 - 一键编译

rem ===================================================================
rem  双击即可编译 Rust 原生下载内核（hungercat_downloader.node）。
rem
rem  中文提示为什么不能乱码？——两点必须同时满足：
rem  1. 控制台代码页与本文件编码一致；
rem  2. 本文件以 UTF-8(无 BOM) 保存，故这里用 chcp 65001。
rem     （若改回 GBK 保存，则必须同时把 chcp 改回 936。）
rem ===================================================================

cd /d "%~dp0.."

echo.
echo ============================================================
echo   HungerCat MineCraft Launcher - 原生下载内核编译
echo ============================================================
echo.
echo   作用：把 Rust 下载内核编译成 Node 可加载的 .node 文件，
echo         让下载走多连接加速。
echo   产物：resources\native\^<平台-架构^>\hungercat_downloader.node
echo.
echo   说明：编译失败不影响启动器使用，会自动降级到 TS 下载器。
echo.

rem ---------- 1. 检查 Rust 工具链 ----------
rem 注意：这里只用 if/where 判定，不用 for /f 取版本 —— for /f 会把
rem errorlevel 重置为 0，容易把后续的失败判断带偏。
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
  echo [错误] 没有找到 Rust 工具链（cargo）。
  echo.
  echo   请先安装 Rust：
  echo     1. 打开 https://rustup.rs
  echo     2. 下载并运行 rustup-init.exe，一路回车用默认选项
  echo     3. 安装完成后重启本脚本
  echo.
  echo   另外还需要 MSVC 链接器（Visual Studio Build Tools 的
  echo   「使用 C++ 的桌面开发」工作负载），否则 Rust 无法链接。
  echo.
  pause
  exit /b 1
)
echo [1/4] 已找到 Rust 工具链

rem ---------- 2. 检查 Node ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js。请先安装 Node.js 后重试。
  echo.
  pause
  exit /b 1
)
echo [2/4] 已找到 Node.js

rem ---------- 3. 检查链接器（提前给出明确提示，而不是等 cargo 报错） ----------
set "HAS_VS=0"
for /d %%d in ("C:\Program Files (x86)\Microsoft Visual Studio\2022\*") do set "HAS_VS=1"
for /d %%d in ("C:\Program Files\Microsoft Visual Studio\2022\*") do set "HAS_VS=1"
if "!HAS_VS!"=="0" (
  echo.
  echo [警告] 没检测到 Visual Studio 2022 / Build Tools。
  echo        Rust 在 Windows 上依赖其 MSVC 链接器，继续编译很可能失败。
  echo.
  echo        解决：安装 Visual Studio Build Tools，勾选
  echo              「使用 C++ 的桌面开发」工作负载。
  echo              下载：https://aka.ms/vs/17/release/vs_BuildTools.exe
  echo.
  echo        仍要继续尝试吗？按任意键继续，或关掉窗口退出。
  pause >nul
) else (
  echo [3/4] 已检测到 Visual Studio 2022
)

rem ---------- 4. 调用编译脚本 ----------
echo [4/4] 开始编译（首次编译需下载依赖，可能要几分钟，请耐心等待）...
echo.

call node "scripts\build-native-downloader.mjs"
set "BUILD_RESULT=%ERRORLEVEL%"

echo.
if not "%BUILD_RESULT%"=="0" (
  echo ============================================================
  echo   编译失败
  echo ============================================================
  echo.
  echo   常见原因：
  echo     - 缺少 MSVC 链接器：装 Visual Studio Build Tools 的
  echo       「使用 C++ 的桌面开发」工作负载。
  echo     - 网络问题：首次编译需从 crates.io 下载依赖，若超时可
  echo       配置国内镜像后重试。
  echo     - 上面输出中的 error 行就是具体原因，可据此排查。
  echo.
  echo   注意：编译失败不影响启动器正常使用，下载会自动
  echo         降级到内置的 TS 实现。
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo   编译成功
echo ============================================================
echo.
echo   产物已就位，重新启动启动器即可生效。
echo   可在「设置 - 下载 - 单文件连接数」调整并发连接数。
echo.
pause
exit /b 0
