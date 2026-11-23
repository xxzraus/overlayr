#requires -Version 5.1
<#
    Aurora - installed applications scanner.

    The only thing written to stdout is one JSON object.  Diagnostics are
    written to stderr so Electron can safely parse stdout with JSON.parse().
#>
[CmdletBinding()]
param(
    [string]$IconDir = (Join-Path $env:LOCALAPPDATA 'Aurora\icons'),
    [int]$MaxIcons = 400
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'

# UTF-8 without BOM for both the console and the raw stdout write at the end.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$script:Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$script:DrawingReady = $false
$script:IconDirReady = $false
$script:ResolvedIconDir = $null
$script:WshShell = $null
$script:AppxPackageMap = $null
$script:AssetDirCache = @{}
$script:ManifestCache = @{}
$script:JunkNameRegex = "(?i)(uninstall|деинсталл|удалить|удаление|read\s*me|документац|documentation|справк|help|website|web\s*site|release\s*notes|what'?s\s*new|changelog|change\s*log|licen[cs]e|лиценз|manual(?:s)?|руководств|quick\s*start|faq|home\s*page|visit\s+|online\s+documentation|pydoc|error\s*report|updat(?:e|er|ing)|обновлен|administrative\s+tools|административн)"

function Write-Diag {
    param([string]$Message)
    try {
        [Console]::Error.WriteLine('[scan-apps] ' + $Message)
    } catch { }
}

function Write-Timing {
    param([string]$Label)
    if ($env:AURORA_SCAN_DEBUG -ne '1') { return }
    Write-Diag ('timing ' + $Label + '=' + $script:Stopwatch.ElapsedMilliseconds + 'ms')
}

function Get-NormalizedName {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return '' }
    $n = $Name.Trim()
    try { $n = $n.Normalize([System.Text.NormalizationForm]::FormKC) } catch { }
    $n = $n -replace '[\u200B-\u200D\uFEFF]', ''
    $n = ($n -replace '\s+', '').ToLowerInvariant()
    return $n
}

function Test-JunkName {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return $true }
    $n = $Name.Trim()
    if ($n.Length -lt 2) { return $true }
    if ($n -match $script:JunkNameRegex) { return $true }
    if ($n -match '^\s*(about|check\s+for\s+updates?|install\b|установить\b|setup\b|unload\b)') { return $true }
    return $false
}

function Test-UninstallerTarget {
    param([string]$Target)
    if ([string]::IsNullOrWhiteSpace($Target)) { return $false }
    try {
        $leaf = [System.IO.Path]::GetFileNameWithoutExtension($Target)
        return ($leaf -match '(?i)^(unins\d*|uninstall(?:er)?|unwise(?:32|64)?|setup(?:32|64)?)$')
    } catch {
        return $false
    }
}

# ---------------------------------------------------------------------------
# Path / shortcut helpers
# ---------------------------------------------------------------------------

