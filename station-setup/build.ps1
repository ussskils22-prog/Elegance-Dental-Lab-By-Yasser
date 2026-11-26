# Builds station-setup\dist\OCCLA-Station-Setup.exe (run on a developer PC with Node + internet).
#   powershell -ExecutionPolicy Bypass -File station-setup\build.ps1
# The .exe carries: setup.ps1 (the window), station.json (server + lab name + version) and
# payload.zip (print-agent + scan-agent with their node_modules + a private node.exe).
# Lab PCs need nothing installed beforehand — not even Node.js.
param(
  [string]$Server = 'https://elegance-dental-lab-by-yasser-production-5940.up.railway.app',
  [string]$LabName = 'OCCLA Dental Lab',
  [string]$Version = (Get-Date -Format 'yyyy.MM.dd.HHmm')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$setupDir = Join-Path $root 'station-setup'
$work = Join-Path $env:TEMP 'occla-station-build'
$stage = Join-Path $work 'payload'
$pack = Join-Path $work 'pack'
$dist = Join-Path $setupDir 'dist'

Write-Host "Building OCCLA Station Setup $Version"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage, $pack, $dist | Out-Null

foreach ($agent in @('print-agent', 'scan-agent')) {
  Write-Host "  copying $agent"
  & robocopy.exe (Join-Path $root $agent) (Join-Path $stage $agent) /E /NFL /NDL /NJH /NJS /NP `
    /XD node_modules daemon /XF config.json config.scanner1.json config.scanner2.json config.scanner3.json '*.log' '*.lock' | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $agent failed ($LASTEXITCODE)" }
  Write-Host "  npm ci $agent"
  Push-Location (Join-Path $stage $agent)
  $env:PUPPETEER_SKIP_DOWNLOAD = '1'   # printing uses the PC's own Edge / Chrome
  & npm.cmd ci --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm ci $agent failed" }
  Pop-Location
}

$nodeExe = (Get-Command node).Source
Write-Host "  bundling node.exe from $nodeExe ($(& node --version))"
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'node') | Out-Null
Copy-Item $nodeExe (Join-Path $stage 'node\node.exe')

Write-Host '  zipping payload'
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath (Join-Path $pack 'payload.zip') -CompressionLevel Optimal

# setup.ps1 must be UTF-8 *with* BOM for Windows PowerShell 5.1 (Arabic text)
$setupText = [IO.File]::ReadAllText((Join-Path $setupDir 'setup.ps1'), [Text.Encoding]::UTF8)
[IO.File]::WriteAllText((Join-Path $pack 'setup.ps1'), $setupText, (New-Object Text.UTF8Encoding $true))
$info = @{ server = $Server; labName = $LabName; version = $Version } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $pack 'station.json'), $info, (New-Object Text.UTF8Encoding $false))

$exe = Join-Path $dist 'OCCLA-Station-Setup.exe'
$sed = Join-Path $work 'setup.sed'
$sedText = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$exe
FriendlyName=OCCLA Station Setup
AppLaunched=powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File setup.ps1
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
FILE0="setup.ps1"
FILE1="station.json"
FILE2="payload.zip"
[SourceFiles]
SourceFiles0=$pack\
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
"@
[IO.File]::WriteAllText($sed, $sedText, [Text.Encoding]::ASCII)

Write-Host '  packing exe (IExpress)'
if (Test-Path $exe) { Remove-Item $exe -Force }
$p = Start-Process -FilePath "$env:WINDIR\System32\iexpress.exe" -ArgumentList @('/N', '/Q', $sed) -Wait -PassThru
if (-not (Test-Path $exe)) { throw "IExpress did not create the exe (exit $($p.ExitCode))" }
$mb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "Done: $exe ($mb MB)"
