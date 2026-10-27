import { ApplicationRef, Injectable, inject, signal } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { concat, filter, first, fromEvent, interval, merge, of, switchMap } from 'rxjs';

/**
 * Keep installed PWAs / phones on the latest deploy.
 * Mobile PWAs throttle timers hard in background — so we also check on
 * focus / visibility, and show a banner if auto-reload doesn't land.
 */
@Injectable({ providedIn: 'root' })
export class SwUpdateService {
  private readonly updates = inject(SwUpdate);
  private readonly appRef = inject(ApplicationRef);

  /** True when a new version is ready and waiting for reload */
  readonly updateReady = signal(false);
  readonly applying = signal(false);

  private started = false;
  private reloadArmed = false;

  start(): void {
    if (this.started || !this.updates.isEnabled) return;
    this.started = true;

    this.updates.versionUpdates
      .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
      .subscribe(() => {
        this.updateReady.set(true);
        void this.applyUpdate(true);
      });

    this.updates.unrecoverable.subscribe(() => {
      void this.hardResetApp();
    });

    // Immediate check (don't wait for Angular stability — PWA reopen needs this)
    this.safeCheck();
    void this.nudgeInstalledWorker();
    window.setTimeout(() => {
      try {
        sessionStorage.removeItem('masar_sw_reload');
      } catch {
        /* ignore */
      }
    }, 15000);

    // After first stable, then every 30s while the tab/app is open
    this.appRef.isStable
      .pipe(
        first((stable) => stable === true),
        switchMap(() => concat(of(0), interval(30_000)))
      )
      .subscribe(() => this.safeCheck());

    // Critical for installed apps: check whenever user comes back
    if (typeof document !== 'undefined' && typeof window !== 'undefined') {
      merge(
        fromEvent(document, 'visibilitychange'),
        fromEvent(window, 'focus'),
        fromEvent(window, 'pageshow')
      ).subscribe(() => {
        if (document.visibilityState === 'hidden') return;
        this.safeCheck();
        void this.nudgeInstalledWorker();
      });
    }
  }

  /** User tapped the update banner */
  async applyNow(): Promise<void> {
    await this.applyUpdate(false);
  }

  private safeCheck(): void {
    this.updates.checkForUpdate().catch(() => undefined);
  }

  private async applyUpdate(auto: boolean): Promise<void> {
    if (this.reloadArmed) return;
    this.applying.set(true);
    this.updateReady.set(true);
    try {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('controllerchange', () => this.reloadOnce(), {
          once: true,
        });
      }
      await this.updates.activateUpdate();
      window.setTimeout(() => this.reloadOnce(), 1200);
    } catch {
      this.applying.set(false);
      this.updateReady.set(true);
      if (!auto) {
        await this.hardResetApp();
      }
    }
  }

  /** Ask the installed worker to look for a deploy, then switch to it. */
  private async nudgeInstalledWorker(): Promise<void> {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return;
      await reg.update().catch(() => undefined);
      const waiting = reg.waiting;
      if (waiting) {
        waiting.postMessage({ action: 'ACTIVATE_UPDATE' });
        this.updateReady.set(true);
        window.setTimeout(() => this.reloadOnce(), 1500);
        return;
      }
      navigator.serviceWorker.controller?.postMessage({ action: 'CHECK_FOR_UPDATES' });
    } catch {
      /* ignore */
    }
  }

  private reloadOnce(): void {
    if (this.reloadArmed) return;
    try {
      if (sessionStorage.getItem('masar_sw_reload') === '1') return;
      sessionStorage.setItem('masar_sw_reload', '1');
    } catch {
      /* ignore */
    }
    this.reloadArmed = true;
    window.location.reload();
  }

  private async hardResetApp(): Promise<void> {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch {
      /* ignore */
    }
    window.location.reload();
  }
}
