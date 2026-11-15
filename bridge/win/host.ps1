# JARVIS's hands on the Windows PC the bridge runs on (bridge/media.mjs).
#
# One long-lived Windows PowerShell 5.1 process: one JSON request per line on
# stdin, one JSON answer per line on stdout. Kept alive by the bridge so a
# button press costs a pipe write, not the half second PowerShell takes to
# start. Windows PowerShell, not pwsh 7: only 5.1 projects WinRT types.
#
# Media goes through the System Media Transport Controls — the same sessions
# the volume flyout shows — so it works for Spotify, a browser tab, any player
# that reports itself, with nothing installed. When no session exists the
# media keys are pressed instead.
#
# Must run in the logged-in user's session: as a service (session 0) there are
# no media sessions to see.

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Await($op, [Type]$type) {
  $task = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(5000)) { throw 'Windows did not answer in time' }
  $task.Result
}

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime]
$ManagerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$PropsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]

Add-Type -Namespace Jarvis -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);
[DllImport("user32.dll")] public static extern bool LockWorkStation();
[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr hWnd, uint msg, System.IntPtr w, System.IntPtr l);
'@

# The default output device's volume, through Core Audio. The interfaces are
# declared in vtable order; the unnamed methods are the ones not called.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Jarvis {
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int f(); int g(); int h(); int i();
    int SetMasterVolumeLevelScalar(float level, Guid ctx);
    int j();
    int GetMasterVolumeLevelScalar(out float level);
    int k(); int l(); int m(); int n();
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx);
    int GetMute(out bool mute);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid id, int ctx, IntPtr p, out IAudioEndpointVolume v); }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
  public static class Audio {
    static IAudioEndpointVolume Vol() {
      var e = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      IMMDevice d; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out d));
      IAudioEndpointVolume v; var id = typeof(IAudioEndpointVolume).GUID;
      Marshal.ThrowExceptionForHR(d.Activate(ref id, 23, IntPtr.Zero, out v));
      return v;
    }
    public static float Level {
      get { float x; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out x)); return x; }
      set { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(value, Guid.Empty)); }
    }
    public static bool Muted {
      get { bool x; Marshal.ThrowExceptionForHR(Vol().GetMute(out x)); return x; }
      set { Marshal.ThrowExceptionForHR(Vol().SetMute(value, Guid.Empty)); }
    }
  }
}
'@

function Tap([byte]$vk) {
  # KEYEVENTF_EXTENDEDKEY, then the same with KEYEVENTF_KEYUP.
  [Jarvis.Native]::keybd_event($vk, 0, 1, [UIntPtr]::Zero)
  [Jarvis.Native]::keybd_event($vk, 0, 3, [UIntPtr]::Zero)
}

$script:mgr = $null
function Manager {
  if (-not $script:mgr) { $script:mgr = Await ($ManagerType::RequestAsync()) $ManagerType }
  $script:mgr
}

# The session asked for by app (a substring of its app id, e.g. "spotify"), or
# the one Windows itself considers current, or any.
function Pick([string]$app) {
  $m = Manager
  if ($app) {
    $want = $app.ToLowerInvariant()
    foreach ($s in $m.GetSessions()) {
      if ($s.SourceAppUserModelId.ToLowerInvariant().Contains($want)) { return $s }
    }
    return $null
  }
  $current = $m.GetCurrentSession()
  if ($current) { return $current }
  foreach ($s in $m.GetSessions()) { return $s }
  return $null
}

$script:artKey = $null
$script:art = $null

