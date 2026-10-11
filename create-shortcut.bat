@echo off
rem Adds "Open Painter" shortcuts to the desktop and the Start menu (see create-shortcut.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1"
pause
