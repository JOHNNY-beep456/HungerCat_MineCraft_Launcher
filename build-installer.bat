@echo off
setlocal
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  One-click installer build.
rem
rem  Outputs (both under release\):
rem    HCMCL-<version> Setup.exe              portable -- the main deliverable.
rem                                           Setup.exe IS the launcher: it detects
rem                                           PORTABLE_EXECUTABLE_FILE and switches
rem                                           to install mode, so the package carries
rem                                           only ONE Electron runtime.
rem    HungerCat... Setup <version>.exe       nsis -- emergency fallback. Does not
rem                                           go through install mode at all.
rem
rem  Options:
rem    --legacy        build the retired "installer wrapping the launcher" package
rem                     instead (two Electron runtimes, ~2x the size). Kept only as
rem                     a rollback path; it also needs installer/ to be present.
rem    --skip-native   skip the Rust downloader build. The launcher degrades to its
rem                     TypeScript downloader when the native lib is missing, so this
rem                     is only for machines without a Rust toolchain.
rem ---------------------------------------------------------------------------

set "LEGACY="
set "SKIP_NATIVE="

:parseargs
if "%~1"=="" goto parsedargs
if /i "%~1"=="--legacy" set "LEGACY=--legacy"
if /i "%~1"=="--skip-native" set "SKIP_NATIVE=1"
shift
goto parseargs
:parsedargs

echo === HungerCat MineCraft Launcher - Build Installer ===

if defined LEGACY (
  echo   MODE: --legacy  ^(retired double-runtime installer, ~2x size^)
) else (
  echo   MODE: default   ^^(portable + nsis fallback^)
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install it from https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

if defined SKIP_NATIVE goto step2

where cargo >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
    set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
  ) else (
    echo [WARNING] Cargo not found. Install Rust from https://rustup.rs
    echo           Re-run with --skip-native to build without the native downloader
    echo           ^(the launcher then falls back to its TypeScript downloader^).
    pause
    exit /b 1
  )
)

:step2
if defined SKIP_NATIVE (
  echo [1/4] Skipping native downloader ^(--skip-native^)...
) else (
  echo [1/4] Building native downloader...
  call node "scripts\build-native-downloader.mjs"
  if errorlevel 1 (
    echo [ERROR] Native downloader build failed.
    echo         Re-run with --skip-native to build without it.
    pause
    exit /b 1
  )
)

echo [2/4] Type checking...
call npm run typecheck
if errorlevel 1 (
  echo [ERROR] Type check failed.
  pause
  exit /b 1
)

echo [3/4] Building app...
call npm run build
if errorlevel 1 (
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

rem The installer UI lives in src\renderer\public\installer and is copied verbatim
rem into out\renderer\installer by the Vite build. Without it the install mode has
rem no window to show, so fail here rather than shipping a Setup.exe that opens a
rem broken window.
if not exist "out\renderer\installer\index.html" (
  echo [ERROR] Missing out\renderer\installer\index.html
  echo         The installer's UI assets did not make it into the build.
  pause
  exit /b 1
)

echo [4/4] Packaging installer...
if defined LEGACY (
  echo       ^(--legacy: retired double-runtime layout^)
) else (
  echo       ^(portable main artifact + nsis fallback^)
)
call node "scripts\build-installer.mjs" %LEGACY%
if errorlevel 1 (
  echo [ERROR] Installer build failed.
  pause
  exit /b 1
)

echo.
echo --- Artifacts in release\ ---
rem Kept on ONE line: adjacent quoted strings would be passed to PowerShell as
rem separate arguments, not concatenated. Pipes are safe here because the whole
rem command is inside double quotes (batch only treats | specially outside them).
powershell -NoProfile -Command "$f=Get-ChildItem '%CD%\release' -File -Filter '*.exe' | Where-Object { $_.Name -match 'Setup' } | Sort-Object LastWriteTime -Descending | Select-Object -First 3; $f | ForEach-Object { '    {0,-52} {1,7:N1} MB' -f $_.Name, ($_.Length/1MB) }"

echo.
if defined LEGACY (
  echo Done. Legacy installer built ^(retired layout, ~2x size^).
  echo Publish it only if the portable artifact has to be rolled back.
) else (
  echo Done. Publish "HCMCL-^<version^> Setup.exe".
  echo The nsis package is an emergency fallback; it does not use install mode.
)
echo Before publishing, run the Setup.exe on a clean machine and check:
echo   - install wizard appears, progress and cancel work
echo   - desktop / Start Menu shortcuts and the "Apps ^& features" entry appear
echo   - the uninstall script removes directory, shortcuts and registry keys
pause
exit /b 0