function ReadArt($thumb) {
  $stream = Await ($thumb.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  $type = if ($stream.ContentType) { $stream.ContentType } else { 'image/png' }
  $size = [uint32]$stream.Size
  if ($size -le 0 -or $size -gt 2MB) { return $null }
  $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
  $null = Await ($reader.LoadAsync($size)) ([uint32])
  $bytes = New-Object byte[] $size
  $reader.ReadBytes($bytes)
  $reader.Dispose()
  $stream.Dispose()
  "data:$type;base64," + [Convert]::ToBase64String($bytes)
}

function Info($s, [bool]$withArt) {
  if (-not $s) { return $null }
  $p = Await ($s.TryGetMediaPropertiesAsync()) $PropsType
  $status = "$($s.GetPlaybackInfo().PlaybackStatus)".ToLowerInvariant()
  $tl = $s.GetTimelineProperties()
  $position = $tl.Position.TotalSeconds
  # Players report the position when it changes state, not continuously.
  if ($status -eq 'playing' -and $tl.LastUpdatedTime.Year -gt 2000) {
    $position += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalSeconds
  }
  $duration = $tl.EndTime.TotalSeconds
  if ($duration -gt 0 -and $position -gt $duration) { $position = $duration }
  $key = "$($s.SourceAppUserModelId)|$($p.Title)|$($p.Artist)|$($p.AlbumTitle)"
  $art = $null
  if ($withArt -and $p.Thumbnail) {
    if ($script:artKey -ne $key) {
      try {
        $fresh = ReadArt $p.Thumbnail
        if ($fresh) { $script:art = $fresh; $script:artKey = $key }
      } catch { }
    }
    if ($script:artKey -eq $key) { $art = $script:art }
  }
  [ordered]@{
    appId    = $s.SourceAppUserModelId
    title    = $p.Title
    artist   = $p.Artist
    album    = $p.AlbumTitle
    status   = $status
    position = [math]::Round($position, 1)
    duration = [math]::Round($duration, 1)
    artKey   = $key
    art      = $art
  }
}

function Sessions {
  $list = New-Object System.Collections.ArrayList
  foreach ($s in (Manager).GetSessions()) {
    try { $null = $list.Add((Info $s $false)) } catch { }
  }
  , $list
}

# VK_MEDIA_NEXT_TRACK, VK_MEDIA_PREV_TRACK, VK_MEDIA_PLAY_PAUSE.
$MediaKeys = @{ next = 0xB0; previous = 0xB1; play_pause = 0xB3; play = 0xB3; pause = 0xB3 }

function Media([string]$op, [string]$app) {
  $s = Pick $app
  if (-not $s) {
    if ($app) { throw "No media session from $app" }
    Tap ([byte]$MediaKeys[$op])
    return [ordered]@{ ok = $true; via = 'key' }
  }
  $call = switch ($op) {
    'play' { $s.TryPlayAsync() }
    'pause' { $s.TryPauseAsync() }
    'play_pause' { $s.TryTogglePlayPauseAsync() }
    'next' { $s.TrySkipNextAsync() }
    'previous' { $s.TrySkipPreviousAsync() }
  }
  $ok = Await $call ([bool])
  [ordered]@{ ok = [bool]$ok; via = 'smtc'; appId = $s.SourceAppUserModelId }
}

function Volume($req) {
  if ($null -ne $req.level) { [Jarvis.Audio]::Level = [float]([math]::Max(0, [math]::Min(100, [double]$req.level)) / 100) }
  if ($null -ne $req.mute) { [Jarvis.Audio]::Muted = [bool]$req.mute }
  [ordered]@{ level = [int][math]::Round([Jarvis.Audio]::Level * 100); muted = [Jarvis.Audio]::Muted }
}

# An app from the Start menu, by name: exact, then starts-with, then contains.
function OpenApp([string]$name) {
  $apps = @(Get-StartApps)
  $hit = $apps | Where-Object { $_.Name -eq $name } | Select-Object -First 1
  if (-not $hit) { $hit = $apps | Where-Object { $_.Name -like "$name*" } | Select-Object -First 1 }
  if (-not $hit) { $hit = $apps | Where-Object { $_.Name -like "*$name*" } | Select-Object -First 1 }
  if (-not $hit) { throw "No app called $name in the Start menu" }
  Start-Process "shell:AppsFolder\$($hit.AppID)"
  [ordered]@{ opened = $hit.Name }
}

function Dispatch($req) {
  switch ([string]$req.op) {
    'ping' { return [ordered]@{ ok = $true; ps = "$($PSVersionTable.PSVersion)" } }
    'now_playing' { return (Info (Pick ([string]$req.app)) ([bool]$req.art)) }
    'sessions' { return , (Sessions) }
    'volume' { return (Volume $req) }
    'lock' { $null = [Jarvis.Native]::LockWorkStation(); return [ordered]@{ ok = $true } }
    # WM_SYSCOMMAND / SC_MONITORPOWER / off, to every window. Posted, not sent:
    # a broadcast SendMessage waits on every hung window on the desktop.
    'display_off' { $null = [Jarvis.Native]::PostMessage([IntPtr]0xFFFF, 0x0112, [IntPtr]0xF170, [IntPtr]2); return [ordered]@{ ok = $true } }
    'sleep' {
      Add-Type -AssemblyName System.Windows.Forms
      $null = [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)
      return [ordered]@{ ok = $true }
    }
    'open_app' { return (OpenApp ([string]$req.app)) }
    'open_url' {
      $u = [string]$req.url
      if ($u -notmatch '^https?://') { throw 'Only http and https links' }
      Start-Process $u
      return [ordered]@{ opened = $u }
    }
    { $MediaKeys.ContainsKey($_) } { return (Media ([string]$req.op) ([string]$req.app)) }
  }
  throw "unknown op: $($req.op)"
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $out = [ordered]@{ id = $id; ok = $true; result = (Dispatch $req) }
  } catch {
    $msg = $_.Exception.Message
    if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
    $out = [ordered]@{ id = $id; ok = $false; error = "$msg" }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
