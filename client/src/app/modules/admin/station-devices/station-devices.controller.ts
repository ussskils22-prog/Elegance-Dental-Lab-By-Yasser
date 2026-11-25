import { signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { apiBaseUrl } from '../../../core/api/api.config';

type StationKind = 'print' | 'scanner1' | 'scanner2' | 'scanner3';

interface StationDevice {
  _id: string;
  name: string;
  kind: StationKind;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Where lab PCs download the setup program (latest GitHub release of this project). */
export const STATION_SETUP_URL =
  'https://github.com/usskilssss-ui/Elegance-Dental-Lab-By-Yasser/releases/latest/download/OCCLA-Station-Setup.exe';

/**
 * Admin → أجهزة المعمل: connect a new print / scan PC with a one-time 6-digit code,
 * see which PCs are connected, and disconnect one. Used by the admin page (its styles apply).
 */
export class StationDevicesController {
  constructor(private http: HttpClient) {}

  private get base(): string {
    return `${apiBaseUrl()}/stations`;
  }

  readonly setupUrl = STATION_SETUP_URL;
  readonly kinds: { value: StationKind; label: string; hint: string }[] = [
    { value: 'print', label: 'جهاز الطباعة', hint: 'الجهاز المتوصل بالطابعة' },
    { value: 'scanner1', label: 'سكان 1', hint: 'منتهية' },
    { value: 'scanner2', label: 'سكان 2', hint: 'ديزاين' },
    { value: 'scanner3', label: 'سكان 3', hint: 'فينيش' },
  ];

  devices = signal<StationDevice[]>([]);
  loading = signal(false);
  error = signal('');
  code = signal<{ code: string; kind: StationKind; expiresAt: string } | null>(null);
  secondsLeft = signal(0);
  creating = signal(false);
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Call when the admin leaves the page. */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }

  kindLabel(kind: string): string {
    return this.kinds.find((k) => k.value === kind)?.label || kind;
  }

  /** "متصل" if the PC talked to the server in the last 10 minutes. */
  isOnline(d: StationDevice): boolean {
    return !!d.lastSeenAt && Date.now() - new Date(d.lastSeenAt).getTime() < 10 * 60 * 1000;
  }

  lastSeenText(d: StationDevice): string {
    if (!d.lastSeenAt) return '—';
    const mins = Math.round((Date.now() - new Date(d.lastSeenAt).getTime()) / 60000);
    if (mins < 1) return 'دلوقتي';
    if (mins < 60) return `من ${mins} دقيقة`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `من ${hours} ساعة`;
    return `من ${Math.round(hours / 24)} يوم`;
  }

  load(): void {
    this.loading.set(true);
    this.http.get<{ data: StationDevice[] }>(this.base).subscribe({
      next: (res) => {
        this.devices.set(res?.data || []);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(err?.error?.message || 'تعذر تحميل الأجهزة');
      },
    });
  }

  createCode(kind: StationKind): void {
    if (this.creating()) return;
    this.creating.set(true);
    this.error.set('');
    this.http.post<{ data: { code: string; kind: StationKind; expiresAt: string } }>(`${this.base}/pair-codes`, { kind }).subscribe({
      next: (res) => {
        this.creating.set(false);
        this.code.set(res.data);
        this.startCountdown();
      },
      error: (err) => {
        this.creating.set(false);
        this.error.set(err?.error?.message || 'تعذر إنشاء الكود');
      },
    });
  }

  private startCountdown(): void {
    if (this.timer) clearInterval(this.timer);
    const tick = () => {
      const c = this.code();
      const left = c ? Math.max(0, Math.round((new Date(c.expiresAt).getTime() - Date.now()) / 1000)) : 0;
      this.secondsLeft.set(left);
      if (!left) {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.load(); // the PC may have joined meanwhile
      }
    };
    tick();
    this.timer = setInterval(tick, 1000);
  }

  countdownText(): string {
    const s = this.secondsLeft();
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  revoke(d: StationDevice): void {
    const ok = confirm(`فصل «${d.name}» (${this.kindLabel(d.kind)})؟\nالجهاز ده هيبطّل يطبع أو يعمل سكان لحد ما يتربط تاني بكود جديد.`);
    if (!ok) return;
    this.http.post(`${this.base}/${d._id}/revoke`, {}).subscribe({
      next: () => this.load(),
      error: (err) => this.error.set(err?.error?.message || 'تعذر فصل الجهاز'),
    });
  }
}
