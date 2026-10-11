# Opens Moonfang as a desktop app in the system's default browser: starts the dev server hidden, shows the app
# in a window of its own and runs stop.bat once that window is closed.
#  - Chromium browsers (Edge, Chrome, Brave, Vivaldi): app mode, no tabs or address bar.
#  - Firefox (no app mode): a separate profile whose tab strip and toolbars are hidden.
# Run through the desktop shortcut made by create-shortcut.bat.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$port = 5178
$url = "http://localhost:$port"
$dataDir = Join-Path $env:LOCALAPPDATA 'Moonfang'

Add-Type -AssemblyName System.Windows.Forms
function Fail($msg) {
  [System.Windows.Forms.MessageBox]::Show($msg, 'Moonfang', 'OK', 'Error') | Out-Null
  exit 1
}

function Test-Listening {
  [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

# The executable the system opens http links with, or $null.
function Get-DefaultBrowser {
  try {
    $progId = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice').ProgId
    $cmd = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\$progId\shell\open\command").'(default)'
    if ($cmd -match '^\s*"([^"]+)"' -or $cmd -match '^\s*(\S+)') { if (Test-Path $Matches[1]) { return $Matches[1] } }
  } catch {}
  $null
}

$CHROMIUM = 'msedge', 'chrome', 'brave', 'vivaldi', 'chromium'
$FIREFOX = 'firefox', 'librewolf', 'waterfox', 'floorp', 'zen'

$browser = Get-DefaultBrowser
$kind = if (-not $browser) { $null } else {
  $exe = [IO.Path]::GetFileNameWithoutExtension($browser).ToLower()
  if ($CHROMIUM -contains $exe) { 'chromium' } elseif ($FIREFOX -contains $exe) { 'firefox' }
}
if (-not $kind) {
  # Unknown or no default browser: fall back to Edge / Chrome app mode.
  $browser = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $browser) { Fail 'Set Firefox, Chrome or Edge as the default browser to run Moonfang as an app.' }
  $kind = 'chromium'
}

# A browser profile of its own: the app window is then a separate browser process we can wait for.
if ($kind -eq 'chromium') {
  $profileDir = Join-Path $dataDir 'browser-profile'
  $browserArgs = @("--app=$url", "--user-data-dir=$profileDir", '--no-first-run', '--no-default-browser-check', '--start-maximized')
} else {
  $profileDir = Join-Path $dataDir 'firefox-profile'
  $browserArgs = @('-profile', "`"$profileDir`"", '-new-window', $url)
}

function Get-AppBrowser {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*$profileDir*" }
}

function Test-AppWindow {
  [bool](Get-AppBrowser | Where-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).MainWindowHandle -ne 0 })
}

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
  $log = Join-Path $env:TEMP 'moonfang-server.log'
  Start-Process cmd -ArgumentList '/c', "npx vite --port $port --strictPort > `"$log`" 2>&1" -WorkingDirectory $root -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Listening)) {
    if ((Get-Date) -gt $deadline) { Fail "The server did not start. See $log for details." }
    Start-Sleep -Milliseconds 250
  }
}

# Profile setup, only while the browser is not running on it (browsers rewrite these files on exit).
$utf8 = New-Object System.Text.UTF8Encoding $false
if (-not (Get-AppBrowser)) {
  try {
    New-Item -ItemType Directory -Force $profileDir | Out-Null
    if ($kind -eq 'chromium') {
      # Chromium keeps running in the background after its last window closes unless told not to.
      $localState = Join-Path $profileDir 'Local State'
      $state = if (Test-Path $localState) { [IO.File]::ReadAllText($localState) | ConvertFrom-Json } else { [pscustomobject]@{} }
      foreach ($key in 'background_mode', 'startup_boost') {
        if (-not $state.$key) { $state | Add-Member -NotePropertyName $key -NotePropertyValue ([pscustomobject]@{}) -Force }
        $state.$key | Add-Member -NotePropertyName enabled -NotePropertyValue $false -Force
      }
      [IO.File]::WriteAllText($localState, ($state | ConvertTo-Json -Depth 64 -Compress), $utf8)
    } else {
      # No welcome pages or prompts; the native title bar so hiding the tab strip keeps the window buttons.
      $prefs = @{
        'toolkit.legacyUserProfileCustomizations.stylesheets' = 'true'
        'browser.tabs.inTitlebar' = '0'
        'browser.shell.checkDefaultBrowser' = 'false'
        'browser.aboutwelcome.enabled' = 'false'
        'trailhead.firstrun.didSeeAboutWelcome' = 'true'
        'datareporting.policy.dataSubmissionPolicyBypassNotification' = 'true'
        'toolkit.telemetry.reportingpolicy.firstRun' = 'false'
        'browser.startup.homepage_override.mstone' = '"ignore"'
        'startup.homepage_welcome_url' = '""'
        'startup.homepage_welcome_url.additional' = '""'
        'browser.sessionstore.resume_from_crash' = 'false'
        'browser.startup.page' = '0'
        'browser.tabs.warnOnClose' = 'false'
        'browser.warnOnQuit' = 'false'
        'browser.toolbars.bookmarks.visibility' = '"never"'
        'sidebar.revamp' = 'false'
        'sidebar.verticalTabs' = 'false'
      }
      $userJs = ($prefs.GetEnumerator() | Sort-Object Name | ForEach-Object { "user_pref(`"$($_.Name)`", $($_.Value));" }) -join "`n"
      [IO.File]::WriteAllText((Join-Path $profileDir 'user.js'), "// Written by Moonfang's launch.ps1`n$userJs`n", $utf8)
      New-Item -ItemType Directory -Force (Join-Path $profileDir 'chrome') | Out-Null
      [IO.File]::WriteAllText((Join-Path $profileDir 'chrome\userChrome.css'), @'
/* Written by Moonfang's launch.ps1: only the page, like an app window. */
#TabsToolbar, #nav-bar, #PersonalToolbar, #sidebar-main, #sidebar-box, #sidebar-splitter { visibility: collapse !important; }
'@, $utf8)
      # Open maximised the first time (Firefox remembers the window state afterwards).
      $xul = Join-Path $profileDir 'xulstore.json'
      if (-not (Test-Path $xul)) {
        [IO.File]::WriteAllText($xul, '{"chrome://browser/content/browser.xhtml":{"main-window":{"sizemode":"maximized"}}}', $utf8)
      }
    }
  } catch {}
}

Start-Process $browser -ArgumentList $browserArgs
# Wait for the app window to appear, then for the last one to close.
$deadline = (Get-Date).AddSeconds(30)
while (-not (Test-AppWindow) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
while (Test-AppWindow) { Start-Sleep -Seconds 1 }

& (Join-Path $root 'stop.bat') --quiet | Out-Null