$script:KnownFolders = @{}
if ($env:SystemRoot) {
    $sys32 = Join-Path $env:SystemRoot 'System32'
    $syswow = Join-Path $env:SystemRoot 'SysWOW64'
    $script:KnownFolders['{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}'] = $sys32
    $script:KnownFolders['{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}'] = $syswow
    $script:KnownFolders['{F38BF404-1D43-42F2-9305-67DE0B28FC23}'] = $env:SystemRoot
}
$pf64 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
$pf86 = ${env:ProgramFiles(x86)}
if ([string]::IsNullOrWhiteSpace($pf86)) { $pf86 = $pf64 }
if (-not [string]::IsNullOrWhiteSpace($pf64)) {
    $script:KnownFolders['{6D809377-6AF0-444B-8957-A3773F02200E}'] = $pf64
    $script:KnownFolders['{905E63B6-C1BF-494E-B29C-65B732D3D21A}'] = $pf64
}
if (-not [string]::IsNullOrWhiteSpace($pf86)) {
    $script:KnownFolders['{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}'] = $pf86
}
$desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)
if (-not [string]::IsNullOrWhiteSpace($desktop)) {
    $script:KnownFolders['{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}'] = $desktop
}
$profileDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
if (-not [string]::IsNullOrWhiteSpace($profileDir)) {
    $script:KnownFolders['{5E6C858F-0E22-4760-9AFE-EA3317B67173}'] = $profileDir
}
$localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if (-not [string]::IsNullOrWhiteSpace($localAppData)) {
    $script:KnownFolders['{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}'] = $localAppData
}
$roamingAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
if (-not [string]::IsNullOrWhiteSpace($roamingAppData)) {
    $script:KnownFolders['{3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}'] = $roamingAppData
    $script:KnownFolders['{A77F5D77-2E2B-44C3-A6A2-ABA601054A51}'] = (Join-Path $roamingAppData 'Microsoft\Windows\Start Menu\Programs')
}
$commonProgramData = $env:ProgramData
if (-not [string]::IsNullOrWhiteSpace($commonProgramData)) {
    $script:KnownFolders['{0139D44E-6AFE-49F2-8690-3DAFCAE6FFB8}'] = (Join-Path $commonProgramData 'Microsoft\Windows\Start Menu\Programs')
    $script:KnownFolders['{A4115719-D62E-491D-AA7C-E74B8BE3B067}'] = (Join-Path $commonProgramData 'Microsoft\Windows\Start Menu')
}
$publicDir = $env:PUBLIC
if (-not [string]::IsNullOrWhiteSpace($publicDir)) {
    $script:KnownFolders['{DFDF76A2-C82A-4D63-906A-5644AC457385}'] = $publicDir
}

function Expand-FolderGuidPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    $p = $Path.Trim()
    if ($p.Length -ge 2 -and $p[0] -eq '"' -and $p[$p.Length - 1] -eq '"') {
        $p = $p.Substring(1, $p.Length - 2)
    }
    try { $p = [Environment]::ExpandEnvironmentVariables($p) } catch { }
    if ($p -match '^\{([0-9A-Fa-f-]{36})\}(?:\\(.*))?$') {
        $key = '{' + $Matches[1].ToUpperInvariant() + '}'
        if ($script:KnownFolders.ContainsKey($key)) {
            $rest = $Matches[2]
            $p = if ([string]::IsNullOrWhiteSpace($rest)) {
                $script:KnownFolders[$key]
            } else {
                Join-Path $script:KnownFolders[$key] $rest
            }
        }
    }
    return $p
}

function Resolve-ExeTarget {
    param([string]$Target)
    if ([string]::IsNullOrWhiteSpace($Target)) { return $null }
    $t = $Target.Trim()
    if ($t.Length -ge 2 -and $t[0] -eq '"' -and $t[$t.Length - 1] -eq '"') {
        $t = $t.Substring(1, $t.Length - 2)
    }
    if ([System.IO.Path]::GetExtension($t) -ine '.exe') { return $null }
    try {
        $t = [System.IO.Path]::GetFullPath($t)
        if (-not (Test-Path -LiteralPath $t -PathType Leaf)) { return $null }
    } catch {
        return $null
    }
    return $t
}

function Resolve-ShortcutInfo {
    param(
        [string]$ShortcutPath,
        $Shell
    )
    if ($null -eq $Shell -or [string]::IsNullOrWhiteSpace($ShortcutPath)) { return $null }
    $shortcut = $null
    try {
        $shortcut = $Shell.CreateShortcut($ShortcutPath)
        if ($null -eq $shortcut) { return $null }
        $target = [string]$shortcut.TargetPath
        $arguments = [string]$shortcut.Arguments
        return [pscustomobject]@{
            TargetPath = $target
            Arguments  = $arguments
        }
    } catch {
        return $null
    } finally {
        if ($null -ne $shortcut) {
            try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) } catch { }
        }
    }
}

