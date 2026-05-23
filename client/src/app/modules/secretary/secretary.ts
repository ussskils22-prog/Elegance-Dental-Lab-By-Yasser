import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, HostListener, OnDestroy, OnInit, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { CaseApiService } from '../../core/services/case-api.service';
import { SharedCasesService } from '../../core/services/shared-cases.service';
import {
  buildCreateCasePayload,
  mapApiCaseToDentalCase,
  toStoredCaseImagePath,
} from '../../core/mappers/dental-case-api.mapper';

import { Subscription } from 'rxjs';
import { SocketService } from '../../core/services/socket.service';
import { CaseDraft, SecretaryService } from './secretary.service';
import { PatientLabelPipe } from './patient-label.pipe';
import { SizeFormatPipe } from './size-format.pipe';

function emptyDraft(): CaseDraft {
  const today = new Date();
  const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const day = today.getDate();
  const month = months[today.getMonth()];
  const year = today.getFullYear();

  // الوقت الحالي بصيغة HH:MM
  const hours = String(today.getHours()).padStart(2, '0');
  const minutes = String(today.getMinutes()).padStart(2, '0');
  const currentTime = `${hours}:${minutes}`;

  // دمج التاريخ والوقت
  const dateWithTime = `${day} ${month} ${year} ${currentTime}`;

  return {
    doctor: '',
    patient: '',
    patientPhone: '',
    studentPrice: 0,
    workType: '',
    workDetail: '',
    color: '',
    size: '',
    quantity: 1,
    date: dateWithTime,
    deliveryDate: '',
    deliveryTime: '',
  };
}

@Component({
  selector: 'app-secretary',
  standalone: true,
  imports: [CommonModule, FormsModule, PatientLabelPipe, SizeFormatPipe],
  templateUrl: './secretary.html',
  styleUrl: './secretary.css',
})
export class Secretary implements OnInit, OnDestroy {
  private readonly svc = inject(SecretaryService);
  private readonly sharedCases = inject(SharedCasesService);
  private readonly auth = inject(AuthService);
  private readonly caseApi = inject(CaseApiService);
  private readonly socketService = inject(SocketService);
  private readonly router = inject(Router);
  private readonly socketSubs: Subscription[] = [];
  readonly activeFilter = signal<
    'all' | 'pending' | 'in-progress' | 'under-khart' | 'ready-for-finishing' | 'finished' | 'exited'
  >('all');
  readonly casesLoading = signal(false);
  readonly saveInProgress = signal(false);

  // عرض الحالات من SharedCasesService مباشرة لتحديث فوري
  readonly cases = computed(() => {
    const allCases = this.sharedCases.cases();
    const selectedFilter = this.activeFilter();
    const filteredByStatus =
      selectedFilter === 'all'
        ? allCases.filter(c => c.status !== 'exited')
        : allCases.filter(c => c.status === selectedFilter);
    const q = this.normalizeSearchText(this.searchQuery());

    if (!q) return filteredByStatus;

    const scored = filteredByStatus
      .map(c => ({ caseItem: c, score: this.searchScore(c, q) }))
      .filter(item => item.score >= 0)
      .sort((a, b) => b.score - a.score);

    return scored.map(item => item.caseItem);
  });

  readonly stats = computed(() => {
    const allCases = this.sharedCases.cases();
    const activeCases = allCases.filter(c => c.status !== 'exited');
    const total = allCases.length;
    const pending = activeCases.filter(c => c.status === 'pending').length;
    const inProgress = activeCases.filter(c => c.status === 'in-progress').length;
    const underKhart = activeCases.filter(c => c.status === 'under-khart').length;
    const ready = activeCases.filter(c => c.status === 'ready-for-finishing').length;
    const finished = activeCases.filter(c => c.status === 'finished').length;
    const exited = allCases.filter(c => c.status === 'exited').length;

    return [
      { label: 'إجمالي الحالات', value: total, color: 'blue' as const, hint: total > 0 ? '+12%' : undefined },
      { label: 'الحالات الجديدة', value: pending, color: 'green' as const },
      { label: 'الحالات قيد الديزاين', value: inProgress, color: 'blue' as const },
      { label: 'الحالات تحت الخرط', value: underKhart, color: 'teal' as const },
      { label: 'جاهزة للتسليم', value: ready, color: 'green' as const },
      { label: 'الحالات الخارجة', value: exited, color: 'teal' as const },
    ];
  });

