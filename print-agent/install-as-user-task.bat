@echo off
:: Auto-start print agent at USER logon (USB printers need user session, not LocalSystem).
:: Prefer: double-click this file WHILE LOGGED IN (Admin optional).
cd /d "%~dp0"

if not exist "config.json" (
  echo ERROR: config.json missing.
  pause
  exit /b 1
)

echo Stopping LocalSystem Windows service if present (needs Admin; ignore errors)...
sc stop eleganceprintagent.exe >nul 2>&1
sc config eleganceprintagent.exe start= disabled >nul 2>&1

where node >nul 2>&1
if %errorLevel% neq 0 (
  if exist "C:\Program Files\nodejs\node.exe" (
    set "PATH=C:\Program Files\nodejs;%PATH%"
  ) else (
    echo ERROR: Node.js not found. Install Node then retry.
    pause
    exit /b 1
  )
)

echo Installing dependencies...
call npm install
if %errorLevel% neq 0 (
  echo npm install failed.
  pause
  exit /b 1
)

if not exist "daemon" mkdir daemon

set "RUN_BAT=%~dp0run-agent-user.bat"

echo Creating Desktop shortcut (this PC blocks Startup/Registry sometimes)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$desk=[Environment]::GetFolderPath('Desktop'); $ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut((Join-Path $desk 'ElegancePrintAgent.lnk')); $s.TargetPath='%~dp0run-agent-user.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save(); Write-Host ('OK Desktop: ' + (Join-Path $desk 'ElegancePrintAgent.lnk'))"

echo.
echo Optional auto-start (ignore Access denied — Desktop shortcut is enough):
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "ElegancePrintAgent" /t REG_SZ /d "\"%RUN_BAT%\"" /f >nul 2>&1
schtasks /Delete /TN "ElegancePrintAgent" /F >nul 2>&1
schtasks /Create /TN "ElegancePrintAgent" /TR "\"%RUN_BAT%\"" /SC ONLOGON /RL LIMITED /F >nul 2>&1
echo (If both failed: after each reboot double-click Desktop\ElegancePrintAgent)

echo.
echo Stopping any old agent window, then starting now...
taskkill /FI "WINDOWTITLE eq ElegancePrintAgent*" /F >nul 2>&1
start "ElegancePrintAgent" /MIN "%RUN_BAT%"

echo.
echo Done.
echo  - Agent started minimized (look for node in Task Manager)
echo  - Will auto-start at next login via Startup folder
echo  - Printer in config: HP LaserJet Professional P1102
echo  - Logs: daemon\user-agent.out.log  and  daemon\agent-live.log
echo  - Do NOT use install-as-service.bat for this USB printer
echo.
echo Now reprint one case from Secretary and watch the HP printer.
pause

