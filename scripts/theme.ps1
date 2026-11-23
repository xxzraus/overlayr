param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('dark', 'accent', 'wallpaper', 'status', 'all', 'deskicons', 'deskicons-status')]
  [string]$Action,
  [int]$Dark = 1,
  [string]$Hex = '#7C5CFF',
  [string]$Path = '',
  [int]$TaskbarAccent = 1,
  [int]$Value = 1,
  [switch]$SkipDark
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AuroraNative {
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern bool SystemParametersInfo(uint uAction, uint uParam, string lpvParam, uint fuWinIni);
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
}
"@

$PERSONALIZE = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
$DWM = 'HKCU:\Software\Microsoft\Windows\DWM'
$EXPLORER_ACCENT = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Accent'
$DESKTOP = 'HKCU:\Control Panel\Desktop'

foreach ($k in @($PERSONALIZE, $DWM, $EXPLORER_ACCENT)) {
  if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
}

function Broadcast-Setting([string]$what) {
  $res = [IntPtr]::Zero
  [void][AuroraNative]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [IntPtr]::Zero, $what, 2, 1200, [ref]$res)
  try { [void][AuroraNative]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [IntPtr]::Zero, 'ImmersiveColorSet', 2, 1200, [ref]$res) } catch { }
}

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OverlayrShell {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string win);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr child, string cls, string win);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
"@

function Get-DesktopView {
  $prog = [OverlayrShell]::FindWindow('Progman', [NullString]::Value)
  if ($prog -eq [IntPtr]::Zero) { return [IntPtr]::Zero }
  $def = [OverlayrShell]::FindWindowEx($prog, [IntPtr]::Zero, 'SHELLDLL_DefView', [NullString]::Value)
  if ($def -ne [IntPtr]::Zero) { return $def }
  $worker = [OverlayrShell]::FindWindowEx([IntPtr]::Zero, [IntPtr]::Zero, 'WorkerW', [NullString]::Value)
  while ($worker -ne [IntPtr]::Zero) {
    $def = [OverlayrShell]::FindWindowEx($worker, [IntPtr]::Zero, 'SHELLDLL_DefView', [NullString]::Value)
    if ($def -ne [IntPtr]::Zero) { return $def }
    $worker = [OverlayrShell]::FindWindowEx([IntPtr]::Zero, $worker, 'WorkerW', [NullString]::Value)
  }
  return [IntPtr]::Zero
}

function Get-DesktopIconsVisible {
  try {
    $def = Get-DesktopView
    if ($def -eq [IntPtr]::Zero) { return $null }
    $script:iconList = [IntPtr]::Zero
    $cb = [OverlayrShell+EnumProc]{
      param($h, $l)
      $sb = New-Object System.Text.StringBuilder 256
      [void][OverlayrShell]::GetClassName($h, $sb, 256)
      if ($sb.ToString() -eq 'SysListView32') { $script:iconList = $h }
      return $true
    }
    [void][OverlayrShell]::EnumChildWindows($def, $cb, [IntPtr]::Zero)
    if ($script:iconList -eq [IntPtr]::Zero) { return $null }
    return [OverlayrShell]::IsWindowVisible($script:iconList)
  } catch { return $null }
}

function Set-DesktopIcons([int]$hide) {
  $advanced = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced'
  try { Set-ItemProperty -Path $advanced -Name 'HideIcons' -Value $hide -Type DWord } catch { }
  $visible = Get-DesktopIconsVisible
  $wantVisible = ($hide -eq 0)
  if ($null -ne $visible -and $visible -ne $wantVisible) {
    $def = Get-DesktopView
    if ($def -ne [IntPtr]::Zero) {
      [void][OverlayrShell]::SendMessage($def, 0x111, [IntPtr]0x7402, [IntPtr]::Zero)
    }
  }
  Start-Sleep -Milliseconds 250
  $now = Get-DesktopIconsVisible
  return @{ ok = $true; action = 'deskicons'; hidden = ($hide -eq 1); visible = $now }
}
function Set-DarkMode([int]$dark) {
  $light = if ($dark -eq 1) { 0 } else { 1 }
  Set-ItemProperty -Path $PERSONALIZE -Name 'AppsUseLightTheme' -Value $light -Type DWord
  Set-ItemProperty -Path $PERSONALIZE -Name 'SystemUsesLightTheme' -Value $light -Type DWord
  try { Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'rundll32.exe user32.dll,UpdatePerUserSystemParameters 1, True' } | Out-Null } catch { }
  Broadcast-Setting 'ImmersiveColorSet'
  return @{ ok = $true; action = 'dark'; dark = ($dark -eq 1) }
}

function Convert-HexToRgb([string]$h) {
  $h = $h.TrimStart('#')
  if ($h.Length -eq 3) { $h = '' + $h[0] + $h[0] + $h[1] + $h[1] + $h[2] + $h[2] }
  if ($h.Length -ne 6) { $h = '7C5CFF' }
  return @{
    r = [Convert]::ToInt32($h.Substring(0, 2), 16)
    g = [Convert]::ToInt32($h.Substring(2, 2), 16)
    b = [Convert]::ToInt32($h.Substring(4, 2), 16)
  }
}

function To-SignedInt32([uint32]$u) {
  return [BitConverter]::ToInt32([BitConverter]::GetBytes($u), 0)
}

