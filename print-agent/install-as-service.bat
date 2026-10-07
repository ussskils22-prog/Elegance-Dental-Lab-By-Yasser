@echo off
:: DEPRECATED for USB printers: LocalSystem cannot print to USB (HP P1102).
:: Prefer: install-as-user-task.bat
cd /d "%~dp0"

echo WARNING: Windows Service (LocalSystem) often cannot print to USB printers.
echo Prefer running install-as-user-task.bat instead.
echo.
choice /C YN /M "Continue installing LocalSystem service anyway"
if errorlevel 2 exit /b 0

net session >nul 2>&1
if %errorLevel% neq 0 (
  echo ERROR: Run this file as Administrator.
  pause
  exit /b 1
)

if not exist "config.json" (
  echo ERROR: config.json missing. Copy and set SERVER_URL / PRINT_AGENT_SECRET / PRINTER_NAME.
  pause
  exit /b 1
)

echo Installing dependencies...
call npm install
if %errorLevel% neq 0 (
  echo npm install failed.
  pause
  exit /b 1
)

echo Installing Windows service ElegancePrintAgent...
node install-service.js
echo.
echo Done. Check services.msc for ElegancePrintAgent.
pause
