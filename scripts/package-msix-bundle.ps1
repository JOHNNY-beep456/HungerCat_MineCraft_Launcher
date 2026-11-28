#Requires -Version 5.1
<#
.SYNOPSIS
    Bundle per-architecture MSIX packages into a Store upload (.msixbundle / .msixupload).

.DESCRIPTION
    Partner Center accepts loose .msix (one per architecture), .msixbundle and
    .msixupload. A bundle is the better default: one submission serves x64 / x86 / arm64
    and the Store picks the matching package per device.

    .msixupload is nothing but a ZIP that contains the bundle (and optionally the public
    symbols .appxsym) with the extension renamed. Partner Center accepts it as-is, and it
    is what Visual Studio produces.

    The script refuses to build a bundle whose members disagree on Identity Name,
    Publisher or Version (makeappx would fail later with a much less obvious message),
    and unpacks the result once to prove the bundle parses.

.PARAMETER PackagesDir
    Directory holding the per-arch .msix files. Extra files are ignored.

.PARAMETER OutDir
    Where the .msixbundle (and .msixupload) land.

.PARAMETER Name
    File name stem. Defaults to "HungerCat MineCraft Launcher_<version>".

.PARAMETER SymbolsDir
    Optional directory with .appxsym files to embed in the .msixupload (crash analytics).

.PARAMETER NoVerify
    Skip the unbundle round-trip used to prove the bundle parses.

.EXAMPLE
    ./scripts/package-msix-bundle.ps1 -PackagesDir dist-msix-store -OutDir dist-store -Version 0.8.3
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackagesDir,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Name = '',
    [string]$SymbolsDir = '',
    [switch]$NoVerify
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step([string]$text) { Write-Host "==> $text" }

Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression

if (-not (Test-Path -LiteralPath $PackagesDir)) { throw "PackagesDir not found: $PackagesDir" }
$packages = @(Get-ChildItem -LiteralPath $PackagesDir -Filter *.msix -File)
if ($packages.Count -lt 1) { throw "no .msix found in $PackagesDir" }

# ---- validate members -------------------------------------------------------
# makeappx bundle 的报错只说「包不匹配」，不说是哪一项；先在脚本里点名。
Write-Step "inspecting $($packages.Count) package(s)"
$identities = @()
foreach ($pkg in $packages) {
    $zip = [System.IO.Compression.ZipFile]::OpenRead($pkg.FullName)
    try {
        $entry = $zip.Entries | Where-Object { $_.FullName -eq 'AppxManifest.xml' } | Select-Object -First 1
        if (-not $entry) { throw "$($pkg.Name): AppxManifest.xml missing" }
        $reader = New-Object System.IO.StreamReader($entry.Open())
        try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $zip.Dispose() }
    $doc = [xml]$text
    $id = $doc.Package.Identity
    if (-not $id) { throw "$($pkg.Name): Package/Identity missing" }
    $identities += [pscustomobject]@{
        File      = $pkg.Name
        Name      = [string]$id.Name
        Publisher = [string]$id.Publisher
        Version   = [string]$id.Version
        Arch      = [string]$id.ProcessorArchitecture
    }
}

$identities | Format-Table -AutoSize | Out-String | Write-Host

