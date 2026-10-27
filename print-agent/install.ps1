# Elegance Station Supervisor - one-time install for the CURRENT USER (no administrator needed).
# Registers the supervisor to start hidden at Windows logon and starts it now.
# After this, everything (print agent, receipt printer, scanners) is controlled from the website.
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

if (-not (Test-Path (Join-Path $dir 'config.json'))) {
  Write-Host 'ERROR: config.json missing next to install.ps1'
  exit 1
}

$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source } else {
    Write-Host 'ERROR: Node.js not found. Install Node.js LTS from https://nodejs.org then run again.'
    exit 1
  }
}

Write-Host 'Stopping any running supervisor / agent...'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  $c = [string]$_.CommandLine
  if ($c -match 'print-agent[/\\]+(agent|supervisor)\.js') {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

if (-not (Test-Path (Join-Path $dir 'node_modules'))) {
  Write-Host 'npm install (first time only)...'
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Write-Host 'npm install failed'; exit 1 }
}

# Scan agent next to us? install its deps too so the supervisor can start scanners.
$scanDir = Join-Path (Split-Path -Parent $dir) 'scan-agent'
if ((Test-Path (Join-Path $scanDir 'agent.js')) -and -not (Test-Path (Join-Path $scanDir 'node_modules'))) {
  Write-Host 'npm install for scan-agent...'
  Push-Location $scanDir
  & npm install --no-audit --no-fund
  Pop-Location
}

New-Item -ItemType Directory -Force -Path (Join-Path $dir 'daemon') | Out-Null

$runBat = Join-Path $dir 'run-supervisor.bat'
$wrapper = Join-Path $dir 'run-agent-hidden.vbs'
$vbsLines = @(
  'Set sh = CreateObject("WScript.Shell")'
  ('sh.CurrentDirectory = "' + $dir + '"')
  ('sh.Run """' + $runBat + '""", 0, False')
)
Set-Content -Path $wrapper -Value $vbsLines -Encoding ASCII

# 1) Try a per-user scheduled task (works without elevation when RunLevel is Limited)
$taskName = 'EleganceStationSupervisor'
$registered = $false
try {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName 'ElegancePrintAgent' -Confirm:$false -ErrorAction SilentlyContinue
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $wrapper + '"') -WorkingDirectory $dir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  $registered = $true
  Write-Host ('Scheduled task ' + $taskName + ' registered for ' + $env:USERNAME)
} catch {
  Write-Host ('Scheduled task not available (' + $_.Exception.Message + ') - using Startup folder instead.')
}

# 2) Always also drop a shortcut in the user's Startup folder (never needs admin)
$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'Elegance Station Supervisor.lnk'
try {
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath = 'wscript.exe'
  $lnk.Arguments = '"' + $wrapper + '"'
  $lnk.WorkingDirectory = $dir
  $lnk.WindowStyle = 7
  $lnk.Save()
  Write-Host ('Startup shortcut: ' + $lnkPath)
} catch {
  Write-Host ('Startup shortcut failed: ' + $_.Exception.Message)
}

Write-Host 'Starting supervisor now (hidden)...'
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $wrapper + '"') -WorkingDirectory $dir -WindowStyle Hidden
Start-Sleep -Seconds 3

try {
  $st = Invoke-RestMethod -Uri 'http://127.0.0.1:17891/status' -TimeoutSec 5
  Write-Host ''
  Write-Host 'Done. Supervisor is running.'
  Write-Host ('  Print agent managed: ' + $st.print.installed + '  running: ' + $st.print.running)
  Write-Host ('  Scanners installed here: ' + (($st.scanners | Where-Object { $_.installed } | ForEach-Object { $_.id }) -join ', '))
} catch {
  Write-Host ''
  Write-Host 'Supervisor started but did not answer yet - open the website in 10 seconds and check the Devices menu.'
}
Write-Host ''
Write-Host 'From now on use the website: menu (three lines) -> Devices.'
