import { Injectable, signal } from '@angular/core';

/** Local station supervisor on this PC (see print-agent/supervisor.js). */
const CONTROL_BASE = 'http://127.0.0.1:17891';

export type PrinterState = 'ready' | 'offline' | 'error' | 'missing' | 'unknown';

export interface PrinterInfo {
  name: string;
  state: PrinterState;
  jobs: number;
  raw: string;
  checkedAt: string | null;
}

export interface AgentInfo {
  installed: boolean;
  running: boolean;
  pid: number | null;
  /** true/false from the agent's own state file; null = running but not reported yet */
  serverLinked: boolean | null;
  lastSeen: string | null;
}

export interface ScannerInfo extends AgentInfo {
  id: number;
  label: string;
}

export type LocalPrintStatus = {
  reachable: boolean;
  /** legacy: print agent running */
  running: boolean;
  pid: number | null;
  print: AgentInfo;
  printers: { sheet: PrinterInfo | null; receipt: PrinterInfo | null };
  scanners: ScannerInfo[];
};

const EMPTY_AGENT: AgentInfo = { installed: false, running: false, pid: null, serverLinked: false, lastSeen: null };

function emptyStatus(): LocalPrintStatus {
  return {
    reachable: false,
    running: false,
    pid: null,
    print: { ...EMPTY_AGENT },
    printers: { sheet: null, receipt: null },
    scanners: [],
  };
}

function abortAfter(ms: number): AbortSignal {
  const anyAbort = AbortSignal as unknown as { timeout?: (n: number) => AbortSignal };
  if (typeof anyAbort.timeout === 'function') return anyAbort.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

function normalize(data: Record<string, unknown>): LocalPrintStatus {
  const print = (data['print'] as AgentInfo | undefined) || {
    ...EMPTY_AGENT,
    installed: true,
    running: Boolean(data['running']),
    pid: (data['pid'] as number | null) ?? null,
    serverLinked: null,
  };
  const printers = (data['printers'] as LocalPrintStatus['printers'] | undefined) || { sheet: null, receipt: null };
  const scanners = Array.isArray(data['scanners']) ? (data['scanners'] as ScannerInfo[]) : [];
  return {
    reachable: true,
    running: Boolean(print.running),
    pid: print.pid ?? null,
    print,
    printers,
    scanners,
  };
}

@Injectable({ providedIn: 'root' })
export class LocalPrintControlService {
  readonly status = signal<LocalPrintStatus>(emptyStatus());
  readonly busy = signal(false);
  readonly lastError = signal<string | null>(null);

  async refresh(): Promise<LocalPrintStatus> {
    try {
      const res = await fetch(`${CONTROL_BASE}/status`, {
        method: 'GET',
        cache: 'no-store',
        signal: abortAfter(2500),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>;
      const next = normalize(data);
      this.status.set(next);
      this.lastError.set(null);
      return next;
    } catch {
      const next = emptyStatus();
      this.status.set(next);
      return next;
    }
  }

  start(): Promise<LocalPrintStatus> {
    return this.postAction('/print/start');
  }

  stop(): Promise<LocalPrintStatus> {
    return this.postAction('/print/stop');
  }

  startScanner(id: number): Promise<LocalPrintStatus> {
    return this.postAction(`/scanner/${id}/start`);
  }

  stopScanner(id: number): Promise<LocalPrintStatus> {
    return this.postAction(`/scanner/${id}/stop`);
  }

  private async postAction(path: string): Promise<LocalPrintStatus> {
    this.busy.set(true);
    this.lastError.set(null);
    try {
      const res = await fetch(`${CONTROL_BASE}${path}`, {
        method: 'POST',
        cache: 'no-store',
        signal: abortAfter(12000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      this.status.set(normalize(data));
      // Confirm with a fresh status poll
      await new Promise((r) => setTimeout(r, path.endsWith('/start') ? 600 : 250));
      return await this.refresh();
    } catch {
      this.lastError.set('unreachable');
      return await this.refresh();
    } finally {
      this.busy.set(false);
    }
  }
}
