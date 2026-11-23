param(
  [string]$Root = '',
  [string]$OutDir = '',
  [string]$RcEdit = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
  $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}
if (-not $OutDir) {
  $OutDir = Join-Path $Root 'dist'
}
if (-not $RcEdit) {
  $RcEdit = Join-Path $Root '.buildtools\rcedit.exe'
}

$pkg = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
$appDir = Join-Path $OutDir 'Overlayr-win32-x64'
$electronDist = Join-Path $Root 'node_modules\electron\dist'

if (-not (Test-Path $electronDist)) {
  throw "Electron runtime not found at $electronDist — run 'npm install' first."
}

Write-Host "== Cleaning $appDir"
if (Test-Path $appDir) { Remove-Item $appDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host '== Copying Electron runtime'
Copy-Item $electronDist $appDir -Recurse -Force

$exe = Join-Path $appDir 'Overlayr.exe'
if (Test-Path (Join-Path $appDir 'electron.exe')) {
  Rename-Item (Join-Path $appDir 'electron.exe') 'Overlayr.exe'
}
$stale = Join-Path $appDir 'resources\default_app.asar'
if (Test-Path $stale) { Remove-Item $stale -Force }

Write-Host '== Copying application sources'
$appRes = Join-Path $appDir 'resources\app'
New-Item -ItemType Directory -Force -Path $appRes | Out-Null

foreach ($item in @('src', 'scripts', 'tools', 'assets', 'README.md', 'ROADMAP.md', 'LICENSE')) {
  $from = Join-Path $Root $item
  if (Test-Path $from) { Copy-Item $from $appRes -Recurse -Force }
}
# Developer-only helpers are not shipped.
Get-ChildItem (Join-Path $appRes 'tools') -Filter '*.ps1' -ErrorAction SilentlyContinue | Remove-Item -Force
Copy-Item (Join-Path $Root 'package.json') (Join-Path $appRes 'package.json') -Force

if (Test-Path $RcEdit) {
  Write-Host '== Stamping version info and icon'
  $icon = Join-Path $Root 'assets\icon.ico'
  & $RcEdit $exe `
    --set-icon $icon `
    --set-version-string 'FileDescription' 'Overlayr - themes, music and quick launch' `
    --set-version-string 'ProductName' 'Overlayr' `
    --set-version-string 'CompanyName' 'Overlayr' `
    --set-version-string 'LegalCopyright' 'Overlayr' `
    --set-version-string 'OriginalFilename' 'Overlayr.exe' `
    --set-file-version "$version.0" `
    --set-product-version "$version.0"
  if ($LASTEXITCODE -ne 0) { throw "rcedit failed with $LASTEXITCODE" }
} else {
  Write-Host '== rcedit not found, skipping icon/version stamping'
}

$size = (Get-ChildItem $appDir -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("== Portable build ready: {0} ({1:N0} MB)" -f $appDir, ($size / 1MB))

$zip = Join-Path $OutDir "Overlayr-portable-$version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Write-Host '== Creating portable zip'
Compress-Archive -Path (Join-Path $appDir '*') -DestinationPath $zip -CompressionLevel Optimal
Write-Host ("== Zip: {0:N0} MB" -f ((Get-Item $zip).Length / 1MB))
