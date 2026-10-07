import { Injectable, signal } from '@angular/core';

/** Local supervisor on the print PC (see print-agent/supervisor.js). */
const CONTROL_BASE = 'http://127.0.0.1:17891';

export type LocalPrintStatus = {
  reachable: boolean;
  running: boolean;
  pid: number | null;
};

function abortAfter(ms: number): AbortSignal {
  const anyAbort = AbortSignal as unknown as { timeout?: (n: number) => AbortSignal };
  if (typeof anyAbort.timeout === 'function') return anyAbort.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

@Injectable({ providedIn: 'root' })
export class LocalPrintControlService {
  readonly status = signal<LocalPrintStatus>({
    reachable: false,
    running: false,
    pid: null,
  });
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
      const data = (await res.json()) as { running?: boolean; pid?: number | null };
      const next: LocalPrintStatus = {
        reachable: true,
        running: Boolean(data.running),
        pid: data.pid ?? null,
      };
      this.status.set(next);
      this.lastError.set(null);
      return next;
    } catch {
      const next: LocalPrintStatus = { reachable: false, running: false, pid: null };
      this.status.set(next);
      return next;
    }
  }

  async start(): Promise<LocalPrintStatus> {
    return this.postAction('/start');
  }

  async stop(): Promise<LocalPrintStatus> {
    return this.postAction('/stop');
  }

  private async postAction(path: '/start' | '/stop'): Promise<LocalPrintStatus> {
    this.busy.set(true);
    this.lastError.set(null);
    try {
      const res = await fetch(`${CONTROL_BASE}${path}`, {
        method: 'POST',
        cache: 'no-store',
        signal: abortAfter(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json().catch(() => ({}))) as {
        running?: boolean;
        pid?: number | null;
      };
      const next: LocalPrintStatus = {
        reachable: true,
        running: Boolean(data.running),
        pid: data.pid ?? null,
      };
      this.status.set(next);
      // Confirm with a fresh status poll
      await new Promise((r) => setTimeout(r, path === '/start' ? 400 : 200));
      return await this.refresh();
    } catch {
      this.lastError.set('unreachable');
      const next = await this.refresh();
      return next;
    } finally {
      this.busy.set(false);
    }
  }
}

