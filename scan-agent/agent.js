/**
 * Elegance Dental Lab — Station Scan Agent
 * Runs on a lab Windows PC next to a USB barcode scanner (keyboard wedge).
 * Logs in as scanner1 / scanner2 / scanner3 and POSTs scanned codes to /api/cases/scan.
 *
 * Default on Windows: global background listener — scan without focusing CMD/browser.
 *
 * Usage:
 *   node agent.js config.scanner2.json
 *   npm run start:2
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile, exec, spawn } = require('child_process');
const readline = require('readline');

// Never crash the agent on optional hook / spawn noise
process.on('uncaughtException', (err) => {
  console.warn('⚠️  Ignored error:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.warn('⚠️  Ignored rejection:', err && err.message ? err.message : err);
});

const configPath = path.resolve(
  process.cwd(),
  process.argv[2] || process.env.SCAN_CONFIG || 'config.json'
);

if (!fs.existsSync(configPath)) {
  console.error(`❌ Config not found: ${configPath}`);
  console.error('   Copy config.scannerN.example.json → config.scannerN.json and fill EMAIL/PASSWORD');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const SERVER_URL = String(config.SERVER_URL || '').replace(/\/$/, '');
const EMAIL = String(config.EMAIL || '').trim().toLowerCase();
const PASSWORD = String(config.PASSWORD || '');
const LABEL = String(config.LABEL || 'Scan Agent');
const TOKEN_REFRESH_MS = Number(config.TOKEN_REFRESH_MS) || 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = Number(config.REQUEST_TIMEOUT_MS) || 60000;
const LOGIN_RETRIES = Number(config.LOGIN_RETRIES) || 8;
const CAPTURE_PORT = Number(config.CAPTURE_PORT) || 3921;
const OPEN_CAPTURE_UI = config.OPEN_CAPTURE_UI === true;
/** Listen for barcode globally (no need to focus CMD). Default ON for Windows. */
const BACKGROUND_SCAN =
  config.BACKGROUND_SCAN !== undefined
    ? config.BACKGROUND_SCAN === true
    : process.platform === 'win32';
/** Hide/minimize console after ready. Default ON when background scan is on. */
const HIDE_CONSOLE =
  config.HIDE_CONSOLE !== undefined ? config.HIDE_CONSOLE === true : BACKGROUND_SCAN;

if (!SERVER_URL || !EMAIL || !PASSWORD) {
  console.error('❌ Config needs SERVER_URL, EMAIL, PASSWORD');
  process.exit(1);
}

// State file read by print-agent/supervisor.js so the web UI shows the REAL link state
const SCANNER_STATE_PATH = path.join(
  __dirname,
  'daemon',
  path.basename(configPath).replace(/^config\./, '').replace(/\.json$/, '') + '.state.json'
);
let scannerLinked = false;
function writeScannerState(connected) {
  if (connected !== undefined) scannerLinked = !!connected;
  try {
    fs.mkdirSync(path.dirname(SCANNER_STATE_PATH), { recursive: true });
    fs.writeFileSync(
      SCANNER_STATE_PATH,
      JSON.stringify({ pid: process.pid, connected: scannerLinked, ts: new Date().toISOString() }),
      'utf8'
    );
  } catch (_) {}
}
writeScannerState(false);
setInterval(() => writeScannerState(), 15000).unref();
process.on('exit', () => {
  try {
    if (fs.existsSync(SCANNER_STATE_PATH)) fs.unlinkSync(SCANNER_STATE_PATH);
  } catch (_) {}
});

let authToken = '';
let authRole = '';
let busy = false;
/** Queue one pending code while a scan request is in-flight (never drop as "skipped"). */
let pendingCode = '';
let lastAcceptedCode = '';
let lastAcceptedAt = 0;
const DEDUPE_MS = 1200;
const MIN_CODE_LEN = 6;
const LOG_FILE = path.join(path.dirname(configPath), 'scan-agent.log');

function appendLog(line) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

function say(...parts) {
  const line = parts.join(' ');
  console.log(...parts);
  appendLog(line);
}

say('📷 Elegance Scan Agent starting...');
say(`   Config : ${configPath}`);
say(`   Label  : ${LABEL}`);
say(`   Server : ${SERVER_URL}`);
say(`   Email  : ${EMAIL}`);
say(`   Log    : ${LOG_FILE}`);

