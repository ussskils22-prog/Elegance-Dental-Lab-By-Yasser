# OCCLA Station Setup — installs the print / scan station on a lab PC.
# Runs from OCCLA-Station-Setup.exe (built by build.ps1). No console, no CMD for the user:
#   1. pick what this PC does (printer / scan 1 / 2 / 3)   2. type the 6-digit code from Admin → أجهزة المعمل
# Everything else (files, Node, auto-start, power settings, old installs) is done here.
# Running it again on the same PC updates the programs and keeps the existing pairing.

param(
  # Developer check only: render the window to a PNG and exit, changing nothing on the PC
  [string]$SnapshotPath = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── Elevate (needed for the scheduled task and power settings) ─────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $SnapshotPath) {
  Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$($MyInvocation.MyCommand.Path)`"")
  exit
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$info = Get-Content (Join-Path $here 'station.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$Server = [string]$info.server
$LabName = [string]$info.labName
$Version = [string]$info.version
$InstallDir = 'C:\OCCLA\station'
$TaskName = 'OCCLA Station'
$PrintCfgPath = Join-Path $InstallDir 'print-agent\config.json'

function Read-JsonFile($path) {
  if (-not (Test-Path $path)) { return $null }
  try { return (Get-Content $path -Raw -Encoding UTF8) -replace "^\uFEFF", '' | ConvertFrom-Json } catch { return $null }
}

function Write-JsonFile($path, $obj) {
  $json = $obj | ConvertTo-Json -Depth 5
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
  [IO.File]::WriteAllText($path, $json, (New-Object Text.UTF8Encoding $false))
}

function Set-Prop($obj, $name, $value) {
  if ($obj.PSObject.Properties.Name -contains $name) { $obj.$name = $value }
  else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}

$kinds = @(
  @{ Key = 'print';    Text = 'جهاز الطباعة (متوصل بالطابعة)' },
  @{ Key = 'scanner1'; Text = 'سكان 1 — منتهية' },
  @{ Key = 'scanner2'; Text = 'سكان 2 — ديزاين' },
  @{ Key = 'scanner3'; Text = 'سكان 3 — فينيش' }
)

# Already paired roles on this PC (re-running setup = update without a new code)
function Get-ExistingToken($kind) {
  if ($kind -eq 'print') {
    $c = Read-JsonFile $PrintCfgPath
    if ($c -and $c.DEVICE_TOKEN -and $c.MANAGE_PRINT -ne $false) { return [string]$c.DEVICE_TOKEN }
    return $null
  }
  $n = $kind.Substring(7)
  $c = Read-JsonFile (Join-Path $InstallDir "scan-agent\config.scanner$n.json")
  if ($c -and $c.DEVICE_TOKEN) { return [string]$c.DEVICE_TOKEN }
  return $null
}

# ── Window ─────────────────────────────────────────────────────────────────────
$font = New-Object System.Drawing.Font('Segoe UI', 11)
$form = New-Object System.Windows.Forms.Form
$form.Text = "OCCLA — تثبيت جهاز المعمل ($Version)"
$form.RightToLeft = 'Yes'
$form.RightToLeftLayout = $true
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.ClientSize = New-Object System.Drawing.Size(540, 560)
$form.Font = $font
$form.BackColor = [System.Drawing.Color]::White

$title = New-Object System.Windows.Forms.Label
$title.Text = 'تثبيت جهاز الطباعة أو السكان'
$title.Font = New-Object System.Drawing.Font('Segoe UI', 15, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = [System.Drawing.Color]::FromArgb(15, 110, 86)
$title.SetBounds(20, 14, 500, 34)
$form.Controls.Add($title)

$group = New-Object System.Windows.Forms.GroupBox
$group.Text = '1. الجهاز ده هيشتغل إيه؟'
$group.SetBounds(20, 56, 500, 170)
$form.Controls.Add($group)

$radios = @{}
$y = 28
foreach ($k in $kinds) {
  $rb = New-Object System.Windows.Forms.RadioButton
  $rb.Text = $k.Text
  if (Get-ExistingToken $k.Key) { $rb.Text = $k.Text + '   ✓ مربوط' }
  $rb.Tag = $k.Key
  $rb.SetBounds(16, $y, 460, 30)
  $group.Controls.Add($rb)
  $radios[$k.Key] = $rb
  $y += 34
}

$printPanel = New-Object System.Windows.Forms.Panel
$printPanel.SetBounds(20, 232, 500, 110)
$form.Controls.Add($printPanel)

$printers = @()
try { $printers = @(Get-Printer | Select-Object -ExpandProperty Name) } catch { }
$defaultPrinter = ''
try { $defaultPrinter = (Get-CimInstance Win32_Printer | Where-Object { $_.Default } | Select-Object -First 1).Name } catch { }

$lblSheet = New-Object System.Windows.Forms.Label
$lblSheet.Text = 'طابعة الشيتات:'
$lblSheet.SetBounds(0, 6, 150, 28)
$printPanel.Controls.Add($lblSheet)
$cmbSheet = New-Object System.Windows.Forms.ComboBox
$cmbSheet.DropDownStyle = 'DropDownList'
$cmbSheet.SetBounds(160, 2, 340, 30)
$cmbSheet.RightToLeft = 'No'
foreach ($p in $printers) { [void]$cmbSheet.Items.Add($p) }
$printPanel.Controls.Add($cmbSheet)

$lblRec = New-Object System.Windows.Forms.Label
$lblRec.Text = 'طابعة الإيصالات:'
$lblRec.SetBounds(0, 48, 150, 28)
$printPanel.Controls.Add($lblRec)
$cmbRec = New-Object System.Windows.Forms.ComboBox
$cmbRec.DropDownStyle = 'DropDownList'
$cmbRec.SetBounds(160, 44, 340, 30)
$cmbRec.RightToLeft = 'No'
[void]$cmbRec.Items.Add('(مفيش)')
foreach ($p in $printers) { [void]$cmbRec.Items.Add($p) }
$printPanel.Controls.Add($cmbRec)

# Pre-select: saved choice → default printer → first; receipt: saved → XP-Q808K → none
$oldCfg = Read-JsonFile $PrintCfgPath
$sheetPick = if ($oldCfg -and $oldCfg.PRINTER_NAME -and ($printers -contains $oldCfg.PRINTER_NAME)) { $oldCfg.PRINTER_NAME } elseif ($defaultPrinter) { $defaultPrinter } else { $null }
if ($sheetPick) { $cmbSheet.SelectedItem = $sheetPick } elseif ($cmbSheet.Items.Count) { $cmbSheet.SelectedIndex = 0 }
$recPick = if ($oldCfg -and $oldCfg.RECEIPT_PRINTER_NAME -and ($printers -contains $oldCfg.RECEIPT_PRINTER_NAME)) { $oldCfg.RECEIPT_PRINTER_NAME } else { $printers | Where-Object { $_ -match 'XP-Q808K|80mm|POS|Receipt' } | Select-Object -First 1 }
if ($recPick) { $cmbRec.SelectedItem = $recPick } else { $cmbRec.SelectedIndex = 0 }

$lblCode = New-Object System.Windows.Forms.Label
$lblCode.Text = '2. كود الربط (من شاشة الأدمن ← أجهزة المعمل):'
$lblCode.SetBounds(20, 350, 500, 28)
$form.Controls.Add($lblCode)

$txtCode = New-Object System.Windows.Forms.TextBox
$txtCode.Font = New-Object System.Drawing.Font('Segoe UI', 20, [System.Drawing.FontStyle]::Bold)
$txtCode.TextAlign = 'Center'
$txtCode.RightToLeft = 'No'
$txtCode.MaxLength = 9
$txtCode.SetBounds(140, 380, 260, 44)
$form.Controls.Add($txtCode)

$lblHint = New-Object System.Windows.Forms.Label
$lblHint.ForeColor = [System.Drawing.Color]::DimGray
$lblHint.SetBounds(20, 428, 500, 24)
$form.Controls.Add($lblHint)

$status = New-Object System.Windows.Forms.Label
$status.SetBounds(20, 456, 500, 48)
$status.ForeColor = [System.Drawing.Color]::FromArgb(15, 110, 86)
$form.Controls.Add($status)

$btn = New-Object System.Windows.Forms.Button
$btn.Text = 'تثبيت'
$btn.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
$btn.BackColor = [System.Drawing.Color]::FromArgb(15, 110, 86)
$btn.ForeColor = [System.Drawing.Color]::White
$btn.FlatStyle = 'Flat'
$btn.SetBounds(190, 508, 160, 42)
$form.Controls.Add($btn)
$form.AcceptButton = $btn

function Selected-Kind {
  foreach ($k in $kinds) { if ($radios[$k.Key].Checked) { return $k.Key } }
  return $null
}

function Refresh-Form {
  $kind = Selected-Kind
  $printPanel.Visible = ($kind -eq 'print')
  if ($kind -and (Get-ExistingToken $kind)) {
    $lblHint.Text = 'الجهاز ده مربوط بالفعل — سيب الكود فاضي عشان تحدّث البرنامج بس.'
  } else {
    $lblHint.Text = 'اطلب من الأدمن كود جديد (6 أرقام، صالح 15 دقيقة).'
  }
}
foreach ($rb in $radios.Values) { $rb.Add_CheckedChanged({ Refresh-Form }) }
$radios['print'].Checked = $true
Refresh-Form

function Say($text, $isError = $false) {
  $status.ForeColor = if ($isError) { [System.Drawing.Color]::Firebrick } else { [System.Drawing.Color]::FromArgb(15, 110, 86) }
  $status.Text = $text
  [System.Windows.Forms.Application]::DoEvents()
}

# ── Install steps ──────────────────────────────────────────────────────────────
function Stop-OldStations {
  # Old Elegance installs (other folders) and this one: stop processes and their auto-start
  foreach ($t in @('EleganceStationSupervisor', 'ElegancePrintAgent', 'EleganceScanAgent1', 'EleganceScanAgent2', 'EleganceScanAgent3', $TaskName)) {
    try { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue } catch { }
    if ($t -ne $TaskName) { try { Disable-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue | Out-Null } catch { } }
  }
  $startup = [Environment]::GetFolderPath('CommonStartup'), [Environment]::GetFolderPath('Startup')
  foreach ($s in $startup) {
    $lnk = Join-Path $s 'Elegance Station Supervisor.lnk'
    if (Test-Path $lnk) { Remove-Item $lnk -Force -ErrorAction SilentlyContinue }
  }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
    $c = [string]$_.CommandLine
    if ($c -match '(print-agent|scan-agent)[/\\]+(agent|supervisor)\.js') {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  # Barcode hook helpers left behind by old versions
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | ForEach-Object {
    if ([string]$_.CommandLine -match 'win-us-barcode-hook\.ps1|keep-awake|SleepPreventer|OcclaAwake') {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Milliseconds 800
}

function Copy-Programs {
  $zip = Join-Path $here 'payload.zip'
  $tmp = Join-Path $env:TEMP ('occla-payload-' + [guid]::NewGuid().ToString('N'))
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  # Keep this PC's configs and runtime state; replace everything else
  & robocopy.exe $tmp $InstallDir /E /NFL /NDL /NJH /NJS /NP /R:2 /W:1 /XF 'config.json' 'config.scanner1.json' 'config.scanner2.json' 'config.scanner3.json' /XD 'daemon' | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "نسخ الملفات فشل (robocopy $LASTEXITCODE)" }
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

function Pair-Device($kind, $code) {
  $body = @{ code = $code; name = $env:COMPUTERNAME } | ConvertTo-Json
  try {
    $r = Invoke-RestMethod -Method Post -Uri "$Server/api/stations/pair" -Body ([Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
  } catch {
    $msg = $null
    try { $msg = ($_.ErrorDetails.Message | ConvertFrom-Json).message } catch { }
    if (-not $msg) { $msg = 'مش قادر أوصل للسيرفر — اتأكد إن النت شغال وجرّب تاني' }
    throw $msg
  }
  if ($r.data.kind -ne $kind) {
    throw "الكود ده معمول لـ «$($r.data.kind)» — اختار نفس النوع اللي الأدمن اختاره"
  }
  return [string]$r.data.token
}

function Write-Configs($kind, $token) {
  $sup = Read-JsonFile $PrintCfgPath
  if (-not $sup) { $sup = New-Object PSObject }
  Set-Prop $sup 'SERVER_URL' $Server
  Set-Prop $sup 'LAB_NAME' $LabName
  $scanList = @()
  if ($sup.PSObject.Properties.Name -contains 'AUTO_START_SCANNERS') { $scanList = @($sup.AUTO_START_SCANNERS | ForEach-Object { [string]$_ }) }

  if ($kind -eq 'print') {
    Set-Prop $sup 'DEVICE_TOKEN' $token
    Set-Prop $sup 'MANAGE_PRINT' $true
    Set-Prop $sup 'PRINTER_NAME' ([string]$cmbSheet.SelectedItem)
    $rec = [string]$cmbRec.SelectedItem
    Set-Prop $sup 'RECEIPT_PRINTER_NAME' $(if ($cmbRec.SelectedIndex -le 0) { '' } else { $rec })
  } else {
    $n = $kind.Substring(7)
    $label = ($kinds | Where-Object { $_.Key -eq $kind }).Text
    $scanCfg = Read-JsonFile (Join-Path $InstallDir "scan-agent\config.scanner$n.json")
    if (-not $scanCfg) { $scanCfg = New-Object PSObject }
    Set-Prop $scanCfg 'SERVER_URL' $Server
    Set-Prop $scanCfg 'DEVICE_TOKEN' $token
    Set-Prop $scanCfg 'LABEL' $label
    Set-Prop $scanCfg 'BACKGROUND_SCAN' $true
    Set-Prop $scanCfg 'HIDE_CONSOLE' $true
    Write-JsonFile (Join-Path $InstallDir "scan-agent\config.scanner$n.json") $scanCfg
    if ($scanList -notcontains $n) { $scanList += $n }
    if (-not ($sup.PSObject.Properties.Name -contains 'MANAGE_PRINT')) { Set-Prop $sup 'MANAGE_PRINT' $false }
  }
  Set-Prop $sup 'AUTO_START_SCANNERS' @($scanList)
  Write-JsonFile $PrintCfgPath $sup
  # Started-by-supervisor marker so the watchdog keeps each scanner running
  foreach ($n in $scanList) {
    $pidFile = Join-Path $InstallDir "print-agent\daemon\scanner$n.pid"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pidFile) | Out-Null
    if (-not (Test-Path $pidFile)) { [IO.File]::WriteAllText($pidFile, '0') }
  }
}

function Set-PowerSettings {
  # On the charger: never sleep, never hibernate, closing the lid does nothing
  & powercfg.exe /change standby-timeout-ac 0 | Out-Null
  & powercfg.exe /change hibernate-timeout-ac 0 | Out-Null
  & powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 | Out-Null
  & powercfg.exe /setactive SCHEME_CURRENT | Out-Null
}

function Register-StationTask {
  $node = Join-Path $InstallDir 'node\node.exe'
  $sup = Join-Path $InstallDir 'print-agent\supervisor.js'
  $vbs = Join-Path $InstallDir 'start-station.vbs'
  $lines = @(
    'Set sh = CreateObject("WScript.Shell")',
    ('sh.CurrentDirectory = "' + (Join-Path $InstallDir 'print-agent') + '"'),
    ('sh.Run """' + $node + '"" ""' + $sup + '""", 0, False')
  )
  Set-Content -Path $vbs -Value $lines -Encoding ASCII

  # The person who uses this PC (not the admin account typed into the UAC prompt)
  $user = (Get-CimInstance Win32_ComputerSystem).UserName
  if (-not $user) { $user = "$env:USERDOMAIN\$env:USERNAME" }

  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"') -WorkingDirectory $InstallDir
  $atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
  # Every 5 minutes: brings the supervisor back if it ever died (a running one just exits)
  $every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($atLogon, $every5) -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
}

function Wait-Running($kind) {
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    [System.Windows.Forms.Application]::DoEvents()
    try {
      $s = Invoke-RestMethod -Uri 'http://127.0.0.1:17891/status' -TimeoutSec 3
      if ($kind -eq 'print' -and $s.print.running) { return $true }
      if ($kind -ne 'print') {
        $n = [int]$kind.Substring(7)
        $sc = $s.scanners | Where-Object { $_.id -eq $n }
        if ($sc -and $sc.running) { return $true }
      }
    } catch { }
  }
  return $false
}

$btn.Add_Click({
  $kind = Selected-Kind
  if (-not $kind) { Say 'اختار نوع الجهاز الأول' $true; return }
  $code = ($txtCode.Text -replace '\s|-', '')
  $existing = Get-ExistingToken $kind
  if (-not $code -and -not $existing) { Say 'اكتب كود الربط اللي ظاهر في شاشة الأدمن' $true; $txtCode.Focus(); return }
  if ($kind -eq 'print' -and -not $cmbSheet.SelectedItem) { Say 'مفيش طابعة متعرّفة على الجهاز — عرّف الطابعة في ويندوز الأول' $true; return }

  $btn.Enabled = $false
  try {
    Say 'جاري إيقاف النسخة القديمة…'
    Stop-OldStations
    Say 'جاري نسخ البرامج…'
    Copy-Programs
    # Pair last, right before saving: a code works once, so nothing may fail after it
    $token = $existing
    if ($code) {
      Say 'جاري ربط الجهاز بالسيرفر…'
      $token = Pair-Device $kind $code
    }
    Say 'جاري الحفظ والإعدادات…'
    Write-Configs $kind $token
    Set-PowerSettings
    Say 'جاري التشغيل…'
    Register-StationTask
    if (Wait-Running $kind) {
      Say '✅ تمام — الجهاز اتربط وشغال. هتلاقي أيقونته جنب الساعة.'
      [System.Windows.Forms.MessageBox]::Show('تم التثبيت ✅' + "`n`n" + 'البرنامج هيشتغل لوحده كل ما الجهاز يفتح، ومش محتاج أي حاجة تانية.', 'OCCLA', 'OK', 'Information', 'Button1', 'RtlReading') | Out-Null
      $form.Close()
    } else {
      Say 'اتثبّت، بس لسه مش باين إنه شغال — اعمل ريستارت للجهاز، ولو المشكلة فضلت كلّم الدعم.' $true
    }
  } catch {
    Say ([string]$_.Exception.Message) $true
  } finally {
    $btn.Enabled = $true
  }
})

if ($SnapshotPath) {
  $form.Add_Shown({
    $bmp = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
    $form.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
    $bmp.Save($SnapshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $form.Close()
  })
}
[void]$form.ShowDialog()
