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
rem    build-all.cmd                     build EVERYTHING (no args = --platform all
rem                                      --arch all):
rem                                        Windows x64 / ia32 / arm64
rem                                          portable.exe + setup.exe
rem                                        Linux   x64 / arm64 / armv7l (inside WSL)
rem                                          AppImage + .deb + .rpm
rem                                      macOS is NOT included: a dmg only exists on a
rem                                      Mac (see below), so --platform all never
rem                                      targets it here.
rem    build-all.cmd --platform win      Windows release only (skips the WSL trip)
rem    build-all.cmd --platform linux    Linux release only (inside WSL)
rem    build-all.cmd --platform mac      not possible here: macOS needs a Mac (below)
rem    build-all.cmd --arch x64          a single arch for every platform
rem    build-all.cmd --arch x64,arm64    pick architectures explicitly
rem    build-all.cmd --no-wsl            skip WSL, run electron-builder directly
rem    build-all.cmd --skip-easytier     skip EasyTier (saves 10-30 min)
rem    build-all.cmd --skip-native       skip the Rust downloader
rem    build-all.cmd --skip-install      reuse the existing node_modules
rem    build-all.cmd --clean             clean caches (release/ is kept)
rem    build-all.cmd --debug             native downloader debug build
rem    build-all.cmd -h                  show help
rem
rem  Failure policy: each platform / arch is built on its own, so one failing
rem  target (typically the NSIS installer step, which has to execute the freshly
rem  written unsigned exe and can be blocked by antivirus) only costs that arch;
rem  the remaining arches still produce artifacts and every failure is listed
rem  again in the summary at the end.
rem
rem  Output: release\HCMCL<version>-win-<arch>-portable.exe
rem          release\HCMCL<version>-win-<arch>-setup.exe
rem          release\HCMCL<version>-<arch>.AppImage / *.deb / *.rpm
rem          release\HCMCL<version>-mac-<arch>.dmg / .zip   (macOS only)
rem
rem  macOS: not buildable on Windows at all (dmg needs hdiutil, signing needs
rem  codesign). Two ways to get it:
rem    1) push, then run the build-mac workflow on GitHub Actions (macos-14)
rem    2) on any Mac: ./build-all.sh --platform mac --arch all
rem ===========================================================================

setlocal EnableExtensions
chcp 65001 >nul 2>&1

rem With no arguments this builds every platform this machine can produce, for
rem every architecture. Pass --platform / --arch to narrow it down.
set "HCMCL_ARGS=%*"
if "%HCMCL_ARGS%"=="" set "HCMCL_ARGS=--platform all --arch all"

node "%~dp0scripts\build-all.mjs" %HCMCL_ARGS%
if errorlevel 1 (
    echo.
    echo [build] Build aborted - see the failure list above.
    echo.
    rem Keep the window open when started by double-click, so the error stays readable.
    pause
    exit /b 1
)

exit /b 0
