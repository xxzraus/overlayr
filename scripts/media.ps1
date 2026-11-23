#requires -Version 5.1
<#
  Aurora media bridge (GSMTC / Windows.Media.Control).

  Long-lived watcher:
    * enumerates ALL GSMTC sessions (GetSessions), not just the "current" one;
    * picks a "sticky" session - the last one that was really playing - so a
      paused browser video never hijacks the overlay after you pause your music;
    * accepts targeted commands from a JSON file ({"action":"toggle","target":"<appId>"});
    * prints exactly one compact JSON line per tick to stdout (NDJSON, UTF-8 no BOM).

  Parameters:
    -IntervalMs     tick period (default 250)
    -CmdFile        command file path (deleted after it is parsed)
    -ArtDir         album-art PNG cache directory
    -StickySeconds  how long a paused session stays displayed (default 1800, 0 = off)
    -StickyApps     comma separated appIds/app names that always win while playing
                    or paused recently, e.g. "Spotify.exe,Microsoft.ZuneMusic"
    -Once           apply pending commands, print one state line and exit

  Exit codes: 0 on success (also for -Once), 1 only for fatal startup problems.
#>
[CmdletBinding()]
param(
  [int]$IntervalMs = 250,
  [string]$CmdFile = "$env:TEMP\aurora-media-cmd.json",
  [string]$ArtDir = "$env:TEMP\aurora-art",
  [int]$StickySeconds = 1800,
  [string]$StickyApps = '',
  [switch]$Once
)

$ErrorActionPreference = 'Continue'
# UTF-8 on stdout, no BOM, so the host can decode NDJSON as UTF-8.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { $OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$ProgressPreference = 'SilentlyContinue'

if ($IntervalMs -lt 50) { $IntervalMs = 50 }
if ($StickySeconds -lt 0) { $StickySeconds = 0 }

# --- WinRT async helper -------------------------------------------------
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

# Bounded wait: a hung WinRT call must never freeze the watcher forever.
function Await($op, $type, [int]$timeoutMs = 2500) {
  if ($null -eq $op) { return $null }
  try {
    $asTask = $asTaskGeneric.MakeGenericMethod($type)
    $netTask = $asTask.Invoke($null, @($op))
    if (-not $netTask.Wait($timeoutMs)) { return $null }
    return $netTask.Result
  } catch {
    return $null
  }
}

$MgrType   = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$PropsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
$RasType   = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime]
$DrType    = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]

# The auto-repeat enum lives in Windows.Media.winmd; resolve it lazily from the
# session method signature so we never depend on a hard-coded projection name.
$script:repeatType = $null
function Get-RepeatType($session) {
  if ($null -ne $script:repeatType) { return $script:repeatType }
  try {
    $m = $session.GetType().GetMethod('TryChangeAutoRepeatModeAsync')
    if ($null -ne $m) { $script:repeatType = $m.GetParameters()[0].ParameterType }
  } catch { }
  return $script:repeatType
}

if (-not (Test-Path -LiteralPath $ArtDir)) {
  try { New-Item -ItemType Directory -Force -Path $ArtDir | Out-Null } catch { }
}

# --- sticky bookkeeping -------------------------------------------------
$script:lastPlaying   = @{}   # appId -> epoch ms, last time we saw it Playing
$script:playingSince  = @{}   # appId -> epoch ms, when the current Playing streak started
$script:propsCache    = @{}   # appId -> @{ at; title; artist; album; art }
$script:artMemo       = @{}   # art hash -> path (or $null after a failed decode)
$script:PropsTtlMs    = 3000  # media properties refresh period for non-displayed sessions
$script:StickyMs      = [long]$StickySeconds * 1000
$script:StickyTokens  = @()
$script:startedAt     = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$script:SeedWindowMs  = 5000  # only bootstrap lastPlaying during startup
$script:lastStateLine = $null
$script:cmdBadRaw     = $null
$script:cmdBadCount   = 0
$script:managerFail   = 0
$script:manager       = $null

foreach ($tok in ($StickyApps -split '[,;]')) {
  $t = $tok.Trim().Trim('"').Trim("'").Trim()
  if (-not [string]::IsNullOrWhiteSpace($t)) { $script:StickyTokens += $t }
}

