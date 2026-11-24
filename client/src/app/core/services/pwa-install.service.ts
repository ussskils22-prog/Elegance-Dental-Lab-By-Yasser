import { Injectable, signal } from '@angular/core';

const REMEMBER_EMAIL_KEY = 'dental_remember_email';
const INSTALL_HINT_DISMISSED_KEY = 'dental_pwa_install_hint_dismissed';

/** Chromium custom event for install prompt */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

@Injectable({ providedIn: 'root' })
export class PwaInstallService {
  readonly canInstall = signal(false);
  readonly isStandalone = signal(false);
  readonly isInAppBrowser = signal(false);
  readonly showInstallHint = signal(false);
  readonly copied = signal(false);
  readonly installing = signal(false);
  readonly preparingInstall = signal(false);
  /** iOS cannot install via JS — show the Safari guide modal instead */
  readonly showIosGuide = signal(false);

  private deferredPrompt: BeforeInstallPromptEvent | null = null;

  constructor() {
    if (typeof window === 'undefined') return;

    this.isStandalone.set(this.detectStandalone());
    this.isInAppBrowser.set(this.detectInAppBrowser());

    const dismissed = localStorage.getItem(INSTALL_HINT_DISMISSED_KEY) === '1';
    const wantHint = !this.isStandalone() && !dismissed && this.isMobile();
    this.showInstallHint.set(wantHint);

    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('install') === '1' && wantHint) {
        this.showInstallHint.set(true);
        if (this.isIos()) this.showIosGuide.set(true);
      }
    } catch {
      /* ignore */
    }

    if (wantHint && this.isAndroid() && !this.isInAppBrowser()) {
      this.preparingInstall.set(true);
    }

    const takePrompt = (e: Event) => {
      e.preventDefault();
      this.deferredPrompt = e as BeforeInstallPromptEvent;
      this.canInstall.set(true);
      this.preparingInstall.set(false);
      if (!dismissed) this.showInstallHint.set(true);
    };
    // The event may have fired before this service existed (captured in index.html).
    const early = (window as unknown as { __deferredInstallPrompt?: Event }).__deferredInstallPrompt;
    if (early) takePrompt(early);
    window.addEventListener('beforeinstallprompt', takePrompt);

    window.addEventListener('appinstalled', () => {
      this.deferredPrompt = null;
      this.canInstall.set(false);
      this.preparingInstall.set(false);
      this.showInstallHint.set(false);
      this.showIosGuide.set(false);
      this.isStandalone.set(true);
      this.installing.set(false);
      this.clearInstallQuery();
    });

    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.ready
        .then(() => {
          window.setTimeout(() => {
            if (!this.deferredPrompt) this.preparingInstall.set(false);
          }, 12000);
        })
        .catch(() => this.preparingInstall.set(false));
    }
  }

  getRememberedEmail(): string {
    try {
      return localStorage.getItem(REMEMBER_EMAIL_KEY) || '';
    } catch {
      return '';
    }
  }

  setRememberedEmail(email: string | null): void {
    try {
      if (email?.trim()) localStorage.setItem(REMEMBER_EMAIL_KEY, email.trim());
      else localStorage.removeItem(REMEMBER_EMAIL_KEY);
    } catch {
      /* ignore */
    }
  }

  dismissInstallHint(): void {
    try {
      localStorage.setItem(INSTALL_HINT_DISMISSED_KEY, '1');
    } catch {
      /* ignore */
    }
    this.showInstallHint.set(false);
    this.showIosGuide.set(false);
  }

  closeIosGuide(): void {
    this.showIosGuide.set(false);
  }

  isIos(): boolean {
    if (typeof navigator === 'undefined') return false;
    return (
      /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  }

  isAndroid(): boolean {
    if (typeof navigator === 'undefined') return false;
    return /android/i.test(navigator.userAgent);
  }

  isMobile(): boolean {
    if (typeof navigator === 'undefined') return false;
    return this.isIos() || this.isAndroid() || /Mobile|webOS/i.test(navigator.userAgent);
  }

  appUrl(): string {
    return typeof location !== 'undefined' ? `${location.origin}/login` : '';
  }

  installDeepLink(): string {
    const url = new URL(this.appUrl());
    url.searchParams.set('install', '1');
    return url.toString();
  }

  async copyAppLink(): Promise<void> {
    const url = this.appUrl();
    try {
      await navigator.clipboard.writeText(url);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2500);
    } catch {
      /* ignore */
    }
  }

  openInSystemBrowser(): void {
    const target = this.installDeepLink();
    if (this.isAndroid()) {
      const hostPath = target.replace(/^https?:\/\//, '');
      window.location.href =
        `intent://${hostPath}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(target)};end`;
      return;
    }
    // iOS in-app: open Safari if possible
    window.location.href = target;
  }

  /**
   * Android: native install sheet (one tap + system confirm).
   * iOS: Apple blocks auto-install — open the Safari guide (never use navigator.share;
   * that sheet does NOT include Add to Home Screen).
   */
  async installApp(): Promise<boolean> {
    this.installing.set(false);

    if (this.isStandalone()) {
      this.showInstallHint.set(false);
      return true;
    }

    if (this.isInAppBrowser()) {
      if (this.isIos()) {
        this.showIosGuide.set(true);
        return false;
      }
      this.openInSystemBrowser();
      return false;
    }

    // iPhone / iPad — no JS install API exists
    if (this.isIos()) {
      this.showIosGuide.set(true);
      return false;
    }

    const promptEvent = this.deferredPrompt;
    if (promptEvent) {
      this.installing.set(true);
      this.deferredPrompt = null;
      this.canInstall.set(false);
      try {
        await promptEvent.prompt();
        const choice = await promptEvent.userChoice;
        this.installing.set(false);
        if (choice.outcome === 'accepted') {
          this.showInstallHint.set(false);
          this.clearInstallQuery();
          return true;
        }
        return false;
      } catch {
        this.installing.set(false);
        return false;
      }
    }

    if (this.isAndroid()) {
      this.preparingInstall.set(true);
      window.location.href = this.installDeepLink();
      return false;
    }

    return false;
  }

  async promptInstall(): Promise<boolean> {
    return this.installApp();
  }

  private clearInstallQuery(): void {
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has('install')) return;
      url.searchParams.delete('install');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    } catch {
      /* ignore */
    }
  }

  private detectStandalone(): boolean {
    const nav = window.navigator as Navigator & { standalone?: boolean };
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      nav.standalone === true ||
      document.referrer.includes('android-app://')
    );
  }

  private detectInAppBrowser(): boolean {
    const ua = navigator.userAgent || '';
    return (
      /FBAN|FBAV|Instagram|Line\//i.test(ua) ||
      /WhatsApp/i.test(ua) ||
      (/Android/i.test(ua) && /wv\)/i.test(ua) && /Version\/[\d.]+/i.test(ua))
    );
  }
}
