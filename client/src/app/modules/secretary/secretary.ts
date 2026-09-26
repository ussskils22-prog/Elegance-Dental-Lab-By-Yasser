import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, HostListener, OnDestroy, OnInit, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { catchError, concatMap, forkJoin, from, map, of, Subscription, switchMap, tap, toArray } from 'rxjs';
import type { Observable } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { type ClientAccountKind } from '../../core/auth/client-account';
import { CaseApiService } from '../../core/services/case-api.service';
import { SharedCasesService, type DentalCase } from '../../core/services/shared-cases.service';
import { UserApiService } from '../../core/services/user-api.service';
import {
  buildCreateCasePayload,
  mapApiCaseToDentalCase,
  normalizeRequesterType,
  toStoredCaseImagePath,
  type RequesterType,
} from '../../core/mappers/dental-case-api.mapper';
import { buildPrintData } from '../../core/utils/print-job.util';
import { formatCaseWorkflowError } from '../../core/utils/api-error';
import { environment } from '../../../environments/environment';

import { SocketService } from '../../core/services/socket.service';
import { CaseDraft, SecretaryService } from './secretary.service';
import { PatientLabelPipe } from './patient-label.pipe';
import { ThemeService } from '../../core/services/theme.service';
import { LanguageService } from '../../core/i18n/language.service';
import { TPipe } from '../../core/i18n/t.pipe';
import { AppOverflowMenuComponent, type AppMenuItem } from '../../shared/app-overflow-menu/app-overflow-menu';
import { CaseBarcodeComponent } from '../../shared/case-barcode/case-barcode';
import { LabConfigService } from '../../core/services/lab-config.service';
import { ToothChartComponent } from '../../shared/tooth-chart/tooth-chart';
import { ToothAssignment, countByMaterial } from '../../shared/tooth-chart/tooth-chart.types';
import { ExocadApiService, ExocadCaseStatus } from '../../core/services/exocad-api.service';
import {
  applyWorkPhaseToName,
  buildAfterTryInLabel,
  formatWorkPartWithQty,
  isTryInBeforeWorkType,
  parseMaterialAndPhaseFromPart,
  parseTryInBeforeMaterial,
  supportsTryInPhase,
  type WorkPhase,
} from '../../core/utils/tryin-phase.util';
import {
  formatPartWithKind,
  inferDropdownCaseType,
  normalizeCaseTypeParts,
  parsePartKind,
  type WorkPartKind,
} from '../../core/utils/case-type-parts.util';

function emptyDraft(): CaseDraft {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');

  return {
    doctor: '',
    patient: '',
    patientPhone: '',
    studentPrice: 0,
    workType: '',
    workDetail: '',
    color: '',
    size: '',
    quantity: '1' as any,
    date: `${yyyy}-${mm}-${dd}`,
    deliveryDate: '',
    deliveryTime: '',
    caseType: 'New',
    exitedAt: '',
  };
}

