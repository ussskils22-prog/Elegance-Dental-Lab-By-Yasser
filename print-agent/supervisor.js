/**
 * Elegance Station Supervisor — local device controller
 *
 * Always-on tiny HTTP server on 127.0.0.1 so the web UI can start / stop the
 * print agent and the scan agents on THIS PC, and see the REAL state of the
 * Windows printers (sheet + receipt).
 *
 *   GET  /status                 → full station status (see getStatus)
 *   POST /print/start | /print/stop
 *   POST /scanner/:n/start | /scanner/:n/stop     (n = 1 | 2 | 3)
 *   POST /start | /stop          → legacy aliases for /print/*
 *
 * Install once per PC with install.bat (no administrator needed).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');

const ROOT = __dirname;
const DAEMON_DIR = path.join(ROOT, 'daemon');
const LOCK_PATH = path.join(DAEMON_DIR, 'agent.lock');
const AGENT_STATE_PATH = path.join(DAEMON_DIR, 'agent.state.json');
const AGENT_JS = path.join(ROOT, 'agent.js');
const OUT_LOG = path.join(DAEMON_DIR, 'user-agent.out.log');
const ERR_LOG = path.join(DAEMON_DIR, 'user-agent.err.log');
const SUP_LOG = path.join(DAEMON_DIR, 'supervisor.log');

let config = {};
try {
  const raw = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
  config = JSON.parse(raw);
} catch (_) {}

const PORT = Number(config.CONTROL_PORT) || 17891;
const HOST = '127.0.0.1';
const AUTO_START_AGENT = config.AUTO_START_AGENT !== false;
const PRINTER_NAME = String(config.PRINTER_NAME || '').trim();
const RECEIPT_PRINTER_NAME = String(config.RECEIPT_PRINTER_NAME || '').trim();
/** Print agent is managed on this PC when agent.js + config exist (or MANAGE_PRINT forced). */
const MANAGE_PRINT =
  config.MANAGE_PRINT !== undefined ? config.MANAGE_PRINT === true : fs.existsSync(AGENT_JS);
const SCAN_AGENT_DIR = path.resolve(ROOT, String(config.SCAN_AGENT_DIR || path.join('..', 'scan-agent')));
const SCANNER_IDS = ['1', '2', '3'];
const PRINTER_POLL_MS = Math.max(3000, Number(config.PRINTER_STATUS_POLL_MS) || 6000);
const IS_WIN = process.platform === 'win32';

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try {
    fs.mkdirSync(DAEMON_DIR, { recursive: true });
    fs.appendFileSync(SUP_LOG, line);
  } catch (_) {}
  console.log(...args);
}

function nodePath() {
  const candidates = [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    process.execPath,
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return 'node';
}

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) {
    return null;
  }
}

function readPidFile(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const n = Number(String(fs.readFileSync(p, 'utf8')).trim().split(/\r?\n/)[0]);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (_) {
    return null;
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function psEscape(s) {
  return String(s).replace(/'/g, "''");
}

/** Run a PowerShell snippet synchronously (start/stop paths only). */
function psSync(script, timeout = 8000) {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true, timeout, encoding: 'utf8' }
  );
}

/** Run a PowerShell snippet asynchronously (status polling — never blocks HTTP). */
function psAsync(script, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout || '')))
    );
  });
}

// ───────────────────────── process discovery ─────────────────────────

