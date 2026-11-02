$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$exe = Join-Path $PSScriptRoot 'src/artifacts/win-x64/PCCL2.Native.exe'
$assembly = [Reflection.Assembly]::LoadFile($exe)
$resourceName = $assembly.GetManifestResourceNames() | Where-Object { $_.EndsWith('.g.resources') } | Select-Object -First 1
$reader = New-Object System.Resources.ResourceReader($assembly.GetManifestResourceStream($resourceName))
$found = $false
foreach ($entry in $reader) {
    if ($entry.Key -eq 'images/hcmcl-splash.png') {
        $image = [Drawing.Image]::FromStream($entry.Value)
        Write-Host ('Embedded splash: {0}x{1}' -f $image.Width, $image.Height)
        if ($image.Width -ne 102 -or $image.Height -ne 102) { throw 'Wrong splash dimensions' }
        $image.Dispose()
        $found = $true
    }
}
$reader.Close()
if (-not $found) { throw 'HCMCL splash is not embedded' }