# @() 包裹是必要的：只有一个分组时 Group-Object 返回单个 GroupInfo，而 GroupInfo 自己也有
# .Count（组内元素数），直接取 .Count 会得到 3 而不是 1，于是「三项一致」反而被判成不一致。
$distinct = @($identities | Group-Object Name, Publisher, Version)
if ($distinct.Count -ne 1) {
    $detail = $identities | ForEach-Object { "$($_.File): $($_.Name) / $($_.Publisher) / $($_.Version)" }
    throw "bundle members disagree on Identity Name / Publisher / Version; Partner Center would reject this set.`n$($detail -join "`n")"
}
$archs = @($identities | Select-Object -ExpandProperty Arch)
if (($archs | Select-Object -Unique).Count -ne $archs.Count) {
    throw "duplicate architecture in bundle: $($archs -join ', ')"
}

$bundleVersion = $identities[0].Version
$expected = @($Version.Split('.'))
while ($expected.Count -lt 3) { $expected += '0' }
$expectedVersion = (@($expected[0], $expected[1], $expected[2], '0') -join '.')
if ($bundleVersion -ne $expectedVersion) {
    throw "package version $bundleVersion does not match requested $expectedVersion (rebuild the msix files first)."
}
if ($identities[0].Publisher -eq 'CN=HungerCat') {
    Write-Warning 'Publisher is still the sideload default CN=HungerCat; the Store will reject this upload.'
}

# ---- pack -------------------------------------------------------------------
$makeappx = Get-Command makeappx.exe -ErrorAction SilentlyContinue
if (-not $makeappx) {
    $candidate = Get-ChildItem -Path (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin') -Filter makeappx.exe -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $candidate) { throw 'makeappx.exe not found (install the Windows SDK).' }
    $makeappx = $candidate.FullName
} else { $makeappx = $makeappx.Source }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if ([string]::IsNullOrWhiteSpace($Name)) { $Name = "HungerCat MineCraft Launcher_$Version" }
$safeName = ($Name -replace '[\\/:*?"<>|]', '_')

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("hcmcl-bundle-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $staging | Out-Null
try {
    # makeappx bundle 只打包目录里的 .msix，先集中到一处，避免把无关文件带进去。
    foreach ($pkg in $packages) { Copy-Item -LiteralPath $pkg.FullName -Destination $staging }

    $bundle = Join-Path $OutDir "$safeName.msixbundle"
    if (Test-Path -LiteralPath $bundle) { Remove-Item -LiteralPath $bundle -Force }

    Write-Step "makeappx bundle -> $bundle"
    & $makeappx bundle /d $staging /p $bundle /o
    if ($LASTEXITCODE -ne 0) { throw "makeappx bundle failed with exit code $LASTEXITCODE" }

    # ---- verify -------------------------------------------------------------
    if (-not $NoVerify) {
        Write-Step 'unbinding the bundle once to prove it parses'
        $check = Join-Path ([System.IO.Path]::GetTempPath()) ("hcmcl-bundlecheck-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $check | Out-Null
        try {
            # bundle 用 unbundle，不是 unpack：unpack 只认单个包，会报 0x80080203
            #「missing a required footprint file」。
            & $makeappx unbundle /p $bundle /d $check /o | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "bundle produced by makeappx cannot be unbound (exit $LASTEXITCODE)" }
            $inside = @(Get-ChildItem -LiteralPath $check -Filter *.msix -File -Recurse)
            if ($inside.Count -ne $packages.Count) {
                throw "bundle contains $($inside.Count) package(s), expected $($packages.Count)"
            }
        } finally {
            Remove-Item -LiteralPath $check -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    # ---- .msixupload --------------------------------------------------------
    # Partner Center 接受 .msixbundle 本身；.msixupload 只是把 bundle（可带符号）打成 zip。
    # 两种都给出来：带符号的那个更适合长期发布，出错时商店侧能做崩溃分析。
    $upload = Join-Path $OutDir "$safeName.msixupload"
    if (Test-Path -LiteralPath $upload) { Remove-Item -LiteralPath $upload -Force }
    $uploadStage = Join-Path $staging '_upload'
    New-Item -ItemType Directory -Force -Path $uploadStage | Out-Null
    Copy-Item -LiteralPath $bundle -Destination $uploadStage
    if (-not [string]::IsNullOrWhiteSpace($SymbolsDir) -and (Test-Path -LiteralPath $SymbolsDir)) {
        Get-ChildItem -LiteralPath $SymbolsDir -Filter *.appxsym -File | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $uploadStage
        }
    }
    Write-Step "zipping -> $upload"
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $uploadStage, $upload, [System.IO.Compression.CompressionLevel]::Optimal, $false)

    Write-Step ("bundle: {0} bytes ({1} arch: {2})" -f (Get-Item -LiteralPath $bundle).Length, $archs.Count, ($archs -join ', '))
    Write-Step ("upload: {0} bytes" -f (Get-Item -LiteralPath $upload).Length)
} finally {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
}
