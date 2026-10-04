@echo off
setlocal
cd /d "%~dp0"

echo === HungerCat MineCraft Launcher - Build Installer ===

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install it from https://nodejs.org
  pause
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
    set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
  ) else (
    echo [ERROR] Cargo not found. Install Rust from https://rustup.rs
    pause
    exit /b 1
  )
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

echo [1/4] Building native downloader...
call node "scripts\build-native-downloader.mjs"
if errorlevel 1 (
  echo [ERROR] Native downloader build failed.
  pause
  exit /b 1
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

echo [4/4] Packaging installer...
call npx --node-options=--use-system-ca electron-builder --win
if errorlevel 1 (
  echo [ERROR] Packaging failed.
  pause
  exit /b 1
)

echo.
echo Done. Installer is in the release\ directory.
pause
exit /b 0