  readonly filterCounts = computed(() => {
    const allCases = this.sharedCases.cases();
    const activeCases = allCases.filter(c => c.status !== 'exited');
    return {
      all: activeCases.length,
      pending: activeCases.filter(c => c.status === 'pending').length,
      inProgress: activeCases.filter(c => c.status === 'in-progress').length,
      underKhart: activeCases.filter(c => c.status === 'under-khart').length,
      ready: activeCases.filter(c => c.status === 'ready-for-finishing').length,
      finished: activeCases.filter(c => c.status === 'finished').length,
      exited: allCases.filter(c => c.status === 'exited').length,
    };
  });

  readonly searchQuery = signal('');

  get searchQueryValue(): string {
    return this.searchQuery();
  }

  set searchQueryValue(value: string) {
    this.searchQuery.set(value);
  }

  readonly dialogOpen = signal(false);
  readonly dialogMode = signal<'create' | 'create-student' | 'edit'>('create');
  editingId: string | null = null;
  formDraft: CaseDraft = emptyDraft();
  /** ملف مسح .ply اختياري عند الإنشاء/التعديل */
  selectedPlyFile: File | null = null;
  /** اسم ملف PLY المحفوظ مسبقاً (وضع التعديل) */
  existingPlyFileName: string | null = null;

  readonly filterOpen = signal(false);
  readonly menuOpenId = signal<string | null>(null);
  readonly notificationsOpen = signal(false);
  readonly toast = signal<string | null>(null);

  onSearchInput(value: string): void {
    this.searchQuery.set(value);
  }

  logout(): void {
    this.auth.performLogout(this.router);
  }

  ngOnInit(): void {
    this.reloadCasesFromBackend();
    this.connectRealtimeUpdates();
  }

  ngOnDestroy(): void {
    this.socketSubs.forEach((s) => s.unsubscribe());
  }

  private connectRealtimeUpdates(): void {
    this.socketService.connect();
    const reload = () => this.reloadCasesFromBackend();
    this.socketSubs.push(
      this.socketService.onCaseCreated().subscribe((evt) => {
        if (evt) reload();
      }),
      this.socketService.onCaseAssigned().subscribe((evt) => {
        if (evt) reload();
      }),
      this.socketService.onCaseReassigned().subscribe((evt) => {
        if (evt) reload();
      }),
      this.socketService.onCaseMovedStage().subscribe((evt) => {
        if (evt) reload();
      }),
      this.socketService.onCaseCompleted().subscribe((evt) => {
        if (evt) reload();
      }),
      this.socketService.onCaseReleased().subscribe((evt) => {
        if (evt) reload();
      }),
      this.socketService.onCaseUpdated().subscribe((evt) => {
        if (evt) reload();
      }),
      this.socketService.onCaseDeleted().subscribe((evt) => {
        if (evt) reload();
      })
    );
  }

  private reloadCasesFromBackend(): void {
    this.casesLoading.set(true);
    this.caseApi.getAllCases(1, 500).subscribe({
      next: res => {
        const rows = (res?.data ?? []) as Record<string, unknown>[];
        const mapped = Array.isArray(rows) ? rows.map(r => mapApiCaseToDentalCase(r)) : [];
        this.sharedCases.setCasesFromServer(mapped);
        this.casesLoading.set(false);
      },
      error: () => {
        this.casesLoading.set(false);
        this.flash('تعذر تحميل الحالات من الخادم');
      },
    });
  }

  setFilter(
    filter: 'all' | 'pending' | 'in-progress' | 'under-khart' | 'ready-for-finishing' | 'finished' | 'exited'
  ): void {
    this.activeFilter.set(filter);
  }

