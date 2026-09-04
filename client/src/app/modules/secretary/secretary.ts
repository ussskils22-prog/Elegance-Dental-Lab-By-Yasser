import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, HostListener, OnDestroy, OnInit, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { catchError, of, Subscription, switchMap } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { CaseApiService } from '../../core/services/case-api.service';
import { SharedCasesService } from '../../core/services/shared-cases.service';
import { UserApiService } from '../../core/services/user-api.service';
import {
  buildCreateCasePayload,
  mapApiCaseToDentalCase,
  toStoredCaseImagePath,
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

  readonly secretaryMenuItems: AppMenuItem[] = [
    {
      id: 'create-doctor',
      labelKey: 'menu.createDoctor',
      action: () => this.openCreateDoctorModal(),
    },
    {
      id: 'doctor-list',
      labelKey: 'menu.doctorList',
      action: () => this.openDoctorListModal(),
    },
    {
      id: 'reset-doctor-password',
      labelKey: 'menu.resetDoctorPassword',
      action: () => this.openResetDoctorPasswordModal(),
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

  newDoctor = { name: '', email: '', phone: '', password: '' };
  createDoctorError = '';
  createDoctorSaving = false;
  showNewDoctorPassword = false;

  doctorRows: { id: string; fullName: string; email: string; phone: string }[] = [];
  readonly doctorListSearchQuery = signal('');
  readonly filteredDoctorRows = computed(() => {
    const q = this.normalizeSearchText(this.doctorListSearchQuery());
    if (!q) return this.doctorRows;
    const tokens = q.split(' ').filter(Boolean);
    return this.doctorRows.filter((doc) => {
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
  readonly dialogMode = signal<'create' | 'edit'>('create');
  editingId: string | null = null;
  formDraft: any = emptyDraft();

  // Autocomplete Doctor logic — فقط دكاترة لهم أكونت نشط على السيستم
  readonly accountDoctors = signal<string[]>([]);

  readonly uniqueDoctors = computed(() => {
    return [...this.accountDoctors()].sort((a, b) => a.localeCompare(b, 'ar'));
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

  private loadAccountDoctors(): void {
    this.userApi.getUsersByRole('doctor').subscribe({
      next: (res) => {
        const rows = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
        const names = rows
          .map((u: any) => String(u?.fullName || '').trim())
          .filter((n: string) => !!n);
        this.accountDoctors.set(Array.from(new Set(names)));
      },
      error: () => {
        this.accountDoctors.set([]);
      },
    });
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
    if (!wt) return 'New';
    const normalized = wt.trim();
    if (normalized === 'Modification' || normalized.startsWith('Modification - ')) return 'Modification';
    if (normalized === 'Redo' || normalized === 'Remake' || normalized.startsWith('Redo - ') || normalized.startsWith('Remake - ')) return 'Redo';
    if (normalized === 'Empty') return 'Empty';
    return 'New';
  }

  formatWorkTypeForDisplay(wt: string): string {
    if (!wt) return '';
    if (wt === 'Empty') return this.lang.t('caseType.empty');
    if (wt === 'Modification') return this.lang.t('caseType.modification');
    if (wt === 'Redo' || wt === 'Remake') return this.lang.t('caseType.redo');

    const modPrefix = `${this.lang.t('caseType.modification')} - `;
    const redoPrefix = `${this.lang.t('caseType.redo')} - `;
    let display = wt;
    if (display.startsWith('Modification - ')) {
      display = display.replace('Modification - ', modPrefix);
    } else if (display.startsWith('Redo - ')) {
      display = display.replace('Redo - ', redoPrefix);
    } else if (display.startsWith('Remake - ')) {
      display = display.replace('Remake - ', redoPrefix);
    }
    return display;
  }

  onCaseTypeChange(): void {
    if (this.formDraft.caseType === 'Empty') {
      this.selectedWorkTypes.clear();
      this.workTypeQuantities = {};
      this.nightGuardType = '';
      this.formDraft.workType = 'Empty';
      this.formDraft.quantity = 0;
    } else {
      this.updateWorkTypeString();
    }
  }

  selectedWorkTypes = new Set<string>();
  toothAssignments: ToothAssignment[] = [];
  toothLinkMode: 'connected' | 'separate' = 'separate';
  activeToothMaterial = '';

  get chartMaterials(): string[] {
    return [...this.selectedWorkTypes].filter((wt) => wt !== 'Remake' && wt !== 'Empty');
  }

  onToothAssignmentsChange(list: ToothAssignment[]): void {
    this.toothAssignments = list || [];
    const counts = countByMaterial(this.toothAssignments);
    for (const [mat, n] of Object.entries(counts)) {
      if (this.selectedWorkTypes.has(mat)) this.workTypeQuantities[mat] = n;
    }
    for (const wt of this.selectedWorkTypes) {
      if (!(wt in counts) && (this.workTypeQuantities[wt] == null || this.workTypeQuantities[wt] < 1)) {
        this.workTypeQuantities[wt] = 1;
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
        this.selectedWorkTypes.add('Empty');
        this.workTypeQuantities['Empty'] = 1;
        this.nightGuardType = '';
        this.toothAssignments = [];
        this.activeToothMaterial = '';
        this.workPhase = '';
      } else {
        this.selectedWorkTypes.delete('Empty');
        delete this.workTypeQuantities['Empty'];
        this.selectedWorkTypes.add(type);
        this.workTypeQuantities[type] = 1;
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
    this.updateWorkTypeString();
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
    const multi = this.selectedWorkTypes.size > 1;
    for (const wt of this.selectedWorkTypes) {
      const q = Number(this.workTypeQuantities[wt]) || 1;
      total += q;

      let displayName = wt;
      if (wt === 'Night Guard') {
        if (this.nightGuardType) {
          displayName = `Night Guard ${this.nightGuardType}`;
        } else {
          displayName = 'Night Guard';
        }
      }

      if (this.workPhase && supportsTryInPhase(wt)) {
        displayName = applyWorkPhaseToName(displayName, this.workPhase);
      }

      parts.push(formatWorkPartWithQty(displayName, q, multi || q > 1));
    }

    let finalString = parts.join(' + ');
    if (this.formDraft.caseType === 'Modification' && finalString) {
      finalString = 'Modification - ' + finalString;
    } else if (this.formDraft.caseType === 'Redo' && finalString) {
      finalString = 'Redo - ' + finalString;
    } else if ((this.formDraft.caseType === 'Modification' || this.formDraft.caseType === 'Redo') && !finalString) {
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

  openCreateDoctorModal(): void {
    this.newDoctor = { name: '', email: '', phone: '', password: '' };
    this.createDoctorError = '';
    this.showNewDoctorPassword = false;
    this.createDoctorOpen.set(true);
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
      .registerDoctor({ fullName: name, email, phone, password })
      .subscribe({
        next: () => {
          this.createDoctorSaving = false;
          this.createDoctorOpen.set(false);
          this.flash(this.lang.t('secretary.doctors.created'));
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

  openDoctorListModal(): void {
    this.doctorListSearchQuery.set('');
    this.doctorListOpen.set(true);
    this.loadDoctorRows();
  }

  closeDoctorListModal(): void {
    this.doctorListOpen.set(false);
    this.doctorListSearchQuery.set('');
  }

  get doctorListSearchQueryValue(): string {
    return this.doctorListSearchQuery();
  }

  set doctorListSearchQueryValue(value: string) {
    this.doctorListSearchQuery.set(value);
  }

  private loadDoctorRows(): void {
    this.doctorListLoading = true;
    this.doctorListError = '';
    this.userApi.getUsersByRole('doctor').subscribe({
      next: (res) => {
        const rows = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
        this.doctorRows = rows
          .map((u: { _id?: string; id?: string; fullName?: string; email?: string; phone?: string }) => ({
            id: String(u._id || u.id || ''),
            fullName: String(u.fullName || '').trim(),
            email: String(u.email || '').trim(),
            phone: String(u.phone || '').trim(),
          }))
          .filter((u: { id: string; fullName: string }) => u.id && u.fullName);
        this.doctorListLoading = false;
      },
      error: () => {
        this.doctorListLoading = false;
        this.doctorListError = this.lang.t('secretary.toast.loadFail');
        this.doctorRows = [];
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

  openResetDoctorPasswordModal(): void {
    this.resetDoctorId = '';
    this.resetDoctorPassword = '';
    this.resetDoctorError = '';
    this.showResetDoctorPassword = false;
    this.resetDoctorPasswordOpen.set(true);
    if (!this.doctorRows.length) {
      this.loadDoctorRows();
    }
  }

  closeResetDoctorPasswordModal(): void {
    if (this.resetDoctorSaving) return;
    this.resetDoctorPasswordOpen.set(false);
  }

  saveResetDoctorPassword(): void {
    this.resetDoctorError = '';
    if (!this.resetDoctorId) {
      this.resetDoctorError = this.lang.t('secretary.doctors.selectDoctor');
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

  private reloadCasesFromBackend(silent = false): void {
    if (!silent) this.casesLoading.set(true);
    this.caseApi.getAllCases(1, 1500).subscribe({
      next: res => {
        const rows = (res?.data ?? []) as Record<string, unknown>[];
        const mapped = Array.isArray(rows) ? rows.map(r => mapApiCaseToDentalCase(r)) : [];
        this.sharedCases.setCasesFromServer(mapped);
        this.casesLoading.set(false);
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

  openCreateDialog(): void {
    this.dialogMode.set('create');
    this.editingId = null;
    this.formDraft = emptyDraft();
    this.selectedWorkTypes.clear();
    this.workTypeQuantities = {};
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
    this.editingId = c.id;
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
    this.workTypeError = '';
    this.nightGuardType = '';
    this.workPhase = '';
    this.patientWarning = '';
    if (currentCaseType !== 'Empty' && c.workType) {
      let wtToParse = c.workType;
      if (wtToParse.startsWith('Modification - ')) wtToParse = wtToParse.replace('Modification - ', '');
      else if (wtToParse === 'Modification') wtToParse = '';
      else if (wtToParse.startsWith('Redo - ')) wtToParse = wtToParse.replace('Redo - ', '');
      else if (wtToParse === 'Redo' || wtToParse === 'Remake') wtToParse = '';

      if (wtToParse) {
        const parts = wtToParse.split('+').map((s: string) => s.trim()).filter((s: string) => s);
      for (const p of parts) {
        const match = p.match(/^(.*?)(?:\s*\((\d+)\))?$/);
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
            this.workTypeQuantities['Night Guard'] = qty;
            if (wtName.includes('Soft')) {
              this.nightGuardType = 'Soft';
            } else if (wtName.includes('Hard')) {
              this.nightGuardType = 'Hard';
            } else {
              this.nightGuardType = 'Soft';
            }
          } else if (this.workTypeOptions.includes(wtName) || supportsTryInPhase(wtName)) {
            // Match catalog label case-insensitively if needed
            const catalog =
              this.workTypeOptions.find((o) => o.toLowerCase() === wtName.toLowerCase()) || wtName;
            this.selectedWorkTypes.add(catalog);
            this.workTypeQuantities[catalog] = qty;
            if (supportsTryInPhase(catalog) && !this.workPhase) {
              this.workPhase = 'final';
            }
          }
        }
      }
      if (this.selectedWorkTypes.size === 1) {
        const onlyWt = [...this.selectedWorkTypes][0];
        if (!c.workType.includes('(')) {
          this.workTypeQuantities[onlyWt] = Number(c.quantity) || 1;
        }
      }
        }
      if (this.selectedWorkTypes.size > 0) {
        this.updateWorkTypeString();
      } else {
        this.formDraft.workType = c.workType;
      }
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
    const isStudentCase = existing?.requesterType === 'student';

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
    if (isStudentCase && (!Number.isFinite(Number(d.studentPrice)) || Number(d.studentPrice) <= 0)) {
      this.flash(this.lang.t('secretary.toast.needStudentPrice'));
      return;
    }

    let patientName = d.patient.trim();
    const docName = d.doctor.trim();

    const formPayload = {
      requesterType: isStudentCase ? ('student' as const) : ('doctor' as const),
      studentPrice: isStudentCase ? Number(d.studentPrice || 0) : 0,
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

      this.caseApi
        .createCase(buildCreateCasePayload(formPayload))
        .pipe(
          switchMap((res: { case?: { caseNumber?: string; _id?: string; id?: string } }) => {
            const caseNumber = String(res?.case?.caseNumber ?? '');
            const caseId = String(res?.case?._id ?? res?.case?.id ?? '');
            const print$ = this.http.post(`${this.apiBase}/print/job`, {
              printData: buildPrintData(printDraft, caseNumber),
            });
            const attach$ = caseId ? this.attachScanAfterSave(caseId, ply, plyLink) : null;
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
            this.flash(this.lang.t('secretary.toast.savedPrint'));
            this.closeDialog();
            this.reloadCasesFromBackend();
          },
          error: (err: unknown) => {
            this.saveInProgress.set(false);
            this.flash(this.formatCaseApiError(err) || this.lang.t('secretary.toast.saveFail'));
          },
        });
      return;
    }

    if (this.editingId) {
      this.saveInProgress.set(true);
      const ply = this.intakeType === 'scan' ? this.selectedPlyFile : null;
      const plyLink = this.intakeType === 'scan' && !ply ? this.plyScanLink.trim() : '';
      this.caseApi
        .updateCase(this.editingId, buildCreateCasePayload(formPayload, plyPreserveMeta))
        .subscribe({
        next: () => {
          const done = () => {
            this.saveInProgress.set(false);
            this.flash(this.lang.t('secretary.toast.savedEdit'));
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

  isStudentDialog(): boolean {
    if (this.dialogMode() === 'edit' && this.editingId) {
      return this.sharedCases.getCaseById(this.editingId)?.requesterType === 'student';
    }
    return false;
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
    const detailExtra = this.lang
      .t('secretary.spawnFinalDetail')
      .replace('{n}', String(c.caseNumber || ''));
    const workDetail = [String(c.workDetail || '').trim(), detailExtra].filter(Boolean).join(' — ');

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
      requesterType: (c.requesterType === 'student' ? 'student' : 'doctor') as 'student' | 'doctor',
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

    this.caseApi
      .createCase(buildCreateCasePayload(formPayload))
      .pipe(
        switchMap((res: { case?: { caseNumber?: string; _id?: string; id?: string } }) => {
          const caseNumber = String(res?.case?.caseNumber ?? '');
          return this.http.post(`${this.apiBase}/print/job`, {
            printData: buildPrintData(printDraft, caseNumber),
          });
        })
      )
      .subscribe({
        next: () => {
          this.spawningFinalId = null;
          this.flash(this.lang.t('secretary.toast.spawnFinalOk'));
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
