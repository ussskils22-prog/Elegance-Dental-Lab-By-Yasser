@echo off
:: Elegance Station Supervisor - double-click ONCE per PC. No administrator needed.
:: Afterwards control printers / scanners from the website menu (Devices).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
