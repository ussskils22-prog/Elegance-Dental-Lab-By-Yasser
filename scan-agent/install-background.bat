@echo off
:: Install scan agent to run HIDDEN at Windows login.
:: Default: scanner 1 (completed). Or: install-background.bat 2 | 3
:: Shortcuts: install-scanner2.bat / install-scanner3.bat
:: Right-click → Run as administrator
cd /d "%~dp0"

set "SCANNER=%~1"
if "%SCANNER%"=="" set "SCANNER=1"

net session >nul 2>&1
if %errorLevel% neq 0 (
  echo ERROR: Right-click this file → Run as administrator
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-background.ps1" -Scanner "%SCANNER%"
echo.
pause
