$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'src/PclFrontend/upstream/Plain Craft Launcher 2/Plain Craft Launcher 2.vbproj'
$outDir = Join-Path $PSScriptRoot 'src/artifacts/win-x64'
$exe = Join-Path $outDir 'PCCL2.Native.exe'
$msbuild = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe'
$referenceRoot = (Join-Path $PSScriptRoot 'tools/build').TrimEnd('\')
if (-not (Test-Path $msbuild)) { throw 'Visual Studio 2022 Build Tools with VB/WPF and .NET Framework 4.8 is required' }
$responseFile = Join-Path $outDir 'build.rsp'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
@("`"$project`"", '/p:Configuration=Release', '/p:Platform=AnyCPU', '/p:BuildProjectReferences=false', "/p:TargetFrameworkRootPath=`"$referenceRoot`"", '/v:minimal') | Set-Content -LiteralPath $responseFile -Encoding ascii
& $msbuild "@$responseFile"
if ($LASTEXITCODE -ne 0) { throw "Native frontend build failed: $LASTEXITCODE" }
$source = Join-Path $PSScriptRoot 'src/PclFrontend/upstream/Plain Craft Launcher 2/bin/Plain Craft Launcher 2.exe'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Copy-Item -LiteralPath $source -Destination $exe -Force
Write-Host "Full PCL-HCMCL frontend output: $exe"
