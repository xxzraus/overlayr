param(
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Root) {
  $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path $csc)) {
  throw '.NET Framework 4.x compiler (csc.exe) not found.'
}

foreach ($name in @('AuroraAudio', 'AuroraSpectrum', 'AuroraDisplay')) {
  $source = Join-Path $Root "tools\$name.cs"
  $output = Join-Path $Root "tools\$name.exe"
  Write-Host "== Compiling $name"
  & $csc /nologo /target:exe /platform:anycpu /optimize+ "/out:$output" $source
  if ($LASTEXITCODE -ne 0) { throw "Compilation of $name failed." }
}

Write-Host '== Native helpers rebuilt'