# ---------------------------------------------------------------------------
# Candidate collection
# ---------------------------------------------------------------------------

function New-AppCandidate {
    param(
        [string]$Name,
        [string]$Id,
        [string]$Kind,
        [string]$Target,
        [string]$Arguments,
        [string]$Source,
        [int]$SourceRank
    )
    $cleanName = $Name.Trim()
    return [pscustomobject]@{
        Id             = $Id
        Name           = $cleanName
        Icon           = $null
        Kind           = $Kind
        Target         = $Target
        Args           = [string]$Arguments
        Source         = $Source
        SourceRank     = $SourceRank
        NormalizedName = (Get-NormalizedName $cleanName)
    }
}

function Get-Win32Id {
    param([string]$Target, [string]$Arguments)
    $key = $Target.ToLowerInvariant()
    if (-not [string]::IsNullOrEmpty($Arguments)) {
        $key = $key + '|' + $Arguments.ToLowerInvariant()
    }
    return 'win32:' + $key
}

function Add-StartAppsCandidates {
    param(
        $Candidates,
        $Shell
    )
    $startApps = @()
    try {
        $startApps = @(Get-StartApps -ErrorAction Stop)
    } catch {
        Write-Diag ('Get-StartApps failed: ' + $_.Exception.Message)
        return
    }

    foreach ($sa in $startApps) {
        try {
            $name = [string]$sa.Name
            if (Test-JunkName $name) { continue }
            $appId = [string]$sa.AppID
            if ([string]::IsNullOrWhiteSpace($appId)) { continue }
            $appId = $appId.Trim()

            # AUMID: package-family!application-id.  Never classify a filesystem
            # path (which can theoretically contain "!") as UWP.
            $hasBang = $appId.IndexOf('!') -gt 0
            $looksLikePath = ($appId -match '[\\/]') -or ($appId -match '^[A-Za-z]:')
            if ($hasBang -and -not $looksLikePath) {
                $candidate = New-AppCandidate -Name $name -Id ('uwp:' + $appId.ToLowerInvariant()) `
                    -Kind 'uwp' -Target $appId -Arguments '' -Source 'get-startapps' -SourceRank 0
                [void]$Candidates.Add($candidate)
                continue
            }

            if ($appId -match '^[A-Za-z][A-Za-z0-9+.-]*://') { continue }
            if ($appId -match '^(shell|ms-[A-Za-z0-9-]+):') { continue }

            $expanded = Expand-FolderGuidPath $appId
            if ([string]::IsNullOrWhiteSpace($expanded)) { continue }

            $target = $null
            $launchArgs = ''
            if ([System.IO.Path]::GetExtension($expanded) -ieq '.lnk') {
                $info = Resolve-ShortcutInfo -ShortcutPath $expanded -Shell $Shell
                if ($null -eq $info) { continue }
                $target = Resolve-ExeTarget ($info.TargetPath)
                $launchArgs = [string]$info.Arguments
            } else {
                $target = Resolve-ExeTarget $expanded
            }
            if ($null -eq $target) { continue }
            if (Test-UninstallerTarget $target) { continue }

            $candidate = New-AppCandidate -Name $name -Id (Get-Win32Id $target $launchArgs) `
                -Kind 'win32' -Target $target -Arguments $launchArgs -Source 'get-startapps' -SourceRank 0
            [void]$Candidates.Add($candidate)
        } catch {
            # One broken StartApps row must not abort the scan.
        }
    }
}

function Add-ShortcutCandidates {
    param(
        $Candidates,
        $Shell
    )
    if ($null -eq $Shell) {
        Write-Diag 'WScript.Shell is unavailable; skipping Start Menu shortcuts.'
        return
    }

    $roots = @(
        (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
        (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
    ) | Select-Object -Unique

    foreach ($root in $roots) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        try {
            if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
            $shortcuts = @(Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse -File -ErrorAction SilentlyContinue)
        } catch {
            continue
        }

        foreach ($file in $shortcuts) {
            try {
                $name = $file.BaseName
                if (Test-JunkName $name) { continue }
                $info = Resolve-ShortcutInfo -ShortcutPath $file.FullName -Shell $Shell
                if ($null -eq $info) { continue }
                $target = Resolve-ExeTarget ($info.TargetPath)
                if ($null -eq $target) { continue }
                if (Test-UninstallerTarget $target) { continue }
                $launchArgs = [string]$info.Arguments
                $candidate = New-AppCandidate -Name $name -Id (Get-Win32Id $target $launchArgs) `
                    -Kind 'win32' -Target $target -Arguments $launchArgs -Source 'start-menu' -SourceRank 1
                [void]$Candidates.Add($candidate)
            } catch {
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Image / icon helpers
# ---------------------------------------------------------------------------

function Get-StableHash {
    param([string]$Value)
    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    try {
        $bytes = $sha1.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Value))
        return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha1.Dispose()
    }
}

function Test-IconFile {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
        return ((Get-Item -LiteralPath $Path).Length -gt 0)
    } catch {
        return $false
    }
}

function Get-IconCachePath {
    param([string]$Id)
    return (Join-Path $script:ResolvedIconDir ((Get-StableHash $Id) + '.png'))
}

function Save-SquarePng64 {
    param(
        $Image,
        [string]$OutPath
    )
    if ($null -eq $Image) { return $false }
    if ([string]::IsNullOrWhiteSpace($OutPath)) { return $false }

    $bitmap = $null
    $graphics = $null
    $tempPath = $null
    try {
        $bitmap = [System.Drawing.Bitmap]::new(64, 64, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

        $srcW = [int]$Image.Width
        $srcH = [int]$Image.Height
        if ($srcW -le 0 -or $srcH -le 0) { return $false }

        $scale = [Math]::Min(64.0 / $srcW, 64.0 / $srcH)
        $dstW = [int][Math]::Max(1, [Math]::Round($srcW * $scale))
        $dstH = [int][Math]::Max(1, [Math]::Round($srcH * $scale))
        $dstX = [int][Math]::Floor((64 - $dstW) / 2)
        $dstY = [int][Math]::Floor((64 - $dstH) / 2)

        $graphics.DrawImage($Image, $dstX, $dstY, $dstW, $dstH)
        $graphics.Dispose()
        $graphics = $null

        $tempPath = Join-Path $script:ResolvedIconDir ('.tmp-' + [Guid]::NewGuid().ToString('N') + '.png')
        $bitmap.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)
        Move-Item -LiteralPath $tempPath -Destination $OutPath -Force
        $tempPath = $null
        return (Test-IconFile $OutPath)
    } catch {
        return $false
    } finally {
        if ($null -ne $graphics) { try { $graphics.Dispose() } catch { } }
        if ($null -ne $bitmap) { try { $bitmap.Dispose() } catch { } }
        if ($null -ne $tempPath) {
            try { if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force } } catch { }
        }
    }
}

function Get-AssetDirectoryFiles {
    param([string]$Directory)
    if ($script:AssetDirCache.ContainsKey($Directory)) {
        return $script:AssetDirCache[$Directory]
    }
    $files = @()
    try {
        $files = @(Get-ChildItem -LiteralPath $Directory -File -ErrorAction SilentlyContinue)
    } catch { }
    $script:AssetDirCache[$Directory] = $files
    return $files
}

function Get-UwpAssetScore {
    param(
        [string]$FileName,
        [string]$BaseName,
        [int]$BaseSize
    )
    $suffix = ''
    if ($FileName.Length -gt $BaseName.Length) {
        $suffix = $FileName.Substring($BaseName.Length)
    }

    $size = $null
    if ($suffix -match '(?i)targetsize-(\d+)') {
        $size = [int]$Matches[1]
    } elseif ($suffix -match '(?i)scale-(\d+)') {
        $size = [int][Math]::Round($BaseSize * ([int]$Matches[1]) / 100.0)
    } else {
        $size = $BaseSize
    }

    $score = [double][Math]::Abs($size - 64)
    # Slight preference for downscaling a larger source over upscaling a tiny one.
    if ($size -gt 72) { $score += ($size - 72) * 0.1 }
    if ($size -lt 32) { $score += 4.0 }
    return $score
}

function Find-BestUwpAsset {
    param(
        [string]$InstallLocation,
        [string]$RelativePath,
        [int]$BaseSize
    )
    try {
        $rel = $RelativePath -replace '/', '\'
        $rel = $rel.TrimStart('\')
        $full = if ([System.IO.Path]::IsPathRooted($rel)) { $rel } else { Join-Path $InstallLocation $rel }
        $full = [System.IO.Path]::GetFullPath($full)
        $dir = [System.IO.Path]::GetDirectoryName($full)
        $leaf = [System.IO.Path]::GetFileName($full)
        if ([string]::IsNullOrWhiteSpace($dir) -or [string]::IsNullOrWhiteSpace($leaf)) { return $null }
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return $null }

        $ext = [System.IO.Path]::GetExtension($leaf)
        if ([string]::IsNullOrWhiteSpace($ext)) { $ext = '.png' }
        $baseName = [System.IO.Path]::GetFileNameWithoutExtension($leaf)
        if ([string]::IsNullOrWhiteSpace($baseName)) { return $null }

        $files = Get-AssetDirectoryFiles $dir
        $best = $null
        $bestScore = [double]::MaxValue

        foreach ($file in $files) {
            try {
                $candidateName = $file.Name
                $sameExact = $candidateName.Equals($leaf, [System.StringComparison]::OrdinalIgnoreCase)
                $sameBase = $candidateName.StartsWith($baseName + '.', [System.StringComparison]::OrdinalIgnoreCase)
                if (-not ($sameExact -or $sameBase)) { continue }
                if ([System.IO.Path]::GetExtension($candidateName) -ine $ext) { continue }
                if ($candidateName -match '(?i)contrast|\.lang-') { continue }
                if ($file.Length -le 0) { continue }

                $score = Get-UwpAssetScore -FileName ([System.IO.Path]::GetFileNameWithoutExtension($candidateName)) `
                    -BaseName $baseName -BaseSize $BaseSize

                # Transparent "unplated" assets are the best choice for a dark UI.
                if ($candidateName -match '(?i)_altform-unplated(?:_|\.|$)') { $score -= 0.60 }
                elseif ($candidateName -match '(?i)_altform-lightunplated(?:_|\.|$)') { $score -= 0.10 }
                if ([System.IO.Path]::GetFileNameWithoutExtension($candidateName) -ieq $baseName) { $score -= 0.25 }

                if ($score -lt $bestScore) {
                    $bestScore = $score
                    $best = $file
                }
            } catch { }
        }

        if ($null -ne $best) { return $best.FullName }
        return $null
    } catch {
        return $null
    }
}

function Initialize-AppxPackageMap {
    if ($null -ne $script:AppxPackageMap) { return }
    $map = @{}
    try {
        $packages = @(Get-AppxPackage -ErrorAction SilentlyContinue)
        foreach ($pkg in $packages) {
            try {
                if ($pkg.IsFramework -or $pkg.IsResourcePackage -or $pkg.IsBundle) { continue }
                $family = [string]$pkg.PackageFamilyName
                if ([string]::IsNullOrWhiteSpace($family)) { continue }
                $key = $family.ToLowerInvariant()
                if (-not $map.ContainsKey($key)) {
                    $map[$key] = $pkg
                }
            } catch { }
        }
    } catch { }
    $script:AppxPackageMap = $map
    Write-Timing ('appx-map=' + $map.Count)
}

function Get-ManifestDocument {
    param([string]$ManifestPath)
    if ($script:ManifestCache.ContainsKey($ManifestPath)) {
        return $script:ManifestCache[$ManifestPath]
    }
    $doc = $null
    try {
        $xmlText = [System.IO.File]::ReadAllText($ManifestPath)
        [xml]$doc = $xmlText
    } catch {
        $doc = $null
    }
    $script:ManifestCache[$ManifestPath] = $doc
    return $doc
}

function Get-UwpIconAsset {
    param([string]$Aumid)
    if ([string]::IsNullOrWhiteSpace($Aumid)) { return $null }
    if ($Aumid.IndexOf('!') -le 0) { return $null }

    $parts = $Aumid.Split('!', 2)
    $family = $parts[0].ToLowerInvariant()
    $applicationId = $parts[1]

    Initialize-AppxPackageMap
    if ($null -eq $script:AppxPackageMap -or -not $script:AppxPackageMap.ContainsKey($family)) { return $null }
    $pkg = $script:AppxPackageMap[$family]
    if ($null -eq $pkg) { return $null }

    $install = [string]$pkg.InstallLocation
    if ([string]::IsNullOrWhiteSpace($install)) { return $null }
    $manifestPath = Join-Path $install 'AppxManifest.xml'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $null }

    $doc = Get-ManifestDocument $manifestPath
    if ($null -eq $doc) { return $null }

    $applicationNodes = @()
    try {
        $applicationNodes = @($doc.SelectNodes("/*[local-name()='Package']/*[local-name()='Applications']/*[local-name()='Application']"))
    } catch {
        return $null
    }
    if ($applicationNodes.Count -eq 0) { return $null }

    $applicationNode = $null
    foreach ($node in $applicationNodes) {
        if ($node.GetAttribute('Id') -ieq $applicationId) {
            $applicationNode = $node
            break
        }
    }
    if ($null -eq $applicationNode) { $applicationNode = $applicationNodes[0] }

    $visual = $null
    try {
        $visual = $applicationNode.SelectSingleNode("./*[local-name()='VisualElements']")
    } catch { }
    if ($null -eq $visual) { return $null }

    $logoSources = @(
        @{ Attribute = 'Square44x44Logo'; Size = 44 },
        @{ Attribute = 'Square150x150Logo'; Size = 150 },
        @{ Attribute = 'Logo'; Size = 50 }
    )

    foreach ($logoSource in $logoSources) {
        try {
            $relative = [string]$visual.GetAttribute($logoSource.Attribute)
            if ([string]::IsNullOrWhiteSpace($relative)) { continue }
            if ($relative -match '^ms-resource:') { continue }
            $asset = Find-BestUwpAsset -InstallLocation $install -RelativePath $relative -BaseSize $logoSource.Size
            if (-not [string]::IsNullOrWhiteSpace($asset)) { return $asset }
        } catch { }
    }

    # Some manifests only have Properties/Logo (usually a Store logo).
    try {
        $packageLogo = $doc.SelectSingleNode("/*[local-name()='Package']/*[local-name()='Properties']/*[local-name()='Logo']")
        if ($null -ne $packageLogo) {
            $relative = [string]$packageLogo.InnerText
            if (-not [string]::IsNullOrWhiteSpace($relative) -and $relative -notmatch '^ms-resource:') {
                $asset = Find-BestUwpAsset -InstallLocation $install -RelativePath $relative -BaseSize 50
                if (-not [string]::IsNullOrWhiteSpace($asset)) { return $asset }
            }
        }
    } catch { }

    return $null
}

function Get-UwpIconFile {
    param(
        [string]$Aumid,
        [string]$Id
    )
    if (-not $script:DrawingReady -or -not $script:IconDirReady) { return $null }
    $cachePath = Get-IconCachePath $Id
    if (Test-IconFile $cachePath) { return $cachePath }

    $asset = $null
    $image = $null
    try {
        $asset = Get-UwpIconAsset $Aumid
        if ([string]::IsNullOrWhiteSpace($asset)) { return $null }
        if (-not (Test-Path -LiteralPath $asset -PathType Leaf)) { return $null }
        $image = [System.Drawing.Image]::FromFile($asset)
        if ([int]$image.Width -le 0 -or [int]$image.Height -le 0) { return $null }
        if (Save-SquarePng64 -Image $image -OutPath $cachePath) {
            if (Test-IconFile $cachePath) { return $cachePath }
        }
        return $null
    } catch {
        return $null
    } finally {
        if ($null -ne $image) { try { $image.Dispose() } catch { } }
    }
}

function Get-Win32IconFile {
    param(
        [string]$Target,
        [string]$Id
    )
    if (-not $script:DrawingReady -or -not $script:IconDirReady) { return $null }
    $cachePath = Get-IconCachePath $Id
    if (Test-IconFile $cachePath) { return $cachePath }
    if ([string]::IsNullOrWhiteSpace($Target)) { return $null }
    if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { return $null }

    $icon = $null
    $bitmap = $null
    try {
        $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Target)
        if ($null -eq $icon) { return $null }
        $bitmap = $icon.ToBitmap()
        if ($null -eq $bitmap) { return $null }
        if (Save-SquarePng64 -Image $bitmap -OutPath $cachePath) {
            if (Test-IconFile $cachePath) { return $cachePath }
        }
        return $null
    } catch {
        return $null
    } finally {
        if ($null -ne $bitmap) { try { $bitmap.Dispose() } catch { } }
        if ($null -ne $icon) { try { $icon.Dispose() } catch { } }
    }
}

