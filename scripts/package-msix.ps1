#Requires -Version 5.1
<#
.SYNOPSIS
    Wrap a Tauri Windows build into an MSIX package.

.DESCRIPTION
    Tauri's bundler only produces NSIS (.exe) and MSI; MSIX has to be assembled here.
    The package is a "full trust" desktop package: the launcher runs as a normal Win32
    executable (EntryPoint = Windows.FullTrustApplication + runFullTrust), so it keeps
    writing to %APPDATA% and can spawn the bundled easytier binaries.

    Staged layout (must match the NSIS installer, which ships the exe plus easytier/):
        <stage>/hcmcl-tauri.exe
        <stage>/easytier/easytier-core.exe
        <stage>/easytier/easytier-cli.exe
        <stage>/Assets/*.png
        <stage>/AppxManifest.xml

.PARAMETER Arch
    x64 | x86 | arm64 - becomes ProcessorArchitecture in the manifest.

.PARAMETER Version
    Semver from tauri.conf.json (e.g. 0.8.2). Converted to the 4-part MSIX version.
    Pre-release suffixes are rejected: an MSIX identity version must be numeric.

.PARAMETER ExeDir
    Directory that contains hcmcl-tauri.exe (target/<triple>/release).

.PARAMETER OutDir
    Where the .msix (and optional .cer) is written.

.PARAMETER Sign
    Create a self-signed code-signing certificate, sign the package and export the
    public .cer next to it. The certificate is generated per run and never leaves the
    runner except as a public .cer; install that .cer as trusted before sideloading.

.PARAMETER Store
    Validate and pack for **Microsoft Store submission** instead of sideloading.
    IdentityName / Publisher / PublisherDisplayName must be copied verbatim from
    Partner Center (App management -> App identity); the defaults are rejected because
    a mismatched identity is refused at upload time. Implies -Sign: the Store replaces
    the signature during publishing anyway, but a signed package is the only way to
    verify the payload locally (Add-AppxPackage) before uploading.

.NOTES
    Publisher must equal the certificate subject. For Microsoft Store submission the
    Publisher has to be replaced with the value Partner Center assigned to the app.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('x64', 'x86', 'arm64')][string]$Arch,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$ExeDir,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [string]$IconPng = '',
    [string]$IdentityName = 'top.johnnyblog.hcmcl',
    [string]$Publisher = 'CN=HungerCat',
    [string]$DisplayName = 'HungerCat MineCraft Launcher',
    [string]$PublisherDisplayName = 'HungerCat',
    [switch]$Sign,
    [switch]$Store
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step([string]$text) { Write-Host "==> $text" }

# ---- store identity ------------------------------------------------------
# 商店提交时 Identity/@Name 与 @Publisher 必须与 Partner Center 里预留的名称逐字符一致，
# 差一个字符上传就会被拒。这里挡在打包前，避免出包后才发现。
if ($Store) {
    if ($IdentityName -eq 'top.johnnyblog.hcmcl' -or $Publisher -eq 'CN=HungerCat') {
        throw "Store packaging needs the Partner Center identity, not the sideload defaults. Pass -IdentityName / -Publisher / -PublisherDisplayName."
    }
    if (-not $Publisher.StartsWith('CN=')) {
        throw "Publisher must be a certificate subject starting with 'CN=' (got '$Publisher')."
    }
    if ($IdentityName -notmatch '^[A-Za-z0-9.\-]+$') {
        throw "IdentityName may only contain letters, digits, dots and hyphens (got '$IdentityName')."
    }
    if ([string]::IsNullOrWhiteSpace($PublisherDisplayName)) {
        throw 'PublisherDisplayName is required for Store packaging.'
    }
    # 商店包也要签名：商店发布时会用 Microsoft 证书覆盖，但没签名就没法本机
    # Add-AppxPackage 验收，也过不了 Partner Center 的包校验。
    $Sign = $true
}

# ---- version ----------------------------------------------------------------
# MSIX Identity/@Version is Major.Minor.Build.Revision, each 0-65535, numeric only.
if ($Version -match '-') {
    throw "MSIX version must be numeric (got '$Version'); build a release version instead of a -dev one."
}
$parts = @($Version.Split('.'))
while ($parts.Count -lt 3) { $parts += '0' }
$four = @([int]$parts[0], [int]$parts[1], [int]$parts[2], 0)
$msixVersion = ($four -join '.')
foreach ($n in $four) {
    if ($n -lt 0 -or $n -gt 65535) { throw "MSIX version segment out of range: $msixVersion" }
}

# ---- inputs -----------------------------------------------------------------
if (-not (Test-Path -LiteralPath $ExeDir)) { throw "ExeDir not found: $ExeDir" }
$exe = Join-Path $ExeDir 'hcmcl-tauri.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "launcher executable not found: $exe" }

$root = Split-Path -Parent $PSScriptRoot          # repo root
if ([string]::IsNullOrWhiteSpace($IconPng)) { $IconPng = Join-Path $root 'src-tauri/icons/icon.png' }
if (-not (Test-Path -LiteralPath $IconPng)) { throw "icon not found: $IconPng" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("hcmcl-msix-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null

try {
    # ---- stage files --------------------------------------------------------
    Write-Step "staging $Arch $msixVersion"
    Copy-Item -LiteralPath $exe -Destination (Join-Path $stage 'hcmcl-tauri.exe')
    # Same file set as the NSIS installer (see tauri.windows.conf.json bundle.resources).
    $easytierSrc = Join-Path $ExeDir 'easytier'
    if (Test-Path -LiteralPath $easytierSrc) {
        Copy-Item -LiteralPath $easytierSrc -Destination (Join-Path $stage 'easytier') -Recurse
    } else {
        Write-Warning "easytier/ not found next to the exe; the multiplayer tunnel will be unavailable"
    }

    # ---- assets -------------------------------------------------------------
    # StoreLogo 50, Square44, Square150, Square310, Wide310x150 - the sizes the
    # Store validation toolkit expects. Rendered from the 1024px master icon.
    Write-Step 'rendering assets'
    $assets = Join-Path $stage 'Assets'
    New-Item -ItemType Directory -Force -Path $assets | Out-Null
    Add-Type -AssemblyName System.Drawing
    $src = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $IconPng))
    try {
        function New-Asset([string]$name, [int]$w, [int]$h) {
            $bmp = New-Object System.Drawing.Bitmap $w, $h
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            try {
                $g.Clear([System.Drawing.Color]::Transparent)
                $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                # Contain: keep the master icon's aspect ratio, centred.
                $scale = [Math]::Min($w / $src.Width, $h / $src.Height)
                $dw = [int][Math]::Round($src.Width * $scale)
                $dh = [int][Math]::Round($src.Height * $scale)
                $dx = [int](($w - $dw) / 2)
                $dy = [int](($h - $dh) / 2)
                $g.DrawImage($src, $dx, $dy, $dw, $dh)
            } finally { $g.Dispose() }
            $target = Join-Path $assets $name
            $bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose()
        }
        New-Asset 'StoreLogo.png' 50 50
        New-Asset 'Square44x44Logo.png' 44 44
        New-Asset 'Square71x71Logo.png' 71 71
        New-Asset 'Square150x150Logo.png' 150 150
        New-Asset 'Square310x310Logo.png' 310 310
        New-Asset 'Wide310x150Logo.png' 310 150
    } finally { $src.Dispose() }

    # ---- manifest -----------------------------------------------------------
    # EntryPoint 与 uap10:* 两个标记同时保留，是刻意为之：
    #   EntryPoint="Windows.FullTrustApplication" —— Windows 10 1809~1903 只认这个；
    #   uap10:RuntimeBehavior="packagedClassicApp" + TrustLevel="mediumIL" —— 19041 起描述
    #   「打包的经典桌面应用 + 完全信任」；不写会被当成 appContainer，写注册表 / 起子进程会失败。
    # uap10 命名空间在旧系统上按 IgnorableNamespaces 被忽略，所以这样写两头都能装。
    Write-Step 'writing AppxManifest.xml'
    $escapedDisplay = [System.Security.SecurityElement]::Escape($DisplayName)
    $manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap10 rescap">
  <Identity Name="$IdentityName" Publisher="$([System.Security.SecurityElement]::Escape($Publisher))" Version="$msixVersion" ProcessorArchitecture="$Arch" />
  <Properties>
    <DisplayName>$escapedDisplay</DisplayName>
    <PublisherDisplayName>$([System.Security.SecurityElement]::Escape($PublisherDisplayName))</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>
  <Resources>
    <Resource Language="zh-CN" />
    <Resource Language="en-US" />
  </Resources>
  <Applications>
    <Application Id="App" Executable="hcmcl-tauri.exe" EntryPoint="Windows.FullTrustApplication"
                 uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
      <uap:VisualElements
        DisplayName="$escapedDisplay"
        Description="$escapedDisplay"
        BackgroundColor="#04060F"
        Square44x44Logo="Assets\Square44x44Logo.png"
        Square150x150Logo="Assets\Square150x150Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\Wide310x150Logo.png" Square310x310Logo="Assets\Square310x310Logo.png" ShortName="HCMCL" />
      </uap:VisualElements>
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
"@
    $manifestPath = Join-Path $stage 'AppxManifest.xml'
    # UTF-8 without BOM: makeappx rejects a BOM before the XML declaration.
    [System.IO.File]::WriteAllText($manifestPath, $manifest, (New-Object System.Text.UTF8Encoding($false)))

    # ---- pack ---------------------------------------------------------------
    $makeappx = Get-Command makeappx.exe -ErrorAction SilentlyContinue
    if (-not $makeappx) {
        $candidate = Get-ChildItem -Path (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin') -Filter makeappx.exe -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
        if (-not $candidate) { throw 'makeappx.exe not found (install the Windows SDK).' }
        $makeappx = $candidate.FullName
    } else { $makeappx = $makeappx.Source }

    $safeName = ($DisplayName -replace '[\\/:*?"<>|]', '_')
    $msix = Join-Path $OutDir ("{0}_{1}_{2}.msix" -f $safeName, $Version, $Arch)
    if (Test-Path -LiteralPath $msix) { Remove-Item -LiteralPath $msix -Force }

    Write-Step "makeappx pack -> $msix"
    & $makeappx pack /d $stage /p $msix /o
    if ($LASTEXITCODE -ne 0) { throw "makeappx failed with exit code $LASTEXITCODE" }

    # ---- sign (optional) ----------------------------------------------------
    if ($Sign) {
        Write-Step 'creating self-signed certificate'
        $cert = New-SelfSignedCertificate `
            -Type CodeSigningCert `
            -Subject $Publisher `
            -KeyUsage DigitalSignature `
            -CertStoreLocation 'Cert:\CurrentUser\My' `
            -NotAfter (Get-Date).AddYears(3)
        $signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
        if (-not $signtool) {
            $found = Get-ChildItem -Path (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin') -Filter signtool.exe -Recurse -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
            if (-not $found) { throw 'signtool.exe not found (install the Windows SDK).' }
            $signtool = $found.FullName
        } else { $signtool = $signtool.Source }

        Write-Step "signing (thumbprint $($cert.Thumbprint))"
        & $signtool sign /fd SHA256 /sha1 $cert.Thumbprint /s My $msix
        if ($LASTEXITCODE -ne 0) { throw "signtool failed with exit code $LASTEXITCODE" }

        $cer = [System.IO.Path]::ChangeExtension($msix, '.cer')
        Export-Certificate -Cert $cert -FilePath $cer -Type CERT | Out-Null
        Write-Step "public certificate -> $cer"
        if ($Store) {
            # 商店发布时会用 Microsoft 证书覆盖这份签名；.cer 只用于本机 Add-AppxPackage 验收。
            Write-Step 'store package ready: upload the .msixbundle built by package-msix-bundle.ps1'
        } else {
            Write-Warning 'The certificate is self-signed and per-run. Trust the .cer before sideloading; for Microsoft Store, replace Publisher with the Partner Center identity and let Microsoft sign.'
        }
    }

    Write-Step "done: $((Get-Item -LiteralPath $msix).Length) bytes"
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
