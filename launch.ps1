# Opens Open Painter as a desktop app: starts the dev server hidden, shows the app in its own Edge/Chrome
# window (no tabs or address bar) and runs stop.bat once that window is closed.
# Run through the desktop shortcut made by create-shortcut.bat.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$port = 5178
$url = "http://localhost:$port"
# A browser profile of its own: the app window is then a separate browser process we can wait for.
$profileDir = Join-Path $env:LOCALAPPDATA 'OpenPainter\browser-profile'

Add-Type -AssemblyName System.Windows.Forms
function Fail($msg) {
  [System.Windows.Forms.MessageBox]::Show($msg, 'Open Painter', 'OK', 'Error') | Out-Null
  exit 1
}

function Test-Listening {
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Get-AppBrowser {
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$profileDir*" }
}

function Test-AppWindow {
  [bool](Get-AppBrowser | Where-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).MainWindowHandle -ne 0 })
}

$browser = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { Fail 'Microsoft Edge or Google Chrome is needed to run Open Painter as an app.' }

$browserArgs = @("--app=$url", "--user-data-dir=$profileDir", '--no-first-run', '--no-default-browser-check', '--start-maximized')

# Already open: just bring up another window; the first launcher stops the server when the last one closes.
if ((Test-AppWindow) -and (Test-Listening)) {
  Start-Process $browser -ArgumentList $browserArgs
  exit 0
}

if (-not (Test-Listening)) {
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'Node.js is not installed. Get it from https://nodejs.org and try again.' }
  if (-not (Test-Path (Join-Path $root 'node_modules'))) {
    # First run: show the install so it is clear something is happening.
    $p = Start-Process cmd -ArgumentList '/c', 'echo Installing dependencies, this takes a minute the first time... && npm install' -WorkingDirectory $root -Wait -PassThru
    if ($p.ExitCode -ne 0) { Fail 'npm install failed. Run start.bat to see the error.' }
  }
  $log = Join-Path $env:TEMP 'open-painter-server.log'
  Start-Process cmd -ArgumentList '/c', "npx vite --port $port --strictPort > `"$log`" 2>&1" -WorkingDirectory $root -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Listening)) {
    if ((Get-Date) -gt $deadline) { Fail "The server did not start. See $log for details." }
    Start-Sleep -Milliseconds 250
  }
}

# Edge keeps running in the background after its last window closes unless told not to.
# (Only while it is not running: it rewrites the file on exit.)
if (-not (Get-AppBrowser)) {
  try {
    New-Item -ItemType Directory -Force $profileDir | Out-Null
    $localState = Join-Path $profileDir 'Local State'
    $state = if (Test-Path $localState) { Get-Content $localState -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
    foreach ($key in 'background_mode', 'startup_boost') {
      if (-not $state.$key) { $state | Add-Member -NotePropertyName $key -NotePropertyValue ([pscustomobject]@{}) -Force }
      $state.$key | Add-Member -NotePropertyName enabled -NotePropertyValue $false -Force
    }
    [IO.File]::WriteAllText($localState, ($state | ConvertTo-Json -Depth 64 -Compress))
  } catch {}
}

Start-Process $browser -ArgumentList $browserArgs
# Wait for the app window to appear, then for the last one to close.
$deadline = (Get-Date).AddSeconds(30)
while (-not (Test-AppWindow) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
while (Test-AppWindow) { Start-Sleep -Seconds 1 }

& (Join-Path $root 'stop.bat') --quiet | Out-Null