function beep(ok) {
  if (process.platform !== 'win32') return;
  const freq = ok ? 880 : 220;
  const dur = ok ? 120 : 280;
  execFile(
    'powershell.exe',
    ['-NoProfile', '-Command', `[console]::beep(${freq},${dur})`],
    { windowsHide: true },
    () => {}
  );
}

function httpJson(method, urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : JSON.stringify(body);
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        family: 4,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch {
            data = { raw };
          }
          resolve({ status: res.statusCode || 0, data });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout after ${REQUEST_TIMEOUT_MS / 1000}s`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function loginOnce() {
  const res = await httpJson('POST', `${SERVER_URL}/api/auth/login`, {
    email: EMAIL,
    password: PASSWORD,
  });
  if (res.status >= 400 || !res.data?.token) {
    const msg = res.data?.message || res.data?.errors?.[0]?.msg || `HTTP ${res.status}`;
    throw new Error(`Login failed: ${msg}`);
  }
  authToken = res.data.token;
  authRole = String(res.data.user?.role || '');
  const name = res.data.user?.fullName || EMAIL;
  say(`✅ Logged in as ${name} (role: ${authRole})`);
  writeScannerState(true);
  if (!/^scanner[123]$/.test(authRole)) {
    say('⚠️  Account role is not scanner1/2/3 — station may not lock correctly');
    say('   Fix the employee position in Admin to سكان 1 / 2 / 3');
  }
}

async function login() {
  let lastErr = null;
  for (let attempt = 1; attempt <= LOGIN_RETRIES; attempt++) {
    try {
      await loginOnce();
      return;
    } catch (err) {
      lastErr = err;
      const wait = Math.min(15000, 1500 * attempt);
      console.warn(`⚠️  Login attempt ${attempt}/${LOGIN_RETRIES} failed: ${err.message}`);
      if (attempt < LOGIN_RETRIES) {
        console.log(`   Retrying in ${Math.round(wait / 1000)}s...`);
        await sleep(wait);
      }
    }
  }
  throw lastErr || new Error('Login failed');
}

async function ensureAuth() {
  if (!authToken) await login();
}

function normalizeScanInput(rawCode) {
  return String(rawCode || '')
    .replace(/[\r\n\t]+/g, '')
    .replace(/[\u064B-\u065F\u0670\u200e\u200f\u202a-\u202e\ufeff]/g, '')
    .trim();
}

async function scanCode(rawCode) {
  const code = normalizeScanInput(rawCode);
  if (!code) return { ok: false, message: 'Empty code' };
  if (code.length < MIN_CODE_LEN) {
    console.log(`⏭️  Ignored short code: "${code}"`);
    return { ok: false, message: 'Short code' };
  }

  // Same barcode from dual hooks / double Enter within ~1.2s → ignore duplicate
  const now = Date.now();
  if (code === lastAcceptedCode && now - lastAcceptedAt < DEDUPE_MS) {
    return { ok: true, message: 'Duplicate ignored', deduped: true };
  }

  if (busy) {
    // Keep latest pending — process after current request finishes (no "skipped")
    pendingCode = code;
    return { ok: false, message: 'Queued' };
  }

  lastAcceptedCode = code;
  lastAcceptedAt = now;
  busy = true;
  say(`\n📷 Scan: ${code}`);
  try {
    await ensureAuth();
    let res = await httpJson(
      'POST',
      `${SERVER_URL}/api/cases/scan`,
      { caseNumber: code },
      { Authorization: `Bearer ${authToken}` }
    );

    if (res.status === 401) {
      say('🔄 Token expired — re-login...');
      authToken = '';
      await login();
      res = await httpJson(
        'POST',
        `${SERVER_URL}/api/cases/scan`,
        { caseNumber: code },
        { Authorization: `Bearer ${authToken}` }
      );
    }

    if (res.status >= 200 && res.status < 300 && res.data?.success) {
      const message = res.data.message || 'OK';
      writeScannerState(true);
      say(`✅ ${message}`);
      if (res.data.case?.currentStage) {
        say(`   → stage: ${res.data.case.currentStage}`);
      }
      beep(true);
      return { ok: true, message, stage: res.data.case?.currentStage };
    }

    const message = res.data?.message || res.data?.error || `HTTP ${res.status}`;
    writeScannerState(true); // server answered — link is alive even if the scan was rejected
    say(`❌ ${message}`);
    beep(false);
    return { ok: false, message };
  } catch (err) {
    writeScannerState(false); // network / server unreachable
    say(`❌ ${err.message}`);
    beep(false);
    return { ok: false, message: err.message };
  } finally {
    busy = false;
    const next = pendingCode;
    pendingCode = '';
    if (next && next !== code) {
      setImmediate(() => {
        void scanCode(next);
      });
    }
  }
}

function startStdinFallback() {
  say('⌨️  Console input ON (backup if you focus this window)');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', (line) => {
    void scanCode(line);
  });
}

function keyNameToChar(name) {
  const n = String(name || '').toUpperCase();
  if (/^[0-9]$/.test(n)) return n;
  if (/^[A-Z]$/.test(n)) return n;
  if (n === 'MINUS' || n === 'OEM_MINUS' || n === 'DASH' || n === 'SUBTRACT') return '-';
  if (n === 'PERIOD' || n === 'OEM_PERIOD' || n === 'DECIMAL') return '.';
  return '';
}

/**
 * Primary Windows background capture: US-QWERTY VK map via PowerShell hook.
 * Works even when Arabic keyboard is active and CMD is hidden/unfocused.
 */
function startUsLayoutBarcodeHook() {
  if (!BACKGROUND_SCAN || process.platform !== 'win32') return false;
  const hookScript = path.join(__dirname, 'win-us-barcode-hook.ps1');
  if (!fs.existsSync(hookScript)) {
    say('⚠️  Missing win-us-barcode-hook.ps1');
    return false;
  }

  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', hookScript],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let buf = '';
    const onData = (chunk) => {
      buf += String(chunk || '');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        if (t === 'HOOK_READY') {
          say('🎧 US-layout background hook READY (no focus needed)');
          continue;
        }
        if (t.startsWith('SCAN:')) {
          void scanCode(t.slice(5));
        }
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => say(`⚠️  Hook stderr: ${String(c).trim()}`));
    child.on('exit', (code) => say(`⚠️  Background hook exited (${code})`));
    child.on('error', (err) => say(`⚠️  Background hook error: ${err.message}`));

    process.on('exit', () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    });

    say('🎧 Starting US-layout barcode hook (works with Arabic keyboard)...');
    return true;
  } catch (err) {
    say(`⚠️  Could not start US-layout hook: ${err.message}`);
    return false;
  }
}

/**
 * Secondary listener (npm package). Kept as extra safety net.
 */
function startGlobalBarcodeListener() {
  if (!BACKGROUND_SCAN || process.platform !== 'win32') return false;
  let GlobalKeyboardListener;
  try {
    ({ GlobalKeyboardListener } = require('node-global-key-listener'));
  } catch (err) {
    return false;
  }

  const listener = new GlobalKeyboardListener();
  let buf = '';
  let lastTs = 0;
  const MAX_GAP_MS = 140;

  listener.addListener((e) => {
    if (e.state !== 'DOWN') return;

    const now = Date.now();
    if (lastTs && now - lastTs > MAX_GAP_MS) buf = '';
    lastTs = now;

    if (e.name === 'RETURN' || e.name === 'ENTER') {
      const code = buf;
      buf = '';
      if (code.length >= MIN_CODE_LEN) void scanCode(code);
      return;
    }

    const ch = keyNameToChar(e.name);
    if (ch) buf += ch;
  });

  say('🎧 Secondary npm key listener ON');
  return true;
}

function hideConsoleWindow() {
  if (!HIDE_CONSOLE || process.platform !== 'win32') return;
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ScanAgentWin {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$h = [ScanAgentWin]::GetConsoleWindow()
if ($h -ne [IntPtr]::Zero) { [ScanAgentWin]::ShowWindow($h, 2) | Out-Null }
`;
  // 2 = SW_SHOWMINIMIZED — stays in taskbar so you can open it if needed, no focus required to scan
  execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
    windowsHide: true,
  }, () => {});
  say('👻 Console minimized — scan works in background (taskbar: Elegance Scan)');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function capturePageHtml() {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(LABEL)}</title>
  <style>
    html, body { height: 100%; margin: 0; font-family: Segoe UI, Tahoma, sans-serif; background: #0f172a; color: #e2e8f0; }
    .wrap { min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 24px; }
    h1 { margin: 0; font-size: 22px; }
    p { margin: 0; opacity: .8; text-align: center; max-width: 480px; }
    input {
      width: min(520px, 92vw); font-size: 22px; padding: 14px 16px; border-radius: 10px;
      border: 2px solid #38bdf8; background: #020617; color: #f8fafc; direction: ltr; text-align: center;
    }
    .log { min-height: 28px; font-size: 16px; font-weight: 700; text-align: center; max-width: 520px; }
    .ok { color: #4ade80; } .err { color: #f87171; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>${escapeHtml(LABEL)}</h1>
    <p>امسح الباركود هنا — سيّب الصفحة دي مفتوحة ومختارة</p>
    <input id="scan" autofocus autocomplete="off" spellcheck="false" placeholder="Ready to scan…" />
    <div id="log" class="log"></div>
  </div>
  <script>
    const input = document.getElementById('scan');
    const log = document.getElementById('log');
    function focusScan() { try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); } }
    setInterval(focusScan, 400);
    window.addEventListener('focus', focusScan);
    document.addEventListener('click', focusScan);
    input.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const code = input.value.trim();
      input.value = '';
      if (!code) return;
      log.textContent = 'Sending ' + code + '…';
      log.className = 'log';
      try {
        const res = await fetch('/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const data = await res.json();
        log.textContent = data.message || (data.ok ? 'OK' : 'Failed');
        log.className = 'log ' + (data.ok ? 'ok' : 'err');
      } catch (err) {
        log.textContent = err.message || 'Error';
        log.className = 'log err';
      }
      focusScan();
    });
  </script>
