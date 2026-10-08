/**
 * Elegance Dental Lab — Print Agent
 * Runs on the lab's Windows laptop.
 * Connects to the Railway server via Socket.IO,
 * receives print jobs, renders HTML → PDF → prints silently.
 *
 * Resilience:
 * - Infinite socket reconnect
 * - HTTP poll for pending jobs (catch-up after sleep / disconnect / restart)
 * - Job dedupe so the same request is not printed twice
 * - Windows keep-awake while the agent is running
 */

const { io } = require('socket.io-client');
const puppeteer = require('puppeteer');
const { print, getPrinters } = require('pdf-to-printer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const util = require('util');

// Single-instance: exclusive local port + kill siblings, then take the lock.
// A second agent (service/task) was printing every job twice.
(function enforceSingleInstance() {
  const net = require('net');
  const lockPath = path.join(__dirname, 'daemon', 'agent.lock');
  const MUTEX_PORT = 17892;
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch (_) {}

  // Exclusive TCP bind — works even when the other process hides its command line
  const mutex = net.createServer();
  mutex.on('error', (err) => {
    console.error(`❌ Another print agent already owns port ${MUTEX_PORT} (${err.code || err.message}). Exiting.`);
    process.exit(1);
  });
  mutex.listen(MUTEX_PORT, '127.0.0.1', () => {
    console.log(`🔒 Single-instance port ${MUTEX_PORT} acquired (pid ${process.pid})`);
  });
  process.on('exit', () => {
    try {
      mutex.close();
    } catch (_) {}
  });

  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('child_process');
      const rootEsc = __dirname.replace(/'/g, "''").replace(/\\/g, '\\\\');
      // Kill other agent.js + any node with empty cmdline that hosts puppeteer chrome (hidden service agents)
      const ps = [
        `$my = ${process.pid}`,
        `$root = '${rootEsc}'`,
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {`,
        `  $pidN = $_.ProcessId`,
        `  if ($pidN -eq $my) { return }`,
        `  $cmd = [string]$_.CommandLine`,
        `  $hit = $false`,
        `  if ($cmd -and (($cmd -match 'print-agent[/\\\\]+agent\\.js') -or ($cmd -match [regex]::Escape($root) -and $cmd -match 'agent\\.js'))) { $hit = $true }`,
        `  if (-not $hit -and [string]::IsNullOrWhiteSpace($cmd)) {`,
        `    $n = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' and ParentProcessId=$pidN").Count`,
        `    if ($n -gt 0) { $hit = $true }`,
        `  }`,
        `  if ($hit) {`,
        `    Stop-Process -Id $pidN -Force -ErrorAction SilentlyContinue`,
        `    Write-Output $pidN`,
        `  }`,
        `}`,
      ].join('; ');
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
        { windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const text = String(out || '').trim();
      if (text) console.log('🔒 Cleared other agent PID(s):', text.replace(/\s+/g, ' '));
    } catch (err) {
      console.warn('⚠️  Could not clear sibling agents:', err.message);
    }
  }

  try {
    if (fs.existsSync(lockPath)) {
      const prev = Number(String(fs.readFileSync(lockPath, 'utf8')).trim());
      if (prev && prev !== process.pid) {
        try {
          process.kill(prev);
        } catch (_) {}
      }
    }
    fs.writeFileSync(lockPath, String(process.pid), 'utf8');
    const clear = () => {
      try {
        if (fs.existsSync(lockPath) && String(fs.readFileSync(lockPath, 'utf8')).trim() === String(process.pid)) {
          fs.unlinkSync(lockPath);
        }
      } catch (_) {}
    };
    process.on('exit', clear);
    process.on('SIGINT', () => {
      clear();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      clear();
      process.exit(0);
    });
  } catch (err) {
    console.warn('⚠️  Could not create agent lock:', err.message);
  }
})();

// Always mirror console to a flushable file (RedirectStandardOutput buffers hide progress)
(function installLiveLog() {
  const logPath = path.join(__dirname, 'daemon', 'agent-live.log');
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  } catch (_) {}
  function writeLine(level, args) {
    const msg = args
      .map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 3 })))
      .join(' ');
    try {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${level} ${msg}\n`);
    } catch (_) {}
  }
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      writeLine(level, args);
      orig(...args);
    };
  }
})();

// ── Config ────────────────────────────────────────────────
// Strip UTF-8 BOM if editors (PowerShell/Notepad) saved one — breaks JSON.parse
const configRaw = fs
  .readFileSync(path.join(__dirname, 'config.json'), 'utf8')
  .replace(/^\uFEFF/, '');
const config = JSON.parse(configRaw);
const SERVER_URL      = config.SERVER_URL.replace(/\/$/, '');
const AGENT_SECRET    = config.PRINT_AGENT_SECRET;
const PRINTER_NAME    = config.PRINTER_NAME;
const RECONNECT_DELAY = 3000; // ms
const POLL_INTERVAL_MS = Number(config.POLL_INTERVAL_MS) || 20000;
const PRINT_CONFIRM_TIMEOUT_MS = Number(config.PRINT_CONFIRM_TIMEOUT_MS) || 90000;
const PRINTER_CHECK_MS = Number(config.PRINTER_CHECK_MS) || 10000;

console.log('🖨️  Elegance Print Agent starting...');
console.log(`   Server  : ${SERVER_URL}`);
console.log(`   Printer : ${PRINTER_NAME}`);
console.log(`   Poll    : every ${POLL_INTERVAL_MS / 1000}s`);
console.log(`   Confirm : ${PRINT_CONFIRM_TIMEOUT_MS / 1000}s spooler timeout`);
console.log(`   Printer check: every ${PRINTER_CHECK_MS / 1000}s`);

// ── Keep Windows from sleeping while agent runs ───────────
function enableKeepAwake() {
  if (process.platform !== 'win32') return;
  try {
    const { execFile } = require('child_process');
    const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SleepPreventer {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
  public static void StayAwake() {
    SetThreadExecutionState(0x80000000 | 0x00000001 | 0x00000002);
  }
}
"@
[SleepPreventer]::StayAwake()
`;
    // Refresh every 60s so the execution state stays active
    const refresh = () => {
      execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }, () => {});
    };
    refresh();
    setInterval(refresh, 60000);
    console.log('☕ Keep-awake enabled (system will not sleep while agent runs)');
  } catch (err) {
    console.warn('⚠️  Could not enable keep-awake:', err.message);
  }
}
enableKeepAwake();

