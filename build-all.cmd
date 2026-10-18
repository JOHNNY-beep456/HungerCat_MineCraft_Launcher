@echo off
rem ===========================================================================
rem  HungerCat MineCraft Launcher - One-click build
rem ===========================================================================
rem  NOTE: this file must stay CRLF with NO UTF-8 BOM. A BOM breaks the
rem  "@echo off" line, and bare-LF endings make cmd run every line as a
rem  separate command. Both cases look like the script "flashes and dies".
rem
rem  Steps:
rem    1. Native downloader (Rust -> .node)   [-NoNative to skip]
rem    2. EasyTier core, no Npcap             [-SkipEasytier to skip]
rem    3. Frontend deps + electron-vite build
rem    4. electron-builder packaging (portable + NSIS)
rem
rem  Usage:
rem    build-all.cmd                     full build
rem    build-all.cmd -SkipEasytier       skip EasyTier (faster)
rem    build-all.cmd -NoNative           skip the Rust downloader
rem    build-all.cmd -Clean              clean caches first
rem    build-all.cmd -DebugBuild         native downloader debug build
rem    build-all.cmd -SkipInstall        reuse existing node_modules
rem    build-all.cmd -EasytierVersion v  EasyTier tag (default v2.5.0)
rem
rem  Output: release\HCMCL-<version> Setup.exe
rem ===========================================================================

setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "SCRIPTS=%ROOT%\scripts"

rem rustup installs cargo under the user profile but does not always add it to
rem PATH for non-interactive shells, so pick it up here.
if defined CARGO_HOME (set "CARGO_BIN=%CARGO_HOME%\bin") else (set "CARGO_BIN=%USERPROFILE%\.cargo\bin")
if not defined PATH set "PATH=%PATH%;%SystemRoot%\system32;%SystemRoot%"
if exist "%CARGO_BIN%\cargo.exe" if /I not "%PATH:~0,1%"==";" set "PATH=%PATH%;%CARGO_BIN%"

set "SKIP_EASYTIER=0"
set "NO_NATIVE=0"
set "CLEAN=0"
set "DEBUG_BUILD=0"
set "SKIP_INSTALL=0"
set "ET_VERSION=v2.5.0"

rem ---------------------------------------------------------------------------
rem  Argument parsing
rem ---------------------------------------------------------------------------
:PARSE
if "%~1"=="" goto :PARSE_END
if /I "%~1"=="-SkipEasytier"    set "SKIP_EASYTIER=1"  & shift & goto :PARSE
if /I "%~1"=="-NoNative"        set "NO_NATIVE=1"      & shift & goto :PARSE
if /I "%~1"=="-Clean"           set "CLEAN=1"          & shift & goto :PARSE
if /I "%~1"=="-DebugBuild"      set "DEBUG_BUILD=1"    & shift & goto :PARSE
if /I "%~1"=="-SkipInstall"     set "SKIP_INSTALL=1"   & shift & goto :PARSE
if /I "%~1"=="-EasytierVersion" set "ET_VERSION=%~2"   & shift & shift & goto :PARSE
if /I "%~1"=="-h" goto :USAGE
if /I "%~1"=="--help" goto :USAGE
echo Unknown option: %1
goto :USAGE
:PARSE_END

rem ---------------------------------------------------------------------------
rem  Header
rem ---------------------------------------------------------------------------
echo.
echo [build] HungerCat MineCraft Launcher - One-click build
echo [build] Root:    %ROOT%
echo [build] Options: SkipEasytier=%SKIP_EASYTIER% NoNative=%NO_NATIVE% Clean=%CLEAN% DebugBuild=%DEBUG_BUILD% SkipInstall=%SKIP_INSTALL% EasyTier=%ET_VERSION%
echo.

rem ---------------------------------------------------------------------------
rem  Pre-flight checks
rem ---------------------------------------------------------------------------
call :STEP "Checking prerequisites..."

