@echo off
rem Starts Moonfang (dev server on http://localhost:5178) and opens it in the browser.
rem Usage: double-click, or "start.bat --no-browser" to only start the server.
setlocal
cd /d "%~dp0"
set PORT=5178
set URL=http://localhost:%PORT%

where npm >nul 2>nul || (
  echo Node.js is not installed. Get it from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies, this takes a minute the first time...
  call npm install || ( echo npm install failed. & pause & exit /b 1 )
)

netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul && (
  echo Moonfang is already running at %URL%
  goto open
)

echo Starting Moonfang...
rem The server runs in its own minimised window; stop.bat (or closing that window) stops it.
start "Moonfang server" /min cmd /c "npx vite --port %PORT% --strictPort"

rem Wait up to 30 s for the server to listen.
for /l %%i in (1,1,30) do (
  netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul && goto ready
  ping -n 2 127.0.0.1 >nul
)
echo The server did not start. Check the "Moonfang server" window for errors.
pause
exit /b 1

:ready
echo Moonfang is running at %URL%

:open
if /i "%~1"=="--no-browser" exit /b 0
start "" %URL%
exit /b 0
