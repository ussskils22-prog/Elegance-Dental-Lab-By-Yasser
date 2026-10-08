@echo off
:: Starts the local supervisor (if needed) then starts the print agent via it.
:: Prefer using the in-app buttons: تشغيل الطباعة / إيقاف الطباعة
title ElegancePrintAgent
cd /d "%~dp0"
if not exist "daemon" mkdir daemon

set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"

:: Ensure supervisor is up (UI talks to http://127.0.0.1:17891)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$alive=$false; try { $r=Invoke-WebRequest -Uri 'http://127.0.0.1:17891/status' -UseBasicParsing -TimeoutSec 2; if($r.StatusCode -eq 200){$alive=$true} } catch {}; if(-not $alive){ Start-Process -FilePath '%NODE%' -ArgumentList '\"%~dp0supervisor.js\"' -WorkingDirectory '%~dp0' -WindowStyle Hidden }"

timeout /t 2 /nobreak >nul

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Invoke-WebRequest -Uri 'http://127.0.0.1:17891/start' -Method POST -UseBasicParsing -TimeoutSec 8 | Out-Null; Write-Host 'Print agent start requested.' } catch { Write-Host 'Supervisor not reachable. Run install-background.bat as Admin once.' }"

echo.
echo Supervisor + agent should be running. You can close this window.
echo Use the website buttons to start/stop printing.
timeout /t 4 /nobreak >nul

