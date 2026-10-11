@echo off
rem Stops the Open Painter dev server started by start.bat (whatever is listening on port 5178).
setlocal enabledelayedexpansion
set PORT=5178
set FOUND=
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  if not "%%p"=="!LAST!" (
    taskkill /PID %%p /T /F >nul 2>nul && set FOUND=1
    set LAST=%%p
  )
)
if defined FOUND (echo Open Painter stopped.) else (echo Open Painter was not running.)
if /i not "%~1"=="--quiet" ping -n 3 127.0.0.1 >nul
exit /b 0
