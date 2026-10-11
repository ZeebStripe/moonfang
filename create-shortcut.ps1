# Adds "Open Painter" shortcuts to the desktop and the Start menu. They run launch.ps1, which opens the app
# in its own window and stops the server again when that window is closed.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) {
  $path = Join-Path $dir 'Open Painter.lnk'
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = Join-Path $PSHOME 'powershell.exe'
  $lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $root 'launch.ps1')`""
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = Join-Path $root 'icon.ico'
  $lnk.WindowStyle = 7 # minimised: no console flash
  $lnk.Description = 'Open Painter'
  $lnk.Save()
  Write-Host "Created $path"
}
