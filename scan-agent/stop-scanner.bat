@echo off
:: Stop scan agent(s). Optional: stop-scanner.bat 1 | 2 | 3
:: No arg = stop all scan agents on this PC
cd /d "%~dp0"
set "SCANNER=%~1"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$n='%SCANNER%';" ^
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object {" ^
  "  $c=[string]$_.CommandLine;" ^
  "  if ($c -notmatch 'scan-agent[/\\\\]+agent\\.js') { return };" ^
  "  if ($n -ne '' -and $c -notmatch [regex]::Escape('config.scanner'+$n+'.json')) { return };" ^
  "  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue;" ^
  "  Write-Host ('Stopped PID ' + $_.ProcessId)" ^
  "}"

if "%SCANNER%"=="" (
  echo Done. All scan agents stopped.
) else (
  echo Done. Scanner %SCANNER% stopped.
)
echo.
echo Note: if Task Scheduler still has EleganceScanAgent%SCANNER%, it may restart at next login.
echo To disable autostart: Task Scheduler -^> EleganceScanAgent%SCANNER% -^> Disable
pause
