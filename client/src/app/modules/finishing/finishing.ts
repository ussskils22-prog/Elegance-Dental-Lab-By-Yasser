import { CommonModule } from '@angular/common';
import { Component, HostListener, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { DentalCase, SharedCasesService } from '../../core/services/shared-cases.service';
import { CaseApiService } from '../../core/services/case-api.service';
import { mapApiCaseToDentalCase } from '../../core/mappers/dental-case-api.mapper';
import { SocketService } from '../../core/services/socket.service';
import { ThemeService } from '../../core/services/theme.service';
import { LanguageService } from '../../core/i18n/language.service';
import { TPipe } from '../../core/i18n/t.pipe';
import { CaseBarcodeComponent } from '../../shared/case-barcode/case-barcode';
import { AppOverflowMenuComponent } from '../../shared/app-overflow-menu/app-overflow-menu';
import { BrandLockupComponent } from '../../shared/brand-lockup/brand-lockup';
import { formatCaseWorkflowError } from '../../core/utils/api-error';

@Component({
  selector: 'app-finishing',
  standalone: true,
  imports: [CommonModule, FormsModule, CaseBarcodeComponent, AppOverflowMenuComponent, BrandLockupComponent, TPipe],
  templateUrl: './finishing.html',
  styleUrl: './finishing.css',
})
export class Finishing implements OnInit, OnDestroy {
  private readonly sharedCasesService = inject(SharedCasesService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly caseApi = inject(CaseApiService);
  private readonly socketService = inject(SocketService);
  public readonly themeService = inject(ThemeService);
  public readonly lang = inject(LanguageService);
  private socketSubs: Subscription[] = [];
  private reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  searchTerm = '';
  exitConfirmCase: DentalCase | null = null;
  exitingId: string | null = null;
  toast = '';
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  notificationsOpen = false;

  @HostListener('document:click')
  onDocumentClick(): void {
    this.notificationsOpen = false;
  }

  ngOnInit(): void {
    this.reloadCasesFromBackend();
    this.connectRealtimeUpdates();
  }

  ngOnDestroy(): void {
    this.socketSubs.forEach((s) => s.unsubscribe());
    if (this.reloadDebounceTimer) clearTimeout(this.reloadDebounceTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  logout(): void {
    this.auth.performLogout(this.router);
  }

  toggleNotifications(e: Event): void {
    e.stopPropagation();
    this.notificationsOpen = !this.notificationsOpen;
  }

  /* ── Cases ── */
  private get finishingQueue(): DentalCase[] {
    return this.sharedCasesService.cases().filter(
      (c) =>
        c.currentStage === 'finishing' ||
        c.status === 'ready-for-finishing'
    );
  }

  get queueCases(): DentalCase[] {
    const search = this.searchTerm.trim().toLowerCase();
    const queue = this.finishingQueue;
    if (!search) return queue;
    return queue.filter(c =>
      c.caseNumber.toLowerCase().includes(search) ||
      c.patient.toLowerCase().includes(search) ||
      c.doctor.toLowerCase().includes(search)
    );
  }

  /* ── Exit flow ── */
  requestExit(c: DentalCase): void {
    this.exitConfirmCase = c;
  }

  cancelExit(): void {
    this.exitConfirmCase = null;
  }

  confirmExit(): void {
    if (!this.exitConfirmCase) return;
    const c = this.exitConfirmCase;
    this.exitConfirmCase = null;
    this.exitingId = c.id;

    this.caseApi.completeCase(c.id).subscribe({
      next: () => {
        this.exitingId = null;
        this.showToast(this.lang.t('finishing.toast.done'));
        this.reloadCasesFromBackend();
      },
      error: (err: unknown) => {
        this.exitingId = null;
        this.showToast(formatCaseWorkflowError(err, this.lang.t('finishing.toast.fail')));
      },
    });
  }

  /* ── Toast ── */
  showToast(msg: string): void {
    this.toast = msg;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toast = ''; }, 3000);
  }

  /* ── Date formatting ── */
  formatDateValue(val: string): { date: string; time: string } {
    if (!val) return { date: '', time: '' };
    const parts = val.trim().split(' ');
    if (parts.length >= 4) {
      const datePart = parts.slice(0, 3).join(' ');
      let timePart = parts.slice(3).join(' ');
      if (timePart && !/[مص]|AM|PM/i.test(timePart)) {
        timePart = this.localTimeTo12Hour(timePart);
      }
      return { date: datePart, time: timePart };
    }
    const dateMatch = val.match(/^(\d{4}-\d{2}-\d{2})(?:\s+(.+))?$/);
    if (dateMatch) {
      const datePart = dateMatch[1];
      let timePart = dateMatch[2] ? dateMatch[2].trim() : '';
      if (timePart && !/[مص]|AM|PM/i.test(timePart)) {
        timePart = this.localTimeTo12Hour(timePart);
      }
      return { date: datePart, time: timePart };
    }
    return { date: val, time: '' };
  }

  private localTimeTo12Hour(timeStr: string): string {
    const clean = timeStr.trim().slice(0, 5);
    const parts = clean.split(':');
    if (parts.length < 2) return timeStr;
    let hour = parseInt(parts[0], 10);
    const minute = parts[1];
    if (isNaN(hour)) return timeStr;
    const ampm = hour >= 12 ? this.lang.t('time.pm') : this.lang.t('time.am');
    hour = hour % 12;
    hour = hour ? hour : 12;
    return `${hour}:${minute} ${ampm}`;
  }

  /* ── Backend ── */
  private reloadCasesFromBackend(): void {
    this.caseApi.getAllCases(1, 400, { stage: 'finishing' }).subscribe({
      next: (res) => {
        const rows = (res?.data ?? []) as Record<string, unknown>[];
        const mapped = Array.isArray(rows) ? rows.map((r) => mapApiCaseToDentalCase(r)) : [];
        this.sharedCasesService.setCasesFromServer(mapped);
      },
      error: () => {},
    });
  }

  private scheduleBackgroundReload(): void {
    if (this.reloadDebounceTimer) clearTimeout(this.reloadDebounceTimer);
    this.reloadDebounceTimer = setTimeout(() => {
      this.reloadDebounceTimer = null;
      this.reloadCasesFromBackend();
    }, 2000);
  }

  private connectRealtimeUpdates(): void {
    this.socketService.connect();
    const reload = () => this.scheduleBackgroundReload();
    this.socketSubs.push(
      this.socketService.onCaseCreated().subscribe((e) => { if (e) reload(); }),
      this.socketService.onCaseMovedStage().subscribe((e) => {
        if (!e) return;
        const patched = this.sharedCasesService.patchCaseStage(
          e.caseId,
          e.caseNumber,
          e.newStage || ''
        );
        if (!patched) reload();
      }),
      this.socketService.onCaseAssigned().subscribe((e) => { if (e) reload(); }),
      this.socketService.onCaseReassigned().subscribe((e) => { if (e) reload(); }),
      this.socketService.onCaseReleased().subscribe((e) => { if (e) reload(); }),
      this.socketService.onCaseCompleted().subscribe((e) => { if (e) reload(); }),
      this.socketService.onCaseDeleted().subscribe((e) => { if (e) reload(); })
    );
  }
}
