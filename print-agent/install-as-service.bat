@echo off
:: Install ElegancePrintAgent as a Windows service (run as Administrator)
cd /d "%~dp0"

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
