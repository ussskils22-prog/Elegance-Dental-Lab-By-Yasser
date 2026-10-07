#Requires -RunAsAdministrator
# Installs the ALWAYS-ON print supervisor (UI can start/stop the agent).
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

if (-not (Test-Path (Join-Path $dir 'config.json'))) {
  Write-Host 'ERROR: config.json missing.'
  exit 1
}

$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source } else {
    Write-Host 'ERROR: Node.js not found.'
    exit 1
  }
}

Write-Host 'Stopping / disabling old LocalSystem service...'
try { Stop-Service -Name 'eleganceprintagent.exe' -Force -ErrorAction SilentlyContinue } catch {}
try { & sc.exe config eleganceprintagent.exe start= disabled | Out-Null } catch {}
try { & $node (Join-Path $dir 'uninstall-service.js') 2>$null } catch {}

Write-Host 'Stopping any running agent/supervisor...'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  $cmd = [string]$_.CommandLine
  if ($cmd -match 'print-agent[/\\]+(agent|supervisor)\.js') {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

Write-Host 'npm install...'
& npm install
if ($LASTEXITCODE -ne 0) {
  Write-Host 'npm install failed'
  exit 1
}

$daemon = Join-Path $dir 'daemon'
New-Item -ItemType Directory -Force -Path $daemon | Out-Null

$runBat = Join-Path $dir 'run-supervisor.bat'
$wrapper = Join-Path $dir 'run-agent-hidden.vbs'

$vbsLines = @(
  'Set sh = CreateObject("WScript.Shell")'
  ('sh.CurrentDirectory = "' + $dir + '"')
  ('sh.Run """' + $runBat + '""", 0, False')
)
Set-Content -Path $wrapper -Value $vbsLines -Encoding ASCII

$taskName = 'ElegancePrintAgent'
$userId = $env:USERDOMAIN + '\' + $env:USERNAME

Write-Host ("Creating Task Scheduler task '" + $taskName + "' for " + $userId + " ...")
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $wrapper + '"') -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Write-Host 'Starting supervisor now (hidden)...'
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 4

$t = Get-ScheduledTask -TaskName $taskName
Write-Host ''
Write-Host 'Done.'
Write-Host ('  Task: ' + $t.TaskName + '  State: ' + $t.State)
Write-Host '  Supervisor stays on at login. Agent auto-starts (config AUTO_START_AGENT).'
Write-Host '  In the website: use تشغيل الطباعة / إيقاف الطباعة'
Write-Host ('  Control API: http://127.0.0.1:17891/status')
Write-Host ('  Logs: ' + (Join-Path $daemon 'supervisor.log'))
Write-Host ''
Write-Host 'Do NOT use install-as-service.bat (LocalSystem breaks USB print).'
