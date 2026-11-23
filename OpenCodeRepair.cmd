@echo off
rem Double-click launcher for OpenCodeRepair.ps1 (bypasses execution policy).
rem Any arguments are forwarded, e.g.:  OpenCodeRepair.cmd doctor
setlocal
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0OpenCodeRepair.ps1" %*
echo.
pause
