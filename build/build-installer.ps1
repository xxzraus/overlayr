param(
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
  $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

$makensis = Join-Path $Root '.buildtools\nsis\makensis.exe'
if (-not (Test-Path $makensis)) {
  $command = Get-Command makensis -ErrorAction SilentlyContinue
  if (-not $command) {
    throw 'makensis not found. Install NSIS or put it under .buildtools\nsis\.'
  }
  $makensis = $command.Source
}

$pkg = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
Write-Host "== Building Overlayr $($pkg.version) installer"

& $makensis (Join-Path $PSScriptRoot 'installer.nsi')
if ($LASTEXITCODE -ne 0) { throw "makensis failed with $LASTEXITCODE" }

$setup = Join-Path $Root "dist\Overlayr-Setup-$($pkg.version).exe"
Write-Host ("== Installer ready: {0} ({1:N1} MB)" -f $setup, ((Get-Item $setup).Length / 1MB))