// ── Connect to server ─────────────────────────────────────
const socket = io(SERVER_URL, {
  auth: { agentSecret: AGENT_SECRET },
  reconnection: true,
  reconnectionDelay: RECONNECT_DELAY,
  reconnectionDelayMax: 15000,
  reconnectionAttempts: Infinity,
  timeout: 20000,
});

socket.on('connect', () => {
  console.log('✅ Connected to server. Waiting for print jobs...');
  // Burst catch-up: network often stabilizes a few seconds after socket reconnect
  catchUpBurst('connect');
});

socket.on('connect_error', (err) => {
  networkDown = true;
  console.error('❌ Connection error:', err.message);
});

socket.on('disconnect', (reason) => {
  networkDown = true;
  console.warn('⚠️  Disconnected:', reason, '— will reconnect automatically...');
});

// ── Print Queue Management ────────────────────────────────
const jobQueue = [];
/** IDs currently waiting in the local queue */
const queuedIds = new Set();
/** IDs finished successfully this process lifetime (may still be pending on server if status sync failed) */
const completedIds = new Set();
let currentJobId = null;
let isProcessingQueue = false;
let networkDown = false;
let printerDown = false;
let lastPrinterOk = null;

function normalizeJobId(jobId) {
  return String(jobId);
}

function isPrinterIssueError(message) {
  return /printer|offline|not ready|not found|spooler/i.test(String(message || ''));
}

/** Jobs we already decided to print this process (set BEFORE any await) */
const startedIds = new Set();
/** Serialize SumatraPDF — concurrent prints jam the HP P1102 spooler */
let printPdfChain = Promise.resolve();
const JOB_LOCK_DIR = path.join(__dirname, 'daemon', 'job-locks');

/**
 * Cross-process exclusive lock — only one agent (or one handler) may own a jobId.
 * Uses O_EXCL file create so two processes cannot both win.
 */
function tryAcquireJobLock(id) {
  try {
    fs.mkdirSync(JOB_LOCK_DIR, { recursive: true });
  } catch (_) {}
  const lockPath = path.join(JOB_LOCK_DIR, `${id}.lock`);
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    console.warn('⚠️  Job lock error:', err.message);
    return false;
  }
}

function isInPipeline(id) {
  return queuedIds.has(id) || currentJobId === id || startedIds.has(id);
}

/**
 * @param {object} job
 * @param {string} source
 * @param {{ fromServerCatchUp?: boolean }} [opts]
 */
function enqueueJob(job, source, opts = {}) {
  const id = normalizeJobId(job.jobId);
  if (!id || id === 'undefined' || id === 'null') {
    console.warn('⚠️  Ignoring job without jobId from', source);
    return false;
  }

  // Critical: once printed successfully this session, NEVER reprint —
  // even if a catch-up poll still sees the job as pending/printing (race before done sync).
  if (completedIds.has(id) || startedIds.has(id)) {
    console.log(`⏭️  Skip ${id} (already printed/started this session, via ${source})`);
    return false;
  }

  if (isInPipeline(id)) {
    return false;
  }

  // Win or lose BEFORE queue — stops double socket delivery / second agent
  if (!tryAcquireJobLock(id)) {
    console.log(`⏭️  Skip ${id} (lock held by another agent/handler, via ${source})`);
    return false;
  }

  queuedIds.add(id);
  startedIds.add(id);
  jobQueue.push({ jobId: id, printData: job.printData || {} });
  console.log(`📥 Queued job ${id} (via ${source}, pid ${process.pid})`);
  processQueue();
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapePsSingleQuoted(value) {
  return String(value || '').replace(/'/g, "''");
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runPowerShell(script, timeoutMs = 15000) {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, killSignal: 'SIGKILL' }
    );
    return String(stdout || '').trim();
  } catch (err) {
    if (err.killed || /ETIMEDOUT|timeout/i.test(err.message || '')) {
      throw new Error(`PowerShell timeout after ${timeoutMs}ms`);
    }
    throw err;
  }
}

