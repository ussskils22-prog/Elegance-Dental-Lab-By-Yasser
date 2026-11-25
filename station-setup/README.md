# OCCLA Station Setup

One installer for every lab PC that prints or scans. No CMD, no Node.js, no config files.

## On the lab PC
1. Admin → **أجهزة المعمل** → download **OCCLA Station Setup** and run it (one Windows "Yes" prompt).
2. Pick what the PC does: **جهاز الطباعة / سكان 1 / سكان 2 / سكان 3** (printer PCs also pick the sheet / receipt printer).
3. In the admin screen press the same station type to get a **6-digit code** (one use, 15 minutes) and type it in.

The installer:
- copies the programs to `C:\OCCLA\station` (with its own `node.exe`),
- pairs the PC with the server (its own device token — no shared secret / password on the PC),
- stops and disables old Elegance installs (scheduled tasks, startup shortcut, old processes),
- sets power: on the charger never sleep, closing the lid does nothing,
- registers the **OCCLA Station** task (at logon + every 5 minutes as a safety net) which runs the
  supervisor; the supervisor keeps the print agent and the scanners running.

Running it again on the same PC **updates** the programs; leave the code empty to keep the pairing.
To add a second role to the same PC (e.g. printer + scan 1), run it again with a new code.

Admin → أجهزة المعمل also lists paired PCs (connected / last seen) and can **disconnect** one.

## Building the installer (developer PC)
```powershell
powershell -ExecutionPolicy Bypass -File station-setup\build.ps1
```
Output: `station-setup\dist\OCCLA-Station-Setup.exe`. Publish it as the asset
`OCCLA-Station-Setup.exe` of a GitHub release — the admin download button points to
`releases/latest/download/OCCLA-Station-Setup.exe`.

Check the window without installing anything:
```powershell
powershell -ExecutionPolicy Bypass -File station-setup\setup.ps1 -SnapshotPath $env:TEMP\setup.png
```
(needs a `station.json` next to it; build.ps1 creates one in the pack folder)