</body>
</html>`;
}

function startCaptureUi() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url?.startsWith('/?'))) {
        const html = capturePageHtml();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (req.method === 'POST' && req.url === '/scan') {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', async () => {
          let code = '';
          try {
            code = JSON.parse(raw || '{}').code || '';
          } catch {
            code = raw;
          }
          const result = await scanCode(code);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        });
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });

    server.on('error', reject);
    server.listen(CAPTURE_PORT, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${CAPTURE_PORT}/`;
      console.log(`🌐 Capture UI: ${url}`);
      if (OPEN_CAPTURE_UI) {
        const cmd =
          process.platform === 'win32'
            ? `start "" "${url}"`
            : process.platform === 'darwin'
              ? `open "${url}"`
              : `xdg-open "${url}"`;
        exec(cmd, () => {});
      }
      resolve(url);
    });
  });
}

function enableKeepAwake() {
  if (process.platform !== 'win32') return;
  try {
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
    const refresh = () => {
      execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }, () => {});
    };
    refresh();
    setInterval(refresh, 60000);
    console.log('☕ Keep-awake enabled');
  } catch {
    /* ignore */
  }
}

async function main() {
  enableKeepAwake();

  for (;;) {
    try {
      await login();
      break;
    } catch (err) {
      say(`❌ Cannot reach server yet: ${err.message}`);
      say('   Waiting 10s then trying again... (check internet / Railway)');
      await sleep(10000);
    }
  }

  setInterval(() => {
    loginOnce().catch((err) => {
      writeScannerState(false);
      say(`⚠️  Re-login failed: ${err.message}`);
    });
  }, TOKEN_REFRESH_MS);

  // Prefer US-layout hook alone — running both fires the same barcode twice
  // and used to log "Busy — skipped" while dropping the real scan.
  const usHookOk = startUsLayoutBarcodeHook();
  const npmHookOk = usHookOk ? false : startGlobalBarcodeListener();
  if (usHookOk) {
    say('🎧 Using US-layout hook only (secondary listener off — avoids duplicate skip)');
  }
  const backgroundOk = usHookOk || npmHookOk;
  startStdinFallback();

  if (OPEN_CAPTURE_UI) {
    await startCaptureUi();
  }

  say('\n✅ Ready — waiting for barcode scans');
  if (backgroundOk) {
    say('   Scan anytime — no need to open or focus CMD');
    say('   Works with Arabic keyboard (US key mapping)');
    say('   Case stage updates on the server automatically');
  } else if (OPEN_CAPTURE_UI) {
    say('   Use the Capture page, or focus this window and scan');
  } else {
    say('   Focus this black window, then scan');
  }
  say('');

  if (backgroundOk && HIDE_CONSOLE) {
    await sleep(2500);
    hideConsoleWindow();
  }
}

main().catch((err) => {
  say(`❌ Fatal: ${err.message}`);
  process.exit(1);
});
