@echo off
:: Disable Task Scheduler auto-start so only ONE print agent runs.
:: Right-click → Run as administrator
cd /d "%~dp0"

net session >nul 2>&1
if %errorLevel% neq 0 (
  echo ERROR: Right-click → Run as administrator
  pause
  exit /b 1
)

echo Ending / disabling scheduled task ElegancePrintAgent...
schtasks /End /TN "ElegancePrintAgent" >nul 2>&1
schtasks /Change /TN "ElegancePrintAgent" /DISABLE
if %errorLevel% neq 0 (
  echo Trying delete...
  schtasks /Delete /TN "ElegancePrintAgent" /F
)

echo Stopping any running print-agent node processes...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match 'print-agent\\agent\\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host ('Killed ' + $_.ProcessId) }"

echo.
echo Done. Now start ONLY one agent: double-click run-agent-user.bat
pause

