@echo off
rem ===========================================================================
rem  HungerCat MineCraft Launcher - One-click build (Windows entry point)
rem ===========================================================================
rem  NOTE: this file must stay CRLF, ASCII-only and without a UTF-8 BOM.
rem  A BOM breaks the "@echo off" line, bare-LF endings make cmd run every line
rem  as a separate command, and non-ASCII text is decoded with the *console*
rem  code page before "chcp" takes effect (cmd then tries to execute fragments
rem  of the comments). All the human-readable Chinese output lives in the Node
rem  script instead.
rem
rem  The real build / packaging pipeline has exactly one implementation:
rem  scripts/build-all.mjs (Node, cross-platform). This file only forwards
rem  arguments and keeps the window open on failure. Two separate pipelines
rem  inevitably drift apart - and both used to start by deleting release/,
rem  so building Windows wiped the Linux artifacts and vice versa.
rem
rem  Usage:
rem    build-all.cmd                           build Windows *and* Linux (no args = both;
rem                                            Linux is built inside WSL automatically)
rem    build-all.cmd --platform win            build the Windows release only
rem    build-all.cmd --platform linux          build the Linux release only (inside WSL)
rem    build-all.cmd --platform mac            not possible here: macOS needs a Mac (see below)
rem    build-all.cmd --no-wsl                 skip WSL, run electron-builder directly
rem    build-all.cmd --skip-easytier           skip EasyTier (saves 10-30 min)
rem    build-all.cmd --arch all               all arches: win x64/ia32/arm64, linux x64/arm64/armv7l
rem    build-all.cmd --arch x64,arm64         pick architectures explicitly (default: x64)
rem    build-all.cmd --skip-native             skip the Rust downloader
rem    build-all.cmd --skip-install            reuse the existing node_modules
rem    build-all.cmd --clean                   clean caches (release/ is kept)
rem    build-all.cmd --debug                   native downloader debug build
rem    build-all.cmd -h                        show help
rem
rem  Output: release\HCMCL<version>-win-<arch>-portable.exe
rem          release\HCMCL<version>-win-<arch>-setup.exe
rem          release\HCMCL<version>-<arch>.AppImage / *.deb / *.rpm
rem          release\HCMCL<version>-mac-<arch>.dmg / .zip   (macOS only)
rem ===========================================================================

setlocal EnableExtensions
chcp 65001 >nul 2>&1

rem With no arguments this builds every platform: Windows natively, Linux inside WSL.
rem Use --platform win for a Windows-only run (skips the WSL trip).
set "HCMCL_ARGS=%*"
if "%HCMCL_ARGS%"=="" set "HCMCL_ARGS=--platform all"

node "%~dp0scripts\build-all.mjs" %HCMCL_ARGS%
if errorlevel 1 (
    echo.
    echo [build] Build aborted.
    echo.
    rem Keep the window open when started by double-click, so the error stays readable.
    pause
    exit /b 1
)

exit /b 0