/** node.exe PIDs whose command line matches `pattern` (regex source). */
function listNodePidsMatching(pattern) {
  if (!IS_WIN) return [];
  try {
    const out = psSync(
      [
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {`,
        `  $cmd = [string]$_.CommandLine`,
        `  if ($cmd -and ($cmd -match '${psEscape(pattern)}')) { $_.ProcessId }`,
        `}`,
      ].join('; '),
      6000
    );
    return [...new Set(
      String(out)
        .split(/\r?\n/)
        .map((s) => Number(String(s).trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    )];
  } catch (_) {
    return [];
  }
}

function killPids(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch (_) {}
  }
  if (IS_WIN && pids.length) {
    try {
      psSync(
        `@(${pids.join(',')}) | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`,
        6000
      );
    } catch (_) {}
  }
}

const PRINT_AGENT_PATTERN = 'print-agent[/\\\\]+agent\\.js';
function scannerPattern(n) {
  return `scan-agent[/\\\\]+agent\\.js.*config\\.scanner${n}\\.json`;
}

function spawnDetached(cmdArgs, cwd, outLog, errLog) {
  fs.mkdirSync(path.dirname(outLog), { recursive: true });
  const outFd = fs.openSync(outLog, 'a');
  const errFd = fs.openSync(errLog, 'a');
  const child = spawn(nodePath(), cmdArgs, {
    cwd,
    detached: true,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
  });
  child.unref();
  try {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  } catch (_) {}
  return child.pid;
}

// ───────────────────────── print agent ─────────────────────────

function printAgentFastPids() {
  const lock = readPidFile(LOCK_PATH);
  return lock && isPidAlive(lock) ? [lock] : [];
}

function printAgentStatus() {
  const pids = printAgentFastPids();
  const state = readJsonSafe(AGENT_STATE_PATH) || {};
  const running = pids.length > 0;
  // agent writes {pid, connected, ts} on connect/disconnect
  const stateFresh = state && Number(state.pid) === pids[0];
  return {
    installed: MANAGE_PRINT,
    running,
    pid: pids[0] || null,
    serverLinked: running && stateFresh ? state.connected === true : running ? null : false,
    lastSeen: state.ts || null,
    printerDown: stateFresh ? state.printerDown === true : null,
  };
}

function stopPrintAgent() {
  const pids = [...new Set([...printAgentFastPids(), ...listNodePidsMatching(PRINT_AGENT_PATTERN)])];
  killPids(pids);
  clearPrinterQueue(PRINTER_NAME);
  clearPrinterQueue(RECEIPT_PRINTER_NAME);
  try {
    if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
  } catch (_) {}
  try {
    if (fs.existsSync(AGENT_STATE_PATH)) fs.unlinkSync(AGENT_STATE_PATH);
  } catch (_) {}
  log('Print agent stopped', pids.join(','));
}

function startPrintAgent() {
  if (!MANAGE_PRINT) return printAgentStatus();
  const cur = printAgentStatus();
  if (cur.running && isPidAlive(cur.pid)) {
    const strays = listNodePidsMatching(PRINT_AGENT_PATTERN).filter((p) => p !== cur.pid);
    if (strays.length) killPids(strays);
    return { ...cur, alreadyRunning: true };
  }
  killPids(listNodePidsMatching(PRINT_AGENT_PATTERN));
  try {
    if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
  } catch (_) {}
  const pid = spawnDetached([AGENT_JS], ROOT, OUT_LOG, ERR_LOG);
  log('Print agent started pid', String(pid));
  return { ...printAgentStatus(), running: true, pid, started: true };
}

/** Cancel anything sitting in the Windows spooler for a printer */
function clearPrinterQueue(name) {
  if (!IS_WIN || !name) return;
  try {
    psSync(
      `Get-PrintJob -PrinterName '${psEscape(name)}' -ErrorAction SilentlyContinue | Remove-PrintJob -Confirm:$false -ErrorAction SilentlyContinue`,
      8000
    );
    log('Cleared printer queue for', name);
  } catch (err) {
    log('Clear printer queue skipped:', err.message || String(err));
  }
}

// ───────────────────────── scanners ─────────────────────────

function scannerConfigPath(n) {
  return path.join(SCAN_AGENT_DIR, `config.scanner${n}.json`);
}
function scannerPidPath(n) {
  return path.join(DAEMON_DIR, `scanner${n}.pid`);
}
function scannerStatePath(n) {
  return path.join(SCAN_AGENT_DIR, 'daemon', `scanner${n}.state.json`);
}

function scannerStatus(n) {
  const installed = fs.existsSync(path.join(SCAN_AGENT_DIR, 'agent.js')) && fs.existsSync(scannerConfigPath(n));
  const pid = readPidFile(scannerPidPath(n));
  const statePid = readPidFile(scannerStatePath(n));
  const state = readJsonSafe(scannerStatePath(n)) || {};
  const livePid = isPidAlive(pid) ? pid : isPidAlive(Number(state.pid)) ? Number(state.pid) : null;
  const running = !!livePid;
  const cfg = installed ? readJsonSafe(scannerConfigPath(n)) || {} : {};
  return {
    id: Number(n),
    label: String(cfg.LABEL || `سكان ${n}`),
    installed,
    running,
    pid: livePid,
    serverLinked: running && Number(state.pid) === livePid ? state.connected === true : running ? null : false,
    lastSeen: state.ts || null,
  };
}

function stopScanner(n) {
  const pids = [...new Set([readPidFile(scannerPidPath(n)), ...listNodePidsMatching(scannerPattern(n))].filter(Boolean))];
  killPids(pids);
  try {
    if (fs.existsSync(scannerPidPath(n))) fs.unlinkSync(scannerPidPath(n));
  } catch (_) {}
  try {
    if (fs.existsSync(scannerStatePath(n))) fs.unlinkSync(scannerStatePath(n));
  } catch (_) {}
  log(`Scanner ${n} stopped`, pids.join(','));
}

function startScanner(n) {
  const cur = scannerStatus(n);
  if (!cur.installed) return cur;
  if (cur.running) return { ...cur, alreadyRunning: true };
  killPids(listNodePidsMatching(scannerPattern(n)));
  const pid = spawnDetached(
    [path.join(SCAN_AGENT_DIR, 'agent.js'), `config.scanner${n}.json`],
    SCAN_AGENT_DIR,
    path.join(SCAN_AGENT_DIR, 'daemon', `scanner${n}.out.log`),
    path.join(SCAN_AGENT_DIR, 'daemon', `scanner${n}.err.log`)
  );
  try {
    fs.mkdirSync(DAEMON_DIR, { recursive: true });
    fs.writeFileSync(scannerPidPath(n), String(pid), 'utf8');
  } catch (_) {}
  log(`Scanner ${n} started pid`, String(pid));
  return { ...scannerStatus(n), running: true, pid, started: true };
}

// ───────────────────────── Windows printer state (cached) ─────────────────────────

/** name → { name, state: ready|offline|error|missing|unknown, jobs, raw } */
const printerCache = {};
let printerPollInFlight = false;

function mapPrinterState(row) {
  if (!row) return 'missing';
  if (row.WorkOffline === true) return 'offline';
  const st = String(row.PrinterStatus || '').toLowerCase();
  // PrinterStatus enum: Normal, Offline, Error, PaperJam, PaperOut, DoorOpen, TonerLow, ...
  if (!st || st === 'normal' || st === 'idle' || st === 'printing' || st === 'tonerlow' || st === 'warmingup') return 'ready';
  if (st === 'offline' || st === 'notavailable' || st === 'poweredoff') return 'offline';
  return 'error';
}

async function pollPrinters() {
  if (!IS_WIN || printerPollInFlight) return;
  const names = [PRINTER_NAME, RECEIPT_PRINTER_NAME].filter(Boolean);
  if (!names.length) return;
  printerPollInFlight = true;
  try {
    const list = names.map((n) => `'${psEscape(n)}'`).join(',');
    const out = await psAsync(
      [
        `$names = @(${list})`,
        `$res = foreach ($n in $names) {`,
        `  $p = Get-Printer -Name $n -ErrorAction SilentlyContinue`,
        `  if ($p) {`,
        `    $jobs = @(Get-PrintJob -PrinterName $n -ErrorAction SilentlyContinue).Count`,
        `    [pscustomobject]@{ Name=$n; Found=$true; PrinterStatus=[string]$p.PrinterStatus; WorkOffline=[bool]$p.WorkOffline; Jobs=$jobs }`,
        `  } else { [pscustomobject]@{ Name=$n; Found=$false } }`,
        `}`,
        `@($res) | ConvertTo-Json -Compress`,
      ].join('; '),
      12000
    );
    let rows = [];
    try {
      const parsed = JSON.parse(out.trim() || '[]');
      rows = Array.isArray(parsed) ? parsed : [parsed];
    } catch (_) {
      rows = [];
    }
    const now = new Date().toISOString();
    for (const n of names) {
      const row = rows.find((r) => r && r.Name === n);
      printerCache[n] = {
        name: n,
        state: row && row.Found ? mapPrinterState(row) : 'missing',
        jobs: row && row.Found ? Number(row.Jobs) || 0 : 0,
        raw: row && row.Found ? String(row.PrinterStatus || '') : '',
        checkedAt: now,
      };
    }
  } catch (err) {
    for (const n of names) {
      if (!printerCache[n]) printerCache[n] = { name: n, state: 'unknown', jobs: 0, raw: '', checkedAt: null };
    }
    log('Printer poll failed:', err.message || String(err));
  } finally {
    printerPollInFlight = false;
  }
}

function printerInfo(name) {
  if (!name) return null;
  return printerCache[name] || { name, state: 'unknown', jobs: 0, raw: '', checkedAt: null };
}

// ───────────────────────── status + HTTP ─────────────────────────

function getStatus() {
  const print = printAgentStatus();
  return {
    ok: true,
    supervisor: true,
    version: 2,
    port: PORT,
    // legacy fields (old UI builds)
    running: print.running,
    pid: print.pid,
    pids: print.pid ? [print.pid] : [],
    print,
    printers: {
      sheet: printerInfo(PRINTER_NAME),
      receipt: printerInfo(RECEIPT_PRINTER_NAME),
    },
    scanners: SCANNER_IDS.map(scannerStatus),
    scanAgentDir: SCAN_AGENT_DIR,
  };
}

function sendJson(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function respondAfter(res, ms) {
  setTimeout(() => sendJson(res, 200, getStatus()), ms);
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  const method = (req.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  if (method === 'GET' && (url === '/' || url === '/status')) {
    sendJson(res, 200, getStatus());
    void pollPrinters();
    return;
  }

  if (method !== 'POST') {
    sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }

  try {
    if (url === '/start' || url === '/print/start') {
      startPrintAgent();
      return respondAfter(res, 900);
    }
    if (url === '/stop' || url === '/print/stop') {
      stopPrintAgent();
      return respondAfter(res, 200);
    }
    const m = url.match(/^\/scanner\/([123])\/(start|stop)$/);
    if (m) {
      if (m[2] === 'start') startScanner(m[1]);
      else stopScanner(m[1]);
      return respondAfter(res, m[2] === 'start' ? 900 : 200);
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  log(`Supervisor listening on http://${HOST}:${PORT}`);
  console.log(`🎛️  Station supervisor on http://${HOST}:${PORT}`);
  console.log(`   print agent: ${MANAGE_PRINT ? 'managed' : 'not on this PC'} | scan-agent dir: ${SCAN_AGENT_DIR}`);
  void pollPrinters();
  setInterval(() => void pollPrinters(), PRINTER_POLL_MS);
  if (AUTO_START_AGENT && MANAGE_PRINT) {
    setTimeout(() => {
      try {
        const st = startPrintAgent();
        log('Auto-start print agent → pid=', String(st.pid || ''));
      } catch (err) {
        log('Auto-start failed:', err.message);
      }
    }, 300);
  }
  // Auto-start scanners that were running before (pid file present) or configured AUTO_START_SCANNERS
  const autoScan = Array.isArray(config.AUTO_START_SCANNERS) ? config.AUTO_START_SCANNERS.map(String) : [];
  for (const n of SCANNER_IDS) {
    if (autoScan.includes(n) || fs.existsSync(scannerPidPath(n))) {
      setTimeout(() => {
        try {
          startScanner(n);
        } catch (err) {
          log(`Auto-start scanner ${n} failed:`, err.message);
        }
      }, 800);
    }
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} already in use — supervisor may already be running.`);
    process.exit(0);
  }
  console.error('❌ Supervisor error:', err.message);
  process.exit(1);
});
