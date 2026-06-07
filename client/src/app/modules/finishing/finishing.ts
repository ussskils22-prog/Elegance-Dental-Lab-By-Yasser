import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { DentalCase, SharedCasesService } from '../../core/services/shared-cases.service';
import { CaseApiService } from '../../core/services/case-api.service';
import { mapApiCaseToDentalCase } from '../../core/mappers/dental-case-api.mapper';
import { SocketService } from '../../core/services/socket.service';

@Component({
  selector: 'app-finishing',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './finishing.html',
  styleUrl: './finishing.css',
})
export class Finishing implements OnInit, OnDestroy {
  private readonly sharedCasesService = inject(SharedCasesService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly caseApi = inject(CaseApiService);
  private readonly socketService = inject(SocketService);
  private socketSubs: Subscription[] = [];
  private reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  searchTerm = '';
  exitConfirmCase: DentalCase | null = null;
  exitingId: string | null = null;
  toast = '';
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

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

  /* ── Cases ── */
  private get readyForFinishingCases(): DentalCase[] {
    return this.sharedCasesService.cases().filter(c => c.status === 'ready-for-finishing');
  }

  get queueCases(): DentalCase[] {
    const search = this.searchTerm.trim().toLowerCase();
    const queue = this.readyForFinishingCases;
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
        this.showToast('تم إخراج الحالة بنجاح ✅');
        this.reloadCasesFromBackend();
      },
      error: () => {
        this.exitingId = null;
        this.showToast('فشل إخراج الحالة، حاول مرة أخرى');
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
      if (timePart && !timePart.includes('م') && !timePart.includes('ص')) {
        timePart = this.localTimeTo12Hour(timePart);
      }
      return { date: datePart, time: timePart };
    }
    const dateMatch = val.match(/^(\d{4}-\d{2}-\d{2})(?:\s+(.+))?$/);
    if (dateMatch) {
      const datePart = dateMatch[1];
      let timePart = dateMatch[2] ? dateMatch[2].trim() : '';
      if (timePart && !timePart.includes('م') && !timePart.includes('ص')) {
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
    const ampm = hour >= 12 ? 'م' : 'ص';
    hour = hour % 12;
    hour = hour ? hour : 12;
    return `${hour}:${minute} ${ampm}`;
  }

  /* ── Backend ── */
  private reloadCasesFromBackend(): void {
    this.caseApi.getAllCases(1, 500).subscribe({
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
      this.socketService.onCaseMovedStage().subscribe((e) => { if (e) reload(); }),
      this.socketService.onCaseAssigned().subscribe((e) => { if (e) reload(); }),
      this.socketService.onCaseReassigned().subscribe((e) => { if (e) reload(); }),
      this.socketService.onCaseReleased().subscribe((e) => { if (e) reload(); }),
      this.socketService.onCaseCompleted().subscribe((e) => { if (e) reload(); }),
      this.socketService.onCaseUpdated().subscribe((e) => { if (e) reload(); }),
      this.socketService.onCaseDeleted().subscribe((e) => { if (e) reload(); })
    );
  }
}
