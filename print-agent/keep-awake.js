/**
 * Keep Windows awake while this agent runs.
 *
 * SetThreadExecutionState only lasts while the calling THREAD is alive. The old code
 * called it from a PowerShell that exited a second later, so the PC could still sleep.
 * Here one hidden PowerShell stays alive, holds the state, and is restarted if it dies.
 * (Closing a laptop lid still follows the Windows lid setting — the installer sets it.)
 */
const { spawn } = require('child_process');

const PS_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class OcclaAwake {
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED (screen may still turn off)
[OcclaAwake]::SetThreadExecutionState([uint32]"0x80000001") | Out-Null
Write-Output "AWAKE_ON"
while ($true) { Start-Sleep -Seconds 300; [OcclaAwake]::SetThreadExecutionState([uint32]"0x80000001") | Out-Null }
`;

function startKeepAwake(log = console.log) {
  if (process.platform !== 'win32') return () => {};
  let child = null;
  let stopped = false;

  const launch = () => {
    if (stopped) return;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      child.stdout.on('data', (d) => {
        if (String(d).includes('AWAKE_ON')) log('☕ Keep-awake ON (PC will not sleep while the agent runs)');
      });
      child.on('exit', () => {
        child = null;
        if (!stopped) setTimeout(launch, 5000);
      });
      child.on('error', () => {});
    } catch (err) {
      log(`⚠️  Keep-awake failed: ${err.message}`);
      setTimeout(launch, 30000);
    }
  };

  launch();
  const stop = () => {
    stopped = true;
    try {
      if (child) child.kill();
    } catch (_) {}
  };
  process.on('exit', stop);
  return stop;
}

module.exports = { startKeepAwake };