  openCreate(): void {
    this.dialogMode.set('create');
    this.editingId = null;
    this.formDraft = emptyDraft();
    this.existingPlyFileName = null;
    this.clearPlySelection();
    this.dialogOpen.set(true);
    this.menuOpenId.set(null);
  }

  openCreateStudent(): void {
    this.dialogMode.set('create-student');
    this.editingId = null;
    this.formDraft = emptyDraft();
    this.existingPlyFileName = null;
    this.clearPlySelection();
    this.dialogOpen.set(true);
    this.menuOpenId.set(null);
  }

  openEdit(c: any): void {
    this.dialogMode.set('edit');
    this.editingId = c.id;
    this.existingPlyFileName = c.plyFileName || null;
    this.clearPlySelection();
    const delivery = String(c.deliveryDate || '');
    const dateMatch = delivery.match(/^(\d{4}-\d{2}-\d{2})(?:\s+(.+))?$/);
    this.formDraft = {
      doctor: c.doctor,
      patient: c.patient,
      patientPhone: c.patientPhone || '',
      studentPrice: Number(c.salaryAmount || 0),
      workType: c.workType,
      workDetail: c.workDetail,
      color: c.color,
      size: c.size,
      quantity: c.quantity,
      date: c.receivedDate || c.date,
      deliveryDate: dateMatch ? dateMatch[1] : '',
      deliveryTime: dateMatch && dateMatch[2] ? dateMatch[2].trim().slice(0, 5) : '',
    };
    this.dialogOpen.set(true);
    this.menuOpenId.set(null);
  }

  closeDialog(): void {
    this.dialogOpen.set(false);
    this.existingPlyFileName = null;
    this.clearPlySelection();
  }

  onPlyFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      this.selectedPlyFile = null;
      return;
    }
    const name = file.name.toLowerCase();
    if (!name.endsWith('.ply')) {
      this.flash('يُسمح فقط بملفات بصيغة .ply');
      input.value = '';
      this.selectedPlyFile = null;
      return;
    }
    this.selectedPlyFile = file;
  }

  clearPlySelection(): void {
    this.selectedPlyFile = null;
    const el = document.getElementById('secretaryPlyInput') as HTMLInputElement | null;
    if (el) el.value = '';
  }

  save(): void {
    const d = this.formDraft;
    const existing =
      this.dialogMode() === 'edit' && this.editingId
        ? this.sharedCases.getCaseById(this.editingId)
        : undefined;
    const isStudentCase =
      this.dialogMode() === 'create-student' || existing?.requesterType === 'student';

    if (!d.doctor.trim() || !d.workType.trim()) {
      this.flash('يرجى تعبئة اسم الطبيب ونوع العمل');
      return;
    }
    if (!d.patient?.trim()) {
      this.flash('يرجى إدخال اسم المريض');
      return;
    }
    if (isStudentCase && !d.patientPhone?.trim()) {
      this.flash('رقم هاتف المريض مطلوب في حالات الطلبة');
      return;
    }
    if (isStudentCase && (!Number.isFinite(Number(d.studentPrice)) || Number(d.studentPrice) <= 0)) {
      this.flash('يرجى إدخال سعر حالة الطالب بشكل صحيح');
      return;
    }

    const formPayload = {
      requesterType: isStudentCase ? ('student' as const) : ('doctor' as const),
      studentPrice: isStudentCase ? Number(d.studentPrice || 0) : 0,
      doctor: d.doctor.trim(),
      patient: d.patient.trim(),
      patientEmail: existing?.patientEmail?.trim() || undefined,
      patientPhone: d.patientPhone?.trim(),
      workType: d.workType.trim(),
      workDetail: (d.workDetail || '').trim(),
      color: (d.color || '').trim(),
      size: (d.size || '').trim(),
      quantity: d.quantity,
      date: d.date,
      deliveryDate: d.deliveryDate || '',
      deliveryTime: d.deliveryTime || '',
    };

    const plyPreserveMeta =
      this.dialogMode() === 'edit' && existing?.plyScanUrl
        ? (() => {
            const scanPath = toStoredCaseImagePath(existing.plyScanUrl);
            return scanPath
              ? {
                  plyScanPath: scanPath,
                  plyFileName: existing.plyFileName,
                }
              : undefined;
          })()
        : undefined;

    if (this.dialogMode() === 'create' || this.dialogMode() === 'create-student') {
      this.saveInProgress.set(true);
      const ply = this.selectedPlyFile;
      this.caseApi.createCase(buildCreateCasePayload(formPayload)).subscribe({
        next: (res) => {
          const caseId = String(
            (res as { case?: { _id?: string; id?: string } })?.case?._id ??
              (res as { case?: { id?: string } })?.case?.id ??
              ''
          );
          const done = (msg: string) => {
            this.saveInProgress.set(false);
            this.flash(msg);
            this.closeDialog();
            this.reloadCasesFromBackend();
          };
          if (ply && caseId) {
            this.caseApi.uploadCasePly(caseId, ply).subscribe({
              next: () => done('تمت إضافة الحالة ورفع ملف PLY'),
              error: (err: unknown) => {
                this.saveInProgress.set(false);
                const detail = this.formatCaseApiError(err);
                this.flash(
                  detail
                    ? `تم إنشاء الحالة، لكن فشل رفع PLY: ${detail}`
                    : 'تم إنشاء الحالة لكن تعذر رفع ملف PLY'
                );
                this.closeDialog();
                this.reloadCasesFromBackend();
              },
            });
          } else {
            done('تمت إضافة الحالة في النظام');
          }
        },
        error: (err: unknown) => {
          this.saveInProgress.set(false);
          this.flash(this.formatCaseApiError(err));
        },
      });
      return;
    }

    if (this.editingId) {
      this.saveInProgress.set(true);
      const ply = this.selectedPlyFile;
      this.caseApi
        .updateCase(this.editingId, buildCreateCasePayload(formPayload, plyPreserveMeta))
        .subscribe({
        next: () => {
          const done = () => {
            this.saveInProgress.set(false);
            this.flash('تم حفظ التعديلات');
            this.closeDialog();
            this.reloadCasesFromBackend();
          };
          if (ply) {
            this.caseApi.uploadCasePly(this.editingId!, ply).subscribe({
              next: () => done(),
              error: (err: unknown) => {
                this.saveInProgress.set(false);
                const detail = this.formatCaseApiError(err);
                this.flash(
                  detail
                    ? `تم حفظ بيانات الحالة، لكن فشل رفع PLY: ${detail}`
                    : 'تم حفظ التعديلات لكن تعذر رفع/استبدال ملف PLY'
                );
                this.closeDialog();
                this.reloadCasesFromBackend();
              },
            });
          } else {
            done();
          }
        },
        error: (err: unknown) => {
          this.saveInProgress.set(false);
          this.flash(this.formatCaseApiError(err));
        },
      });
    }
  }

  isStudentDialog(): boolean {
    if (this.dialogMode() === 'create-student') return true;
    if (this.dialogMode() === 'edit' && this.editingId) {
      return this.sharedCases.getCaseById(this.editingId)?.requesterType === 'student';
    }
    return false;
  }

  private formatCaseApiError(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      const body = err.error as Record<string, unknown> | undefined;
      const msg = body?.['message'];
      const detail = body?.['error'];
      if (typeof msg === 'string' && typeof detail === 'string' && detail.trim()) {
        return `${msg}: ${detail}`;
      }
      if (msg && typeof msg === 'string') return msg;
      const errs = body?.['errors'];
      if (Array.isArray(errs) && errs[0]?.msg) return String(errs[0].msg);
      if (err.status === 403) {
        if (typeof msg === 'string' && /attach scans|PLY/i.test(msg)) {
          return 'لا يمكن إرفاق مسح لهذه الحالة إلا من السكرتير الذي أنشأها.';
        }
        return 'لا يمكنك تعديل أو حذف حالة لم تنشئها.';
      }
    }
    return 'تعذر الحفظ — تحقق من البيانات والاتصال بالخادم';
  }

  confirmDelete(c: any): void {
    const ok = confirm(`هل تريد حذف الحالة ${c.caseNumber}؟`);
    if (!ok) return;
    this.caseApi.deleteCase(c.id).subscribe({
      next: () => {
        this.flash('تم حذف الحالة');
        this.reloadCasesFromBackend();
      },
      error: (err: unknown) => {
        this.flash(this.formatCaseApiError(err));
      },
    });
  }

  confirmExit(c: any): void {
    if (c.status !== 'finished') {
      this.flash('الخروج متاح فقط للحالات المكتملة');
      return;
    }
    const ok = confirm(`هل تريد إخراج الحالة ${c.caseNumber} نهائيًا؟`);
    if (!ok) return;

    this.caseApi.exitCase(c.id).subscribe({
      next: () => {
        this.flash('تم إخراج الحالة بنجاح');
        this.reloadCasesFromBackend();
      },
      error: (err: unknown) => {
        this.flash(this.formatCaseApiError(err));
      },
    });
  }

  toggleMenu(id: string, ev: Event): void {
    ev.stopPropagation();
    this.menuOpenId.update((open) => (open === id ? null : id));
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(ev: MouseEvent): void {
    const el = ev.target as HTMLElement;
    if (el.closest('.menu-anchor')) {
      return;
    }
    if (el.closest('.notifications-anchor')) {
      return;
    }
    if (el.closest('.filter-anchor')) {
      return;
    }
    this.menuOpenId.set(null);
    this.notificationsOpen.set(false);
    this.filterOpen.set(false);
  }

  toggleNotifications(ev: Event): void {
    ev.stopPropagation();
    this.notificationsOpen.update((v) => !v);
  }

  getCasePhase(caseId: string): { label: string; status: string; color: string } {
    return this.svc.getCasePhase(caseId);
  }

  private searchScore(
    caseItem: {
      caseNumber: string;
      doctor: string;
      patient: string;
      workType: string;
      workDetail: string;
      color: string;
      size: string;
    },
    query: string
  ): number {
    const doctor = this.normalizeSearchText(caseItem.doctor).replace(/^د\s+/, '').replace(/^dr\s+/, '');
    const patient = this.normalizeSearchText(caseItem.patient);
    const caseNumber = this.normalizeSearchText(caseItem.caseNumber);
    const workType = this.normalizeSearchText(caseItem.workType);
    const workDetail = this.normalizeSearchText(caseItem.workDetail);
    const color = this.normalizeSearchText(caseItem.color);
    const size = this.normalizeSearchText(caseItem.size);
    const queryTokens = query.split(' ').filter(Boolean);
    const patientHasAllTokens = queryTokens.every(token => patient.includes(token));
    const doctorHasAllTokens = queryTokens.every(token => doctor.includes(token));

    // Priority 1: patient/doctor starts with query
    if (patient.startsWith(query)) return 120;
    if (doctor.startsWith(query)) return 110;

    // Priority 1.5: all query words found in patient/doctor
    if (patientHasAllTokens) return 105;
    if (doctorHasAllTokens) return 95;

    // Priority 2: patient/doctor contains query
    if (patient.includes(query)) return 100;
    if (doctor.includes(query)) return 90;

    // Priority 3: case number / work fields
    if (caseNumber.includes(query)) return 80;
    if (workType.includes(query)) return 60;
    if (workDetail.includes(query)) return 50;
    if (color.includes(query)) return 40;
    if (size.includes(query)) return 30;

    return -1;
  }

  private normalizeSearchText(value: string): string {
    return (value || '')
      .toLowerCase()
      .replace(/[أإآ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/[ً-ْ]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private flash(msg: string): void {
    this.toast.set(msg);
    window.setTimeout(() => this.toast.set(null), 2800);
  }
}