function To-UInt32([object]$raw) {
  if ($null -eq $raw) { return [uint32]0 }
  try { return [uint32]$raw } catch { }
  try { return [uint32]([int64]$raw -band 0xFFFFFFFFL) } catch { }
  return [uint32]0
}

function Set-Accent([string]$hex, [int]$prevalence) {
  $c = Convert-HexToRgb $hex
  $abgrU = ([uint32]0xFF -shl 24) -bor ([uint32]$c.b -shl 16) -bor ([uint32]$c.g -shl 8) -bor [uint32]$c.r
  $colorizationU = ([uint32]0xC4 -shl 24) -bor ([uint32]$c.b -shl 16) -bor ([uint32]$c.g -shl 8) -bor [uint32]$c.r
  $abgr = To-SignedInt32 $abgrU
  $colorization = To-SignedInt32 $colorizationU

  Set-ItemProperty -Path $DWM -Name 'AccentColor' -Value $abgr -Type DWord
  Set-ItemProperty -Path $DWM -Name 'ColorizationColor' -Value $colorization -Type DWord
  Set-ItemProperty -Path $DWM -Name 'ColorizationAfterglow' -Value $colorization -Type DWord
  Set-ItemProperty -Path $DWM -Name 'ColorPrevalence' -Value $prevalence -Type DWord
  Set-ItemProperty -Path $DWM -Name 'EnableTransparency' -Value 1 -Type DWord
  Set-ItemProperty -Path $DWM -Name 'AutoColorization' -Value 0 -Type DWord

  # Accent ladder used by Start menu / taskbar / common controls
  $factors = @(0.20, 0.38, 0.52, 0.66, 0.80, 0.90, 1.0, 1.18)
  $ladder = New-Object byte[] 32
  for ($i = 0; $i -lt 8; $i++) {
    $f = $factors[$i]
    $r = [math]::Min(255, [int]($c.r * $f))
    $g = [math]::Min(255, [int]($c.g * $f))
    $b = [math]::Min(255, [int]($c.b * $f))
    $ladder[($i * 4) + 0] = [byte]$b
    $ladder[($i * 4) + 1] = [byte]$g
    $ladder[($i * 4) + 2] = [byte]$r
    $ladder[($i * 4) + 3] = 0
  }
  try {
    Set-ItemProperty -Path $EXPLORER_ACCENT -Name 'AccentPalette' -Value $ladder -Type Binary
    Set-ItemProperty -Path $EXPLORER_ACCENT -Name 'AccentColorMenu' -Value $abgr -Type DWord
    Set-ItemProperty -Path $EXPLORER_ACCENT -Name 'StartColorMenu' -Value $abgr -Type DWord
  } catch { }

  Broadcast-Setting 'ImmersiveColorSet'
  return @{ ok = $true; action = 'accent'; hex = $hex }
}

function Set-Wallpaper([string]$file) {
  if ([string]::IsNullOrWhiteSpace($file) -or -not (Test-Path -LiteralPath $file)) {
    return @{ ok = $false; action = 'wallpaper'; error = 'file-not-found' }
  }
  Set-ItemProperty -Path $DESKTOP -Name 'WallpaperStyle' -Value '10' -Type String
  Set-ItemProperty -Path $DESKTOP -Name 'TileWallpaper' -Value '0' -Type String
  $full = (Resolve-Path -LiteralPath $file).Path
  $ok = [AuroraNative]::SystemParametersInfo(20, 0, $full, 3)
  if (-not $ok) { $ok = [AuroraNative]::SystemParametersInfo(20, 0, $full, 1) }
  return @{ ok = [bool]$ok; action = 'wallpaper'; path = $full }
}

function Get-Status {
  $light = 1
  try { $light = [int](Get-ItemProperty -Path $PERSONALIZE -Name 'AppsUseLightTheme' -ErrorAction Stop).AppsUseLightTheme } catch { }
  $accent = '#7C5CFF'
  try {
    $raw = (Get-ItemProperty -Path $DWM -Name 'AccentColor' -ErrorAction Stop).AccentColor
    $v = To-UInt32 $raw
    $r = $v -band 0xFF
    $g = ($v -shr 8) -band 0xFF
    $b = ($v -shr 16) -band 0xFF
    if (($r + $g + $b) -gt 0) { $accent = ('#{0:X2}{1:X2}{2:X2}' -f $r, $g, $b) }
  } catch { }
  $wp = ''
  try { $wp = [string](Get-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name 'WallPaper' -ErrorAction Stop).WallPaper } catch { }
  return @{ ok = $true; action = 'status'; dark = ($light -eq 0); accent = $accent; wallpaper = $wp }
}

$result = switch ($Action) {
  'dark' { Set-DarkMode $Dark }
  'accent' { Set-Accent $Hex $TaskbarAccent }
  'wallpaper' { Set-Wallpaper $Path }
  'status' { Get-Status }
  'deskicons' { Set-DesktopIcons $Value }
  'deskicons-status' { @{ ok = $true; action = 'deskicons-status'; visible = (Get-DesktopIconsVisible) } }
  'all' {
    if (-not $SkipDark) { Set-DarkMode $Dark | Out-Null }
    Set-Accent $Hex $TaskbarAccent | Out-Null
    $wpRes = if ($Path) { Set-Wallpaper $Path } else { @{ ok = $true } }
    @{ ok = $true; action = 'all'; dark = if ($SkipDark) { 'unchanged' } else { ($Dark -eq 1) }; hex = $Hex; wallpaper = $wpRes.ok }
  }
}

[Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 4))