function Friendly-App([string]$id) {
  if ([string]::IsNullOrWhiteSpace($id)) { return 'Аудио' }
  $n = $id
  if ($n -match '^([^!_]+)_[a-z0-9]+!') { $n = $Matches[1] }
  $n = $n -replace '\.exe$', ''
  $n = $n -replace '\.Exe$', ''
  if ($n -match 'Microsoft\.ZuneMusic') { return 'Media Player' }
  if ($n -match 'Spotify') { return 'Spotify' }
  if ($n -match 'Chrome') { return 'Chrome' }
  if ($n -match 'msedge') { return 'Edge' }
  if ($n -match 'firefox') { return 'Firefox' }
  if ($n -match 'foobar') { return 'foobar2000' }
  if ($n -match 'AIMP') { return 'AIMP' }
  if ($n -match 'Yandex') { return 'Яндекс Музыка' }
  if ($n -match 'VLC') { return 'VLC' }
  if ($n -match 'wmplayer') { return 'Windows Media Player' }
  return $n
}

function Test-StickyApp($rec) {
  if ($null -eq $rec -or $script:StickyTokens.Count -eq 0) { return $false }
  $appId = [string]$rec.appId
  $appName = [string]$rec.app
  foreach ($t in $script:StickyTokens) {
    if ([string]::IsNullOrWhiteSpace($t)) { continue }
    if ($appId -and $appId.IndexOf($t, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    $tNoExe = $t -replace '\.exe$', ''
    $aNoExe = $appId -replace '\.exe$', ''
    if ($aNoExe -and [string]::Equals($aNoExe, $tNoExe, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($appName -and $appName.IndexOf($t, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    # "Microsoft.ZuneMusic" must match "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"
    $norm = $appId
    $i = $norm.IndexOf('!'); if ($i -gt 0) { $norm = $norm.Substring(0, $i) }
    $i = $norm.IndexOf('_'); if ($i -gt 0) { $norm = $norm.Substring(0, $i) }
    if ($norm -and [string]::Equals($norm, $t, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

# --- GSMTC manager ------------------------------------------------------
function Get-Manager {
  if ($null -ne $script:manager) { return $script:manager }
  try {
    $script:manager = Await ($MgrType::RequestAsync()) $MgrType 5000
    if ($null -ne $script:manager) { $script:managerFail = 0 }
  } catch {
    $script:manager = $null
  }
  return $script:manager
}

function Get-SessionsSafe {
  $mgr = Get-Manager
  if ($null -eq $mgr) { return @() }
  try {
    $list = $mgr.GetSessions()
    $arr = @()
    foreach ($s in $list) { if ($null -ne $s) { $arr += $s } }
    if ($arr.Count -gt 0) {
      $script:managerFail = 0
      return $arr
    }
    return @()
  } catch {
    # Stale manager object: drop it, re-request on a later tick (with cooldown).
    $script:managerFail++
    if ($script:managerFail -ge 2) {
      $script:manager = $null
      $script:managerFail = 0
    }
    return @()
  }
}

# --- album art ----------------------------------------------------------
function Save-Art($thumb, [string]$key) {
  if ($null -eq $thumb -or [string]::IsNullOrEmpty($key)) { return $null }
  if ($script:artMemo.ContainsKey($key)) { return $script:artMemo[$key] }
  $path = Join-Path $ArtDir ("$key.png")
  try {
    if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path).Length -gt 200)) {
      $script:artMemo[$key] = $path
      return $path
    }
  } catch { }
  try {
    $ras = Await ($thumb.OpenReadAsync()) $RasType
    if ($null -eq $ras) { return $null }
    $size = [int]$ras.Size
    if ($size -le 0 -or $size -gt 12MB) { return $null }
    $reader = $DrType::new($ras)
    Await ($reader.LoadAsync([uint32]$size)) ([uint32]) | Out-Null
    $bytes = New-Object byte[] $size
    $reader.ReadBytes($bytes)
    [System.IO.File]::WriteAllBytes($path, $bytes)
    $reader.Dispose()
    $ras.Dispose()
    $script:artMemo[$key] = $path
    return $path
  } catch {
    $script:artMemo[$key] = $null
    return $null
  }
}

function Get-ArtKey([string]$src) {
  try {
    $sha = [System.Security.Cryptography.SHA1]::Create()
    $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($src))
    return ([System.BitConverter]::ToString($hash) -replace '-', '').Substring(0, 16).ToLower()
  } catch {
    return ([string]([guid]::NewGuid())).Replace('-', '').Substring(0, 16)
  }
}

# --- timeline -----------------------------------------------------------
function Get-Timeline($session, [bool]$playing) {
  $pos = 0.0; $dur = 0.0; $lastMs = [long]0
  try {
    $tl = $session.GetTimelineProperties()
    if ($null -ne $tl) {
      try { $pos = [double]$tl.Position.TotalMilliseconds } catch { }
      try { $dur = [double]$tl.EndTime.TotalMilliseconds } catch { }
      try {
        $last = $tl.LastUpdatedTime
        if ($null -ne $last) {
          $lastMs = [long]$last.ToUnixTimeMilliseconds()
          if ($playing) {
            $delta = ([DateTimeOffset]::UtcNow - $last).TotalMilliseconds
            if ($delta -gt 0) { $pos += $delta }
          }
        }
      } catch { }
      if ($dur -le 0) {
        try { $dur = [double]($tl.EndTime - $tl.StartTime).TotalMilliseconds } catch { }
      }
      if ($pos -gt $dur -and $dur -gt 0) { $pos = $dur }
      if ($pos -lt 0) { $pos = 0 }
    }
  } catch { }
  return @{ position = [long][math]::Round($pos); duration = [long][math]::Round($dur); lastUpdated = $lastMs }
}

# --- per-session records ------------------------------------------------
function Update-PropsCache($session, [string]$appId, [long]$now) {
  $props = $null
  try { $props = Await ($session.TryGetMediaPropertiesAsync()) $PropsType } catch { $props = $null }
  if ($null -eq $props) { return $null }
  $title = ''; $artist = ''; $album = ''
  try { $title = [string]$props.Title } catch { }
  try { $artist = [string]$props.Artist } catch { }
  try { $album = [string]$props.AlbumTitle } catch { }
  if ([string]::IsNullOrWhiteSpace($title)) { $title = $album }
  $key = Get-ArtKey ($appId + '|' + $title + '|' + $artist + '|' + $album)
  $thumb = $null
  try { $thumb = $props.Thumbnail } catch { }
  $art = $null
  if ($null -ne $thumb) { $art = Save-Art $thumb $key }
  $cache = @{ at = $now; title = $title; artist = $artist; album = $album; art = $art }
  $script:propsCache[$appId] = $cache
  return $cache
}

function Apply-Props($rec, $cache) {
  if ($null -eq $rec -or $null -eq $cache) { return }
  try { $rec.title = [string]$cache.title } catch { }
  try { $rec.artist = [string]$cache.artist } catch { }
  try { $rec.album = [string]$cache.album } catch { }
  try { $rec.art = $cache.art } catch { }
}

function Read-SessionRecord($session, [long]$now) {
  if ($null -eq $session) { return $null }
  $appId = ''
  try { $appId = [string]$session.SourceAppUserModelId } catch { $appId = '' }

  $rec = @{
    appId        = $appId
    app          = (Friendly-App $appId)
    title        = ''
    artist       = ''
    album        = ''
    status       = 'None'
    playing      = $false
    position     = [long]0
    duration     = [long]0
    art          = $null
    shuffle      = $false
    repeat       = 0
    lastActive   = [long]0
    playingSince = [long]0
    session      = $session
  }

  $info = $null
  try { $info = $session.GetPlaybackInfo() } catch { }
  $status = 'None'
  if ($null -ne $info) {
    try { $status = [string]$info.PlaybackStatus.ToString() } catch { }
    $rec.playing = ($status -eq 'Playing')
    try { $rec.shuffle = [bool]$info.IsShuffleActive } catch { }
    try { if ($null -ne $info.AutoRepeatMode) { $rec.repeat = [int]$info.AutoRepeatMode } } catch { }
  }
  $rec.status = $status

  $tl = Get-Timeline $session $rec.playing
  $rec.position = $tl.position
  $rec.duration = $tl.duration

  # Sticky bookkeeping: remember when each appId was last seen Playing.
  if ($rec.playing) {
    if (-not $script:playingSince.ContainsKey($appId)) { $script:playingSince[$appId] = $now }
    $rec.playingSince = [long]$script:playingSince[$appId]
    $script:lastPlaying[$appId] = $now
    $rec.lastActive = $now
  } else {
    if ($script:playingSince.ContainsKey($appId)) { $script:playingSince.Remove($appId) | Out-Null }
    if ($script:lastPlaying.ContainsKey($appId)) {
      $rec.lastActive = [long]$script:lastPlaying[$appId]
    } elseif ($status -eq 'Paused' -and $tl.position -gt 1000 -and $tl.lastUpdated -gt 0 -and
              ($now - [long]$script:startedAt) -lt $script:SeedWindowMs) {
      # Fresh process (e.g. a single -Once run): bootstrap the sticky history
      # from the OS timeline, but only at startup and only for sessions whose
      # position actually advanced, so a paused-but-never-played tab (position 0)
      # is still never selected. Mid-run sessions are tracked from observation.
      $script:lastPlaying[$appId] = [long]$tl.lastUpdated
      $rec.lastActive = [long]$tl.lastUpdated
    }
  }

  # Media properties: served from cache, refreshed when stale (cheap ticks).
  $cache = $null
  if ($appId -and $script:propsCache.ContainsKey($appId)) { $cache = $script:propsCache[$appId] }
  if ($null -eq $cache -or (($now - [long]$cache.at) -ge $script:PropsTtlMs)) {
    $fresh = Update-PropsCache $session $appId $now
    if ($null -ne $fresh) { $cache = $fresh }
  }
  Apply-Props $rec $cache
  return $rec
}

function Get-SessionRecords([long]$now) {
  $records = @()
  foreach ($s in @(Get-SessionsSafe)) {
    try {
      $rec = Read-SessionRecord $s $now
      if ($null -ne $rec) { $records += $rec }
    } catch { }
  }
  return $records
}

# --- display (sticky) selection ----------------------------------------
function Select-DisplaySession($records, [long]$now) {
  if ($null -eq $records -or $records.Count -eq 0) { return $null }
  $stickyMs = [long]$script:StickyMs

  # 1) Priority apps (-StickyApps): Playing, or paused less than StickySeconds ago.
  $best = $null
  foreach ($r in $records) {
    if (-not (Test-StickyApp $r)) { continue }
    $fresh = $r.playing -or ($r.lastActive -gt 0 -and ($now - [long]$r.lastActive) -lt $stickyMs)
    if (-not $fresh) { continue }
    if ($null -eq $best) { $best = $r; continue }
    if ($r.playing -and -not $best.playing) { $best = $r; continue }
    if ($r.playing -eq $best.playing) {
      if ($r.playing) {
        if ([long]$r.playingSince -gt [long]$best.playingSince) { $best = $r }
      } elseif ([long]$r.lastActive -gt [long]$best.lastActive) {
        $best = $r
      }
    }
  }
  if ($null -ne $best) { return $best }

  # 2) Something is playing: pick the one that started playing most recently
  #    (all currently playing sessions share lastPlaying=now, so playingSince
  #    is the meaningful tie-breaker here).
  $best = $null
  foreach ($r in $records) {
    if (-not $r.playing) { continue }
    if ($null -eq $best) { $best = $r; continue }
    if ([long]$r.playingSince -gt [long]$best.playingSince) { $best = $r }
  }
  if ($null -ne $best) { return $best }

  # 3) Nothing plays: keep the freshest lastPlaying, but only within StickySeconds.
  #    Sessions that never played have lastActive=0 and are never selected.
  $best = $null
  foreach ($r in $records) {
    if ([long]$r.lastActive -le 0) { continue }
    if (($now - [long]$r.lastActive) -ge $stickyMs) { continue }
    if ($null -eq $best -or [long]$r.lastActive -gt [long]$best.lastActive) { $best = $r }
  }
  return $best
}

# --- commands -----------------------------------------------------------
function Find-TargetRecord($records, [string]$target) {
  if ([string]::IsNullOrWhiteSpace($target)) { return $null }
  $t = $target.Trim()
  foreach ($r in $records) {
    if ([string]::Equals(([string]$r.appId).Trim(), $t, [System.StringComparison]::OrdinalIgnoreCase)) { return $r }
  }
  return $null
}

function Convert-ToBool($v) {
  if ($null -eq $v) { return $false }
  if ($v -is [bool]) { return $v }
  $s = ([string]$v).Trim().ToLowerInvariant()
  if ($s -eq 'true' -or $s -eq '1' -or $s -eq 'on' -or $s -eq 'yes') { return $true }
  return $false
}

function Resolve-RepeatMode($v) {
  if ($null -eq $v) { return 2 }
  if ($v -is [int] -or $v -is [long] -or $v -is [double]) {
    $m = [int]$v
    if ($m -lt 0 -or $m -gt 2) { return $null }
    return $m
  }
  $s = ([string]$v).Trim().ToLowerInvariant()
  switch ($s) {
    'none'  { return 0 }
    'track' { return 1 }
    'list'  { return 2 }
    ''      { return 2 }
  }
  $m = 0
  if ([int]::TryParse($s, [ref]$m)) {
    if ($m -ge 0 -and $m -le 2) { return $m }
  }
  return $null
}

function Invoke-MediaCommand($cmd, $records, $display) {
  try {
    if ($null -eq $cmd) { return }
    $action = ''
    try { $action = ([string]$cmd.action).Trim().ToLowerInvariant() } catch { return }
    if ([string]::IsNullOrEmpty($action)) { return }

    $target = ''
    try { $target = [string]$cmd.target } catch { }
    $value = $null
    try { $value = $cmd.value } catch { }

    $rec = $null
    if (-not [string]::IsNullOrWhiteSpace($target)) {
      $rec = Find-TargetRecord $records $target
      if ($null -eq $rec) { return }   # unknown target: silently ignore
    } else {
      $rec = $display
    }
    if ($null -eq $rec) { return }
    $session = $rec.session
    if ($null -eq $session) { return }

    switch ($action) {
      'toggle' { Await ($session.TryTogglePlayPauseAsync()) ([bool]) | Out-Null }
      'play'   { Await ($session.TryPlayAsync()) ([bool]) | Out-Null }
      'pause'  { Await ($session.TryPauseAsync()) ([bool]) | Out-Null }
      'next'   { Await ($session.TrySkipNextAsync()) ([bool]) | Out-Null }
      'prev'   { Await ($session.TrySkipPreviousAsync()) ([bool]) | Out-Null }
      'seek' {
        $dur = [double]$rec.duration
        if ($dur -le 0) { $dur = [double](Get-Timeline $session $false).duration }
        if ($dur -gt 0) {
          $f = 0.0
          try { $f = [double]$value } catch { $f = 0.0 }
          if ($f -lt 0) { $f = 0 }
          if ($f -gt 1) { $f = 1 }
          $ms = [long]($dur * $f)
          Await ($session.TryChangePlaybackPositionAsync([long]($ms * 10000))) ([bool]) | Out-Null
        }
      }
      'seekms' {
        $ms = -1
        try { $ms = [long]$value } catch { $ms = -1 }
        if ($ms -ge 0) {
          Await ($session.TryChangePlaybackPositionAsync([long]($ms * 10000))) ([bool]) | Out-Null
        }
      }
      'shuffle' {
        $on = $true
        if ($null -ne $value) {
          $on = Convert-ToBool $value
        } else {
          try { $on = -not [bool]$session.GetPlaybackInfo().IsShuffleActive } catch { $on = $true }
        }
        Await ($session.TryChangeShuffleActiveAsync([bool]$on)) ([bool]) | Out-Null
      }
      'repeat' {
        $mode = Resolve-RepeatMode $value
        if ($null -ne $mode) {
          $enumType = Get-RepeatType $session
          if ($null -ne $enumType) {
            try {
              $enum = [System.Enum]::ToObject($enumType, [int]$mode)
              Await ($session.TryChangeAutoRepeatModeAsync($enum)) ([bool]) | Out-Null
            } catch { }
          }
        }
      }
    }
  } catch { }
}

function Invoke-PendingCommands {
  if ([string]::IsNullOrWhiteSpace($CmdFile)) { return }
  if (-not (Test-Path -LiteralPath $CmdFile)) { return }
  $raw = $null
  try { $raw = [System.IO.File]::ReadAllText($CmdFile) } catch { return }
  if ([string]::IsNullOrWhiteSpace($raw)) {
    try { Remove-Item -LiteralPath $CmdFile -Force -ErrorAction SilentlyContinue } catch { }
    return
  }
  $parsed = $null
  try {
    $parsed = $raw | ConvertFrom-Json
  } catch {
    # Possibly a half-written file: retry a few ticks instead of dropping it.
    if ($script:cmdBadRaw -eq $raw) { $script:cmdBadCount++ } else { $script:cmdBadRaw = $raw; $script:cmdBadCount = 1 }
    if ($script:cmdBadCount -ge 5) {
      try { Remove-Item -LiteralPath $CmdFile -Force -ErrorAction SilentlyContinue } catch { }
      $script:cmdBadRaw = $null
      $script:cmdBadCount = 0
    }
    return
  }
  $script:cmdBadRaw = $null
  $script:cmdBadCount = 0
  try { Remove-Item -LiteralPath $CmdFile -Force -ErrorAction SilentlyContinue } catch { }
  if ($null -eq $parsed) { return }

  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $records = @(Get-SessionRecords $now)
  $display = Select-DisplaySession $records $now
  if ($parsed -is [System.Array]) {
    foreach ($c in $parsed) { Invoke-MediaCommand $c $records $display }
  } else {
    Invoke-MediaCommand $parsed $records $display
  }
}

# --- state --------------------------------------------------------------
function Build-State {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $state = [ordered]@{
    type         = 'state'
    ok           = $true
    hasSession   = $false
    sticky       = $false
    appId        = ''
    app          = ''
    title        = ''
    artist       = ''
    album        = ''
    status       = 'None'
    playing      = $false
    position     = [long]0
    duration     = [long]0
    art          = $null
    shuffle      = $false
    repeat       = 0
    ts           = $now
    displayAppId = ''
    sessionCount = 0
    sessions     = @()
    allSessions  = @()
  }

  $records = @(Get-SessionRecords $now)
  $state.sessionCount = $records.Count

  $brief = @()
  foreach ($r in $records) {
    $brief += ([ordered]@{ appId = [string]$r.appId; app = [string]$r.app; playing = [bool]$r.playing })
  }
  $state.sessions = $brief

  $display = Select-DisplaySession $records $now
  if ($null -ne $display) {
    # The displayed session gets fresh metadata every tick; the rest are cached.
    $cache = Update-PropsCache $display.session ([string]$display.appId) $now
    if ($null -ne $cache) { Apply-Props $display $cache }
    $state.hasSession   = $true
    $state.sticky       = (-not $display.playing)
    $state.appId        = [string]$display.appId
    $state.displayAppId = [string]$display.appId
    $state.app          = [string]$display.app
    $state.title        = [string]$display.title
    $state.artist       = [string]$display.artist
    $state.album        = [string]$display.album
    $state.status       = [string]$display.status
    $state.playing      = [bool]$display.playing
    $state.position     = [long]$display.position
    $state.duration     = [long]$display.duration
    $state.art          = $display.art
    $state.shuffle      = [bool]$display.shuffle
    $state.repeat       = [int]$display.repeat
  }

  $all = @()
  foreach ($r in $records) {
    $all += ([ordered]@{
      appId      = [string]$r.appId
      app        = [string]$r.app
      title      = [string]$r.title
      artist     = [string]$r.artist
      album      = [string]$r.album
      status     = [string]$r.status
      playing    = [bool]$r.playing
      position   = [long]$r.position
      duration   = [long]$r.duration
      art        = $r.art
      shuffle    = [bool]$r.shuffle
      repeat     = [int]$r.repeat
      lastActive = [long]$r.lastActive
    })
  }
  $state.allSessions = $all

  return ($state | ConvertTo-Json -Compress -Depth 6)
}

function Get-StateLine {
  try {
    $line = Build-State
    if (-not [string]::IsNullOrWhiteSpace($line)) { $script:lastStateLine = $line }
  } catch {
    # Keep serving the last known good state instead of dying.
  }
  if ([string]::IsNullOrWhiteSpace($script:lastStateLine)) {
    $fallback = [ordered]@{
      type = 'state'; ok = $false; hasSession = $false; sticky = $false
      appId = ''; app = ''; title = ''; artist = ''; album = ''; status = 'None'
      playing = $false; position = [long]0; duration = [long]0; art = $null
      shuffle = $false; repeat = 0; ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      displayAppId = ''; sessionCount = 0; sessions = @(); allSessions = @()
      error = 'fatal'
    }
    try { return ($fallback | ConvertTo-Json -Compress -Depth 6) } catch { return '{"type":"state","ok":false,"hasSession":false}' }
  }
  return $script:lastStateLine
}

function Emit([string]$line) {
  try {
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
  } catch { }
}

if ($Once) {
  try { Invoke-PendingCommands } catch { }
  Emit (Get-StateLine)
  exit 0
}

Emit '{"type":"hello"}'
while ($true) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try { Invoke-PendingCommands } catch { }
  Emit (Get-StateLine)
  $spent = [int]$sw.ElapsedMilliseconds
  $sleep = $IntervalMs - $spent
  if ($sleep -lt 1) { $sleep = 1 }
  try { Start-Sleep -Milliseconds $sleep } catch { Start-Sleep -Seconds 1 }
}