call :NEED git  "Install Git and add it to PATH"
if errorlevel 1 goto :FAIL_END
call :NEED node "Install Node.js 20 or newer from https://nodejs.org"
if errorlevel 1 goto :FAIL_END
call :NEED npm  "npm ships with Node.js; reinstall Node.js if missing"
if errorlevel 1 goto :FAIL_END
call :NEED curl "curl.exe is required by the EasyTier build"
if errorlevel 1 goto :FAIL_END

rem 7z is only needed by the EasyTier build (it unpacks protoc)
if "%SKIP_EASYTIER%"=="0" (
    call :NEED 7z "Install 7-Zip; needed by the EasyTier build"
    if errorlevel 1 goto :FAIL_END
)

if "%NO_NATIVE%"=="0" (
    call :NEED cargo "Install Rust from https://rustup.rs"
    if errorlevel 1 goto :FAIL_END
)

call :STEP "Prerequisites OK."

rem ---------------------------------------------------------------------------
rem  Optional: clean caches
rem ---------------------------------------------------------------------------
if "%CLEAN%"=="1" (
    echo.
    call :STEP "=== Cleaning build caches ==="
    for %%d in ("%ROOT%\out" "%ROOT%\release" "%ROOT%\resources\native" "%ROOT%\resources\easytier" "%ROOT%\native\downloader\target") do (
        if exist "%%~d" (
            rmdir /s /q "%%~d" 2>nul
            echo [build]   cleaned %%~d
        )
    )
    for /d %%d in ("%TEMP%\easytier-src-*") do rmdir /s /q "%%~d" 2>nul
    for /d %%d in ("%TEMP%\easytier-pnet-patch-*") do rmdir /s /q "%%~d" 2>nul
    if exist "%TEMP%\easytier-libclang" rmdir /s /q "%TEMP%\easytier-libclang" 2>nul
    call :STEP "Caches cleaned."
)

rem ---------------------------------------------------------------------------
rem  Step 1: native downloader (Rust -> .node)
rem ---------------------------------------------------------------------------
echo.
if "%NO_NATIVE%"=="0" (
    call :STEP "=== Step 1/4: Build native downloader (Rust to .node) ==="
    set "NATIVE_ARGS="
    if "%DEBUG_BUILD%"=="1" set "NATIVE_ARGS=--debug"
    node "%SCRIPTS%\build-native-downloader.mjs" %NATIVE_ARGS%
    if errorlevel 1 (
        echo [build] ERROR: native downloader build failed
        goto :FAIL_END
    )
    call :STEP "Native downloader built."
) else (
    call :STEP "Step 1/4 skipped (-NoNative); the TS fallback downloader will be used."
)

rem ---------------------------------------------------------------------------
rem  Step 2: EasyTier core
rem ---------------------------------------------------------------------------
echo.
set "ET_DIR=%ROOT%\resources\easytier"
if "%SKIP_EASYTIER%"=="0" (
    call :HAVE_EASYTIER
    rem !HAVE_ET! (not %HAVE_ET%): the whole if-block is parsed before it runs,
    rem so a plain %VAR% here would still hold the pre-call (empty) value.
    if "!HAVE_ET!"=="1" (
        call :STEP "Step 2/4: EasyTier already present and Npcap-free -- reusing it."
    ) else (
        call :STEP "=== Step 2/4: Build EasyTier core (no Npcap) ==="
        echo [build] This takes 10-30 minutes on first run.
        powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPTS%\build-easytier-npcap-free.ps1" -Version %ET_VERSION%
        if errorlevel 1 (
            echo [build] ERROR: EasyTier build failed
            goto :FAIL_END
        )
        call :STEP "EasyTier core built."
    )
) else (
    call :STEP "Step 2/4 skipped (-SkipEasytier); multiplayer will use the TS fallback."
)

rem ---------------------------------------------------------------------------
rem  Step 3: frontend deps + electron-vite build
rem ---------------------------------------------------------------------------
echo.
call :STEP "=== Step 3/4: Install dependencies and build the frontend ==="
pushd "%ROOT%"
if exist out     rmdir /s /q out
if exist release rmdir /s /q release

