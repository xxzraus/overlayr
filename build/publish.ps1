param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$Owner = 'xxzraus',
  [string]$Repo = 'overlayr'
)

$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$git = Join-Path $Root '.buildtools\git\cmd\git.exe'
if (-not (Test-Path $git)) { $git = 'git' }

$pkg = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
$api = 'https://api.github.com'
$headers = @{
  Authorization          = "Bearer $Token"
  Accept                 = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent'           = 'Overlayr-Publisher'
}

function Invoke-GitHub($method, $uri, $body = $null) {
  $params = @{ Uri = "$api$uri"; Method = $method; Headers = $headers }
  if ($body) {
    $params.Body = ($body | ConvertTo-Json -Depth 10)
    $params.ContentType = 'application/json'
  }
  try {
    return Invoke-RestMethod @params
  } catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -eq 404) { return $null }
    throw
  }
}

Write-Host "== Checking $Owner/$Repo"
$repoInfo = Invoke-GitHub 'GET' "/repos/$Owner/$Repo"
if (-not $repoInfo) {
  Write-Host '== Creating repository'
  $repoInfo = Invoke-GitHub 'POST' '/user/repos' @{
    name        = $Repo
    description = 'Themes, a now-playing overlay and a live wallpaper for Windows.'
    homepage    = 'https://www.donationalerts.com/r/xxzraus_creator'
    private     = $false
    has_issues  = $true
    has_discussions = $true
  }
}

Write-Host '== Updating description, topics and homepage'
Invoke-GitHub 'PATCH' "/repos/$Owner/$Repo" @{
  description = 'Themes, a now-playing overlay and a live wallpaper for Windows.'
  homepage    = 'https://www.donationalerts.com/r/xxzraus_creator'
  topics      = @('windows', 'electron', 'themes', 'wallpaper', 'now-playing', 'overlay', 'music', 'customization', 'desktop', 'lyrics')
} | Out-Null

Write-Host '== Pushing main'
$remote = "https://$Owner`:$Token@github.com/$Owner/$Repo.git"
& $git -C $Root push $remote main:main --force
if ($LASTEXITCODE -ne 0) { throw 'git push failed' }

Write-Host '== Publishing release'
$tag = "v$version"
$existing = Invoke-GitHub 'GET' "/repos/$Owner/$Repo/releases/tags/$tag"
if (-not $existing) {
  $release = Invoke-GitHub 'POST' "/repos/$Owner/$Repo/releases" @{
    tag_name = $tag
    name     = "Overlayr $version"
    body     = "Themes, a now-playing overlay and a live wallpaper for Windows. See CHANGELOG.md for details."
    draft    = $false
    prerelease = $false
  }
} else {
  $release = $existing
}

$assets = @(
  (Join-Path $Root "dist\Overlayr-Setup-$version.exe"),
  (Join-Path $Root "dist\Overlayr-portable-$version.zip")
)
foreach ($asset in $assets) {
  if (-not (Test-Path $asset)) { Write-Host "!! missing $asset"; continue }
  $name = Split-Path $asset -Leaf
  Write-Host "== Uploading $name"
  $upload = "https://uploads.github.com/repos/$Owner/$Repo/releases/$($release.id)/assets?name=$([uri]::EscapeDataString($name))"
  Invoke-RestMethod -Uri $upload -Method Post -Headers $headers -ContentType 'application/octet-stream' -InFile $asset | Out-Null
}

Write-Host ''
Write-Host "Done: https://github.com/$Owner/$Repo"
