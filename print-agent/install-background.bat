@echo off
:: Install print agent to run HIDDEN in background at login (no window).
:: Right-click → Run as administrator
cd /d "%~dp0"

net session >nul 2>&1
if %errorLevel% neq 0 (
  echo ERROR: Right-click this file → Run as administrator
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-background.ps1"
echo.
pause