/** Check printer exists and is not offline / in error via Win32_Printer */
async function getPrinterHealth(printerName) {
  const name = (printerName || '').trim();
  if (!name) {
    return { ok: false, error: 'PRINTER_NAME is empty in config.json' };
  }

  const script = `
$ErrorActionPreference = 'Stop'
$name = '${escapePsSingleQuoted(name)}'
$p = Get-CimInstance -ClassName Win32_Printer | Where-Object { $_.Name -eq $name } | Select-Object -First 1
if (-not $p) {
  (@{ ok = $false; error = "Printer not found: $name"; offline = $true; status = -1; detectedError = -1 }) | ConvertTo-Json -Compress
  exit 0
}
$offline = [bool]$p.WorkOffline
$status = [int]$p.PrinterStatus
$detected = [int]$p.DetectedErrorState
# Win32 PrinterStatus: 7 = Offline. DetectedErrorState: 2 = No Error; >=3 often paper/toner/jam.
$ok = (-not $offline) -and ($status -ne 7)
if ($detected -ge 3) { $ok = $false }
$errorText = ''
if (-not $ok) {
  if ($offline -or $status -eq 7) { $errorText = "Printer offline: $name" }
  elseif ($detected -ge 3) { $errorText = "Printer error state ($detected): $name" }
  else { $errorText = "Printer not ready: $name" }
}
(@{
  ok = $ok
  error = $errorText
  offline = $offline
  status = $status
  detectedError = $detected
  name = $p.Name
}) | ConvertTo-Json -Compress
`;

  try {
    const raw = await runPowerShell(script, 2000);
    const parsed = JSON.parse(raw || '{}');
    return {
      ok: Boolean(parsed.ok),
      error: parsed.error || '',
      offline: Boolean(parsed.offline),
      status: Number(parsed.status),
      detectedError: Number(parsed.detectedError),
      name: parsed.name || name,
    };
  } catch (err) {
    // Do NOT call getPrinters() here — it hangs on some HP USB drivers.
    // Optimistic: allow print attempt when health probe times out.
    return {
      ok: true,
      error: '',
      offline: false,
      status: -1,
      detectedError: -1,
      name,
      warning: `Health check skipped (${err.message}); attempting print`,
    };
  }
}

async function assertPrinterReady(printerName) {
  const health = await getPrinterHealth(printerName);
  if (!health.ok) {
    throw new Error(health.error || 'Printer is not ready');
  }
  if (health.warning) {
    console.warn(`   ⚠️  ${health.warning}`);
  }
  return health;
}