function Get-AppIconPath {
    param($Candidate)
    if ($null -eq $Candidate) { return $null }
    try {
        if ($Candidate.Kind -eq 'uwp') {
            return (Get-UwpIconFile -Aumid $Candidate.Target -Id $Candidate.Id)
        }
        return (Get-Win32IconFile -Target $Candidate.Target -Id $Candidate.Id)
    } catch {
        return $null
    }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

$apps = New-Object System.Collections.ArrayList
$iconBudget = if ($MaxIcons -lt 1) { 1 } elseif ($MaxIcons -gt 5000) { 5000 } else { $MaxIcons }

try {
    if ([string]::IsNullOrWhiteSpace($IconDir)) {
        $IconDir = Join-Path $env:LOCALAPPDATA 'Aurora\icons'
    }
    try {
        if (-not (Test-Path -LiteralPath $IconDir -PathType Container)) {
            New-Item -ItemType Directory -Path $IconDir -Force | Out-Null
        }
        $script:ResolvedIconDir = (Resolve-Path -LiteralPath $IconDir).Path
        $script:IconDirReady = $true
    } catch {
        Write-Diag ('Cannot create icon directory: ' + $_.Exception.Message)
    }

    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        $script:DrawingReady = $true
    } catch {
        Write-Diag ('System.Drawing unavailable: ' + $_.Exception.Message)
    }
    Write-Timing 'drawing-ready'

    try { $script:WshShell = New-Object -ComObject WScript.Shell } catch { $script:WshShell = $null }

    $candidates = New-Object System.Collections.ArrayList
    try {
        Add-StartAppsCandidates -Candidates $candidates -Shell $script:WshShell
    } catch {
        Write-Diag ('StartApps collection failed: ' + $_.Exception.Message)
    }
    Write-Timing ('startapps=' + $candidates.Count)
    try {
        Add-ShortcutCandidates -Candidates $candidates -Shell $script:WshShell
    } catch {
        Write-Diag ('Start Menu collection failed: ' + $_.Exception.Message)
    }
    Write-Timing ('shortcuts=' + $candidates.Count)

    # Group by normalized display name.  A group can hold the same app from
    # Get-StartApps, a .lnk and (potentially) Appx; the best icon wins.
    $groups = @{}
    foreach ($candidate in $candidates) {
        try {
            if ([string]::IsNullOrWhiteSpace($candidate.NormalizedName)) { continue }
            if (-not $groups.ContainsKey($candidate.NormalizedName)) {
                $groups[$candidate.NormalizedName] = New-Object System.Collections.ArrayList
            }
            [void]$groups[$candidate.NormalizedName].Add($candidate)
        } catch { }
    }

    $groupInfos = New-Object System.Collections.ArrayList
    foreach ($key in $groups.Keys) {
        $list = $groups[$key]
        if ($null -eq $list -or $list.Count -eq 0) { continue }
        $best = $list | Sort-Object SourceRank, @{ Expression = { $_.Name.ToLowerInvariant() } } | Select-Object -First 1
        [void]$groupInfos.Add([pscustomobject]@{
            Name       = [string]$best.Name
            Rank       = [int]$best.SourceRank
            Candidates = @($list)
        })
    }

    # The cap is applied to apps, so the UI never receives an unbounded list.
    $orderedGroups = @($groupInfos | Sort-Object `
        @{ Expression = { $_.Rank } }, `
        @{ Expression = { $_.Name.ToLowerInvariant() } } | Select-Object -First $iconBudget)
    Write-Timing ('groups=' + $orderedGroups.Count + '/candidates=' + $candidates.Count)

    $seenIds = @{}
    $processed = 0
    foreach ($group in $orderedGroups) {
        try {
            $processed++
            if (($processed % 50) -eq 0) {
                Write-Diag ('icons: ' + $processed + '/' + $orderedGroups.Count)
            }

            $orderedCandidates = @($group.Candidates | Sort-Object `
                @{ Expression = { $_.SourceRank } }, `
                @{ Expression = { if ($_.Kind -eq 'uwp') { 0 } else { 1 } } }, `
                @{ Expression = { if ([string]::IsNullOrEmpty($_.Args)) { 1 } else { 0 } } }, `
                @{ Expression = { $_.Name.ToLowerInvariant() } })

            $selected = $null
            foreach ($candidate in $orderedCandidates) {
                $icon = $null
                try { $icon = Get-AppIconPath -Candidate $candidate } catch { $icon = $null }
                $candidate.Icon = $icon
                if ($null -eq $selected) { $selected = $candidate }
                if (-not [string]::IsNullOrWhiteSpace($icon)) {
                    $selected = $candidate
                    break
                }
            }
            if ($null -eq $selected) { continue }

            $idKey = $selected.Id.ToLowerInvariant()
            if ($seenIds.ContainsKey($idKey)) { continue }
            $seenIds[$idKey] = $true

            [void]$apps.Add([pscustomobject][ordered]@{
                id     = $selected.Id
                name   = $selected.Name
                icon   = $(if ($null -ne $selected.Icon -and $selected.Icon.Length -gt 0) { $selected.Icon } else { $null })
                kind   = $selected.Kind
                target = $selected.Target
                args   = [string]$selected.Args
                source = $selected.Source
            })
        } catch {
        }
    }
    Write-Timing ('icons-done=' + $apps.Count)
} catch {
    Write-Diag ('Fatal scan error: ' + $_.Exception.Message)
} finally {
    if ($null -ne $script:WshShell) {
        try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($script:WshShell) } catch { }
        $script:WshShell = $null
    }
}

$appArray = @($apps)
$elapsedMs = [int]$script:Stopwatch.ElapsedMilliseconds
$json = $null
try {
    $result = [ordered]@{
        apps      = $appArray
        count     = $appArray.Count
        elapsedMs = $elapsedMs
    }
    $json = $result | ConvertTo-Json -Depth 5 -Compress
} catch {
    Write-Diag ('JSON serialization failed: ' + $_.Exception.Message)
    $json = '{"apps":[],"count":0,"elapsedMs":' + $elapsedMs + '}'
}

try {
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $bytes = $utf8.GetBytes($json)
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
} catch {
    # Last-resort path; keep a valid JSON document on stdout.
    [Console]::Out.Write('{"apps":[],"count":0,"elapsedMs":' + $elapsedMs + '}')
}