if "%SKIP_INSTALL%"=="0" (
    call :STEP "npm install..."
    call npm install
    if errorlevel 1 (
        echo [build] ERROR: npm install failed
        popd
        goto :FAIL_END
    )
) else (
    call :STEP "Skipping npm install (-SkipInstall)."
)

call :STEP "electron-vite build (npm run build)..."
call npm run build
if errorlevel 1 (
    echo [build] ERROR: electron-vite build failed
    popd
    goto :FAIL_END
)
popd
call :STEP "Frontend built."

rem ---------------------------------------------------------------------------
rem  Step 4: electron-builder packaging
rem ---------------------------------------------------------------------------
echo.
call :STEP "=== Step 4/4: Package with electron-builder (portable + NSIS) ==="
pushd "%ROOT%"
call npm run dist
if errorlevel 1 (
    echo [build] ERROR: electron-builder failed
    popd
    goto :FAIL_END
)
popd
call :STEP "Packaging done."

rem ---------------------------------------------------------------------------
rem  Summary
rem ---------------------------------------------------------------------------
echo.
call :STEP "=== Build succeeded, artifacts ==="
set "FOUND=0"
for %%f in ("%ROOT%\release\*.exe") do (
    set "FOUND=1"
    set "BYTES=%%~zf"
    set /a "MB=!BYTES!/1048576"
    echo   %%~nxf  --  !MB! MB
)
if "!FOUND!"=="0" (
    echo [build] ERROR: no .exe artifacts were produced in release\
    goto :FAIL_END
)

echo.
call :STEP "All done. Artifacts are in %ROOT%\release"
echo.
exit /b 0

rem ===========================================================================
rem  Subroutines
rem ===========================================================================

rem :STEP <text> - print a status line
:STEP
echo [build] %~1
exit /b 0

rem :HAVE_EASYTIER - sets HAVE_ET=1 when both binaries exist AND neither
rem imports packet.dll. The official EasyTier release binaries DO import it
rem (load-time), so they cannot be substituted here without forcing every end
rem user to install Npcap. Rebuilding is a 10-30 minute cargo build, so only do
rem it when the artefacts are genuinely missing or unusable.
:HAVE_EASYTIER
set "HAVE_ET=0"
set "ET_CORE=%ET_DIR%\easytier-core.exe"
set "ET_CLI=%ET_DIR%\easytier-cli.exe"
if not exist "%ET_CORE%" goto :EOF
if not exist "%ET_CLI%" goto :EOF
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "foreach($f in @('%ET_CORE%','%ET_CLI%')){" ^
  "$b=[IO.File]::ReadAllBytes($f);" ^
  "$a=[Text.Encoding]::ASCII.GetString($b);" ^
  "$u=[Text.Encoding]::Unicode.GetString($b);" ^
  "if($a.Contains('packet.dll') -or $u.Contains('packet.dll') -or $a.Contains('PacketGetAdapterNames')){exit 1}}" ^
  >nul 2>&1
if errorlevel 1 (
    echo [build]   existing EasyTier binaries import packet.dll -- rebuilding.
    set "HAVE_ET=0"
    goto :EOF
)
set "HAVE_ET=1"
goto :EOF

rem :NEED <command> <hint> - return 0 when present, 1 when missing
:NEED
where "%~1" >nul 2>&1
if errorlevel 1 (
    echo [build] ERROR: '%~1' was not found on PATH.
    echo [build]        %~2
    exit /b 1
)
exit /b 0

rem Shared failure exit. The pause keeps the window open when the script is
rem started by double-click, so the error stays readable.
:FAIL_END
echo.
echo [build] Build aborted.
echo.
pause
exit /b 1

:USAGE
echo.
echo Usage: build-all.cmd [options]
echo.
echo   -SkipEasytier        skip the EasyTier build (saves 10-30 minutes)
echo   -NoNative            skip the Rust downloader (TS fallback only)
echo   -Clean               clean all build caches before building
echo   -DebugBuild          build the native downloader with debug symbols
echo   -SkipInstall          reuse the existing node_modules (no npm install)
echo   -EasytierVersion v   EasyTier version tag (default v2.5.0)
echo   -h, --help           show this help
echo.
exit /b 0