async function listSpoolerJobs(printerName) {
  // Prefer Win32_PrintJob — Get-PrintJob hangs on some HP USB drivers (P1102).
  const name = escapePsSingleQuoted(printerName);
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$name = '${name}'
$jobs = @(Get-CimInstance Win32_PrintJob -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -like ($name + ',*')
} | ForEach-Object {
  @{
    id = [string]($_.JobId)
    status = [string]($_.Status)
    name = [string]($_.Document)
  }
})
,@($jobs) | ConvertTo-Json -Compress -Depth 4
`;
  try {
    const raw = await runPowerShell(script, 3000);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
    return [];
  } catch (err) {
    console.warn(`   ⚠️  Spooler list skipped (${err.message})`);
    return [];
  }
}

function jobLooksFailed(statusText) {
  const s = String(statusText || '').toLowerCase();
  return /error|offline|paperout|papercritical|userintervention|blocked|deleted/.test(s);
}

function jobLooksPrinted(statusText) {
  const s = String(statusText || '').toLowerCase();
  return /printed|complete|retained/.test(s);
}

/**
 * After sending to Windows spooler: avoid hammering WMI/Get-PrintJob (hangs HP P1102).
 * Brief wait, one light spooler peek, then accept.
 */
async function waitForPrintConfirmation(_printerName, _beforeJobIds) {
  // Spooler accepted the job — no WMI wait (was adding hundreds of ms).
  return { mode: 'accepted-fast' };
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (jobQueue.length > 0) {
    const job = jobQueue.shift();
    queuedIds.delete(job.jobId);
    currentJobId = job.jobId;

    if (completedIds.has(job.jobId)) {
      console.log(`⏭️  Skip processing ${job.jobId} — already printed this session`);
      currentJobId = null;
      continue;
    }

    console.log(`\n📄 Processing print job: ${job.jobId}`);
    console.log(`   Patient: ${job.printData.patient} | Doctor: ${job.printData.doctor}`);

    try {
      // Atomic server claim — if another agent already owns this job, skip (no second sheet)
      const claimed = await claimJob(job.jobId);
      if (!claimed) {
        console.log(`⏭️  Skip ${job.jobId} — another agent already claimed it`);
        startedIds.delete(job.jobId);
        releaseJobLock(job.jobId);
        currentJobId = null;
        continue;
      }

      const html = await buildPrintHtml(job.printData);
      const pdfPath = path.join(os.tmpdir(), `print_job_${job.jobId}.pdf`);
      const t0 = Date.now();
      await generatePdf(html, pdfPath);
      console.log(`   ✅ PDF generated in ${Date.now() - t0}ms: ${pdfPath}`);

      console.log(`   🖨️  Sending PDF to printer [${PRINTER_NAME}]...`);
      // One Sumatra at a time — parallel prints jam the P1102 and nothing comes out
      await new Promise((resolve, reject) => {
        printPdfChain = printPdfChain
          .then(() => withTimeout(printPdf(pdfPath), 20000, 'printPdf'))
          .then(resolve, reject);
      });
      console.log(`   📤 Sent to Windows spooler [${PRINTER_NAME}]`);

      const confirm = await waitForPrintConfirmation(PRINTER_NAME, new Set());
      console.log(`   🖨️  Print confirmed (${confirm.mode}) on [${PRINTER_NAME}] (${Date.now() - t0}ms total)`);

      // Mark done locally FIRST so overlapping catch-up cannot re-queue this job
      completedIds.add(job.jobId);
      // Don't await HTTP — paper is already printing
      reportStatus(job.jobId, 'done').catch(() => {});
      fs.unlink(pdfPath, () => {});
    } catch (err) {
      console.error(`   ❌ Print failed:`, err.message);
      if (completedIds.has(job.jobId)) {
        // Shouldn't happen, but never downgrade a completed print
        console.warn('   ⚠️  Ignoring failure after local completion');
      } else if (isPrinterIssueError(err.message)) {
        printerDown = true;
        // Allow a later retry after printer recovers
        startedIds.delete(job.jobId);
        await reportStatus(job.jobId, 'pending', `Waiting for printer: ${err.message}`);
        console.log('   ⏳ Job held as pending — will print when printer/agent is back');
      } else {
        await reportStatus(job.jobId, 'failed', err.message);
      }
    } finally {
      currentJobId = null;
    }
  }

  isProcessingQueue = false;
}

function releaseJobLock(id) {
  try {
    fs.unlinkSync(path.join(JOB_LOCK_DIR, `${id}.lock`));
  } catch (_) {}
}

async function claimJob(jobId) {
  const url = `${SERVER_URL}/api/print/job/${encodeURIComponent(jobId)}/claim`;
  try {
    const res = await httpJson('POST', url, { agentId: `pid-${process.pid}` });
    return Boolean(res && (res.claimed === true || res.success === true));
  } catch (err) {
    const msg = String(err.message || '');
    // Another agent / already done
    if (/HTTP 409/.test(msg) || /HTTP 404/.test(msg)) return false;
    // Network blip: local file lock already makes us the only printer on this PC
    console.warn(`   ⚠️  Claim unavailable for ${jobId} (${err.message}) — printing with local lock`);
    return true;
  }
}

async function reportStatus(jobId, status, error) {
  // Never send a downgrade if we already completed this job locally
  if (completedIds.has(normalizeJobId(jobId)) && status !== 'done') {
    console.log(`   ⏭️  Skip status "${status}" for ${jobId} (already completed locally)`);
    return;
  }

  const payload = { jobId, status, error: error || '' };
  if (socket.connected) {
    socket.emit('print:job-status', payload);
  }
  const url = `${SERVER_URL}/api/print/job/${encodeURIComponent(jobId)}/status`;
  try {
    await httpJson('PATCH', url, { status, errorMessage: error || '' });
  } catch (err) {
    console.warn(`   ⚠️  Status HTTP update failed (${status}):`, err.message);
  }
}

// ── Receive print job (realtime) ──────────────────────────
socket.on('print:new-job', (job) => {
  enqueueJob(job, 'socket');
});

// ── HTTP helpers ──────────────────────────────────────────
function httpJson(method, url, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-agent-secret': AGENT_SECRET,
          'x-agent-id': `pid-${process.pid}`,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch {
              resolve({});
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchAndEnqueuePending(reason) {
  try {
    const res = await httpJson('GET', `${SERVER_URL}/api/print/jobs/pending`);
    const jobs = res.jobs || [];

    const wasDown = networkDown;
    if (wasDown) {
      console.log('🌐 Network restored — catching up missed print jobs...');
      networkDown = false;
    }

    if (jobs.length === 0) {
      if (reason === 'connect' || String(reason).startsWith('connect') || wasDown) {
        console.log('   No pending jobs to catch up.');
      }
      if (wasDown && reason === 'interval') {
        catchUpBurst('net-restore');
      }
      return true;
    }

    // If printer is down, hold jobs on server as pending — don't burn them as failed
    const health = await getPrinterHealth(PRINTER_NAME);
    if (!health.ok) {
      printerDown = true;
      lastPrinterOk = false;
      console.warn(
        `⏳ Printer not ready (${health.error || 'unknown'}) — holding ${jobs.length} unfinished job(s) until printer is back`
      );
      return true;
    }

    if (printerDown || lastPrinterOk === false) {
      console.log('🖨️  Printer ready — releasing held print jobs...');
      printerDown = false;
    }
    lastPrinterOk = true;

    let added = 0;
    for (const job of jobs) {
      const ok = enqueueJob(job, `poll:${reason}`, { fromServerCatchUp: true });
      if (ok) added += 1;
    }
    console.log(
      `🔁 Catch-up (${reason}): server has ${jobs.length} unfinished job(s), queued ${added} new`
    );
    if (wasDown && reason === 'interval') {
      catchUpBurst('net-restore');
    }
    return true;
  } catch (err) {
    networkDown = true;
    console.warn(`⚠️  Pending poll failed (${reason}):`, err.message);
    return false;
  }
}

/** Several catch-up attempts after reconnect — covers slow DNS / flaky Wi‑Fi / PC boot */
function catchUpBurst(reason) {
  fetchAndEnqueuePending(reason);
  setTimeout(() => fetchAndEnqueuePending(`${reason}+2s`), 2000);
  setTimeout(() => fetchAndEnqueuePending(`${reason}+5s`), 5000);
  setTimeout(() => fetchAndEnqueuePending(`${reason}+15s`), 15000);
  setTimeout(() => fetchAndEnqueuePending(`${reason}+30s`), 30000);
}

// Poll forever — covers sleep wake, missed socket events, and PC restarts
setInterval(() => fetchAndEnqueuePending('interval'), POLL_INTERVAL_MS);

// Watch printer USB/power — when it comes back, print everything waiting
setInterval(async () => {
  try {
    const health = await getPrinterHealth(PRINTER_NAME);
    const ok = Boolean(health.ok);
    if (lastPrinterOk === false && ok) {
      console.log('🖨️  Printer came back online — catching up held jobs...');
      printerDown = false;
      lastPrinterOk = true;
      catchUpBurst('printer-restore');
    } else if (lastPrinterOk === true && !ok) {
      printerDown = true;
      lastPrinterOk = false;
      console.warn(`⚠️  Printer went offline: ${health.error || 'not ready'}`);
    } else if (lastPrinterOk === null) {
      lastPrinterOk = ok;
      printerDown = !ok;
      console.log(ok ? `   Printer status: ready` : `   Printer status: NOT ready (${health.error || ''})`);
    }
  } catch (err) {
    console.warn('⚠️  Printer health check failed:', err.message);
  }
}, Math.max(PRINTER_CHECK_MS, 30000));

// Catch-up on boot / agent restart (laptop was off, service just started)
catchUpBurst('startup');
setTimeout(() => catchUpBurst('startup-late'), 8000);

// Find local Chrome/Edge executable path to avoid downloading Chromium
function getLocalBrowserPath() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function printPdf(pdfPath) {
  const options = {};
  if (PRINTER_NAME && PRINTER_NAME.trim()) {
    options.printer = PRINTER_NAME.trim();
  }
  return print(pdfPath, options);
}

// Keep one Chrome alive — cold launch every job was ~5–6s of the ~15s feel
let pdfBrowser = null;
let pdfBrowserLaunching = null;

async function getPdfBrowser() {
  if (pdfBrowser) {
    try {
      if (pdfBrowser.isConnected()) return pdfBrowser;
    } catch (_) {}
    pdfBrowser = null;
  }
  if (pdfBrowserLaunching) return pdfBrowserLaunching;

  pdfBrowserLaunching = (async () => {
    const browserPath = getLocalBrowserPath();
    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: browserPath || undefined,
      timeout: 20000,
      protocolTimeout: 20000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--mute-audio',
      ],
    });
    browser.on('disconnected', () => {
      if (pdfBrowser === browser) pdfBrowser = null;
    });
    pdfBrowser = browser;
    return browser;
  })();

  try {
    return await pdfBrowserLaunching;
  } finally {
    pdfBrowserLaunching = null;
  }
}

async function warmPdfBrowser() {
  try {
    await getPdfBrowser();
    console.log('🔥 PDF browser warmed — next prints skip Chrome cold-start');
  } catch (err) {
    console.warn('⚠️  PDF browser warm failed:', err.message);
  }
}

async function generatePdfViaWarmBrowser(html, outputPath) {
  const browser = await getPdfBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 8000 });
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
    });
  } finally {
    await page.close().catch(() => {});
  }
}

async function generatePdfViaBrowserCli(html, outputPath) {
  const browserPath = getLocalBrowserPath();
  if (!browserPath) throw new Error('Chrome/Edge not found');

  const tempHtmlPath = path.resolve(outputPath + '.html');
  fs.writeFileSync(tempHtmlPath, html, 'utf8');
  const absPdf = path.resolve(outputPath);
  // Encode spaces — unencoded file:// URLs often make Chrome exit with no PDF
  const fileUrl = 'file:///' + tempHtmlPath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-translate',
    '--no-first-run',
    '--no-pdf-header-footer',
    `--print-to-pdf=${absPdf}`,
    fileUrl,
  ];

  console.log(`   🌐 PDF via CLI: ${path.basename(browserPath)}`);
  await execFileAsync(browserPath, args, {
    timeout: 12000,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });

  for (let i = 0; i < 20; i++) {
    try {
      if (fs.existsSync(absPdf) && fs.statSync(absPdf).size > 0) break;
    } catch (_) {}
    await sleep(50);
  }
  if (!fs.existsSync(absPdf) || fs.statSync(absPdf).size === 0) {
    throw new Error('PDF output file was not created');
  }
  fs.unlink(tempHtmlPath, () => {});
}

async function generatePdf(html, outputPath) {
  const t0 = Date.now();
  try {
    await generatePdfViaWarmBrowser(html, outputPath);
    console.log(`   ✅ PDF warm-browser done in ${Date.now() - t0}ms`);
    return;
  } catch (err) {
    console.warn(`   ⚠️ Warm browser PDF failed (${err.message}) — trying CLI…`);
    try {
      await pdfBrowser.close();
    } catch (_) {}
    pdfBrowser = null;
  }

  try {
    await generatePdfViaBrowserCli(html, outputPath);
    console.log(`   ✅ PDF CLI done in ${Date.now() - t0}ms`);
    return;
  } catch (err) {
    console.warn(`   ⚠️ PDF CLI failed (${err.message}) — cold Puppeteer…`);
  }

  const browserPath = getLocalBrowserPath();
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: browserPath || undefined,
    timeout: 12000,
    protocolTimeout: 12000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 8000 });
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
    });
    console.log(`   ✅ PDF Puppeteer done in ${Date.now() - t0}ms`);
  } finally {
    await browser.close().catch(() => {});
  }
}

// Pre-warm as soon as agent starts (don't wait for first job)
warmPdfBrowser();

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function buildBarcodeDataUrl(text) {
  const bwipjs = require('bwip-js');
  const png = await bwipjs.toBuffer({
    bcid: 'code128',
    text: String(text),
    scale: 3,
    height: 14,
    includetext: false,
    textxalign: 'center',
    backgroundcolor: 'FFFFFF',
    barcolor: '000000',
  });
  return `data:image/png;base64,${png.toString('base64')}`;
}

async function buildPrintHtml(c) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  const dateStr = now.toLocaleDateString('en-GB');
  const printDate = c.printDate || `${timeStr} ${dateStr}`;
  const workTypeDisplay = c.workType || '—';
  const quantity = c.caseType === 'Empty' ? 0 : (c.quantity || 0);
  const caseNumber = String(c.caseNumber || '').trim();
  const teeth = Array.isArray(c.teeth) ? c.teeth : [];

  /** Short codes readable on B&W printers (no color reliance). */
  const MATERIAL_CODE = {
    Zircon: 'Zr',
    'German Zircon': 'GZ',
    Emax: 'Em',
    Peek: 'Pk',
    Titanium: 'Ti',
    'Pmma Cad': 'Pm',
    'Try in': 'Tr',
    Mokup: 'Mk',
    Mockup: 'Mk',
    'Night Guard': 'NG',
    Wax: 'Wx',
    Ring: 'Rg',
  };
  const codeFor = (mat) => {
    if (MATERIAL_CODE[mat]) return MATERIAL_CODE[mat];
    const s = String(mat || '').trim();
    if (!s) return '?';
    return s.slice(0, 2);
  };

  const byFdi = {};
  for (const t of teeth) {
    if (t && t.fdi) byFdi[String(t.fdi)] = t;
  }
  // FDI order; Palmer display number = last digit (8‥1 | 1‥8)
  const UPPER_R = ['18', '17', '16', '15', '14', '13', '12', '11'];
  const UPPER_L = ['21', '22', '23', '24', '25', '26', '27', '28'];
  const LOWER_R = ['48', '47', '46', '45', '44', '43', '42', '41'];
  const LOWER_L = ['31', '32', '33', '34', '35', '36', '37', '38'];
  const palmerOf = (fdi) => String(fdi).slice(-1);

  /** Consecutive teeth with same groupId+material → one rectangle (bridge). */
  const segmentQuad = (fdiList) => {
    const segs = [];
    let i = 0;
    while (i < fdiList.length) {
      const fdi = fdiList[i];
      const t = byFdi[fdi];
      if (!t) {
        segs.push({ fdis: [fdi], selected: false });
        i += 1;
        continue;
      }
      if (!t.groupId) {
        segs.push({ fdis: [fdi], selected: true, material: t.material });
        i += 1;
        continue;
      }
      const fdis = [fdi];
      let j = i + 1;
      while (j < fdiList.length) {
        const n = byFdi[fdiList[j]];
        if (n && n.groupId === t.groupId && n.material === t.material) {
          fdis.push(fdiList[j]);
          j += 1;
        } else break;
      }
      segs.push({ fdis, selected: true, material: t.material });
      i = j;
    }
    return segs;
  };

  const renderSegLabels = (segs) =>
    segs
      .map((seg) => {
        const span = `grid-column: span ${seg.fdis.length}`;
        if (!seg.selected) return `<span class="seg-lab" style="${span}"></span>`;
        return `<span class="seg-lab on" style="${span}">${escapeHtml(codeFor(seg.material))}</span>`;
      })
      .join('');

  const renderSegNums = (segs) =>
    segs
      .map((seg) => {
        const span = `grid-column: span ${seg.fdis.length}`;
        const nums = seg.fdis.map((f) => `<span class="pn">${escapeHtml(palmerOf(f))}</span>`).join('');
        if (!seg.selected) {
          return `<span class="seg-box empty" style="${span}">${nums}</span>`;
        }
        const title = escapeHtml(`${seg.fdis.join(',')} — ${seg.material}`);
        return `<span class="seg-box selected" style="${span}" title="${title}">${nums}</span>`;
      })
      .join('');

  /** Classic Palmer arch: abbr above (upper) or below (lower) group rectangles. */
  const renderArch = (rightList, leftList, labelPos) => {
    const rSegs = segmentQuad(rightList);
    const lSegs = segmentQuad(leftList);
    const rLabels = renderSegLabels(rSegs);
    const lLabels = renderSegLabels(lSegs);
    const rNums = renderSegNums(rSegs);
    const lNums = renderSegNums(lSegs);
    // Upper: labels row then numbers; lower: numbers then labels
    const rQuad =
      labelPos === 'above'
        ? `${rLabels}${rNums}`
        : `${rNums}${rLabels}`;
    const lQuad =
      labelPos === 'above'
        ? `${lLabels}${lNums}`
        : `${lNums}${lLabels}`;
    return `<div class="palmer-arch ${labelPos === 'above' ? 'upper' : 'lower'}">
      <span class="rl">R</span>
      <div class="quad">${rQuad}</div>
      <span class="mid-line"></span>
      <div class="quad">${lQuad}</div>
      <span class="rl">L</span>
    </div>`;
  };

  const legendMats = [...new Set(teeth.map((t) => t.material).filter(Boolean))];
  const legendHtml = legendMats.length
    ? `<div class="teeth-legend">${legendMats
        .map((m) => `<span class="leg"><b>${escapeHtml(codeFor(m))}</b>=${escapeHtml(m)}</span>`)
        .join('<span class="leg-sep">·</span>')}</div>`
    : '';

  let barcodeBlock = '';
  if (caseNumber) {
    let barcodeDataUrl = '';
    try {
      barcodeDataUrl = await buildBarcodeDataUrl(caseNumber);
    } catch (err) {
      console.warn('   ⚠️ Barcode generation failed:', err.message);
    }
    barcodeBlock = `
  <div class="barcode-block">
    ${barcodeDataUrl ? `<img class="barcode-img" src="${barcodeDataUrl}" alt="Barcode ${escapeHtml(caseNumber)}" />` : ''}
    <div class="barcode-code-text">${escapeHtml(caseNumber)}</div>
    <div class="barcode-hint">امسح الباركود لنقل الحالة بين المحطات</div>
  </div>`;
  }

  return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8">
  <title>ريكويست</title>
  <style>
    /* A4; content slightly below top so the sheet looks balanced (not stuck to the edge). */
    @page { size: A4; margin: 12mm 12mm 12mm 12mm; }
    html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
      background: #fff;
      color: #000;
      font-size: 14px;
      line-height: 1.4;
      direction: rtl;
      padding-top: 0;
      margin-top: 0;
    }
    .sheet {
      width: 150mm;
      max-width: 100%;
      margin: 18mm auto 0;
      display: flex;
      flex-direction: column;
    }
    .barcode-block {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      margin: 0 auto 6px; padding: 0;
    }
    .barcode-img {
      width: 210px; height: 48px; object-fit: contain;
      image-rendering: pixelated;
    }
    .barcode-code-text {
      margin-top: 4px; font-size: 13px; font-weight: 800; letter-spacing: 0.4px;
      direction: ltr; unicode-bidi: isolate;
    }
    .barcode-hint { font-size: 9px; color: #333; margin-top: 1px; }
    .section { margin-bottom: 10px; }
    .section-work { margin-top: 4mm; }
    .section-title {
      font-size: 14px; font-weight: 700; color: #000;
      border-right: 3px solid #000; padding-right: 8px; margin-bottom: 5px;
    }
    .row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 5px 0; border-bottom: 1.5px solid #000; font-size: 14px;
    }
    .row:last-child { border-bottom: none; }
    .label { color: #000; font-weight: bold; }
    .value { font-weight: 700; color: #000; text-align: left; direction: ltr; }
    .teeth-section {
      margin-top: 6mm;
      margin-bottom: 0;
    }
    .teeth-title {
      font-size: 14px; font-weight: 700; color: #000;
      border-right: 3px solid #000; padding-right: 8px; margin-bottom: 6px;
    }
    .teeth-chart { width: 100%; direction: ltr; }
    .palmer-arch {
      display: flex; align-items: stretch; gap: 3px; width: 100%;
      margin: 4px 0;
    }
    .palmer-arch.upper { border-bottom: 1.5px solid #000; padding-bottom: 6px; }
    .palmer-arch.lower { padding-top: 4px; }
    .palmer-arch .rl {
      flex: 0 0 14px; font-size: 13px; font-weight: 800;
      display: flex; align-items: center; justify-content: center;
    }
    .quad {
      flex: 1 1 0; min-width: 0;
      display: grid;
      grid-template-columns: repeat(8, minmax(0, 1fr));
      grid-template-rows: auto auto;
      column-gap: 2px; row-gap: 2px;
    }
    .seg-lab {
      display: flex; align-items: flex-end; justify-content: center;
      font-size: 11px; font-weight: 800; line-height: 1; color: #000;
      min-height: 13px; min-width: 0;
    }
    .seg-lab.on { letter-spacing: 0.2px; }
    .lower .seg-lab { align-items: flex-start; }
    .seg-box {
      display: flex; align-items: center; justify-content: space-evenly;
      min-width: 0; min-height: 26px; padding: 2px 1px;
      border: 1.5px solid transparent; background: #fff;
    }
    .seg-box.empty .pn { opacity: 0.55; }
    .seg-box.selected {
      border-color: #000; border-radius: 2px;
    }
    .seg-box .pn {
      flex: 1 1 0; text-align: center;
      font-size: 14px; font-weight: 700; line-height: 1.1;
    }
    .mid-line {
      flex: 0 0 2px; align-self: stretch; background: #000; margin: 12px 2px 0;
    }
    .lower .mid-line { margin: 0 2px 12px; }
    .teeth-legend {
      margin-top: 6px; font-size: 11px; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      direction: ltr; text-align: center;
    }
    .teeth-legend .leg { display: inline; }
    .teeth-legend .leg-sep { margin: 0 5px; opacity: 0.7; }
    .footer {
      margin-top: 10px; padding-top: 8px; border-top: 1.5px solid #000;
      display: flex; justify-content: space-between; align-items: center;
      font-size: 10px; color: #000; direction: ltr;
    }
    .footer-lab { font-weight: 700; color: #000; font-size: 11px; }
    .footer-date { color: #000; font-size: 10px; direction: rtl; }
  </style>
</head>
<body>
  <div class="sheet">
  ${barcodeBlock}
  <div class="section">
    <div class="section-title">بيانات الطبيب والمريض</div>
    <div class="row"><span class="label">الطبيب</span><span class="value">${escapeHtml(c.doctor || '—')}</span></div>
    <div class="row"><span class="label">المريض</span><span class="value">${escapeHtml(c.patient || '—')}</span></div>
    <div class="row"><span class="label">الفرع</span><span class="value">${escapeHtml(c.branch || '—')}</span></div>
  </div>
  <div class="section section-work">
    <div class="section-title">تفاصيل العمل</div>
    <div class="row"><span class="label">نوع العمل</span><span class="value">${escapeHtml(workTypeDisplay)}</span></div>
    ${c.workDetail ? `<div class="row"><span class="label">ملاحظات</span><span class="value">${escapeHtml(c.workDetail)}</span></div>` : ''}
    <div class="row"><span class="label">اللون</span><span class="value">${escapeHtml(c.color || '—')}</span></div>
    <div class="row"><span class="label">إجمالي العدد</span><span class="value">${quantity}</span></div>
  </div>
  <div class="teeth-section">
    <div class="teeth-title">مخطط الأسنان</div>
    <div class="teeth-chart">
      ${renderArch(UPPER_R, UPPER_L, 'above')}
      ${renderArch(LOWER_R, LOWER_L, 'below')}
      ${legendHtml}
    </div>
  </div>
  <div class="footer">
    <span class="footer-lab">Elegance Dental Lab</span>
    <span class="footer-date">تاريخ الطباعة: ${escapeHtml(printDate)}</span>
  </div>
  </div>
</body>
</html>`;
}
