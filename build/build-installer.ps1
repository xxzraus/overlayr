param(
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
  $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

$makensis = $env:MAKENSIS
if (-not $makensis -or -not (Test-Path $makensis)) {
  $makensis = Join-Path $Root '.buildtools\nsis\makensis.exe'
}
if (-not (Test-Path $makensis)) {
  $command = Get-Command makensis -ErrorAction SilentlyContinue
  if (-not $command) {
    $candidates = @(
      "$env:ProgramFiles\NSIS\makensis.exe",
      "${env:ProgramFiles(x86)}\NSIS\makensis.exe"
    )
    $found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($found) { $makensis = $found }
  } else {
    $makensis = $command.Source
  }
}
if (-not $makensis -or -not (Test-Path $makensis)) {
  throw 'makensis not found. Install NSIS, set MAKENSIS, or put it under .buildtools\nsis\.'
}

$pkg = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
Write-Host "== Building Overlayr $($pkg.version) installer"

& $makensis (Join-Path $PSScriptRoot 'installer.nsi')
if ($LASTEXITCODE -ne 0) { throw "makensis failed with $LASTEXITCODE" }

$setup = Join-Path $Root "dist\Overlayr-Setup-$($pkg.version).exe"
Write-Host ("== Installer ready: {0} ({1:N1} MB)" -f $setup, ((Get-Item $setup).Length / 1MB))
