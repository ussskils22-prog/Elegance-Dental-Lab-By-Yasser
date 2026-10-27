#Requires -RunAsAdministrator
# Autostart Elegance scan agent at Windows logon (hidden). ASCII-only file.
param(
  [ValidateSet('1', '2', '3')]
  [string]$Scanner = '1'
)

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

$configName = "config.scanner$Scanner.json"
$configPath = Join-Path $dir $configName
$examplePath = Join-Path $dir "config.scanner$Scanner.example.json"

if (-not (Test-Path $configPath)) {
  if (Test-Path $examplePath) {
    Copy-Item $examplePath $configPath -Force
    Write-Host "Created $configName - edit EMAIL/PASSWORD then run installer again."
    Start-Process notepad.exe -ArgumentList $configPath -Wait
  } else {
    Write-Host "ERROR: missing $configName"
    exit 1
  }
}

$cfg = Get-Content $configPath -Raw | ConvertFrom-Json
if (-not $cfg.EMAIL -or -not $cfg.PASSWORD -or ($cfg.SERVER_URL -match 'YOUR-|change-me')) {
  Write-Host "ERROR: Fill SERVER_URL / EMAIL / PASSWORD in $configName first."
  Start-Process notepad.exe -ArgumentList $configPath -Wait
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

Write-Host ("Stopping scan agent for scanner $Scanner only...")
$configLeaf = [regex]::Escape($configName)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  $cmdLine = [string]$_.CommandLine
  if ($cmdLine -match 'scan-agent[/\\]+agent\.js' -and $cmdLine -match $configLeaf) {
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

# Dedicated bat (no args) so VBS quoting works with spaces in the path
$runBat = Join-Path $dir ("run-scanner" + $Scanner + ".bat")
$wrapper = Join-Path $dir ("run-scanner" + $Scanner + "-hidden.vbs")
$vbsLines = @(
  'Set sh = CreateObject("WScript.Shell")'
  ('sh.CurrentDirectory = "' + $dir + '"')
  ('sh.Run """' + $runBat + '""", 0, False')
)
Set-Content -Path $wrapper -Value $vbsLines -Encoding Ascii

$taskName = "EleganceScanAgent$Scanner"
$userId = $env:USERDOMAIN + '\' + $env:USERNAME

Write-Host ("Creating task " + $taskName + " for " + $userId + " ...")
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $wrapper + '"') -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Write-Host 'Starting scan agent now (hidden)...'
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3

$t = Get-ScheduledTask -TaskName $taskName
Write-Host ''
Write-Host 'Done.'
Write-Host ('  Task: ' + $t.TaskName + '  State: ' + $t.State)
Write-Host ('  Config: ' + $configName)
Write-Host ('  Logs: ' + (Join-Path $daemon ("scanner$Scanner.out.log")))
Write-Host '  Agent starts automatically at Windows login.'
