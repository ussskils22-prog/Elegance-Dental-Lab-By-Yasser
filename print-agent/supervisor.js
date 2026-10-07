/**
 * Elegance Print Agent — Local Supervisor
 * Always-on tiny HTTP server on 127.0.0.1 so the web UI can
 * start / stop the print agent with buttons.
 *
 *   GET  /status  → { ok, running, pid, supervisor: true }
 *   POST /start   → spawn agent.js
 *   POST /stop    → kill agent.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = __dirname;
const LOCK_PATH = path.join(ROOT, 'daemon', 'agent.lock');
const AGENT_JS = path.join(ROOT, 'agent.js');
const OUT_LOG = path.join(ROOT, 'daemon', 'user-agent.out.log');
const ERR_LOG = path.join(ROOT, 'daemon', 'user-agent.err.log');
const SUP_LOG = path.join(ROOT, 'daemon', 'supervisor.log');

let config = {};
try {
  const raw = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
  config = JSON.parse(raw);
} catch (_) {}

const PORT = Number(config.CONTROL_PORT) || 17891;
const HOST = '127.0.0.1';
const AUTO_START_AGENT = config.AUTO_START_AGENT !== false;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try {
    fs.mkdirSync(path.dirname(SUP_LOG), { recursive: true });
    fs.appendFileSync(SUP_LOG, line);
  } catch (_) {}
  console.log(...args);
}

function nodePath() {
  const candidates = [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'node';
}

function readLockPid() {
  try {
    if (!fs.existsSync(LOCK_PATH)) return null;
    const n = Number(String(fs.readFileSync(LOCK_PATH, 'utf8')).trim());
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

function listAgentPids() {
  // Fast path only — never block HTTP on PowerShell/WMI
  const lock = readLockPid();
  if (lock && isPidAlive(lock)) return [lock];
  return [];
}

function killAllAgentsHard() {
  if (process.platform !== 'win32') {
    const lock = readLockPid();
    if (lock) {
      try {
        process.kill(lock);
      } catch (_) {}
    }
    return;
  }
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { if ([string]$_.CommandLine -match 'print-agent[/\\\\]+agent\\.js') { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }`,
      ],
      { windowsHide: true, timeout: 6000 }
    );
  } catch (_) {}
}

function getStatus() {
  const pids = listAgentPids();
  const pid = pids[0] || null;
  return {
    ok: true,
    supervisor: true,
    running: pids.length > 0,
    pid,
    pids,
    port: PORT,
  };
}

function stopAgent() {
  const pids = listAgentPids();
  for (const pid of pids) {
    try {
      process.kill(pid);
      log('Stopped agent PID', String(pid));
    } catch (err) {
      log('Kill soft failed', String(pid), err.message);
    }
  }
  // Sweep any orphan agent.js (may briefly block — only on /stop)
  killAllAgentsHard();
  try {
    if (fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
  } catch (_) {}
  return { ok: true, supervisor: true, running: false, pid: null, pids: [], port: PORT };
}

function startAgent() {
  const current = getStatus();
  if (current.running) {
    return { ...current, alreadyRunning: true };
  }

  fs.mkdirSync(path.join(ROOT, 'daemon'), { recursive: true });
  const outFd = fs.openSync(OUT_LOG, 'a');
  const errFd = fs.openSync(ERR_LOG, 'a');
  const child = spawn(nodePath(), [AGENT_JS], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
  });
  child.unref();
  try {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  } catch (_) {}

  log('Started agent spawn PID', String(child.pid));
  // Don't block the HTTP event loop waiting — client polls /status
  return {
    ok: true,
    supervisor: true,
    running: true,
    started: true,
    pid: child.pid,
    pids: [child.pid],
    port: PORT,
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
    return;
  }

  if (method === 'POST' && url === '/start') {
    try {
      const immediate = startAgent();
      setTimeout(() => {
        const st = getStatus();
        sendJson(res, 200, st.running ? { ...st, started: true } : { ...immediate, ...st });
      }, 900);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (method === 'POST' && url === '/stop') {
    try {
      const st = stopAgent();
      setTimeout(() => sendJson(res, 200, st), 50);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, HOST, () => {
  log(`Supervisor listening on http://${HOST}:${PORT}`);
  console.log(`🎛️  Print supervisor on http://${HOST}:${PORT}`);
  console.log('   UI buttons: تشغيل الطباعة / إيقاف الطباعة');
  if (AUTO_START_AGENT) {
    setTimeout(() => {
      try {
        const st = startAgent();
        log('Auto-start agent → pid=', String(st.pid || ''));
      } catch (err) {
        log('Auto-start failed:', err.message);
      }
    }, 300);
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

