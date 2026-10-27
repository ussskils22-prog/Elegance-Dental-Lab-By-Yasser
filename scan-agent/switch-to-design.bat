@echo off
:: Reception PC moved to Design: stop scanner1, disable its task, install scanner2
:: Right-click → Run as administrator
cd /d "%~dp0"

net session >nul 2>&1
if %errorLevel% neq 0 (
  echo ERROR: Right-click this file → Run as administrator
  pause
  exit /b 1
)

echo.
echo [1/3] Stopping scanner 1 (completed)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object {" ^
  "  $c=[string]$_.CommandLine;" ^
  "  if ($c -match 'scan-agent[/\\\\]+agent\\.js' -and $c -match 'config\\.scanner1\\.json') {" ^
  "    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue;" ^
  "    Write-Host ('Stopped scanner1 PID ' + $_.ProcessId)" ^
  "  }" ^
  "}"

echo.
echo [2/3] Disabling Task EleganceScanAgent1 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Disable-ScheduledTask -TaskName 'EleganceScanAgent1' -ErrorAction SilentlyContinue;" ^
  "Unregister-ScheduledTask -TaskName 'EleganceScanAgent1' -Confirm:$false -ErrorAction SilentlyContinue;" ^
  "Write-Host 'Scanner1 autostart removed.'"

echo.
echo [3/3] Installing scanner 2 (design)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-background.ps1" -Scanner "2"

echo.
echo Done. This PC is now Design scanner (scan2).
pause
