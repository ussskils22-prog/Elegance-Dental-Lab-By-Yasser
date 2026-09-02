import { CommonModule } from '@angular/common';
import { Component, ElementRef, OnDestroy, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { Html5Qrcode } from 'html5-qrcode';
import { AppRole } from '../../core/auth/auth.types';
import { AuthService } from '../../core/services/auth.service';
import { CaseApiService } from '../../core/services/case-api.service';
import { ThemeService } from '../../core/services/theme.service';
import { LanguageService } from '../../core/i18n/language.service';
import { TPipe } from '../../core/i18n/t.pipe';
import type { TranslationKey } from '../../core/i18n/translations';
import { mapApiCaseToDentalCase } from '../../core/mappers/dental-case-api.mapper';
import { DentalCase } from '../../core/services/shared-cases.service';
import { PatientLabelPipe } from '../secretary/patient-label.pipe';
import { AppOverflowMenuComponent } from '../../shared/app-overflow-menu/app-overflow-menu';

export type ScanStation = 'reception' | 'design' | 'finishing';

type ScanFeedback = {
  ok: boolean;
  title: string;
  detail: string;
  caseNumber?: string;
  patientName?: string;
  stage?: string;
};

const ROLE_META: Partial<
  Record<AppRole, { station: ScanStation; titleKey: TranslationKey; subtitleKey: TranslationKey }>
> = {
  secretary: {
    station: 'reception',
    titleKey: 'scan.title.reception',
    subtitleKey: 'scan.subtitle.toDone',
  },
  scanner1: {
    station: 'reception',
    titleKey: 'scan.title.scanner1',
    subtitleKey: 'scan.subtitle.toDone',
  },
  scanner2: {
    station: 'design',
    titleKey: 'scan.title.scanner2',
    subtitleKey: 'scan.subtitle.toDesign',
  },
  scanner3: {
    station: 'finishing',
    titleKey: 'scan.title.scanner3',
    subtitleKey: 'scan.subtitle.toFinishing',
  },
};

@Component({
  selector: 'app-station-scan',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, PatientLabelPipe, AppOverflowMenuComponent, TPipe],
  templateUrl: './station-scan.html',
  styleUrls: ['../secretary/secretary.css', './station-scan.css'],
})
export class StationScanComponent implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  private readonly caseApi = inject(CaseApiService);
  private readonly auth = inject(AuthService);
  readonly themeService = inject(ThemeService);
  readonly lang = inject(LanguageService);

  @ViewChild('scanInput') scanInput?: ElementRef<HTMLInputElement>;

  readonly station = signal<ScanStation>('design');
  readonly canPickStation = signal(false);
  private readonly titleKey = signal<TranslationKey>('scan.title.default');
  private readonly subtitleKey = signal<TranslationKey | ''>('');
  readonly accountName = signal('');
  readonly busy = signal(false);
  readonly feedback = signal<ScanFeedback | null>(null);
  readonly lastScans = signal<ScanFeedback[]>([]);
  readonly unauthorized = signal(false);
  readonly showReceptionHub = signal(false);
  /** Cases currently at this station — shown as cards under the scanner */
  readonly queueCases = signal<DentalCase[]>([]);
  readonly queueLoading = signal(false);
  readonly queueSearch = signal('');
  readonly cameraOpen = signal(false);
  readonly cameraError = signal('');
  readonly cameraStarting = signal(false);

  readonly title = computed(() => this.lang.t(this.titleKey()));
  readonly subtitle = computed(() => {
    const key = this.subtitleKey();
    return key ? this.lang.t(key) : '';
  });

  readonly filteredQueueCases = computed(() => {
    const q = this.normalizeSearch(this.queueSearch());
    const list = this.sortNewestFirst(this.queueCases());
    if (!q) return list;
    return list.filter((c) => {
      const doctor = this.normalizeSearch(c.doctor);
      const patient = this.normalizeSearch(c.patient);
      const caseNumber = this.normalizeSearch(c.caseNumber);
      return doctor.includes(q) || patient.includes(q) || caseNumber.includes(q);
    });
  });

  scanBuffer = '';
  private focusTimer: ReturnType<typeof setInterval> | null = null;
  private clearFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private submitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastKeyAt = 0;
  private html5Qr: Html5Qrcode | null = null;
  private lastCameraCode = '';
  private lastCameraAt = 0;

  ngOnInit(): void {
    const session = this.auth.getSession();
    const role = session?.role;
    this.accountName.set(session?.name || '');
    this.showReceptionHub.set(role === 'secretary' || role === 'admin');

    const meta = role ? ROLE_META[role] : undefined;
    if (!meta) {
      if (role === 'admin' || role === 'designer' || role === 'finisher') {
        this.unauthorized.set(false);
        this.canPickStation.set(true);
        this.titleKey.set('scan.title.demo');
        this.subtitleKey.set('scan.subtitle.demo');
        this.station.set(role === 'finisher' ? 'finishing' : 'design');
      } else {
        this.unauthorized.set(true);
      }
    } else {
      this.unauthorized.set(false);
      this.canPickStation.set(false);
      this.station.set(meta.station);
      this.titleKey.set(meta.titleKey);
      this.subtitleKey.set(meta.subtitleKey);
    }

    if (!this.unauthorized()) {
      this.reloadQueue();
    }

    this.focusTimer = setInterval(() => this.focusScanner(), 800);
    setTimeout(() => this.focusScanner(), 200);
  }

  ngOnDestroy(): void {
    if (this.focusTimer) clearInterval(this.focusTimer);
    if (this.clearFeedbackTimer) clearTimeout(this.clearFeedbackTimer);
    if (this.submitTimer) clearTimeout(this.submitTimer);
    void this.stopCamera();
  }

  setStation(next: ScanStation): void {
    if (!this.canPickStation() || this.station() === next) return;
    this.station.set(next);
    this.reloadQueue();
  }

  focusScanner(): void {
    if (this.busy() || this.unauthorized() || this.cameraOpen()) return;
    if (Date.now() - this.lastKeyAt < 200) return;
    if (this.shouldPauseScanFocus()) return;
    const el = this.scanInput?.nativeElement;
    if (!el) return;
    if (document.activeElement !== el) {
      el.focus({ preventScroll: true });
    }
  }

  private shouldPauseScanFocus(): boolean {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === this.scanInput?.nativeElement) return false;

    const tag = active.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (active.isContentEditable) return true;
    if (
      active.closest(
        '.scan-search, .scan-search-input, .app-menu-panel, .app-menu-anchor, .scan-queue-refresh, .scan-link, .scan-camera-panel, .scan-station-picker, button, a, [role="menu"], [role="search"]'
      )
    ) {
      return true;
    }
    return false;
  }

  onScanKeydown(): void {
    this.lastKeyAt = Date.now();
  }

  onScanSubmit(ev?: Event): void {
    ev?.preventDefault();
    if (this.busy() || this.unauthorized()) {
      this.focusScanner();
      return;
    }

    if (this.submitTimer) clearTimeout(this.submitTimer);
    this.submitTimer = setTimeout(() => {
      this.submitTimer = null;
      const el = this.scanInput?.nativeElement;
      const code = String(el?.value ?? this.scanBuffer ?? '')
        .replace(/[\r\n\t]+/g, '')
        .trim();
      if (el) el.value = '';
      this.scanBuffer = '';
      if (!code) {
        this.focusScanner();
        return;
      }
      this.submitCode(code);
    }, 80);
  }

  async toggleCamera(): Promise<void> {
    if (this.cameraOpen()) {
      await this.stopCamera();
      return;
    }
    await this.startCamera();
  }

  private async startCamera(): Promise<void> {
    if (this.unauthorized() || this.cameraStarting()) return;
    this.cameraError.set('');
    this.cameraStarting.set(true);
    this.cameraOpen.set(true);

    await new Promise((r) => setTimeout(r, 80));

    try {
      const readerId = 'scan-camera-reader';
      if (!document.getElementById(readerId)) {
        throw new Error(this.lang.t('scan.camera.mountFail'));
      }
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import('html5-qrcode');
      this.html5Qr = new Html5Qrcode(readerId, {
        formatsToSupport: [
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.QR_CODE,
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
        ],
        verbose: false,
      });

      await this.html5Qr.start(
        { facingMode: 'environment' },
        {
          fps: 8,
          qrbox: (viewW, viewH) => {
            const w = Math.min(Math.floor(viewW * 0.88), 340);
            const h = Math.min(Math.floor(viewH * 0.28), 140);
            return { width: Math.max(180, w), height: Math.max(80, h) };
          },
          aspectRatio: 1.777,
        },
        (decodedText) => this.onCameraDecoded(decodedText),
        () => {
          /* ignore frame errors */
        }
      );
      this.cameraStarting.set(false);
    } catch (err: unknown) {
      this.cameraStarting.set(false);
      this.cameraOpen.set(false);
      this.html5Qr = null;
      const msg =
        err && typeof err === 'object' && 'message' in err
          ? String((err as { message?: string }).message || '')
          : '';
      this.cameraError.set(msg || this.lang.t('scan.camera.fail'));
    }
  }

  private async stopCamera(): Promise<void> {
    const scanner = this.html5Qr;
    this.html5Qr = null;
    this.cameraOpen.set(false);
    this.cameraStarting.set(false);
    if (!scanner) return;
    try {
      if (scanner.isScanning) {
        await scanner.stop();
      }
      scanner.clear();
    } catch {
      /* ignore stop errors */
    }
  }

  private onCameraDecoded(raw: string): void {
    const code = String(raw || '')
      .replace(/[\r\n\t]+/g, '')
      .trim();
    if (!code || this.busy()) return;
    const now = Date.now();
    if (code === this.lastCameraCode && now - this.lastCameraAt < 2800) return;
    this.lastCameraCode = code;
    this.lastCameraAt = now;
    this.submitCode(code);
  }

  queueTitle(): string {
    const s = this.station();
    if (s === 'design') return this.lang.t('scan.queue.design');
    if (s === 'finishing') return this.lang.t('scan.queue.finishing');
    return this.lang.t('scan.queue.done');
  }

  intakeLabel(c: DentalCase): string {
    if (c.intakeType === 'scan' || c.plyScanUrl) return this.lang.t('intake.scan');
    if (c.intakeType === 'impression') return this.lang.t('intake.impression');
    return '';
  }

  cardNotes(c: DentalCase): string {
    const parts: string[] = [];
    const detail = String(c.workDetail || '').trim();
    const design = String(c.designNotes || '').trim();
    const instr = String(c.instructions || '').trim();
    if (detail) parts.push(detail);
    if (instr && !instr.includes('نوع العمل:') && instr !== detail) {
      parts.push(instr);
    }
    if (design && design !== detail) parts.push(design);
    return parts.join(' — ');
  }

  onQueueSearch(value: string): void {
    this.queueSearch.set(value);
  }

  clearQueueSearch(): void {
    this.queueSearch.set('');
  }

  private normalizeSearch(value: string | undefined | null): string {
    return String(value || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  private sortNewestFirst(list: DentalCase[]): DentalCase[] {
    return [...list].sort((a, b) => {
      const ta = this.caseSortTime(a);
      const tb = this.caseSortTime(b);
      if (tb !== ta) return tb - ta;
      return String(b.caseNumber || '').localeCompare(String(a.caseNumber || ''), 'en', {
        numeric: true,
      });
    });
  }

  private caseSortTime(c: DentalCase): number {
    const raw = c.createdAt || c.receivedDateRaw || c.receivedDate || '';
    const t = Date.parse(String(raw));
    if (!Number.isNaN(t)) return t;
    const m = String(c.caseNumber || '').match(/(\d{4})-(\d+)/);
    if (m) return Number(m[1]) * 1_000_000 + Number(m[2]);
    return 0;
  }

  private stationApiStage(): string {
    const s = this.station();
    if (s === 'reception') return 'completed';
    return s;
  }

  reloadQueue(): void {
    this.queueLoading.set(true);
    this.caseApi.getAllCases(1, 200, { stage: this.stationApiStage() }).subscribe({
      next: (res) => {
        const rows = (res?.data ?? []) as Record<string, unknown>[];
        const mapped = Array.isArray(rows) ? rows.map((r) => mapApiCaseToDentalCase(r)) : [];
        this.queueCases.set(this.sortNewestFirst(mapped));
        this.queueLoading.set(false);
      },
      error: () => {
        this.queueLoading.set(false);
      },
    });
  }

  private submitCode(code: string): void {
    this.busy.set(true);
    const role = this.auth.getSession()?.role;
    const stationLocked =
      role === 'scanner1' ||
      role === 'scanner2' ||
      role === 'scanner3' ||
      role === 'secretary';
    const station = stationLocked ? undefined : this.station();
    this.caseApi.scanAtStation(code, station).subscribe({
      next: (res) => {
        this.busy.set(false);
        const c = res?.case || {};
        const fb: ScanFeedback = {
          ok: !!res?.success,
          title: res?.message || this.lang.t('scan.ok'),
          detail: c.patientName
            ? `${c.caseNumber || code} — ${c.patientName}`
            : String(c.caseNumber || code),
          caseNumber: c.caseNumber,
          patientName: c.patientName,
          stage: c.currentStage,
        };
        this.pushFeedback(fb);
        this.playTone(true);
        try {
          if (c && (c._id || c.id || c.caseNumber)) {
            const mapped = mapApiCaseToDentalCase(c as Record<string, unknown>);
            if (mapped?.id || mapped?.caseNumber) {
              this.queueCases.update((list) => {
                const id = mapped.id || String(c._id || c.id || '');
                const without = list.filter((x) => x.id !== id && x.caseNumber !== mapped.caseNumber);
                return this.sortNewestFirst([mapped, ...without]);
              });
            }
          }
        } catch {
          /* ignore map errors — reloadQueue still runs */
        }
        this.reloadQueue();
        this.focusScanner();
      },
      error: (err) => {
        this.busy.set(false);
        const fb: ScanFeedback = {
          ok: false,
          title: err?.error?.message || this.lang.t('scan.fail'),
          detail: code,
          caseNumber: err?.error?.case?.caseNumber,
          patientName: err?.error?.case?.patientName,
          stage: err?.error?.case?.currentStage,
        };
        this.pushFeedback(fb);
        this.playTone(false);
        this.focusScanner();
      },
    });
  }

  private pushFeedback(fb: ScanFeedback): void {
    this.feedback.set(fb);
    this.lastScans.update((list) => [fb, ...list].slice(0, 8));
    if (this.clearFeedbackTimer) clearTimeout(this.clearFeedbackTimer);
    this.clearFeedbackTimer = setTimeout(() => this.feedback.set(null), 5000);
  }

  private playTone(ok: boolean): void {
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = ok ? 880 : 220;
      gain.gain.value = 0.08;
      osc.start();
      setTimeout(() => {
        osc.stop();
        ctx.close();
      }, ok ? 120 : 280);
    } catch {
      /* ignore */
    }
  }

  logout(): void {
    void this.stopCamera();
    this.auth.performLogout(this.router);
  }
}