@Component({
  selector: 'app-secretary',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, PatientLabelPipe, CaseBarcodeComponent, ToothChartComponent, AppOverflowMenuComponent, TPipe],
  templateUrl: './secretary.html',
  styleUrl: './secretary.css',
})
export class Secretary implements OnInit, OnDestroy {
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
    const dateMatch = val.match(/^(\d{4}[/-]\d{1,2}[/-]\d{1,2})(?:\s+(.+))?$/);
    if (dateMatch) {
      let datePart = dateMatch[1];
      try {
        const parts = datePart.split(/[/-]/);
        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) - 1;
        const d = parseInt(parts[2], 10);
        const dateObj = new Date(y, m, d);
        datePart = dateObj.toLocaleDateString('ar-EG-u-nu-latn', { day: 'numeric', month: 'numeric', year: 'numeric' });
      } catch {}
      let timePart = dateMatch[2] ? dateMatch[2].trim() : '';
      if (timePart && !timePart.includes('م') && !timePart.includes('ص')) {
        timePart = this.localTimeTo12Hour(timePart);
      }
      return { date: datePart, time: timePart };
    }
    return { date: val, time: '' };
  }

  /** Received date + request time (falls back to createdAt when meta date has no clock). */
  receivedStamp(c: { receivedDate?: string; createdAt?: string }): { date: string; time: string } {
    const base = this.formatDateValue(c.receivedDate || '');
    if (base.time) return base;
    if (!c.createdAt) return base;
    try {
      const d = new Date(c.createdAt);
      if (Number.isNaN(d.getTime())) return base;
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return { date: base.date, time: this.localTimeTo12Hour(`${hh}:${mm}`) };
    } catch {
      return base;
    }
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

  private readonly svc = inject(SecretaryService);
  private readonly sharedCases = inject(SharedCasesService);
  private readonly auth = inject(AuthService);
  private readonly caseApi = inject(CaseApiService);
  private readonly userApi = inject(UserApiService);
  private readonly http = inject(HttpClient);
  private readonly socketService = inject(SocketService);
  private readonly router = inject(Router);
  public readonly themeService = inject(ThemeService);
  public readonly lang = inject(LanguageService);
  private readonly labConfig = inject(LabConfigService);
  brandTitle = 'Elegance';
  private readonly apiBase = environment.apiUrl;

  /** Admin opening secretary workspace: register cases without auto-print. */
  isAdminUser(): boolean {
    return this.auth.getSession()?.role === 'admin';
  }

  readonly secretaryMenuItems: AppMenuItem[] = [
    {
      id: 'create-doctor',
      labelKey: 'menu.createDoctor',
      action: () => this.openCreateAccountModal('doctor'),
    },
    {
      id: 'doctor-list',
      labelKey: 'menu.doctorList',
      action: () => this.openAccountListModal('doctor'),
    },
    {
      id: 'reset-doctor-password',
      labelKey: 'menu.resetDoctorPassword',
      action: () => this.openResetAccountPasswordModal('doctor'),
    },
    {
      id: 'create-student',
      labelKey: 'menu.createStudent',
      action: () => this.openCreateAccountModal('student'),
    },
    {
      id: 'student-list',
      labelKey: 'menu.studentList',
      action: () => this.openAccountListModal('student'),
    },
    {
      id: 'reset-student-password',
      labelKey: 'menu.resetStudentPassword',
      action: () => this.openResetAccountPasswordModal('student'),
    },
    {
      id: 'create-lab',
      labelKey: 'menu.createLab',
      action: () => this.openCreateAccountModal('lab'),
    },
    {
      id: 'lab-list',
      labelKey: 'menu.labList',
      action: () => this.openAccountListModal('lab'),
    },
    {
      id: 'reset-lab-password',
      labelKey: 'menu.resetLabPassword',
      action: () => this.openResetAccountPasswordModal('lab'),
    },
    {
      id: 'change-my-password',
      labelKey: 'menu.changeMyPassword',
      action: () => this.openChangeMyPasswordModal(),
    },
  ];

  readonly createDoctorOpen = signal(false);
  readonly doctorListOpen = signal(false);
  readonly resetDoctorPasswordOpen = signal(false);
  readonly changeMyPasswordOpen = signal(false);

  accountKind: ClientAccountKind = 'doctor';
  convertingAccountId = '';
  requesterMenuCaseId: string | null = null;
  requesterMenuCase: { id: string; doctor?: string; requesterType?: string } | null = null;
  requesterMenuPos = { top: 0, left: 0 };
  convertingCaseName = '';
  private readonly requesterOverrides = new Map<string, ClientAccountKind>();
  newDoctor = { name: '', email: '', phone: '', password: '' };
  createDoctorError = '';
  createDoctorSaving = false;
  showNewDoctorPassword = false;

  /** Visible rows for the open list. Backed by three isolated caches. */
  doctorRows: { id: string; fullName: string; email: string; phone: string; role: string }[] = [];
  private readonly rowsByKind: Record<
    ClientAccountKind,
    { id: string; fullName: string; email: string; phone: string; role: string }[]
  > = {
    doctor: [],
    student: [],
    lab: [],
  };
  readonly doctorListSearchQuery = signal('');
  private readonly accountListTick = signal(0);
  readonly filteredDoctorRows = computed(() => {
    this.accountListTick();
    const kind = this.accountKind;
    const rows = this.rowsByKind[kind];
    const q = this.normalizeSearchText(this.doctorListSearchQuery());
    if (!q) return rows;
    const tokens = q.split(' ').filter(Boolean);
    return rows.filter((doc) => {
      const name = this.normalizeSearchText(doc.fullName);
      return tokens.every((token) => name.includes(token));
    });
  });
  doctorListLoading = false;
  doctorListError = '';

  resetDoctorId = '';
  resetDoctorPassword = '';
  resetDoctorError = '';
  resetDoctorSaving = false;
  showResetDoctorPassword = false;

  myPasswordCurrent = '';
  myPasswordNew = '';
  myPasswordConfirm = '';
  changeMyPasswordError = '';
  changeMyPasswordSaving = false;
  showMyPasswordFields = false;
  private readonly socketSubs: Subscription[] = [];
  readonly activeFilter = signal<
    'all' | 'urgent' | 'pending' | 'design' | 'finishing' | 'finished' | 'exited'
  >('all');
  readonly casesLoading = signal(false);
  readonly saveInProgress = signal(false);

  /** Same stage buckets as the doctor portal filters/dashboard */
  private caseBucket(
    c: { status: string; currentStage?: string }
  ): 'pending' | 'design' | 'finishing' | 'finished' | 'exited' {
    if (c.status === 'exited') return 'exited';
    const stage = String(c.currentStage || '').toLowerCase();
    if (stage === 'finishing' || c.status === 'ready-for-finishing') return 'finishing';
    if (c.status === 'finished' || stage === 'completed') return 'finished';
    if (c.status === 'in-progress' || c.status === 'under-khart' || c.status === 'needs-revision') {
      return 'design';
    }
    return 'pending';
  }

  private isUrgentCase(c: { priority?: string }): boolean {
    return c.priority === 'emergency';
  }

  // عرض الحالات من SharedCasesService مباشرة لتحديث فوري
  readonly cases = computed(() => {
    const allCases = this.sharedCases.cases();
    const selectedFilter = this.activeFilter();
    const q = this.normalizeSearchText(this.searchQuery());

    let baseCases =
      selectedFilter === 'all'
        ? allCases.filter((c) => c.status !== 'exited')
        : selectedFilter === 'urgent'
          ? allCases.filter((c) => c.status !== 'exited' && this.isUrgentCase(c))
          : allCases.filter((c) => this.caseBucket(c) === selectedFilter);

    if (selectedFilter === 'exited') {
      baseCases = [...baseCases].sort((a, b) => {
        const timeA = a.exitedAtRaw ? new Date(a.exitedAtRaw).getTime() : 0;
        const timeB = b.exitedAtRaw ? new Date(b.exitedAtRaw).getTime() : 0;
        return timeB - timeA;
      });
    } else if (!q) {
      baseCases = [...baseCases].sort((a, b) => {
        const au = this.isUrgentCase(a) ? 1 : 0;
        const bu = this.isUrgentCase(b) ? 1 : 0;
        if (bu !== au) return bu - au;
        return 0;
      });
    }

    if (!q) return baseCases;

    const scored = baseCases
      .map((c) => ({ caseItem: c, score: this.searchScore(c, q) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score);

    return scored.map((item) => item.caseItem);
  });

  /** حالات لم تخرج خلال 4 أيام من تاريخ الدخول */
  readonly overdueCases = computed(() => {
    this.lang.lang();
    const now = Date.now();
    const fourDaysMs = 4 * 24 * 60 * 60 * 1000;
    return this.sharedCases
      .cases()
      .filter((c) => c.status !== 'exited')
      .map((c) => {
        const receivedAt = this.parseCaseReceivedDate(c);
        return { id: c.id, doctor: c.doctor || this.lang.t('common.unknown'), patient: c.patient || '—', receivedAt };
      })
      .filter((item) => item.receivedAt != null && now - item.receivedAt! >= fourDaysMs)
      .sort((a, b) => (a.receivedAt || 0) - (b.receivedAt || 0));
  });

  private parseCaseReceivedDate(c: { receivedDateRaw?: string; receivedDate?: string; date?: string }): number | null {
    const raw = c.receivedDateRaw || '';
    if (raw) {
      const iso = Date.parse(raw);
      if (!Number.isNaN(iso)) return iso;
      const ymd = raw.split(' ')[0].split('T')[0];
      const parts = ymd.split(/[/-]/);
      if (parts.length >= 3) {
        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) - 1;
        const d = parseInt(parts[2], 10);
        if (!Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(d)) {
          return new Date(y, m, d).getTime();
        }
      }
    }
    const display = c.receivedDate || '';
    if (display) {
      const ymdMatch = display.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
      if (ymdMatch) {
        return new Date(
          parseInt(ymdMatch[1], 10),
          parseInt(ymdMatch[2], 10) - 1,
          parseInt(ymdMatch[3], 10)
        ).getTime();
      }
    }
    return null;
  }

  readonly stats = computed(() => {
    this.lang.lang();
    const allCases = this.sharedCases.cases();
    const pending = allCases.filter((c) => this.caseBucket(c) === 'pending').length;
    const design = allCases.filter((c) => this.caseBucket(c) === 'design').length;
    const finishing = allCases.filter((c) => this.caseBucket(c) === 'finishing').length;
    const finished = allCases.filter((c) => this.caseBucket(c) === 'finished').length;
    const exited = allCases.filter((c) => this.caseBucket(c) === 'exited').length;

    return [
      { label: this.lang.t('stats.total'), value: allCases.length, color: 'purple' as const },
      { label: this.lang.t('stats.new'), value: pending, color: 'amber' as const },
      { label: this.lang.t('stats.design'), value: design, color: 'blue' as const },
      { label: this.lang.t('stats.finishing'), value: finishing, color: 'teal' as const },
      { label: this.lang.t('stats.finished'), value: finished, color: 'emerald' as const },
      { label: this.lang.t('stats.exited'), value: exited, color: 'rose' as const },
    ];
  });

  readonly filterCounts = computed(() => {
    const allCases = this.sharedCases.cases();
    const activeCases = allCases.filter((c) => c.status !== 'exited');
    return {
      all: activeCases.length,
      urgent: activeCases.filter((c) => this.isUrgentCase(c)).length,
      pending: allCases.filter((c) => this.caseBucket(c) === 'pending').length,
      design: allCases.filter((c) => this.caseBucket(c) === 'design').length,
      finishing: allCases.filter((c) => this.caseBucket(c) === 'finishing').length,
      finished: allCases.filter((c) => this.caseBucket(c) === 'finished').length,
      exited: allCases.filter((c) => this.caseBucket(c) === 'exited').length,
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
  readonly originalEntryOpen = signal(false);
  readonly originalEntryCase = signal<DentalCase | null>(null);
  readonly dialogMode = signal<'create' | 'edit'>('create');
  createRequesterType: RequesterType = 'doctor';
  readonly formRequesterType = signal<RequesterType>('doctor');
  editingId: string | null = null;

  /** Exocad sync (secretary) — on SYNCED updates quantity + teeth chart from CAD-Data */
  private readonly exocadApi = inject(ExocadApiService);
  exocadStatus: ExocadCaseStatus | null = null;
  exocadLoading = false;
  exocadMessage = '';
  exocadSyncingId: string | null = null;
  formDraft: any = emptyDraft();

  // Autocomplete — أسماء الحسابات حسب نوع الحالة (دكتور / طالب / معمل)
  readonly accountDoctors = signal<string[]>([]);
  readonly accountStudents = signal<string[]>([]);
  readonly accountLabs = signal<string[]>([]);

  readonly uniqueDoctors = computed(() => {
    const kind = this.formRequesterType();
    const source =
      kind === 'student' ? this.accountStudents() : kind === 'lab' ? this.accountLabs() : this.accountDoctors();
    return [...source].sort((a, b) => a.localeCompare(b, 'ar'));
  });

  readonly doctorSearchQuery = signal('');
  readonly showDoctorSuggestions = signal(false);
  readonly activeSuggestionIndex = signal(-1);

  /** امبرشن أو سكان */
  intakeType: 'impression' | 'scan' | '' = '';

  normalizeArabic(text: string): string {
    if (!text) return '';
    return text
      .trim()
      .replace(/[أإآا]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي')
      .replace(/\s+/g, ' ');
  }

  private rowsFromUserResponse(
    res: unknown,
    kind?: ClientAccountKind
  ): { id: string; fullName: string; email: string; phone: string; role: string }[] {
    const raw = res as { data?: unknown } | unknown[] | null;
    const rows = Array.isArray((raw as { data?: unknown })?.data)
      ? (raw as { data: unknown[] }).data
      : Array.isArray(raw)
        ? raw
        : [];
    return rows
      .map((u: unknown) => {
        const row = u as {
          _id?: string;
          id?: string;
          fullName?: string;
          email?: string;
          phone?: string;
          role?: string;
        };
        return {
          id: String(row._id || row.id || ''),
          fullName: String(row.fullName || '').trim(),
          email: String(row.email || '').trim(),
          phone: String(row.phone || '').trim(),
          role: String(row.role || '').trim().toLowerCase(),
        };
      })
      .filter((u) => u.id && u.fullName)
      .filter((u) => !kind || u.role === kind);
  }

  private namesFromUserResponse(res: unknown, kind?: ClientAccountKind): string[] {
    const names = this.rowsFromUserResponse(res, kind).map((u) => u.fullName);
    return Array.from(new Set(names));
  }

  private loadAccountDoctors(): void {
    const empty = of({ data: [] });
    forkJoin({
      doctor: this.userApi.getUsersByRole('doctor').pipe(catchError(() => empty)),
      student: this.userApi.getUsersByRole('student').pipe(catchError(() => empty)),
      lab: this.userApi.getUsersByRole('lab').pipe(catchError(() => empty)),
    }).subscribe({
      next: (res) => {
        this.accountDoctors.set(this.namesFromUserResponse(res.doctor, 'doctor'));
        this.accountStudents.set(this.namesFromUserResponse(res.student, 'student'));
        this.accountLabs.set(this.namesFromUserResponse(res.lab, 'lab'));
      },
      error: () => {
        this.accountDoctors.set([]);
        this.accountStudents.set([]);
        this.accountLabs.set([]);
      },
    });
  }

  requesterNameLabelKey(): string {
    const kind = this.formRequesterType();
    if (kind === 'student') return 'secretary.studentName';
    if (kind === 'lab') return 'secretary.labName';
    return 'secretary.doctorName';
  }

  setIntakeType(type: 'impression' | 'scan'): void {
    if (this.intakeType === type) {
      this.intakeType = '';
      this.clearPlySelection();
      this.plyScanLink = '';
      return;
    }
    this.intakeType = type;
    if (type === 'impression') {
      this.clearPlySelection();
      this.plyScanLink = '';
    }
  }

  intakeLabel(c: { intakeType?: string; plyScanUrl?: string }): string {
    if (c.intakeType === 'scan' || c.plyScanUrl) return this.lang.t('intake.scan');
    if (c.intakeType === 'impression') return this.lang.t('intake.impression');
    return this.lang.t('intake.unknown');
  }

  intakeBadgeClass(c: { intakeType?: string; plyScanUrl?: string }): string {
    if (c.intakeType === 'scan' || c.plyScanUrl) return 'meta-pill--scan';
    if (c.intakeType === 'impression') return 'meta-pill--impression';
    return 'meta-pill--unknown';
  }

  entrySourceLabel(c: { entrySource?: string }): string {
    if (c.entrySource === 'secretary') return this.lang.t('entrySource.secretary');
    if (c.entrySource === 'print') return this.lang.t('entrySource.print');
    if (c.entrySource === 'doctor') return this.lang.t('entrySource.doctor');
    return this.lang.t('entrySource.unknown');
  }

  entrySourceBadgeClass(c: { entrySource?: string }): string {
    if (c.entrySource === 'secretary') return 'meta-pill--secretary';
    if (c.entrySource === 'print') return 'meta-pill--print';
    if (c.entrySource === 'doctor') return 'meta-pill--doctor-entry';
    return 'meta-pill--unknown';
  }

  readonly filteredDoctors = computed(() => {
    const input = this.doctorSearchQuery();
    const unique = this.uniqueDoctors();
    const normalizedInput = this.normalizeArabic(input);
    if (!normalizedInput) {
      return unique.slice(0, 10);
    }
    return unique.filter(doc => 
      this.normalizeArabic(doc).includes(normalizedInput)
    );
  });

  onDoctorInputChange(): void {
    this.doctorSearchQuery.set(this.formDraft.doctor || '');
    this.activeSuggestionIndex.set(-1);
    this.showDoctorSuggestions.set(true);
    this.onPatientInputChange();
  }

  onDoctorInputFocus(): void {
    this.doctorSearchQuery.set(this.formDraft.doctor || '');
    this.showDoctorSuggestions.set(true);
    this.activeSuggestionIndex.set(-1);
  }

  onDoctorInputBlur(): void {
    setTimeout(() => {
      this.showDoctorSuggestions.set(false);
    }, 200);
  }

  selectDoctor(doc: string): void {
    this.formDraft.doctor = doc;
    this.doctorSearchQuery.set(doc);
    this.showDoctorSuggestions.set(false);
    this.activeSuggestionIndex.set(-1);
    this.onPatientInputChange();
  }

  onDoctorInputKeydown(event: KeyboardEvent): void {
    const list = this.filteredDoctors();
    if (!this.showDoctorSuggestions() || list.length === 0) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const nextIdx = (this.activeSuggestionIndex() + 1) % list.length;
      this.activeSuggestionIndex.set(nextIdx);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const prevIdx = (this.activeSuggestionIndex() - 1 + list.length) % list.length;
      this.activeSuggestionIndex.set(prevIdx);
    } else if (event.key === 'Enter') {
      const activeIdx = this.activeSuggestionIndex();
      if (activeIdx >= 0 && activeIdx < list.length) {
        event.preventDefault();
        this.selectDoctor(list[activeIdx]);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.showDoctorSuggestions.set(false);
    }
  }
  /** ملف مسح .ply اختياري عند الإنشاء/التعديل */
  selectedPlyFile: File | null = null;
  /** External scan URL alternative to file upload */
  plyScanLink = '';
  /** اسم ملف PLY المحفوظ مسبقاً (وضع التعديل) */
  existingPlyFileName: string | null = null;

  /** Work Type chip options — loaded from lab materials catalog */
  workTypeOptions: string[] = [
    'Zircon', 'German Zircon', 'Emax', 'Pmma Cad',
    'Peek', 'Titanium', 'Try in', 'Mokup',
    'Night Guard', 'Wax', 'Ring'
  ];
  get caseTypeOptions() {
    return [
      { value: 'New', label: this.lang.t('caseType.new') },
      { value: 'Modification', label: this.lang.t('caseType.modification') },
      { value: 'Redo', label: this.lang.t('caseType.redo') },
      { value: 'Empty', label: this.lang.t('caseType.empty') },
    ];
  }

  getCaseTypeFromWorkType(wt: string): 'New' | 'Modification' | 'Redo' | 'Empty' {
    return inferDropdownCaseType(wt);
  }

  formatWorkTypeForDisplay(wt: string): string {
    if (!wt) return '';
    if (wt === 'Empty') return this.lang.t('caseType.empty');
    if (wt === 'Modification') return this.lang.t('caseType.modification');
    if (wt === 'Redo' || wt === 'Remake') return this.lang.t('caseType.redo');

    const modPrefix = `${this.lang.t('caseType.modification')} - `;
    const redoPrefix = `${this.lang.t('caseType.redo')} - `;
    let display = normalizeCaseTypeParts(wt)
      .split('+')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((part) => {
        if (part.startsWith('Modification - ')) {
          return part.replace('Modification - ', modPrefix);
        }
        if (part.startsWith('Redo - ')) {
          return part.replace('Redo - ', redoPrefix);
        }
        if (part.startsWith('Remake - ')) {
          return part.replace('Remake - ', redoPrefix);
        }
        return part;
      })
      .join(' + ');

    // Normalize try-in phase labels for display (legacy → Tryin Before / After Tryin)
    display = display.replace(/\btry\s*in\s+before\s+/gi, 'Tryin Before ');
    display = display.replace(/\btray\s*in\s+before\s+/gi, 'Tryin Before ');
    display = display.replace(/\s+after\s+try\s*in\b/gi, ' After Tryin');
    display = display.replace(/\s+after\s+tray\s*in\b/gi, ' After Tryin');
    display = display.replace(/\s+after\s+tary\s*in\b/gi, ' After Tryin');
    return display;
  }

  /** Hide auto-generated try-in link notes on cards */
  displayWorkDetail(detail: string | undefined | null): string {
    return String(detail || '')
      .replace(/\s*[—\-–]\s*بعد\s*تراي\s*إن\s+CASE-[\w-]+/gi, '')
      .replace(/\bبعد\s*تراي\s*إن\s+CASE-[\w-]+/gi, '')
      .replace(/\bمن\s*تراي\s*إن\s+CASE-[\w-]+/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  onCaseTypeChange(): void {
    if (this.formDraft.caseType === 'Empty') {
      this.selectedWorkTypes.clear();
      this.workTypeQuantities = {};
      this.workTypeKindQtys = {};
      this.nightGuardType = '';
      this.formDraft.workType = 'Empty';
      this.formDraft.quantity = 0;
    } else {
      // Dropdown is the default for newly added chips; existing splits stay as-is.
      this.updateWorkTypeString();
    }
  }

  selectedWorkTypes = new Set<string>();
  /**
   * Per-material qty split by kind — e.g. Emax New:7 + Redo:3
   * → "Emax (7) + Redo - Emax (3)"
   */
  workTypeKindQtys: Record<string, Record<WorkPartKind, number>> = {};
  toothAssignments: ToothAssignment[] = [];
  toothLinkMode: 'connected' | 'separate' = 'separate';
  activeToothMaterial = '';

  get chartMaterials(): string[] {
    return [...this.selectedWorkTypes].filter((wt) => wt !== 'Remake' && wt !== 'Empty');
  }

  onToothAssignmentsChange(list: ToothAssignment[]): void {
    this.toothAssignments = list || [];
    const counts = countByMaterial(this.toothAssignments);
    // Auto-select materials coming from Exocad so New qty chips actually update.
    for (const mat of Object.keys(counts)) {
      if (!mat || mat === 'Remake' || mat === 'Empty') continue;
      if (!this.selectedWorkTypes.has(mat)) {
        const catalog =
          this.workTypeOptions.find((o) => o.toLowerCase() === mat.toLowerCase()) || mat;
        this.selectedWorkTypes.add(catalog);
      }
    }
    for (const [mat, n] of Object.entries(counts)) {
      const catalog =
        [...this.selectedWorkTypes].find((o) => o.toLowerCase() === String(mat).toLowerCase()) ||
        mat;
      if (!this.selectedWorkTypes.has(catalog)) continue;
      this.ensureKindQtys(catalog);
      this.workTypeKindQtys[catalog].New = n;
      this.syncTotalQtyFromKinds(catalog);
    }
    for (const wt of this.selectedWorkTypes) {
      if (!(wt in counts) && this.materialTotalQty(wt) < 1) {
        // Keep previously selected materials that aren't on the chart at least at 0 New
        // (don't force 1 — Exocad may have replaced the whole chart).
        this.ensureKindQtys(wt);
      }
    }
    this.updateWorkTypeString();
  }

  onActiveToothMaterialChange(mat: string): void {
    this.activeToothMaterial = mat;
  }

  onToothLinkModeChange(mode: 'connected' | 'separate'): void {
    this.toothLinkMode = mode;
  }
  workTypeQuantities: Record<string, number> = {};
  workTypeError = '';
  nightGuardType: 'Soft' | 'Hard' | '' = '';
  /** فاينل أو بروفة — يظهر بعد اختيار مادة زي Emax/Zircon */
  workPhase: WorkPhase | '' = '';
  patientWarning = '';
  /** منع ضغط زر التحويل مرتين */
  spawningFinalId: string | null = null;

  readonly passwordDialogOpen = signal(false);
  passwordInput = '';
  passwordError = '';
  pendingAction: { type: 'edit' | 'delete'; caseItem: any } | null = null;

  openPasswordProtection(type: 'edit' | 'delete', caseItem: any): void {
    this.pendingAction = { type, caseItem };
    this.passwordInput = '';
    this.passwordError = '';
    this.passwordDialogOpen.set(true);
  }

  verifyPasswordAndExecute(): void {
    const allowedPasswords = ['1020', '1234'];
    if (allowedPasswords.includes(this.passwordInput.trim())) {
      this.passwordDialogOpen.set(false);
      const action = this.pendingAction;
      this.pendingAction = null;
      if (action) {
        if (action.type === 'edit') {
          this.proceedWithEdit(action.caseItem);
        } else if (action.type === 'delete') {
          this.proceedWithDelete(action.caseItem);
        } 
      }
    } else {
      this.passwordError = this.lang.t('secretary.err.password');
    }
  }

  closePasswordDialog(): void {
    this.passwordDialogOpen.set(false);
    this.pendingAction = null;
    this.passwordInput = '';
    this.passwordError = '';
  }

  setNightGuardType(type: 'Soft' | 'Hard'): void {
    this.nightGuardType = type;
    this.updateWorkTypeString();
  }

  onPatientInputChange(): void {
    const name = (this.formDraft.patient || '').trim();
    const doc = (this.formDraft.doctor || '').trim();

    if (!name) {
      this.patientWarning = '';
      return;
    }

    const parts = name.split(/\s+/).filter((p: string) => p);
    const isSingleWord = parts.length < 2;

    const exists = this.sharedCases.cases().some(
      (c) =>
        c.status !== 'exited' &&
        c.doctor?.trim().toLowerCase() === doc.toLowerCase() &&
        c.patient?.trim().toLowerCase() === name.toLowerCase() &&
        c.id !== this.editingId
    );

    if (isSingleWord) {
      this.patientWarning = this.lang.t('secretary.err.patientBinary');
    } else if (exists) {
      this.patientWarning = this.lang.t('secretary.warn.duplicatePatient');
    } else {
      this.patientWarning = '';
    }
  }

  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Toggle a work type chip.
   * Rules:
   *  - عادي: اختيار واحد فقط
   *  - لو Remake محدد: يقدر يختار Remake + نوع واحد تاني بس
   *  - Empty: اختيار واحد فقط بدون تركيب
   */
  toggleWorkType(type: string): void {
    this.workTypeError = '';

    if (this.selectedWorkTypes.has(type)) {
      this.selectedWorkTypes.delete(type);
      delete this.workTypeQuantities[type];
      delete this.workTypeKindQtys[type];
      if (type === 'Night Guard') {
        this.nightGuardType = '';
      }
      this.toothAssignments = this.toothAssignments.filter((t) => t.material !== type);
      if (this.activeToothMaterial === type) {
        this.activeToothMaterial = this.chartMaterials[0] || '';
      }
      if (!this.phaseMaterial) {
        this.workPhase = '';
      }
    } else {
      if (type === 'Empty') {
        this.selectedWorkTypes.clear();
        this.workTypeQuantities = {};
        this.workTypeKindQtys = {};
        this.selectedWorkTypes.add('Empty');
        this.workTypeQuantities['Empty'] = 1;
        this.nightGuardType = '';
        this.toothAssignments = [];
        this.activeToothMaterial = '';
        this.workPhase = '';
      } else {
        this.selectedWorkTypes.delete('Empty');
        delete this.workTypeQuantities['Empty'];
        delete this.workTypeKindQtys['Empty'];
        this.selectedWorkTypes.add(type);
        const draftKind = this.formDraft.caseType;
        const kind: WorkPartKind =
          draftKind === 'Redo' || draftKind === 'Modification' ? draftKind : 'New';
        this.workTypeKindQtys[type] = { New: 0, Redo: 0, Modification: 0 };
        this.workTypeKindQtys[type][kind] = 1;
        this.syncTotalQtyFromKinds(type);
        if (type === 'Night Guard') {
          this.nightGuardType = 'Soft';
        }
        if (!this.activeToothMaterial) this.activeToothMaterial = type;
        if (supportsTryInPhase(type) && !this.workPhase) {
          this.workPhase = 'final';
        }
        if (!supportsTryInPhase(type) && type === 'Try in') {
          this.workPhase = '';
        }
      }
    }
    this.syncCaseTypeDropdownFromKinds();
    this.updateWorkTypeString();
  }

  private ensureKindQtys(wt: string): void {
    if (!this.workTypeKindQtys[wt]) {
      this.workTypeKindQtys[wt] = { New: 0, Redo: 0, Modification: 0 };
    }
  }

  getKindQty(wt: string, kind: WorkPartKind): number {
    return Number(this.workTypeKindQtys[wt]?.[kind]) || 0;
  }

  setKindQty(wt: string, kind: WorkPartKind, raw: number | string): void {
    if (!this.selectedWorkTypes.has(wt) || wt === 'Empty') return;
    this.ensureKindQtys(wt);
    const n = Math.max(0, Math.floor(Number(raw) || 0));
    this.workTypeKindQtys[wt][kind] = n;
    if (this.materialTotalQty(wt) < 1) {
      // Keep at least one unit so the chip stays meaningful
      this.workTypeKindQtys[wt][kind] = 1;
    }
    this.syncTotalQtyFromKinds(wt);
    this.syncCaseTypeDropdownFromKinds();
    this.updateWorkTypeString();
  }

  materialTotalQty(wt: string): number {
    const m = this.workTypeKindQtys[wt];
    if (!m) return Number(this.workTypeQuantities[wt]) || 0;
    return (Number(m.New) || 0) + (Number(m.Redo) || 0) + (Number(m.Modification) || 0);
  }

  private syncTotalQtyFromKinds(wt: string): void {
    this.workTypeQuantities[wt] = this.materialTotalQty(wt) || 0;
  }

  private addKindQty(wt: string, kind: WorkPartKind, qty: number): void {
    this.ensureKindQtys(wt);
    this.workTypeKindQtys[wt][kind] = (Number(this.workTypeKindQtys[wt][kind]) || 0) + qty;
    this.syncTotalQtyFromKinds(wt);
  }

  private syncCaseTypeDropdownFromKinds(): void {
    if (this.formDraft.caseType === 'Empty') return;
    const mats = [...this.selectedWorkTypes].filter((wt) => wt !== 'Empty');
    if (!mats.length) return;
    let anyNew = false;
    let anyRedo = false;
    let anyMod = false;
    for (const wt of mats) {
      if (this.getKindQty(wt, 'New') > 0) anyNew = true;
      if (this.getKindQty(wt, 'Redo') > 0) anyRedo = true;
      if (this.getKindQty(wt, 'Modification') > 0) anyMod = true;
    }
    if (anyNew || (anyRedo && anyMod)) this.formDraft.caseType = 'New';
    else if (anyRedo && !anyMod) this.formDraft.caseType = 'Redo';
    else if (anyMod && !anyRedo) this.formDraft.caseType = 'Modification';
    else this.formDraft.caseType = 'New';
  }

  /** المادة الوحيدة اللي ينفع عليها فاينل/بروفة */
  get phaseMaterial(): string | null {
    const mats = [...this.selectedWorkTypes].filter((m) => supportsTryInPhase(m));
    const blockers = [...this.selectedWorkTypes].filter(
      (m) => !supportsTryInPhase(m) && m !== 'Empty'
    );
    if (mats.length === 1 && blockers.length === 0) return mats[0];
    return null;
  }

  get showWorkPhaseOptions(): boolean {
    return !!this.phaseMaterial;
  }

  get workPhasePreviewLabel(): string {
    const mat = this.phaseMaterial;
    if (!mat || !this.workPhase) return '';
    if (this.workPhase === 'prova') return applyWorkPhaseToName(mat, 'prova');
    return mat;
  }

  setWorkPhase(phase: WorkPhase): void {
    this.workPhase = phase;
    this.updateWorkTypeString();
  }

  onWorkTypeQtyChange(): void {
    this.updateWorkTypeString();
  }

  updateWorkTypeString(): void {
    if (this.formDraft.caseType === 'Empty') {
      this.formDraft.workType = 'Empty';
      this.formDraft.quantity = 0;
      return;
    }
    let total = 0;
    const parts: string[] = [];
    const kindOrder: WorkPartKind[] = ['New', 'Redo', 'Modification'];

    for (const wt of this.selectedWorkTypes) {
      this.ensureKindQtys(wt);
      let displayName = wt;
      if (wt === 'Night Guard') {
        displayName = this.nightGuardType ? `Night Guard ${this.nightGuardType}` : 'Night Guard';
      }
      if (this.workPhase && supportsTryInPhase(wt)) {
        displayName = applyWorkPhaseToName(displayName, this.workPhase);
      }

      for (const kind of kindOrder) {
        const q = this.getKindQty(wt, kind);
        if (q <= 0) continue;
        total += q;
        const bare = formatWorkPartWithQty(displayName, q, true);
        parts.push(formatPartWithKind(bare, kind));
      }
    }

    let finalString = parts.join(' + ');
    if (!finalString && (this.formDraft.caseType === 'Modification' || this.formDraft.caseType === 'Redo')) {
      finalString = this.formDraft.caseType;
    }

    this.formDraft.workType = finalString;
    this.formDraft.quantity = total || 1;
  }

  get hasWorkTypesWithQuantity(): boolean {
    for (const wt of this.selectedWorkTypes) {
      if (wt !== 'Remake' && wt !== 'Empty') return true;
    }
    return false;
  }

  isWorkTypeSelected(type: string): boolean {
    return this.selectedWorkTypes.has(type);
  }

  get isRemakeMode(): boolean {
    return this.selectedWorkTypes.has('Remake');
  }

  readonly filterOpen = signal(false);
  readonly menuOpenId = signal<string | null>(null);
  readonly notificationsOpen = signal(false);
  readonly toast = signal<string | null>(null);
  readonly highlightedCaseId = signal<string | null>(null);
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;

  onSearchInput(value: string): void {
    this.searchQuery.set(value);
  }

  logout(): void {
    this.auth.performLogout(this.router);
  }

  openCreateAccountModal(kind: ClientAccountKind): void {
    this.accountKind = kind;
    this.newDoctor = { name: '', email: '', phone: '', password: '' };
    this.createDoctorError = '';
    this.showNewDoctorPassword = false;
    this.createDoctorOpen.set(true);
  }

  openCreateDoctorModal(): void {
    this.openCreateAccountModal('doctor');
  }

  accountCreateTitleKey(): string {
    if (this.accountKind === 'student') return 'secretary.students.createTitle';
    if (this.accountKind === 'lab') return 'secretary.labs.createTitle';
    return 'secretary.doctors.createTitle';
  }

  accountCreateHintKey(): string {
    if (this.accountKind === 'student') return 'secretary.students.createHint';
    if (this.accountKind === 'lab') return 'secretary.labs.createHint';
    return 'secretary.doctors.createHint';
  }

  accountNameLabelKey(): string {
    if (this.accountKind === 'student') return 'secretary.students.nameLabel';
    if (this.accountKind === 'lab') return 'secretary.labs.nameLabel';
    return 'secretary.doctors.nameLabel';
  }

  accountCreatedKey(): string {
    if (this.accountKind === 'student') return 'secretary.students.created';
    if (this.accountKind === 'lab') return 'secretary.labs.created';
    return 'secretary.doctors.created';
  }

  accountListTitleKey(): string {
    if (this.accountKind === 'student') return 'secretary.students.listTitle';
    if (this.accountKind === 'lab') return 'secretary.labs.listTitle';
    return 'secretary.doctors.listTitle';
  }

  accountListEmptyKey(): string {
    if (this.accountKind === 'student') return 'secretary.students.listEmpty';
    if (this.accountKind === 'lab') return 'secretary.labs.listEmpty';
    return 'secretary.doctors.listEmpty';
  }

  accountSearchPlaceholderKey(): string {
    if (this.accountKind === 'student') return 'secretary.students.searchPlaceholder';
    if (this.accountKind === 'lab') return 'secretary.labs.searchPlaceholder';
    return 'secretary.doctors.searchPlaceholder';
  }

  accountSearchEmptyKey(): string {
    if (this.accountKind === 'student') return 'secretary.students.searchEmpty';
    if (this.accountKind === 'lab') return 'secretary.labs.searchEmpty';
    return 'secretary.doctors.searchEmpty';
  }

  accountResetTitleKey(): string {
    if (this.accountKind === 'student') return 'secretary.students.resetTitle';
    if (this.accountKind === 'lab') return 'secretary.labs.resetTitle';
    return 'secretary.doctors.resetTitle';
  }

  accountSelectLabelKey(): string {
    if (this.accountKind === 'student') return 'secretary.students.selectStudent';
    if (this.accountKind === 'lab') return 'secretary.labs.selectLab';
    return 'secretary.doctors.selectDoctor';
  }

  closeCreateDoctorModal(): void {
    if (this.createDoctorSaving) return;
    this.createDoctorOpen.set(false);
  }

  saveNewDoctor(): void {
    this.createDoctorError = '';
    const name = this.newDoctor.name.trim();
    const email = this.newDoctor.email.trim();
    const phone = this.newDoctor.phone.trim();
    const password = this.newDoctor.password;
    if (!name || !email || !password) {
      this.createDoctorError = this.lang.t('secretary.doctors.err.required');
      return;
    }
    if (password.length < 6) {
      this.createDoctorError = this.lang.t('secretary.doctors.err.passwordMin');
      return;
    }
    this.createDoctorSaving = true;
    this.auth
      .registerDoctor({ fullName: name, email, phone, password, role: this.accountKind })
      .subscribe({
        next: () => {
          this.createDoctorSaving = false;
          this.createDoctorOpen.set(false);
          this.flash(this.lang.t(this.accountCreatedKey()));
          this.loadAccountDoctors();
          this.loadDoctorRows();
        },
        error: (err) => {
          this.createDoctorSaving = false;
          this.createDoctorError =
            err?.error?.message || err?.error?.errors?.[0]?.msg || this.lang.t('secretary.toast.saveGeneric');
        },
      });
  }

  openAccountListModal(kind: ClientAccountKind): void {
    this.showAccountKind(kind);
    this.doctorListSearchQuery.set('');
    this.doctorListOpen.set(true);
    this.loadDoctorRows(kind);
  }

  openDoctorListModal(): void {
    this.openAccountListModal('doctor');
  }

  closeDoctorListModal(): void {
    this.doctorListOpen.set(false);
    this.doctorListSearchQuery.set('');
  }

  private namesMatch(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  private nameHasRoleAccount(name: string, kind: ClientAccountKind): boolean {
    const list =
      kind === 'student'
        ? this.accountStudents()
        : kind === 'lab'
          ? this.accountLabs()
          : this.accountDoctors();
    return list.some((row) => this.namesMatch(row, name));
  }

  private autoAccountEmail(name: string, kind: ClientAccountKind): string {
    const ascii = name
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '.')
      .replace(/[^a-z0-9.]/g, '')
      .replace(/\.+/g, '.')
      .replace(/^\.|\.$/g, '');
    const base = ascii || 'client';
    return `${base}.${kind}.${Date.now().toString(36)}@elegance.com`;
  }

  private convertAccountError(err: unknown): string {
    const raw = String((err as { error?: { message?: string } })?.error?.message || '').trim();
    if (/route not found/i.test(raw)) {
      return this.lang.t('secretary.clients.convertNeedDeploy');
    }
    return raw || this.lang.t('secretary.toast.saveGeneric');
  }

  /** Create a client account when the form name has no doctor/student/lab user yet. */
  private ensureFormAccount(name: string, kind: ClientAccountKind): Observable<boolean> {
    const trimmed = name.trim();
    if (!trimmed || this.nameHasRoleAccount(trimmed, kind)) {
      return of(false);
    }
    if (
      this.nameHasRoleAccount(trimmed, 'doctor') ||
      this.nameHasRoleAccount(trimmed, 'student') ||
      this.nameHasRoleAccount(trimmed, 'lab')
    ) {
      return of(false);
    }
    return this.auth
      .registerDoctor({
        fullName: trimmed,
        email: this.autoAccountEmail(trimmed, kind),
        phone: '0000000000',
        password: '123456',
        role: kind,
      })
      .pipe(
        tap(() => this.loadAccountDoctors()),
        switchMap(() => of(true)),
        catchError(() => of(false))
      );
  }

  convertAccountKind(doc: { id: string; fullName: string }, kind: ClientAccountKind): void {
    if (!doc.id || kind === this.accountKind || this.convertingAccountId) return;
    const kindLabel =
      kind === 'student'
        ? this.lang.t('secretary.clients.toStudent')
        : kind === 'lab'
          ? this.lang.t('secretary.clients.toLab')
          : this.lang.t('secretary.clients.toDoctor');
    const ok = confirm(
      this.lang
        .t('secretary.clients.convertConfirm')
        .replace('{name}', doc.fullName)
        .replace('{kind}', kindLabel)
    );
    if (!ok) return;
    this.convertingAccountId = doc.id;
    this.userApi.convertClientRole(doc.id, kind).subscribe({
      next: (res) => {
        this.convertingAccountId = '';
        const n = Number(res?.updatedCases ?? 0);
        this.flash(this.lang.t('secretary.clients.convertDone').replace('{n}', String(n)));
        this.loadDoctorRows();
        this.loadAccountDoctors();
      },
      error: (err) => {
        this.convertingAccountId = '';
        this.flash(this.convertAccountError(err));
      },
    });
  }

  get doctorListSearchQueryValue(): string {
    return this.doctorListSearchQuery();
  }

  set doctorListSearchQueryValue(value: string) {
    this.doctorListSearchQuery.set(value);
  }

  private showAccountKind(kind: ClientAccountKind): void {
    this.accountKind = kind;
    this.doctorRows = this.rowsByKind[kind];
    this.accountListTick.update((n) => n + 1);
  }

  private setKindRows(
    kind: ClientAccountKind,
    rows: { id: string; fullName: string; email: string; phone: string; role: string }[]
  ): void {
    this.rowsByKind[kind] = rows;
    if (this.accountKind === kind) {
      this.doctorRows = rows;
      this.accountListTick.update((n) => n + 1);
    }
  }

  private loadDoctorRows(kind: ClientAccountKind = this.accountKind): void {
    this.doctorListLoading = true;
    this.doctorListError = '';
    this.setKindRows(kind, []);
    this.userApi.getUsersByRole(kind).subscribe({
      next: (res) => {
        this.setKindRows(kind, this.rowsFromUserResponse(res, kind));
        if (this.accountKind === kind) this.doctorListLoading = false;
      },
      error: () => {
        this.setKindRows(kind, []);
        if (this.accountKind !== kind) return;
        this.doctorListLoading = false;
        this.doctorListError = this.lang.t('secretary.toast.loadFail');
      },
    });
  }

  async copyDoctorLoginLink(): Promise<void> {
    const link = this.doctorLoginUrl();
    try {
      await navigator.clipboard.writeText(link);
      this.flash(this.lang.t('secretary.doctors.linkCopied'));
    } catch {
      this.flash(link);
    }
  }

  private doctorLoginUrl(): string {
    const configured = environment.publicAppUrl?.trim().replace(/\/$/, '');
    if (configured) return `${configured}/login`;
    if (typeof location === 'undefined') return '/login';
    const host = location.hostname;
    if (host.endsWith('.vercel.app') && host !== 'dental-system-seven.vercel.app') {
      return 'https://dental-system-seven.vercel.app/login';
    }
    return `${location.origin}/login`;
  }

  openResetAccountPasswordModal(kind: ClientAccountKind): void {
    this.showAccountKind(kind);
    this.resetDoctorId = '';
    this.resetDoctorPassword = '';
    this.resetDoctorError = '';
    this.showResetDoctorPassword = false;
    this.resetDoctorPasswordOpen.set(true);
    this.loadDoctorRows(kind);
  }

  openResetDoctorPasswordModal(): void {
    this.openResetAccountPasswordModal('doctor');
  }

  closeResetDoctorPasswordModal(): void {
    if (this.resetDoctorSaving) return;
    this.resetDoctorPasswordOpen.set(false);
  }

  saveResetDoctorPassword(): void {
    this.resetDoctorError = '';
    if (!this.resetDoctorId) {
      this.resetDoctorError = this.lang.t(this.accountSelectLabelKey());
      return;
    }
    if (!this.resetDoctorPassword || this.resetDoctorPassword.length < 6) {
      this.resetDoctorError = this.lang.t('secretary.doctors.err.passwordMin');
      return;
    }
    this.resetDoctorSaving = true;
    this.userApi.resetDoctorPassword(this.resetDoctorId, this.resetDoctorPassword).subscribe({
      next: () => {
        this.resetDoctorSaving = false;
        this.resetDoctorPasswordOpen.set(false);
        this.flash(this.lang.t('secretary.doctors.resetDone'));
      },
      error: (err) => {
        this.resetDoctorSaving = false;
        this.resetDoctorError = err?.error?.message || this.lang.t('secretary.toast.saveGeneric');
      },
    });
  }

  openChangeMyPasswordModal(): void {
    this.myPasswordCurrent = '';
    this.myPasswordNew = '';
    this.myPasswordConfirm = '';
    this.changeMyPasswordError = '';
    this.showMyPasswordFields = false;
    this.changeMyPasswordOpen.set(true);
  }

  closeChangeMyPasswordModal(): void {
    if (this.changeMyPasswordSaving) return;
    this.changeMyPasswordOpen.set(false);
  }

  saveChangeMyPassword(): void {
    this.changeMyPasswordError = '';
    if (!this.myPasswordCurrent || !this.myPasswordNew) {
      this.changeMyPasswordError = this.lang.t('secretary.doctors.err.required');
      return;
    }
    if (this.myPasswordNew.length < 6) {
      this.changeMyPasswordError = this.lang.t('secretary.doctors.err.passwordMin');
      return;
    }
    if (this.myPasswordNew !== this.myPasswordConfirm) {
      this.changeMyPasswordError = this.lang.t('secretary.doctors.err.mismatch');
      return;
    }
    this.changeMyPasswordSaving = true;
    this.auth.changePassword(this.myPasswordCurrent, this.myPasswordNew).subscribe({
      next: () => {
        this.changeMyPasswordSaving = false;
        this.changeMyPasswordOpen.set(false);
        this.flash(this.lang.t('secretary.doctors.passwordChanged'));
      },
      error: (err) => {
        this.changeMyPasswordSaving = false;
        this.changeMyPasswordError = err?.error?.message || this.lang.t('secretary.err.password');
      },
    });
  }

  private reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    this.reloadCasesFromBackend();
    this.connectRealtimeUpdates();
    this.loadAccountDoctors();
    this.labConfig.workTypeLabels().subscribe((labels) => {
      if (labels?.length) this.workTypeOptions = labels;
    });
    this.labConfig.loadPublicBranding().subscribe((b) => {
      this.brandTitle = (b.labName || 'Lab').split(/\s+/)[0] || 'Lab';
    });
  }

  ngOnDestroy(): void {
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = null;
    }
    this.socketSubs.forEach((s) => s.unsubscribe());
  }

  private connectRealtimeUpdates(): void {
    this.socketService.connect();
    const scheduleReload = () => this.scheduleBackgroundReload();
    this.socketSubs.push(
      this.socketService.onCaseCreated().subscribe((evt) => {
        if (evt) scheduleReload();
      }),
      this.socketService.onCaseAssigned().subscribe((evt) => {
        if (evt) scheduleReload();
      }),
      this.socketService.onCaseReassigned().subscribe((evt) => {
        if (evt) scheduleReload();
      }),
      this.socketService.onCaseMovedStage().subscribe((evt) => {
        if (evt) scheduleReload();
      }),
      this.socketService.onCaseCompleted().subscribe((evt) => {
        if (evt) scheduleReload();
      }),
      this.socketService.onCaseReleased().subscribe((evt) => {
        if (evt) scheduleReload();
      }),
      this.socketService.onCaseUpdated().subscribe((evt) => {
        if (evt) scheduleReload();
      }),
      this.socketService.onCaseDeleted().subscribe((evt) => {
        if (evt) scheduleReload();
      })
    );
  }

  /** Avoid refetch storms when many case events arrive together */
  private scheduleBackgroundReload(): void {
    if (this.reloadDebounceTimer) clearTimeout(this.reloadDebounceTimer);
    this.reloadDebounceTimer = setTimeout(() => {
      this.reloadDebounceTimer = null;
      this.reloadCasesFromBackend(true);
    }, 2000);
  }

  private reloadCasesFromBackend(silent = false, after?: () => void): void {
    if (!silent) this.casesLoading.set(true);
    this.caseApi.getAllCases(1, 1500).subscribe({
      next: (res) => {
        const rows = (res?.data ?? []) as Record<string, unknown>[];
        const mapped = Array.isArray(rows) ? rows.map((r) => mapApiCaseToDentalCase(r)) : [];
        this.sharedCases.setCasesFromServer(mapped);
        this.applyRequesterOverrides();
        this.casesLoading.set(false);
        after?.();
      },
      error: () => {
        this.casesLoading.set(false);
        if (!silent) this.flash(this.lang.t('secretary.toast.loadFail'));
      },
    });
  }

  setFilter(
    filter: 'all' | 'urgent' | 'pending' | 'design' | 'finishing' | 'finished' | 'exited'
  ): void {
    this.activeFilter.set(filter);
  }

  goToOverdueCase(caseId: string): void {
    const target = this.sharedCases.cases().find((c) => c.id === caseId);
    if (!target) {
      this.flash(this.lang.t('secretary.toast.notFound'));
      return;
    }

    this.notificationsOpen.set(false);
    this.searchQuery.set('');

    const bucket = this.caseBucket(target);
    if (bucket === 'exited') {
      this.activeFilter.set('all');
    } else {
      this.activeFilter.set(bucket);
    }

    this.highlightedCaseId.set(caseId);
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlightTimer = setTimeout(() => this.highlightedCaseId.set(null), 4000);

    setTimeout(() => {
      const el = document.querySelector(`[data-case-id="${caseId}"]`) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      this.activeFilter.set('all');
      this.searchQuery.set(target.caseNumber || target.patient || '');
      setTimeout(() => {
        document
          .querySelector(`[data-case-id="${caseId}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 80);
    }, 50);
  }

  onCaseCardClick(c: DentalCase): void {
    if (c.status !== 'exited') return;
    this.originalEntryCase.set(c);
    this.originalEntryOpen.set(true);
  }

  closeOriginalEntry(): void {
    this.originalEntryOpen.set(false);
    this.originalEntryCase.set(null);
  }

  originalEntrySummary(c: DentalCase | null): {
    workType: string;
    quantity: number;
    color: string;
    workDetail: string;
  } {
    if (!c) return { workType: '', quantity: 0, color: '', workDetail: '' };
    const original = c.originalEntry;
    if (original?.workType) {
      return {
        workType: original.workType,
        quantity: Number(original.quantity) || 0,
        color: original.color || '',
        workDetail: original.workDetail || '',
      };
    }
    return {
      workType: c.workType || '',
      quantity: Number(c.quantity) || 0,
      color: c.color || '',
      workDetail: c.workDetail || '',
    };
  }

  originalEntryChanged(c: DentalCase | null): boolean {
    if (!c?.originalEntry?.workType) return false;
    const currentType = String(c.workType || '').trim();
    const originalType = String(c.originalEntry.workType || '').trim();
    const currentQty = Number(c.quantity) || 0;
    const originalQty = Number(c.originalEntry.quantity) || 0;
    return currentType !== originalType || currentQty !== originalQty;
  }

  openCreateDialog(type: RequesterType = 'doctor'): void {
    this.dialogMode.set('create');
    this.createRequesterType = normalizeRequesterType(type);
    this.formRequesterType.set(this.createRequesterType);
    this.editingId = null;
    this.formDraft = emptyDraft();
    this.selectedWorkTypes.clear();
    this.workTypeQuantities = {};
    this.workTypeKindQtys = {};
    this.toothAssignments = [];
    this.activeToothMaterial = '';
    this.toothLinkMode = 'separate';
    this.workTypeError = '';
    this.nightGuardType = '';
    this.workPhase = '';
    this.patientWarning = '';
    this.intakeType = '';
    this.existingPlyFileName = null;
    this.plyScanLink = '';
    this.clearPlySelection();
    this.dialogOpen.set(true);
    this.menuOpenId.set(null);
  }

  openEdit(c: any): void {
    if (c.status === 'exited' && this.auth.getSession()?.role !== 'admin') {
      this.openPasswordProtection('edit', c);
      return;
    }
    this.proceedWithEdit(c);
  }

  proceedWithEdit(c: any): void {
    this.dialogMode.set('edit');
    this.createRequesterType = normalizeRequesterType(c.requesterType);
    this.formRequesterType.set(this.createRequesterType);
    this.editingId = c.id;
    this.loadExocadStatus(c.id);
    this.existingPlyFileName = c.plyFileName || null;
    this.plyScanLink = /^https?:\/\//i.test(String(c.plyScanUrl || ''))
      ? String(c.plyScanUrl)
      : '';
    this.clearPlySelection();
    this.intakeType = c.intakeType === 'scan' || c.plyScanUrl ? 'scan' : c.intakeType === 'impression' ? 'impression' : '';
    const delivery = String(c.deliveryDate || '');
    const dateMatch = delivery.match(/^(\d{4}-\d{2}-\d{2})(?:\s+(.+))?$/);
    const currentCaseType = this.getCaseTypeFromWorkType(c.workType);
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
      date: this.parseArabicDateToYmd(c.receivedDateRaw || c.receivedDate || c.date),
      deliveryDate: dateMatch ? dateMatch[1] : '',
      deliveryTime: dateMatch && dateMatch[2] ? dateMatch[2].trim().slice(0, 5) : '',
      caseType: currentCaseType,
      exitedAt: c.status === 'exited' ? this.parseArabicDateToYmd(c.exitedAtRaw || '') : '',
    };
    // Restore selectedWorkTypes from saved string
    this.selectedWorkTypes = new Set<string>();
    this.workTypeQuantities = {};
    this.workTypeKindQtys = {};
    this.workTypeError = '';
    this.nightGuardType = '';
    this.workPhase = '';
    this.patientWarning = '';
    if (currentCaseType !== 'Empty' && c.workType) {
      const wtToParse = normalizeCaseTypeParts(c.workType);
      if (wtToParse && !/^(Redo|Modification|Remake)$/i.test(wtToParse)) {
        const parts = wtToParse.split('+').map((s: string) => s.trim()).filter((s: string) => s);
        for (const p of parts) {
          const { kind, bare } = parsePartKind(p);
          const match = bare.match(/^(.*?)(?:\s*\((\d+)\))?$/);
          if (match) {
            let wtName = match[1].trim();
            if (wtName === 'Zr') wtName = 'Zircon';
            if (wtName === 'Zr Ger' || wtName === 'Zr Gre') wtName = 'German Zircon';
            const qty = match[2] ? parseInt(match[2], 10) : 1;

            const parsed = parseMaterialAndPhaseFromPart(wtName);
            wtName = parsed.material;
            if (parsed.phase) {
              this.workPhase = parsed.phase;
            }

            if (wtName.startsWith('Night Guard') || wtName.startsWith('Night Gard')) {
              this.selectedWorkTypes.add('Night Guard');
              this.addKindQty('Night Guard', kind, qty);
              if (wtName.includes('Soft')) {
                this.nightGuardType = 'Soft';
              } else if (wtName.includes('Hard')) {
                this.nightGuardType = 'Hard';
              } else {
                this.nightGuardType = 'Soft';
              }
            } else if (this.workTypeOptions.includes(wtName) || supportsTryInPhase(wtName)) {
              const catalog =
                this.workTypeOptions.find((o) => o.toLowerCase() === wtName.toLowerCase()) || wtName;
              this.selectedWorkTypes.add(catalog);
              this.addKindQty(catalog, kind, qty);
              if (supportsTryInPhase(catalog) && !this.workPhase) {
                this.workPhase = 'final';
              }
            }
          }
        }
        if (this.selectedWorkTypes.size === 1) {
          const onlyWt = [...this.selectedWorkTypes][0];
          if (!c.workType.includes('(')) {
            const total = Number(c.quantity) || 1;
            const kind: WorkPartKind =
              this.getKindQty(onlyWt, 'Redo') > 0
                ? 'Redo'
                : this.getKindQty(onlyWt, 'Modification') > 0
                  ? 'Modification'
                  : 'New';
            this.workTypeKindQtys[onlyWt] = { New: 0, Redo: 0, Modification: 0 };
            this.workTypeKindQtys[onlyWt][kind] = total;
            this.syncTotalQtyFromKinds(onlyWt);
          }
        }
      }
      this.syncCaseTypeDropdownFromKinds();
      if (this.selectedWorkTypes.size > 0) {
        this.updateWorkTypeString();
      } else {
        this.formDraft.workType = c.workType;
      }
    } else if (currentCaseType === 'Empty') {
      this.selectedWorkTypes.add('Empty');
      this.workTypeQuantities['Empty'] = 1;
    }
    
    // Trigger warnings immediately on edit open
    this.onPatientInputChange();
    this.toothAssignments = Array.isArray(c.teeth) ? ([...c.teeth] as ToothAssignment[]) : [];
    this.activeToothMaterial = this.chartMaterials[0] || '';
    this.toothLinkMode = 'separate';

    this.dialogOpen.set(true);
    this.menuOpenId.set(null);
  }

  closeDialog(): void {
    this.dialogOpen.set(false);
    this.existingPlyFileName = null;
    this.plyScanLink = '';
    this.clearPlySelection();
    this.exocadStatus = null;
    this.exocadMessage = '';
    this.exocadLoading = false;
    this.exocadSyncingId = null;
  }

  loadExocadStatus(caseId: string): void {
    this.exocadStatus = null;
    this.exocadMessage = '';
    this.exocadLoading = true;
    this.exocadApi.getCaseStatus(caseId).subscribe({
      next: (res) => {
        this.exocadLoading = false;
        this.exocadStatus = res?.data || null;
      },
      error: () => {
        this.exocadLoading = false;
        this.exocadStatus = null;
      },
    });
  }

  syncExocadForCase(caseId: string, status?: string): void {
    if (!caseId) return;
    if (status === 'exited') {
      this.exocadMessage = 'الحالات الخارجة لا تُعدَّل';
      return;
    }
    this.exocadLoading = true;
    this.exocadSyncingId = caseId;
    this.exocadMessage = '';
    this.exocadApi.syncCase(caseId).subscribe({
      next: (res: any) => {
        this.exocadLoading = false;
        this.exocadSyncingId = null;
        if (res?.data) this.exocadStatus = res.data;

        const sheetTeethRaw = Array.isArray(res?.sheet?.teeth) ? res.sheet.teeth : [];
        const builtTeeth = this.buildToothAssignmentsFromExocadSync(res);
        const qty = Number(
          res?.sheet?.quantity ??
            builtTeeth.length ??
            res?.data?.actualDesignedUnits ??
            res?.data?.requestedUnits ??
            0
        );
        const teethCount = builtTeeth.length || qty;
        this.exocadMessage = res?.success
          ? `تمت المزامنة — الكمية ${qty || teethCount} / أسنان ${teethCount}`
          : res?.message || 'تعذر المزامنة';

        if (!res?.success) {
          this.reloadCasesFromBackend(false);
          return;
        }

        if (this.dialogOpen() && this.editingId === caseId) {
          if (builtTeeth.length) {
            this.onToothAssignmentsChange(builtTeeth);
          } else if (qty > 0) {
            this.formDraft.quantity = qty;
            for (const wt of this.selectedWorkTypes) {
              if (wt === 'Remake' || wt === 'Empty') continue;
              this.ensureKindQtys(wt);
              this.workTypeKindQtys[wt].New = qty;
              this.syncTotalQtyFromKinds(wt);
            }
            this.updateWorkTypeString();
          }
        }

        const finishReload = () => {
          this.reloadCasesFromBackend(false, () => {
            if (!(this.dialogOpen() && this.editingId === caseId)) return;
            const updated = this.sharedCases.getCaseById(caseId);
            if (!updated) return;
            // Prefer server teeth when present; otherwise keep what we just painted.
            if (Array.isArray(updated.teeth) && updated.teeth.length) {
              this.onToothAssignmentsChange([...(updated.teeth as ToothAssignment[])]);
            } else if (builtTeeth.length) {
              this.onToothAssignmentsChange(builtTeeth);
            }
            if (Number(updated.quantity) > 0) {
              this.formDraft.quantity = updated.quantity;
            }
            if (updated.workType) {
              this.formDraft.workType = updated.workType;
            }
          });
        };

        // Persist qty+teeth into notes so refresh/reopen keeps the chart.
        // Backend sync should already do this; client update is a safety net.
        if (builtTeeth.length || qty > 0) {
          this.persistExocadSheetToCase(
            caseId,
            {
              quantity: qty || builtTeeth.length || undefined,
              teeth: builtTeeth.length
                ? builtTeeth
                : sheetTeethRaw.length
                  ? sheetTeethRaw
                  : undefined,
              workType: res?.sheet?.caseType || this.formDraft.workType || undefined,
            },
            finishReload
          );
        } else {
          finishReload();
        }
      },
      error: (err) => {
        this.exocadLoading = false;
        this.exocadSyncingId = null;
        if (err?.error?.data) this.exocadStatus = err.error.data;
        const code = err?.error?.data?.syncStatus || err?.error?.data?.error || err?.error?.error || '';
        const detail =
          err?.error?.data?.lastSyncError || err?.error?.message || '';
        this.exocadMessage =
          code === 'MULTIPLE_MATCHES'
            ? 'في أكتر من مشروع Exocad لنفس المريض — حدّث الصفحة وجرب المزامنة تاني'
            : detail || 'تعذر المزامنة مع Exocad';
      },
    });
  }

  /** Normalize Exocad sync payload into ToothAssignment[] (sheet first, then designed FDIs). */
  private buildToothAssignmentsFromExocadSync(res: any): ToothAssignment[] {
    const sheetTeeth = Array.isArray(res?.sheet?.teeth) ? res.sheet.teeth : [];
    if (sheetTeeth.length) {
      return sheetTeeth
        .map((t: any) => ({
          fdi: String(t?.fdi || '').trim(),
          material: String(t?.material || '').trim() || 'Zircon',
          groupId: String(t?.groupId || '').trim() || `g_exo_${t?.fdi || ''}`,
        }))
        .filter((t: ToothAssignment) => !!t.fdi && !!t.material && !!t.groupId);
    }
    const fdis = Array.isArray(res?.data?.actualDesignedTeeth)
      ? res.data.actualDesignedTeeth.map((t: unknown) => String(t).trim()).filter(Boolean)
      : Array.isArray(res?.data?.requestedTeeth)
        ? res.data.requestedTeeth.map((t: unknown) => String(t).trim()).filter(Boolean)
        : [];
    if (!fdis.length) return [];
    const byFdi = new Map(this.toothAssignments.map((t) => [String(t.fdi), t]));
    const existing = this.sharedCases.getCaseById(this.editingId || '')?.teeth;
    const existingByFdi = new Map(
      (Array.isArray(existing) ? existing : []).map((t: ToothAssignment) => [String(t.fdi), t])
    );
    const fromWorkType = String(this.formDraft.workType || '')
      .split('+')[0]
      .trim()
      .replace(/\s*\(\d+\)\s*$/, '')
      .replace(/\s+(final|try\s*in|try-in|prova|waxup)\s*$/i, '')
      .trim();
    const materialHint =
      this.toothAssignments[0]?.material ||
      this.activeToothMaterial ||
      (Array.isArray(existing) && existing[0]?.material) ||
      fromWorkType ||
      'Zircon';
    return fdis.map((fdi: string) => {
      const prev = byFdi.get(fdi) || existingByFdi.get(fdi);
      return {
        fdi,
        material: prev?.material || materialHint,
        groupId: prev?.groupId || `g_exo_${fdi}`,
      };
    });
  }

  /** Quietly write Exocad sheet (qty + teeth) onto the case so a page refresh keeps them. */
  private persistExocadSheetToCase(
    caseId: string,
    patch: {
      quantity?: number;
      teeth?: Array<{ fdi: string; material: string; groupId: string }>;
      workType?: string;
    },
    after?: () => void
  ): void {
    const existing = this.sharedCases.getCaseById(caseId);
    if (!existing) {
      after?.();
      return;
    }
    const teeth =
      Array.isArray(patch.teeth) && patch.teeth.length
        ? patch.teeth
        : Array.isArray(existing.teeth)
          ? existing.teeth
          : [];
    if (!teeth.length && !(Number(patch.quantity) > 0)) {
      after?.();
      return;
    }
    const quantity =
      Number(patch.quantity) > 0
        ? Number(patch.quantity)
        : teeth.length || Number(existing.quantity) || 1;
    const workType = String(
      patch.workType ||
        (this.dialogOpen() && this.editingId === caseId ? this.formDraft.workType : '') ||
        existing.workType ||
        ''
    ).trim();
    const formPayload = {
      requesterType: normalizeRequesterType(existing.requesterType),
      studentPrice: Number(existing.salaryAmount || 0),
      doctor: existing.doctor || '',
      patient: existing.patient || '',
      patientEmail: existing.patientEmail?.trim() || undefined,
      patientPhone: existing.patientPhone || '',
      workType: workType || existing.workType || '',
      workDetail: existing.workDetail || '',
      color: existing.color || '',
      size: existing.size || '',
      quantity,
      date: (() => {
        const raw = existing.receivedDateRaw || '';
        if (raw) return raw;
        return existing.receivedDate || '';
      })(),
      deliveryDate: '',
      deliveryTime: '',
      intakeType: existing.intakeType,
      entrySource: 'secretary' as const,
      teeth: teeth.length ? teeth : undefined,
    };
    const plyPreserveMeta = existing.plyScanUrl
      ? (() => {
          const scanPath = toStoredCaseImagePath(existing.plyScanUrl);
          return scanPath
            ? { plyScanPath: scanPath, plyFileName: existing.plyFileName }
            : undefined;
        })()
      : undefined;

    this.caseApi.updateCase(caseId, buildCreateCasePayload(formPayload, plyPreserveMeta)).subscribe({
      next: () => after?.(),
      error: () => {
        // Backend sheet apply may still have succeeded; don't block UI refresh.
        this.exocadMessage =
          (this.exocadMessage ? this.exocadMessage + ' — ' : '') +
          'تعذر حفظ الأسنان/الكمية من الواجهة (تحقق من صلاحية التعديل)';
        after?.();
      },
    });
  }

  onPlyFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      this.selectedPlyFile = null;
      return;
    }
    const name = file.name.toLowerCase();
    if (!/\.(ply|stl|obj|rar|zip)$/i.test(name)) {
      this.flash(this.lang.t('secretary.toast.fileType'));
      input.value = '';
      this.selectedPlyFile = null;
      return;
    }
    this.selectedPlyFile = file;
    this.plyScanLink = '';
  }

  onPlyLinkChange(): void {
    if (this.plyScanLink.trim()) this.clearPlySelection();
  }

  clearPlySelection(): void {
    this.selectedPlyFile = null;
    const el = document.getElementById('secretaryPlyInput') as HTMLInputElement | null;
    if (el) el.value = '';
  }

  private isValidScanLink(raw: string): boolean {
    const url = String(raw || '').trim();
    if (!url || url.length > 2000) return false;
    try {
      const u = new URL(url);
      return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
    } catch {
      return false;
    }
  }

  private attachScanAfterSave(caseId: string, ply: File | null, link: string) {
    if (ply) return this.caseApi.uploadCasePly(caseId, ply);
    if (link) return this.caseApi.setCasePlyLink(caseId, link);
    return null;
  }

  save(): void {
    const d = this.formDraft;
    const existing =
      this.dialogMode() === 'edit' && this.editingId
        ? this.sharedCases.getCaseById(this.editingId)
        : undefined;
    const requesterType = normalizeRequesterType(
      this.dialogMode() === 'edit' ? existing?.requesterType : this.createRequesterType
    );

    if (!d.doctor.trim()) {
      this.flash(this.lang.t('secretary.toast.needDoctor'));
      return;
    }
    if (!d.patient?.trim()) {
      this.flash(this.lang.t('secretary.toast.needPatient'));
      return;
    }
    const patientParts = d.patient.trim().split(/\s+/).filter((p: string) => p);
    if (patientParts.length < 2) {
      this.patientWarning = this.lang.t('secretary.err.patientBinary');
      this.flash(this.lang.t('secretary.toast.patientBinary'));
      return;
    }
    if (!this.intakeType) {
      this.flash(this.lang.t('secretary.toast.needIntake'));
      return;
    }
    if (this.intakeType === 'scan' && this.plyScanLink.trim() && !this.isValidScanLink(this.plyScanLink)) {
      this.flash(this.lang.t('secretary.toast.badLink'));
      return;
    }
    if (d.caseType !== 'Empty' && this.selectedWorkTypes.size === 0) {
      this.workTypeError = this.lang.t('secretary.err.needWorkType');
      this.flash(this.lang.t('secretary.toast.needWorkType'));
      return;
    }
    if (this.showWorkPhaseOptions && !this.workPhase) {
      this.flash(this.lang.t('secretary.toast.needWorkPhase'));
      return;
    }
    let patientName = d.patient.trim();
    const docName = d.doctor.trim();

    const formPayload = {
      requesterType,
      studentPrice: requesterType === 'student' ? Number(d.studentPrice || 0) : 0,
      doctor: docName,
      patient: patientName,
      patientEmail: existing?.patientEmail?.trim() || undefined,
      patientPhone: d.patientPhone?.trim(),
      workType: d.workType.trim(),
      workDetail: (d.workDetail || '').trim(),
      color: (d.color || '').trim(),
      size: '',
      quantity:
        d.caseType === 'Empty'
          ? 0
          : d.quantity !== '' && d.quantity !== null && !isNaN(Number(d.quantity))
            ? Number(d.quantity)
            : 1,
      date: (() => {
        const raw = existing?.receivedDateRaw;
        if (raw) {
          // Extract YYYY-MM-DD part from stored raw value (e.g. "2026-07-08 22:26:00" → "2026-07-08")
          const rawYmd = raw.split(' ')[0].split('T')[0];
          if (rawYmd === d.date) {
            // User did NOT change the entry date — preserve exact DB value (keeps original time intact)
            return raw;
          }
          // User DID change the entry date — use the new date with current time
        }
        return this.formatDateWithCurrentOrOriginalTime(d.date, existing?.receivedDate);
      })(),
      deliveryDate: d.deliveryDate || '',
      deliveryTime: d.deliveryTime || '',
      exitedAt: d.exitedAt || undefined,
      intakeType: this.intakeType === 'scan' || this.intakeType === 'impression' ? this.intakeType : undefined,
      entrySource: 'secretary' as const,
      teeth: this.toothAssignments.length ? this.toothAssignments : undefined,
    };

    const plyPreserveMeta =
      this.intakeType === 'scan' && this.dialogMode() === 'edit' && existing?.plyScanUrl
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

    if (this.dialogMode() === 'create') {
      this.saveInProgress.set(true);
      const ply = this.intakeType === 'scan' ? this.selectedPlyFile : null;
      const plyLink = this.intakeType === 'scan' && !ply ? this.plyScanLink.trim() : '';
      const printDraft = {
        doctor: docName,
        patient: patientName,
        branch: '',
        caseType: (['New', 'Modification', 'Redo', 'Empty'].includes(String(d.caseType))
          ? d.caseType
          : 'New') as 'New' | 'Modification' | 'Redo' | 'Empty',
        workType: d.workType.trim(),
        workDetail: (d.workDetail || '').trim(),
        color: (d.color || '').trim(),
        quantity:
          d.caseType === 'Empty'
            ? 0
            : d.quantity !== '' && d.quantity !== null && !isNaN(Number(d.quantity))
              ? Number(d.quantity)
              : 1,
        date: d.date,
        teeth: this.toothAssignments.length ? this.toothAssignments : undefined,
      };

      const skipPrint = this.isAdminUser();
      let createdAccount = false;
      this.ensureFormAccount(docName, requesterType)
        .pipe(
          switchMap((created) => {
            createdAccount = created;
            return this.caseApi.createCase(buildCreateCasePayload(formPayload));
          }),
          switchMap((res: {
            case?: { caseNumber?: string; _id?: string; id?: string };
            accountEnsure?: { action?: string };
          }) => {
            if (res?.accountEnsure?.action === 'created') createdAccount = true;
            const caseNumber = String(res?.case?.caseNumber ?? '');
            const caseId = String(res?.case?._id ?? res?.case?.id ?? '');
            const attach$ = caseId ? this.attachScanAfterSave(caseId, ply, plyLink) : null;
            if (skipPrint) {
              if (attach$) {
                return attach$.pipe(catchError(() => of(null)));
              }
              return of(null);
            }
            const print$ = this.http.post(`${this.apiBase}/print/job`, {
              printData: buildPrintData(printDraft, caseNumber),
            });
            if (attach$) {
              return attach$.pipe(
                switchMap(() => print$),
                catchError(() => print$)
              );
            }
            return print$;
          })
        )
        .subscribe({
          next: () => {
            this.saveInProgress.set(false);
            const saved = skipPrint
              ? this.lang.t('secretary.toast.savedNoPrint')
              : this.lang.t('secretary.toast.savedPrint');
            this.flash(
              createdAccount ? `${saved} — ${this.lang.t('secretary.clients.autoCreated')}` : saved
            );
            this.loadAccountDoctors();
            this.closeDialog();
            this.reloadCasesFromBackend();
          },
          error: (err: unknown) => {
            this.saveInProgress.set(false);
            this.flash(
              this.formatCaseApiError(err) ||
                this.lang.t(skipPrint ? 'secretary.toast.saveGeneric' : 'secretary.toast.saveFail')
            );
          },
        });
      return;
    }

    if (this.editingId) {
      this.saveInProgress.set(true);
      const ply = this.intakeType === 'scan' ? this.selectedPlyFile : null;
      const plyLink = this.intakeType === 'scan' && !ply ? this.plyScanLink.trim() : '';
      this.ensureFormAccount(docName, requesterType)
        .pipe(
          switchMap(() =>
            this.caseApi.updateCase(this.editingId!, buildCreateCasePayload(formPayload, plyPreserveMeta))
          )
        )
        .subscribe({
        next: () => {
          const done = () => {
            this.saveInProgress.set(false);
            this.flash(this.lang.t('secretary.toast.savedEdit'));
            this.loadAccountDoctors();
            this.closeDialog();
            this.reloadCasesFromBackend();
          };
          const attach$ = this.attachScanAfterSave(this.editingId!, ply, plyLink);
          if (attach$) {
            attach$.subscribe({
              next: () => done(),
              error: (err: unknown) => {
                this.saveInProgress.set(false);
                const detail = this.formatCaseApiError(err);
                this.flash(
                  detail
                    ? this.lang.t('secretary.toast.savedButScanFailDetail').replace('{detail}', detail)
                    : this.lang.t('secretary.toast.savedButScanFail')
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

  dialogRequesterType(): RequesterType {
    if (this.dialogMode() === 'edit' && this.editingId) {
      return normalizeRequesterType(this.sharedCases.getCaseById(this.editingId)?.requesterType);
    }
    return normalizeRequesterType(this.createRequesterType);
  }

  isStudentDialog(): boolean {
    return this.dialogRequesterType() === 'student';
  }

  isLabDialog(): boolean {
    return this.dialogRequesterType() === 'lab';
  }

  closeRequesterMenu(): void {
    this.requesterMenuCaseId = null;
    this.requesterMenuCase = null;
  }

  toggleRequesterMenu(
    c: { id: string; doctor?: string; requesterType?: string },
    ev: Event
  ): void {
    ev.stopPropagation();
    if (this.requesterMenuCaseId === c.id) {
      this.closeRequesterMenu();
      return;
    }
    this.requesterMenuCaseId = c.id;
    this.requesterMenuCase = c;
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const menuWidth = 140;
    this.requesterMenuPos = {
      top: Math.round(rect.bottom + 8),
      left: Math.round(Math.min(window.innerWidth - menuWidth - 8, Math.max(8, rect.left))),
    };
  }

  private clientUsersFromResponse(
    res: unknown,
    role: ClientAccountKind
  ): { id: string; fullName: string; role: ClientAccountKind }[] {
    return this.rowsFromUserResponse(res, role).map((u) => ({
      id: u.id,
      fullName: u.fullName,
      role,
    }));
  }

  private findClientUser(name: string): Observable<{ id: string; fullName: string; role: ClientAccountKind } | null> {
    const empty = of({ data: [] });
    return forkJoin({
      doctor: this.userApi.getUsersByRole('doctor').pipe(catchError(() => empty)),
      student: this.userApi.getUsersByRole('student').pipe(catchError(() => empty)),
      lab: this.userApi.getUsersByRole('lab').pipe(catchError(() => empty)),
    }).pipe(
      map((res) => {
        const all = [
          ...this.clientUsersFromResponse(res.doctor, 'doctor'),
          ...this.clientUsersFromResponse(res.student, 'student'),
          ...this.clientUsersFromResponse(res.lab, 'lab'),
        ];
        return all.find((u) => this.namesMatch(u.fullName, name)) || null;
      })
    );
  }

  private isMissingRoute(err: unknown): boolean {
    const status = Number((err as { status?: number } | null)?.status || 0);
    const raw = String(
      (err as { error?: { message?: string }; message?: string } | null)?.error?.message ||
        (err as { message?: string } | null)?.message ||
        ''
    );
    return status === 404 || status === 405 || /route not found/i.test(raw);
  }

  private retagVisibleCases(name: string, kind: ClientAccountKind): Observable<{ updatedCases?: number }> {
    const matches = this.sharedCases
      .cases()
      .filter((row) => this.namesMatch(String(row.doctor || ''), name));
    if (!matches.length) return of({ updatedCases: 0 });
    const chunks: (typeof matches)[] = [];
    for (let i = 0; i < matches.length; i += 8) {
      chunks.push(matches.slice(i, i + 8));
    }
    return from(chunks).pipe(
      concatMap((chunk) =>
        forkJoin(
          chunk.map((row) =>
            this.caseApi
              .updateCase(row.id, { requesterType: kind, referringDoctor: name })
              .pipe(catchError(() => of(null)))
          )
        )
      ),
      toArray(),
      map((batches) => ({ updatedCases: batches.flat().filter(Boolean).length }))
    );
  }

  private convertCaseRequesterFallback(
    name: string,
    kind: ClientAccountKind
  ): Observable<{ updatedCases?: number }> {
    return this.userApi.ensureClientAccount(name, kind).pipe(
      catchError((err) => {
        if (!this.isMissingRoute(err)) throw err;
        return this.findClientUser(name).pipe(
          switchMap((user) => {
            if (user) return this.userApi.convertClientRole(user.id, kind);
            return this.auth
              .registerDoctor({
                fullName: name,
                email: this.autoAccountEmail(name, kind),
                phone: '0000000000',
                password: '123456',
                role: kind,
              })
              .pipe(
                switchMap(() => this.findClientUser(name)),
                switchMap((created) => {
                  if (created) return this.userApi.convertClientRole(created.id, kind);
                  return this.retagVisibleCases(name, kind);
                })
              );
          })
        );
      }),
      catchError((err) => {
        if (!this.isMissingRoute(err)) throw err;
        return this.retagVisibleCases(name, kind);
      })
    );
  }

  private applyRequesterOverrides(): void {
    for (const [name, kind] of this.requesterOverrides) {
      this.sharedCases.patchRequesterTypeByDoctor(name, kind);
    }
  }

  convertCaseRequester(c: { id: string; doctor?: string; requesterType?: string }, kind: ClientAccountKind): void {
    const name = String(c.doctor || '').trim();
    if (!name || this.convertingCaseName) return;
    const current = normalizeRequesterType(c.requesterType);
    if (current === kind) {
      this.closeRequesterMenu();
      return;
    }
    const kindLabel =
      kind === 'student'
        ? this.lang.t('secretary.clients.toStudent')
        : kind === 'lab'
          ? this.lang.t('secretary.clients.toLab')
          : this.lang.t('secretary.clients.toDoctor');
    const ok = confirm(
      this.lang
        .t('secretary.clients.convertConfirm')
        .replace('{name}', name)
        .replace('{kind}', kindLabel)
    );
    if (!ok) return;
    this.requesterOverrides.set(name, kind);
    const localN = this.sharedCases.patchRequesterTypeByDoctor(name, kind);
    const caseIds = this.sharedCases
      .cases()
      .filter((row) => this.namesMatch(String(row.doctor || ''), name))
      .map((row) => row.id)
      .filter(Boolean);
    this.closeRequesterMenu();
    this.convertingCaseName = name;
    this.caseApi
      .retagRequester(name, kind, caseIds)
      .pipe(
        catchError((err) => {
          if (!this.isMissingRoute(err)) throw err;
          return this.convertCaseRequesterFallback(name, kind);
        }),
        switchMap((res) => {
          const n = Number(res?.updatedCases || 0);
          if (n > 0) return of(res);
          return this.retagVisibleCases(name, kind).pipe(
            map((visible) => ({
              updatedCases: Math.max(n, Number(visible?.updatedCases || 0)),
            }))
          );
        })
      )
      .subscribe({
        next: () => {
          this.convertingCaseName = '';
          this.reloadCasesFromBackend(true, () => {
            const persisted = this.sharedCases
              .cases()
              .filter(
                (row) =>
                  this.namesMatch(String(row.doctor || ''), name) &&
                  normalizeRequesterType(row.requesterType) === kind
              ).length;
            if (persisted > 0) {
              this.applyRequesterOverrides();
              this.flash(
                this.lang.t('secretary.clients.convertDone').replace('{n}', String(persisted))
              );
            } else {
              this.requesterOverrides.delete(name);
              this.reloadCasesFromBackend(true);
              this.flash('السيرفر مرجعش التحويل. حدّث بعد دقيقة وحاول تاني.');
            }
            this.loadAccountDoctors();
          });
        },
        error: (err) => {
          this.convertingCaseName = '';
          this.flash(this.convertAccountError(err));
          this.applyRequesterOverrides();
        },
      });
  }

  requesterLabel(type: unknown): string {
    const kind = normalizeRequesterType(type);
    if (kind === 'student') return this.lang.t('common.student');
    if (kind === 'lab') return this.lang.t('common.lab');
    return this.lang.t('common.doctorCase');
  }

  dialogTitleKey(): string {
    const kind = this.dialogRequesterType();
    if (this.dialogMode() === 'edit') {
      if (kind === 'student') return 'secretary.editStudentCase';
      if (kind === 'lab') return 'secretary.editLabCase';
      return 'secretary.editCase';
    }
    if (kind === 'student') return 'secretary.addStudentCase';
    if (kind === 'lab') return 'secretary.addLabCase';
    return 'secretary.addDoctorCase';
  }

  private formatCaseApiError(err: unknown): string {
    return formatCaseWorkflowError(err, this.lang.t('secretary.toast.saveGeneric'));
  }

  confirmDelete(c: any): void {
    if (c.status === 'exited' && this.auth.getSession()?.role !== 'admin') {
      this.openPasswordProtection('delete', c);
      return;
    }
    this.proceedWithDelete(c);
  }

  proceedWithDelete(c: any): void {
    const ok = confirm(this.lang.t('secretary.confirmDelete').replace('{n}', c.caseNumber));
    if (!ok) return;
    this.caseApi.deleteCase(c.id).subscribe({
      next: () => {
        this.flash(this.lang.t('secretary.toast.deleted'));
        this.reloadCasesFromBackend();
      },
      error: (err: unknown) => {
        this.flash(this.formatCaseApiError(err));
      },
    });
  }

  confirmExit(c: any): void {
    if (c.status === 'exited' || c.currentStage === 'exited') {
      this.flash(this.lang.t('secretary.toast.alreadyExited'));
      return;
    }
    const stage = String(c.currentStage || c.status || '');
    if (stage !== 'completed' && c.status !== 'completed') {
      this.flash(this.lang.t('secretary.toast.exitOnlyFinished'));
      return;
    }
    const ok = confirm(this.lang.t('secretary.confirmExit').replace('{n}', c.caseNumber));
    if (!ok) return;

    this.caseApi.exitCase(c.id).subscribe({
      next: () => {
        this.flash(this.lang.t('secretary.toast.exited'));
        this.reloadCasesFromBackend();
      },
      error: (err: unknown) => {
        this.flash(this.formatCaseApiError(err));
      },
    });
  }

  canSpawnFinalFromTryIn(c: {
    id: string;
    caseNumber?: string;
    status?: string;
    workType?: string;
  }): boolean {
    if (c.status !== 'exited') return false;
    if (!isTryInBeforeWorkType(String(c.workType || ''))) return false;
    return !this.hasSpawnedFinalAlready(c);
  }

  hasSpawnedFinalAlready(c: { id: string; caseNumber?: string }): boolean {
    const num = String(c.caseNumber || '').trim();
    return this.sharedCases.cases().some(
      (x) =>
        (num && x.sourceTryInCaseNumber === num) ||
        (!!c.id && x.sourceTryInCaseId === c.id)
    );
  }

  spawnFinalFromTryIn(c: any): void {
    if (!this.canSpawnFinalFromTryIn(c)) {
      if (this.hasSpawnedFinalAlready(c)) {
        this.flash(this.lang.t('secretary.toast.finalAlreadySpawned'));
      }
      return;
    }
    const material = parseTryInBeforeMaterial(String(c.workType || ''));
    if (!material) {
      this.flash(this.lang.t('secretary.toast.spawnFinalFail'));
      return;
    }
    const qty = Number(c.quantity) > 0 ? Number(c.quantity) : 1;
    const finalWorkType = formatWorkPartWithQty(buildAfterTryInLabel(material), qty, qty > 1);
    // Keep original notes only — do not append "بعد تراي إن CASE-…"
    const workDetail = String(c.workDetail || '').trim();

    const ok = confirm(
      this.lang
        .t('secretary.confirmSpawnFinal')
        .replace('{n}', String(c.caseNumber || ''))
        .replace('{wt}', finalWorkType)
    );
    if (!ok) return;

    this.spawningFinalId = c.id;
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const dateYmd = `${yyyy}-${mm}-${dd}`;

    const formPayload = {
      requesterType: normalizeRequesterType(c.requesterType),
      studentPrice: Number(c.salaryAmount || 0),
      doctor: String(c.doctor || '').trim(),
      patient: String(c.patient || '').trim(),
      patientEmail: c.patientEmail?.trim() || undefined,
      patientPhone: c.patientPhone?.trim() || undefined,
      workType: finalWorkType,
      workDetail,
      color: String(c.color || '').trim(),
      size: String(c.size || '').trim(),
      quantity: qty,
      date: this.formatDateWithCurrentOrOriginalTime(dateYmd),
      deliveryDate: '',
      deliveryTime: '',
      intakeType:
        c.intakeType === 'scan' || c.intakeType === 'impression' ? c.intakeType : undefined,
      entrySource: 'secretary' as const,
      teeth: Array.isArray(c.teeth) && c.teeth.length ? c.teeth : undefined,
      sourceTryInCaseNumber: String(c.caseNumber || '').trim() || undefined,
      sourceTryInCaseId: String(c.id || '').trim() || undefined,
    };

    const printDraft = {
      doctor: formPayload.doctor,
      patient: formPayload.patient,
      branch: '',
      caseType: 'New' as const,
      workType: finalWorkType,
      workDetail,
      color: formPayload.color,
      quantity: qty,
      date: dateYmd,
      teeth: formPayload.teeth,
    };

    const skipPrint = this.isAdminUser();
    this.caseApi
      .createCase(buildCreateCasePayload(formPayload))
      .pipe(
        switchMap((res: { case?: { caseNumber?: string; _id?: string; id?: string } }) => {
          if (skipPrint) return of(null);
          const caseNumber = String(res?.case?.caseNumber ?? '');
          return this.http.post(`${this.apiBase}/print/job`, {
            printData: buildPrintData(printDraft, caseNumber),
          });
        })
      )
      .subscribe({
        next: () => {
          this.spawningFinalId = null;
          this.flash(
            skipPrint
              ? this.lang.t('secretary.toast.spawnFinalOkNoPrint')
              : this.lang.t('secretary.toast.spawnFinalOk')
          );
          this.activeFilter.set('all');
          this.reloadCasesFromBackend();
        },
        error: (err: unknown) => {
          this.spawningFinalId = null;
          this.flash(this.formatCaseApiError(err) || this.lang.t('secretary.toast.spawnFinalFail'));
        },
      });
  }

  toggleMenu(id: string, ev: Event): void {
    ev.stopPropagation();
    this.menuOpenId.update((open) => (open === id ? null : id));
  }

  @HostListener('document:keydown.escape')
  onEscapeOriginalEntry(): void {
    if (this.originalEntryOpen()) this.closeOriginalEntry();
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
    if (!el.closest('.requester-switch') && !el.closest('.requester-menu')) {
      this.closeRequesterMenu();
    }
  }

  toggleNotifications(ev: Event): void {
    ev.stopPropagation();
    this.notificationsOpen.update((v) => !v);
  }

  getCasePhase(caseId: string): { label: string; status: string; color: string } {
    const phase = this.svc.getCasePhase(caseId);
    const phaseKeyMap: Record<string, string> = {
      pending: 'phase.pending',
      design: 'phase.design',
      khart: 'phase.khart',
      revision: 'phase.revision',
      finishing: 'phase.finishing',
      finished: 'phase.finished',
      exited: 'phase.exited',
    };
    const key = phaseKeyMap[phase.color] || 'phase.pending';
    return { ...phase, label: this.lang.t(key) };
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

    // Priority 3: case number only
    if (caseNumber.includes(query)) return 80;

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

  parseArabicDateToYmd(val: string): string {
    if (!val) return new Date().toISOString().split('T')[0];
    
    const clean = val.trim();

    // 0. Check if it is an ISO string (e.g. 2026-07-21T21:00:00.000Z)
    if (clean.includes('T') && clean.endsWith('Z')) {
      const d = new Date(clean);
      if (!isNaN(d.getTime())) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      }
    }

    // 1. Check if it matches YYYY/MM/DD or YYYY-MM-DD
    const ymdMatch = clean.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    if (ymdMatch && !clean.includes('T')) {
      const y = ymdMatch[1];
      const m = ymdMatch[2].padStart(2, '0');
      const d = ymdMatch[3].padStart(2, '0');
      return `${y}-${m}-${d}`;
    }

    // 2. Check if it matches DD/MM/YYYY or DD-MM-YYYY (ar-EG format)
    const dmyMatch = clean.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (dmyMatch) {
      const d = dmyMatch[1].padStart(2, '0');
      const m = dmyMatch[2].padStart(2, '0');
      const y = dmyMatch[3];
      return `${y}-${m}-${d}`;
    }

    // 3. If it's something like "28 يونيو 2026"
    const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
    const parts = clean.split(' ');
    if (parts.length >= 3) {
      const day = parseInt(parts[0], 10);
      const monthName = parts[1].replace(/[أإآ]/g, 'ا');
      const year = parseInt(parts[2], 10);
      
      const monthIndex = months.findIndex(m => m.replace(/[أإآ]/g, 'ا') === monthName);
      if (!isNaN(day) && !isNaN(year) && monthIndex !== -1) {
        const dStr = String(day).padStart(2, '0');
        const mStr = String(monthIndex + 1).padStart(2, '0');
        return `${year}-${mStr}-${dStr}`;
      }
    }
    
    try {
      const dObj = new Date(val);
      if (!isNaN(dObj.getTime())) {
        return dObj.toISOString().split('T')[0];
      }
    } catch {}
    
    return new Date().toISOString().split('T')[0];
  }

  formatDateWithCurrentOrOriginalTime(newDateYmd: string, originalDateStr?: string): string {
    if (!newDateYmd) return '';
    
    let timePart = '';
    if (originalDateStr) {
      const parsed = this.formatDateValue(originalDateStr);
      if (parsed.time) {
        timePart = this.convert12HourTo24Hour(parsed.time);
      }
    }
    
    if (!timePart) {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      timePart = `${hh}:${mm}:${ss}`;
    }
    
    return `${newDateYmd} ${timePart}`;
  }

  private convert12HourTo24Hour(time12: string): string {
    const clean = time12.trim();
    const match = clean.match(/^(\d{1,2}):(\d{2})\s*(ص|م|AM|PM)?$/i);
    if (!match) return '12:00:00';
    
    let hour = parseInt(match[1], 10);
    const minute = match[2];
    const ampm = match[3];
    
    if (ampm) {
      const isPm = ampm === 'م' || ampm.toUpperCase() === 'PM';
      const isAm = ampm === 'ص' || ampm.toUpperCase() === 'AM';
      if (isPm && hour < 12) hour += 12;
      if (isAm && hour === 12) hour = 0;
    }
    
    return `${String(hour).padStart(2, '0')}:${minute}:00`;
  }

  /** إعادة طباعة عبر Print Agent بنفس تفاصيل الحالة ورقم الكيس — بدون نافذة متصفح */
  reprintCase(c: {
    caseNumber?: string;
    doctor?: string;
    patient?: string;
    branch?: string;
    clinic?: string;
    workType?: string;
    workDetail?: string;
    color?: string;
    quantity?: number;
    priority?: string;
    intakeType?: 'impression' | 'scan';
    receivedDate?: string;
    teeth?: Array<{ fdi: string; material: string; groupId: string }>;
  }): void {
    const caseNumber = String(c.caseNumber || '').trim();
    if (!caseNumber) {
      this.flash(this.lang.t('secretary.toast.noBagId'));
      return;
    }

    const caseType = this.getCaseTypeFromWorkType(c.workType || '');
    const printDraft = {
      doctor: String(c.doctor || '').trim(),
      patient: String(c.patient || '').trim(),
      branch: String(c.branch || c.clinic || '').trim(),
      caseType,
      workType: String(c.workType || '').trim(),
      workDetail: String(c.workDetail || '').trim(),
      color: String(c.color || '').trim(),
      quantity: caseType === 'Empty' ? 0 : Number(c.quantity) || 1,
      date: c.receivedDate,
      urgent: c.priority === 'emergency',
      intakeType: c.intakeType === 'scan' || c.intakeType === 'impression' ? c.intakeType : undefined,
      teeth: Array.isArray(c.teeth) && c.teeth.length ? c.teeth : undefined,
    };

    this.http
      .post(`${this.apiBase}/print/job`, {
        printData: buildPrintData(printDraft, caseNumber),
      })
      .subscribe({
        next: () => this.flash(this.lang.t('secretary.toast.reprintOk')),
        error: () => this.flash(this.lang.t('secretary.toast.reprintFail')),
      });
  }
}
