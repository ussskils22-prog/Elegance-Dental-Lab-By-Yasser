import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, HostListener, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, switchMap, catchError, of } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { CaseApiService } from '../../core/services/case-api.service';
import { SharedCasesService, DentalCase } from '../../core/services/shared-cases.service';
import { mapApiCaseToDentalCase } from '../../core/mappers/dental-case-api.mapper';
import {
  buildCasePayloadFromPrintForm,
  buildPrintData,
  formatWorkTypeForPrint,
} from '../../core/utils/print-job.util';
import {
  formatPartWithKind,
  inferDropdownCaseType,
  normalizeCaseTypeParts,
  parsePartKind,
  type WorkPartKind,
} from '../../core/utils/case-type-parts.util';
import {
  applyWorkPhaseToName,
  formatWorkPartWithQty,
  parseMaterialAndPhaseFromPart,
  supportsTryInPhase,
  type WorkPhase,
} from '../../core/utils/tryin-phase.util';
import { SocketService } from '../../core/services/socket.service';
import { ThemeService } from '../../core/services/theme.service';
import { LanguageService } from '../../core/i18n/language.service';
import { TPipe } from '../../core/i18n/t.pipe';
import { PwaInstallService } from '../../core/services/pwa-install.service';
import { environment } from '../../../environments/environment';
import { PatientLabelPipe } from '../secretary/patient-label.pipe';
import { CaseBarcodeComponent } from '../../shared/case-barcode/case-barcode';
import { LabConfigService } from '../../core/services/lab-config.service';
import { ToothChartComponent } from '../../shared/tooth-chart/tooth-chart';
import { ToothAssignment, countByMaterial } from '../../shared/tooth-chart/tooth-chart.types';
import { AppOverflowMenuComponent, type AppMenuItem } from '../../shared/app-overflow-menu/app-overflow-menu';
import { isClientAccountKind, type ClientAccountKind } from '../../core/auth/client-account';

function todayYmd(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function emptyDraft() {
  return {
    caseNumber: '',
    patient: '',
    workType: '',
    workDetail: '',
    color: '',
    branch: '',
    quantity: 1,
    date: todayYmd(),
    caseType: 'New' as 'New' | 'Modification' | 'Redo' | 'Empty',
    urgent: false,
  };
}

type DoctorStage = 'pending' | 'design' | 'finishing' | 'finished' | 'exited';

type DoctorFilter = 'all' | 'important' | DoctorStage;

export type DoctorNotif = {
  id: string;
  caseId: string;
  caseNumber: string;
  patient: string;
  kind: 'finished' | 'exited';
  message: string;
  at: number;
  read: boolean;
};

@Component({
  selector: 'app-doctor',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    PatientLabelPipe,
    CaseBarcodeComponent,
    ToothChartComponent,
    AppOverflowMenuComponent,
    TPipe,
  ],
  templateUrl: './doctor.html',
  styleUrls: ['../secretary/secretary.css', './doctor.css'],
})
export class DoctorComponent implements OnInit, OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly caseApi = inject(CaseApiService);
  private readonly sharedCases = inject(SharedCasesService);
  private readonly socketService = inject(SocketService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly http = inject(HttpClient);
  public readonly themeService = inject(ThemeService);
  public readonly lang = inject(LanguageService);
  public readonly pwa = inject(PwaInstallService);
  private readonly labConfig = inject(LabConfigService);

  private readonly apiBase = environment.apiUrl;
  private readonly socketSubs: Subscription[] = [];
  private knownStatus = new Map<string, DoctorStage>();
  private notifHydrated = false;

  /** Admin viewing a specific doctor's portal via ?as=Name */
  readonly viewingAsDoctor = signal<string | null>(null);
  readonly viewingClientKind = signal<ClientAccountKind | null>(null);
  readonly isAdminView = computed(() => {
    const role = this.auth.getSession()?.role;
    return role === 'admin' && !!this.viewingAsDoctor();
  });
  readonly doctorName = computed(() => {
    const as = this.viewingAsDoctor()?.trim();
    if (as && this.auth.getSession()?.role === 'admin') return as;
    return this.auth.getSession()?.name?.trim() || '—';
  });
  readonly pageTitle = computed(() => {
    this.lang.lang();
    return this.lang.t('doctor.title').replace('{name}', this.doctorName());
  });
  readonly casesLoading = signal(true);
  readonly toast = signal<string | null>(null);
  readonly dialogOpen = signal(false);
  readonly dialogMode = signal<'create' | 'edit'>('create');
  readonly detailOpen = signal(false);
  readonly detailCase = signal<DentalCase | null>(null);
  readonly notificationsOpen = signal(false);
  readonly notifications = signal<DoctorNotif[]>([]);
  readonly saveInProgress = signal(false);
  readonly activeFilter = signal<DoctorFilter>('all');
  readonly searchQuery = signal('');

  get portalMenuItems(): AppMenuItem[] {
    const items: AppMenuItem[] = [
      {
        id: 'accounts',
        labelKey: 'menu.accounts',
        action: () => this.openAccountsFromMenu(),
      },
    ];
    if (this.showRequestRepMenu()) {
      items.push({
        id: 'request-rep',
        labelKey: 'menu.requestRep',
        action: () => this.requestRepFromMenu(),
      });
    }
    items.push({
      id: 'exited-materials',
      labelKey: 'menu.exitedMaterials',
      action: () => this.openExitedMaterialsFromMenu(),
    });
    return items;
  }

  showRequestRepMenu(): boolean {
    const role = this.auth.getSession()?.role;
    if (role === 'student' || role === 'lab') return false;
    const kind = this.viewingClientKind();
    if (kind === 'student' || kind === 'lab') return false;
    return true;
  }

  /** Labs cannot mark cases urgent — doctors and students still can. */
  isLabPortal(): boolean {
    if (this.viewingClientKind() === 'lab') return true;
    return this.auth.getSession()?.role === 'lab';
  }

  private portalRequesterType(): ClientAccountKind {
    const kind = this.viewingClientKind();
    if (kind) return kind;
    const role = this.auth.getSession()?.role;
    return isClientAccountKind(role) ? role : 'doctor';
  }
  editingId: string | null = null;
  formDraft = emptyDraft();
  patientNameError = '';
  intakeType: 'impression' | 'scan' | '' = '';
  selectedPlyFile: File | null = null;
  /** External scan URL (Drive / WeTransfer / …) as alternative to file upload */
  plyScanLink = '';
  existingPlyFileName: string | null = null;

  /** Prompt doctor to create a PIN after first password login */
  readonly pinSetupOpen = signal(false);
  pinDraft = '';
  pinConfirm = '';
  pinError = '';
  pinSaving = false;

  workTypeOptions = [
    'Zircon',
    'Emax',
    'Pmma Cad',
    'Peek',
    'Titanium',
    'Try in',
    'Mokup',
    'Night Guard',
    'Wax',
    'Ring',
  ];
  brandTitle = 'Elegance';

  get caseTypeOptions() {
    return [
      { value: 'New', label: this.lang.t('caseType.new') },
      { value: 'Modification', label: this.lang.t('caseType.modification') },
      { value: 'Redo', label: this.lang.t('caseType.redo') },
      { value: 'Empty', label: this.lang.t('caseType.empty') },
    ];
  }

  selectedWorkTypes = new Set<string>();
  workTypeQuantities: Record<string, number> = {};
  /** Per-material qty split: New / Redo / Modification on the same request */
  workTypeKindQtys: Record<string, Record<WorkPartKind, number>> = {};
  toothAssignments: ToothAssignment[] = [];
  toothLinkMode: 'connected' | 'separate' = 'separate';
  activeToothMaterial = '';
  nightGuardType: 'Soft' | 'Hard' | '' = '';
  /** فاينل أو بروفة — بعد اختيار مادة تدعم try-in */
  workPhase: WorkPhase | '' = '';
  workTypeError = '';

  readonly colorRequiredTypes = new Set(['Zircon', 'German Zircon', 'Emax', 'Peek', 'Titanium']);

  get isColorRequired(): boolean {
    if (this.formDraft.caseType === 'Empty') return false;
    for (const wt of this.selectedWorkTypes) {
      if (this.colorRequiredTypes.has(wt)) return true;
    }
    return false;
  }

  get searchQueryValue(): string {
    return this.searchQuery();
  }
  set searchQueryValue(v: string) {
    this.searchQuery.set(v);
  }

  readonly unreadCount = computed(
    () => this.notifications().filter((n) => !n.read).length
  );

  private bucket(c: DentalCase): DoctorStage {
    if (c.status === 'exited') return 'exited';
    const stage = String(c.currentStage || '').toLowerCase();
    if (stage === 'finishing' || c.status === 'ready-for-finishing') return 'finishing';
    if (c.status === 'finished' || stage === 'completed') return 'finished';
    if (c.status === 'in-progress' || c.status === 'under-khart' || c.status === 'needs-revision') {
      return 'design';
    }
    return 'pending';
  }

  canEdit(c: DentalCase): boolean {
    return this.bucket(c) === 'pending';
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

  isImportant(c: DentalCase | string): boolean {
    if (typeof c === 'string') {
      const found = this.allCases().find((x) => x.id === c);
      return found?.priority === 'emergency';
    }
    return c.priority === 'emergency';
  }

    toggleImportant(c: DentalCase, ev?: Event): void {
      ev?.stopPropagation();
      if (this.isLabPortal()) return;
      const makeUrgent = c.priority !== 'emergency';
    const prev = c.priority;
    const optimistic: DentalCase = {
      ...c,
      priority: makeUrgent ? 'emergency' : 'normal',
    };
    this.sharedCases.updateCase(c.id, optimistic);
    if (this.detailCase()?.id === c.id) {
      this.detailCase.set(optimistic);
    }
    this.caseApi.updateCase(c.id, { priority: makeUrgent ? 'urgent' : 'normal' }).subscribe({
      next: () => {
        this.flash(
          makeUrgent
            ? this.lang.t('doctor.toast.markedUrgent')
            : this.lang.t('doctor.toast.unmarkedUrgent')
        );
      },
      error: (err) => {
        this.sharedCases.updateCase(c.id, { ...c, priority: prev });
        if (this.detailCase()?.id === c.id) {
          this.detailCase.set({ ...c, priority: prev });
        }
        this.flash(err?.error?.message || this.lang.t('doctor.toast.priorityFail'));
      },
    });
  }

  readonly allCases = computed(() => {
    const name = this.doctorName();
    const rows = this.sharedCases.cases();
    if (!name || name === '—') return rows;
    const key = this.normalizeDoctorKey(name);
    return rows.filter((c) => this.normalizeDoctorKey(c.doctor || '') === key);
  });

  readonly stats = computed(() => {
    this.lang.lang();
    const all = this.allCases();
    const pending = all.filter((c) => this.bucket(c) === 'pending').length;
    const design = all.filter((c) => this.bucket(c) === 'design').length;
    const finishing = all.filter((c) => this.bucket(c) === 'finishing').length;
    const finished = all.filter((c) => this.bucket(c) === 'finished').length;
    const exited = all.filter((c) => this.bucket(c) === 'exited').length;
    return [
      { label: this.lang.t('stats.total'), value: all.length, color: 'purple' as const },
      { label: this.lang.t('stats.new'), value: pending, color: 'amber' as const },
      { label: this.lang.t('stats.design'), value: design, color: 'blue' as const },
      { label: this.lang.t('stats.finishing'), value: finishing, color: 'teal' as const },
      { label: this.lang.t('stats.finished'), value: finished, color: 'emerald' as const },
      { label: this.lang.t('stats.exited'), value: exited, color: 'rose' as const },
    ];
  });

  readonly filterCounts = computed(() => {
    const all = this.allCases();
    const active = all.filter((c) => c.status !== 'exited');
    const important = active.filter((c) => c.priority === 'emergency').length;
    return {
      all: active.length,
      important,
      pending: all.filter((c) => this.bucket(c) === 'pending').length,
      design: all.filter((c) => this.bucket(c) === 'design').length,
      finishing: all.filter((c) => this.bucket(c) === 'finishing').length,
      finished: all.filter((c) => this.bucket(c) === 'finished').length,
      exited: all.filter((c) => this.bucket(c) === 'exited').length,
    };
  });

  readonly cases = computed(() => {
    const q = this.normalizeSearch(this.searchQuery());
    const filter = this.activeFilter();
    let list = this.allCases();
    if (filter === 'important') {
      list = list.filter((c) => c.status !== 'exited' && c.priority === 'emergency');
    } else if (filter === 'all') {
      list = list.filter((c) => c.status !== 'exited');
    } else {
      list = list.filter((c) => this.bucket(c) === filter);
    }
    if (q) {
      list = list
        .map((c) => ({ c, score: this.searchScore(c, q) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.c);
    } else {
      list = [...list].sort((a, b) => {
        const ai = a.priority === 'emergency' ? 1 : 0;
        const bi = b.priority === 'emergency' ? 1 : 0;
        if (bi !== ai) return bi - ai;
        return 0;
      });
    }
    return list;
  });

  private reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    this.socketSubs.push(
      this.route.queryParamMap.subscribe((params) => {
        const as = (params.get('as') || '').trim();
        const kindRaw = (params.get('kind') || '').trim();
        const role = this.auth.getSession()?.role;
        if (role === 'admin' && as) {
          this.viewingAsDoctor.set(as);
          this.viewingClientKind.set(isClientAccountKind(kindRaw) ? kindRaw : 'doctor');
        } else {
          this.viewingAsDoctor.set(null);
          this.viewingClientKind.set(isClientAccountKind(role) ? role : null);
        }
        this.loadNotificationsFromStorage();
        this.loadCases();
        this.maybeOfferPinSetup();
      })
    );
    this.socketService.connect();
    const refresh = () => this.scheduleBackgroundReload();
    this.socketSubs.push(
      this.socketService.onCaseCreated().subscribe((evt) => {
        if (evt) refresh();
      }),
      this.socketService.onCaseUpdated().subscribe((evt) => {
        if (evt) refresh();
      }),
      this.socketService.onCaseExited().subscribe((evt) => {
        if (evt) refresh();
      }),
      this.socketService.onCaseMovedStage().subscribe((evt) => {
        if (evt) refresh();
      }),
      this.socketService.onCaseCompleted().subscribe((evt) => {
        if (evt) refresh();
      }),
      this.socketService.onCaseDeleted().subscribe((evt) => {
        if (evt) refresh();
      })
    );
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

  @HostListener('document:click', ['$event'])
  onDocumentClick(ev: MouseEvent): void {
    const el = ev.target as HTMLElement;
    if (el.closest('.notif-bell') || el.closest('.notifications-panel')) return;
    this.notificationsOpen.set(false);
  }

  private doctorNavQueryParams(): Record<string, string> {
    const as = this.viewingAsDoctor()?.trim();
    if (as && this.auth.getSession()?.role === 'admin') {
      const kind = this.viewingClientKind();
      return kind && kind !== 'doctor' ? { as, kind } : { as };
    }
    return {};
  }

  requestRepFromMenu(): void {
    if (!this.showRequestRepMenu()) return;
    this.notificationsOpen.set(false);
    this.router.navigate(['/doctor/request-rep'], { queryParams: this.doctorNavQueryParams() });
  }

  openAccountsFromMenu(): void {
    this.notificationsOpen.set(false);
    this.router.navigate(['/doctor/accounts'], { queryParams: this.doctorNavQueryParams() });
  }

  openExitedMaterialsFromMenu(): void {
    this.notificationsOpen.set(false);
    this.router.navigate(['/doctor/exited-materials'], { queryParams: this.doctorNavQueryParams() });
  }

  private scheduleBackgroundReload(): void {
    if (this.reloadDebounceTimer) clearTimeout(this.reloadDebounceTimer);
    this.reloadDebounceTimer = setTimeout(() => {
      this.reloadDebounceTimer = null;
      this.loadCases({ silent: true });
    }, 2000);
  }

  private loadCases(opts?: { silent?: boolean }): void {
    if (!opts?.silent) this.casesLoading.set(true);
    this.caseApi.getAllCases(1, 1500).subscribe({
      next: (res) => {
        const rows = (res?.data ?? []) as Record<string, unknown>[];
        if (Array.isArray(rows)) {
          const mapped = rows.map((r) => mapApiCaseToDentalCase(r));
          this.sharedCases.setCasesFromServer(mapped);
          this.processStatusNotifications(mapped, !opts?.silent);
        }
        this.casesLoading.set(false);
      },
      error: () => {
        this.casesLoading.set(false);
        if (!opts?.silent) this.flash(this.lang.t('secretary.toast.loadFail'));
      },
    });
  }

  private notifStorageKey(): string {
    const id = this.auth.getSession()?.id || 'anon';
    const as = this.viewingAsDoctor()?.trim();
    if (as && this.auth.getSession()?.role === 'admin') {
      return `doctor_portal_notifs_${id}_as_${as}`;
    }
    return `doctor_portal_notifs_${id}`;
  }

  private loadNotificationsFromStorage(): void {
    try {
      const raw = localStorage.getItem(this.notifStorageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw) as DoctorNotif[];
      if (Array.isArray(parsed)) {
        this.notifications.set(parsed.slice(0, 40));
      }
    } catch {
      /* ignore */
    }
  }

  private persistNotifications(): void {
    try {
      localStorage.setItem(this.notifStorageKey(), JSON.stringify(this.notifications().slice(0, 40)));
    } catch {
      /* ignore */
    }
  }

  private processStatusNotifications(cases: DentalCase[], isInitial: boolean): void {
    const nextKnown = new Map<string, DoctorStage>();
    const fresh: DoctorNotif[] = [];

    for (const c of cases) {
      const b = this.bucket(c);
      nextKnown.set(c.id, b);
      if (!this.notifHydrated) continue;
      const prev = this.knownStatus.get(c.id);
      if (!prev || prev === b) continue;
      if (b !== 'finished' && b !== 'exited') continue;
      if (prev === 'finished' && b === 'exited') {
        /* allow exit after finish */
      } else if (prev === 'exited' || prev === 'finished') {
        continue;
      }
      const kind = b as 'finished' | 'exited';
      const message =
        kind === 'finished'
          ? this.lang
              .t('doctor.notif.caseFinished')
              .replace('{n}', c.caseNumber)
              .replace('{p}', c.patient)
          : this.lang
              .t('doctor.notif.caseExited')
              .replace('{n}', c.caseNumber)
              .replace('{p}', c.patient);
      fresh.push({
        id: `${c.id}-${kind}-${Date.now()}`,
        caseId: c.id,
        caseNumber: c.caseNumber,
        patient: c.patient,
        kind,
        message,
        at: Date.now(),
        read: false,
      });
    }

    this.knownStatus = nextKnown;
    this.notifHydrated = true;

    if (isInitial || fresh.length === 0) return;

    this.notifications.update((list) => [...fresh, ...list].slice(0, 40));
    this.persistNotifications();
    const last = fresh[0];
    if (last) this.flash(last.kind === 'finished' ? `✅ ${last.message}` : `📦 ${last.message}`);
  }

  toggleNotifications(ev: Event): void {
    ev.stopPropagation();
    const opening = !this.notificationsOpen();
    this.notificationsOpen.set(opening);
    if (opening) this.markAllNotificationsRead();
  }

  markAllNotificationsRead(): void {
    const hasUnread = this.notifications().some((n) => !n.read);
    if (!hasUnread) return;
    this.notifications.update((list) => list.map((n) => ({ ...n, read: true })));
    this.persistNotifications();
  }

  openNotification(n: DoctorNotif): void {
    this.notificationsOpen.set(false);
    const c = this.allCases().find((x) => x.id === n.caseId);
    if (c) {
      this.openDetails(c);
      return;
    }
    this.activeFilter.set(n.kind);
    this.flash(this.lang.t('doctor.toast.notFound'));
  }

  setFilter(f: DoctorFilter): void {
    this.activeFilter.set(f);
  }

  private normalizeDoctorKey(name: string): string {
    return String(name || '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .replace(/[أإآ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي');
  }

  private normalizeSearch(v: string): string {
    return String(v || '')
      .toLowerCase()
      .replace(/[أإآ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي')
      .trim();
  }

  private searchScore(c: DentalCase, q: string): number {
    const patient = this.normalizeSearch(c.patient);
    const work = this.normalizeSearch(this.formatWorkTypeForDisplay(c.workType));
    const color = this.normalizeSearch(c.color);
    const branch = this.normalizeSearch(c.branch || c.clinic || '');
    const detail = this.normalizeSearch(c.workDetail || '');
    const num = this.normalizeSearch(c.caseNumber);
    const tokens = q.split(/\s+/).filter(Boolean);
    const hay = `${patient} ${work} ${color} ${branch} ${detail} ${num}`;
    if (!tokens.every((t) => hay.includes(t))) return 0;
    if (patient.includes(q) || patient.startsWith(q)) return 120;
    if (work.includes(q)) return 100;
    if (color.includes(q)) return 90;
    if (branch.includes(q)) return 85;
    if (num.includes(q)) return 80;
    return 50;
  }

  openDetails(c: DentalCase): void {
    this.detailCase.set(c);
    this.detailOpen.set(true);
  }

  closeDetails(): void {
    this.detailOpen.set(false);
    this.detailCase.set(null);
  }

  openDialog(): void {
    this.dialogMode.set('create');
    this.editingId = null;
    this.formDraft = emptyDraft();
    this.selectedWorkTypes.clear();
    this.workTypeQuantities = {};
    this.workTypeKindQtys = {};
    this.toothAssignments = [];
    this.activeToothMaterial = '';
    this.toothLinkMode = 'separate';
    this.workTypeError = '';
    this.patientNameError = '';
    this.nightGuardType = '';
    this.workPhase = '';
    this.intakeType = '';
    this.existingPlyFileName = null;
    this.plyScanLink = '';
    this.clearPlySelection();
    this.dialogOpen.set(true);
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
      this.existingPlyFileName = null;
    }
  }

  onPlyFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      this.selectedPlyFile = null;
      return;
    }
    if (!/\.(ply|stl|obj|rar|zip)$/i.test(file.name)) {
      this.flash(this.lang.t('doctor.toast.fileType'));
      input.value = '';
      this.selectedPlyFile = null;
      return;
    }
    this.selectedPlyFile = file;
    this.plyScanLink = '';
  }

  onPlyLinkChange(): void {
    if (this.plyScanLink.trim()) {
      this.clearPlySelection();
    }
  }

  clearPlySelection(): void {
    this.selectedPlyFile = null;
    const el = document.getElementById('doctorPlyInput') as HTMLInputElement | null;
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

  /** Upload scan/link in the background so Save is not blocked by large PLY files. */
  private queueScanAttach(caseId: string, ply: File | null, link: string): void {
    const attach$ = this.attachScanAfterSave(caseId, ply, link);
    if (!attach$) return;
    attach$.subscribe({
      next: () => this.loadCases({ silent: true }),
      error: () => {
        this.flash(this.lang.t('doctor.toast.savedScanFail'));
        this.loadCases({ silent: true });
      },
    });
  }

  private maybeOfferPinSetup(): void {
    if (this.isAdminView()) return;
    const session = this.auth.getSession();
    if (!session || !isClientAccountKind(session.role)) return;
    if (session.hasPin) return;
    try {
      if (localStorage.getItem(`pin_setup_skip_${session.id}`) === '1') return;
    } catch {
      /* ignore */
    }
    this.pinSetupOpen.set(true);
  }

  skipPinSetup(): void {
    const session = this.auth.getSession();
    if (session?.id) {
      try {
        localStorage.setItem(`pin_setup_skip_${session.id}`, '1');
      } catch {
        /* ignore */
      }
    }
    this.pinSetupOpen.set(false);
  }

  savePinSetup(): void {
    const pin = this.pinDraft.trim();
    if (!/^\d{4,6}$/.test(pin)) {
      this.pinError = this.lang.t('doctor.err.pinLength');
      return;
    }
    if (pin !== this.pinConfirm.trim()) {
      this.pinError = this.lang.t('doctor.err.pinMismatch');
      return;
    }
    this.pinError = '';
    this.pinSaving = true;
    this.auth.setPin(pin).subscribe({
      next: () => {
        this.pinSaving = false;
        this.pinSetupOpen.set(false);
        this.flash(this.lang.t('doctor.toast.pinSaved'));
      },
      error: (err: { error?: { message?: string } }) => {
        this.pinSaving = false;
        this.pinError = err?.error?.message || this.lang.t('doctor.err.pinSave');
      },
    });
  }

  openEditFromDetail(): void {
    const c = this.detailCase();
    if (!c || !this.canEdit(c)) {
      this.flash(this.lang.t('doctor.toast.editLocked'));
      return;
    }
    this.closeDetails();
    this.openEdit(c);
  }

  openEdit(c: DentalCase): void {
    if (!this.canEdit(c)) {
      this.flash(this.lang.t('doctor.toast.editLocked'));
      return;
    }
    this.dialogMode.set('edit');
    this.editingId = c.id;
    const caseType = this.getCaseTypeFromWorkType(c.workType);
    this.formDraft = {
      caseNumber: c.caseNumber,
      patient: c.patient,
      workType: c.workType,
      workDetail: c.workDetail || '',
      color: c.color || '',
      branch: c.branch || c.clinic || '',
      quantity: c.quantity || 1,
      date: todayYmd(),
      caseType,
      urgent: this.isLabPortal() ? false : c.priority === 'emergency',
    };
    this.selectedWorkTypes = new Set();
    this.workTypeQuantities = {};
    this.workTypeKindQtys = {};
    this.workTypeError = '';
    this.patientNameError = '';
    this.nightGuardType = '';
    this.workPhase = '';
    this.intakeType =
      c.intakeType === 'scan' || c.intakeType === 'impression' ? c.intakeType : '';
    this.existingPlyFileName = c.plyFileName || (c.plyScanUrl ? 'scan' : null);
    this.plyScanLink = /^https?:\/\//i.test(String(c.plyScanUrl || ''))
      ? String(c.plyScanUrl)
      : '';
    this.clearPlySelection();
    this.restoreWorkTypes(c.workType, caseType, c.quantity);
    this.toothAssignments = Array.isArray(c.teeth) ? [...c.teeth] : [];
    this.activeToothMaterial = this.chartMaterials[0] || '';
    this.toothLinkMode = 'separate';
    this.dialogOpen.set(true);
  }

  private getCaseTypeFromWorkType(wt: string): 'New' | 'Modification' | 'Redo' | 'Empty' {
    return inferDropdownCaseType(wt);
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

  private restoreWorkTypes(
    workType: string,
    caseType: 'New' | 'Modification' | 'Redo' | 'Empty',
    quantity: number
  ): void {
    if (caseType === 'Empty' || !workType) return;
    const wtToParse = normalizeCaseTypeParts(workType);
    if (!wtToParse || /^(Redo|Modification|Remake)$/i.test(wtToParse)) return;

    const parts = wtToParse.split('+').map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      const { kind, bare } = parsePartKind(p);
      const match = bare.match(/^(.*?)(?:\s*\((\d+)\))?$/);
      if (!match) continue;
      let wtName = match[1].trim();
      if (wtName === 'Zr') wtName = 'Zircon';
      if (wtName === 'Zr Ger' || wtName === 'Zr Gre') wtName = 'German Zircon';
      const qty = match[2] ? parseInt(match[2], 10) : 1;

      const parsed = parseMaterialAndPhaseFromPart(wtName);
      wtName = parsed.material;
      if (parsed.phase) this.workPhase = parsed.phase;

      if (wtName.startsWith('Night Guard') || wtName.startsWith('Night Gard')) {
        this.selectedWorkTypes.add('Night Guard');
        this.addKindQty('Night Guard', kind, qty);
        this.nightGuardType = wtName.includes('Hard') ? 'Hard' : 'Soft';
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

    if (this.selectedWorkTypes.size === 1 && !workType.includes('(')) {
      const onlyWt = [...this.selectedWorkTypes][0];
      const total = Number(quantity) || 1;
      const kind: WorkPartKind =
        caseType === 'Redo' || caseType === 'Modification' ? caseType : 'New';
      this.workTypeKindQtys[onlyWt] = { New: 0, Redo: 0, Modification: 0 };
      this.workTypeKindQtys[onlyWt][kind] = total;
      this.syncTotalQtyFromKinds(onlyWt);
    }

    this.syncCaseTypeDropdownFromKinds();
    if (this.selectedWorkTypes.size > 0) this.updateWorkTypeString();
  }

  closeDialog(): void {
    this.dialogOpen.set(false);
    this.editingId = null;
    this.plyScanLink = '';
    this.existingPlyFileName = null;
    this.clearPlySelection();
  }

  onCaseTypeChange(): void {
    if (this.formDraft.caseType === 'Empty') {
      this.selectedWorkTypes.clear();
      this.workTypeQuantities = {};
      this.workTypeKindQtys = {};
      this.nightGuardType = '';
      this.workPhase = '';
      this.workTypeError = '';
      this.formDraft.workType = 'Empty';
      this.formDraft.quantity = 0;
      this.toothAssignments = [];
      this.activeToothMaterial = '';
      return;
    }
    // Remap existing material totals into the selected kind bucket
    for (const wt of this.selectedWorkTypes) {
      if (wt === 'Empty') continue;
      const total = this.materialTotalQty(wt) || Number(this.workTypeQuantities[wt]) || 1;
      const kind: WorkPartKind =
        this.formDraft.caseType === 'Redo' || this.formDraft.caseType === 'Modification'
          ? this.formDraft.caseType
          : 'New';
      this.workTypeKindQtys[wt] = { New: 0, Redo: 0, Modification: 0 };
      this.workTypeKindQtys[wt][kind] = total;
      this.syncTotalQtyFromKinds(wt);
    }
    this.updateWorkTypeString();
  }

  toggleWorkType(type: string): void {
    this.workTypeError = '';

    if (this.selectedWorkTypes.has(type)) {
      this.selectedWorkTypes.delete(type);
      delete this.workTypeQuantities[type];
      delete this.workTypeKindQtys[type];
      if (type === 'Night Guard') this.nightGuardType = '';
      this.toothAssignments = this.toothAssignments.filter((t) => t.material !== type);
      if (this.activeToothMaterial === type) {
        this.activeToothMaterial = this.chartMaterials[0] || '';
      }
      if (!this.phaseMaterial) this.workPhase = '';
    } else {
      this.selectedWorkTypes.add(type);
      const draftKind = this.formDraft.caseType;
      const kind: WorkPartKind =
        draftKind === 'Redo' || draftKind === 'Modification' ? draftKind : 'New';
      this.workTypeKindQtys[type] = { New: 0, Redo: 0, Modification: 0 };
      this.workTypeKindQtys[type][kind] = 1;
      this.syncTotalQtyFromKinds(type);
      if (type === 'Night Guard') this.nightGuardType = 'Soft';
      if (!this.activeToothMaterial) this.activeToothMaterial = type;
      if (supportsTryInPhase(type) && !this.workPhase) {
        this.workPhase = 'final';
      }
      if (!supportsTryInPhase(type) && type === 'Try in') {
        this.workPhase = '';
      }
    }
    this.syncCaseTypeDropdownFromKinds();
    this.updateWorkTypeString();
  }

  isWorkTypeSelected(type: string): boolean {
    return this.selectedWorkTypes.has(type);
  }

  get chartMaterials(): string[] {
    return [...this.selectedWorkTypes].filter((wt) => wt !== 'Remake' && wt !== 'Empty');
  }

  onToothAssignmentsChange(list: ToothAssignment[]): void {
    this.toothAssignments = list || [];
    const counts = countByMaterial(this.toothAssignments);
    for (const [mat, n] of Object.entries(counts)) {
      if (this.selectedWorkTypes.has(mat)) {
        this.ensureKindQtys(mat);
        this.workTypeKindQtys[mat].New = n;
        this.syncTotalQtyFromKinds(mat);
      }
    }
    for (const wt of this.selectedWorkTypes) {
      if (!(wt in counts) && this.materialTotalQty(wt) < 1) {
        this.ensureKindQtys(wt);
        this.workTypeKindQtys[wt].New = 1;
        this.syncTotalQtyFromKinds(wt);
      }
    }
    this.syncCaseTypeDropdownFromKinds();
    this.updateWorkTypeString();
  }

  onActiveToothMaterialChange(mat: string): void {
    this.activeToothMaterial = mat;
  }

  onToothLinkModeChange(mode: 'connected' | 'separate'): void {
    this.toothLinkMode = mode;
  }

  get hasWorkTypesWithQuantity(): boolean {
    for (const wt of this.selectedWorkTypes) {
      if (wt !== 'Remake' && wt !== 'Empty') return true;
    }
    return false;
  }

  setNightGuardType(type: 'Soft' | 'Hard'): void {
    this.nightGuardType = type;
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

  private isBinaryPatientName(name: string): boolean {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    return parts.length >= 2;
  }

  save(): void {
    const d = this.formDraft;
    const doctor = this.doctorName();
    if (!doctor || doctor === '—') {
      this.flash(this.lang.t('doctor.toast.needDoctor'));
      return;
    }
    if (!d.patient?.trim()) {
      this.flash(this.lang.t('doctor.toast.needPatient'));
      return;
    }
    if (!this.isBinaryPatientName(d.patient)) {
      this.patientNameError = this.lang.t('doctor.err.patientBinary');
      this.flash(this.lang.t('doctor.err.patientBinary'));
      return;
    }
    this.patientNameError = '';
    if (!d.branch?.trim()) {
      this.flash(this.lang.t('doctor.toast.needBranch'));
      return;
    }
    if (!this.intakeType) {
      this.flash(this.lang.t('doctor.toast.needIntake'));
      return;
    }
    if (this.intakeType === 'scan') {
      const link = this.plyScanLink.trim();
      const hasFile = !!this.selectedPlyFile;
      const hasExisting = !!this.existingPlyFileName;
      if (!hasFile && !link && !hasExisting) {
        this.flash(this.lang.t('doctor.toast.needScan'));
        return;
      }
      if (link && !this.isValidScanLink(link)) {
        this.flash(this.lang.t('doctor.toast.badLink'));
        return;
      }
    }
    if (d.caseType !== 'Empty' && this.selectedWorkTypes.size === 0) {
      this.workTypeError = this.lang.t('doctor.err.needWorkType');
      this.flash(this.lang.t('doctor.toast.needWorkType'));
      return;
    }
    if (d.caseType !== 'Empty' && this.hasWorkTypesWithQuantity && this.toothAssignments.length === 0) {
      this.flash(this.lang.t('doctor.toast.needChart'));
      return;
    }
    if (this.isColorRequired && !d.color?.trim()) {
      this.flash(this.lang.t('doctor.toast.needColor'));
      return;
    }

    this.updateWorkTypeString();
    const isEdit = this.dialogMode() === 'edit' && !!this.editingId;
    const editId = this.editingId;
    const ply = this.intakeType === 'scan' ? this.selectedPlyFile : null;
    const plyLink =
      this.intakeType === 'scan' && !ply ? this.plyScanLink.trim() : '';
    this.closeDialog();
    this.saveInProgress.set(true);

    const draft = {
      doctor,
      patient: d.patient.trim(),
      branch: d.branch.trim(),
      caseType: d.caseType,
      workType: d.workType.trim(),
      workDetail: (d.workDetail || '').trim(),
      color: (d.color || '').trim(),
      quantity: d.caseType === 'Empty' ? 0 : d.quantity || 1,
      date: todayYmd(),
      urgent: this.isLabPortal() ? false : !!d.urgent,
      intakeType: (this.intakeType === 'scan' || this.intakeType === 'impression'
        ? this.intakeType
        : undefined) as 'impression' | 'scan' | undefined,
      teeth: this.toothAssignments.length ? this.toothAssignments : undefined,
    };

    const requesterType = this.portalRequesterType();
    const allowUrgent = !this.isLabPortal() && !!d.urgent;
    const casePayload = buildCasePayloadFromPrintForm(draft, {
      requesterType,
      priority: allowUrgent ? 'urgent' : isEdit || this.isLabPortal() ? 'normal' : undefined,
      entrySource: 'doctor',
    });

    if (isEdit && editId) {
      this.caseApi.updateCase(editId, casePayload).subscribe({
        next: () => {
          this.saveInProgress.set(false);
          this.flash(this.lang.t('secretary.toast.savedEdit'));
          this.loadCases();
          this.queueScanAttach(editId, ply, plyLink);
        },
        error: (err) => {
          this.saveInProgress.set(false);
          this.flash(err?.error?.message || this.lang.t('doctor.toast.updateFail'));
          this.loadCases({ silent: true });
        },
      });
      return;
    }

    this.caseApi
      .createCase(casePayload)
      .pipe(
        switchMap((res: { case?: { caseNumber?: string; _id?: string; id?: string } }) => {
          const caseNumber = String(res?.case?.caseNumber ?? '');
          const caseId = String(res?.case?._id ?? res?.case?.id ?? '');
          if (caseId) this.queueScanAttach(caseId, ply, plyLink);
          return this.http.post(`${this.apiBase}/print/job`, {
            printData: buildPrintData(draft, caseNumber),
          }).pipe(catchError(() => of(null)));
        })
      )
      .subscribe({
        next: () => {
          this.saveInProgress.set(false);
          this.flash(
            draft.urgent
              ? this.lang.t('doctor.toast.savedUrgent')
              : this.lang.t('doctor.toast.saved')
          );
          this.loadCases();
        },
        error: () => {
          this.saveInProgress.set(false);
          this.flash(this.lang.t('doctor.toast.saveFail'));
          this.loadCases({ silent: true });
        },
      });
  }

  logout(): void {
    if (this.isAdminView()) {
      this.backToAdminDoctors();
      return;
    }
    this.auth.performLogout(this.router);
  }

  backToAdminDoctors(): void {
    this.router.navigate(['/admin/dashboard'], {
      queryParams: { nav: 'doctors' },
    });
  }

  private flash(msg: string): void {
    this.toast.set(msg);
    setTimeout(() => this.toast.set(null), 3500);
  }

  formatWorkTypeForDisplay(wt: string): string {
    return formatWorkTypeForPrint(wt);
  }

  getCasePhase(c: DentalCase): { label: string; color: string } {
    const b = this.bucket(c);
    const map: Record<DoctorStage, { label: string; color: string }> = {
      pending: { label: this.lang.t('phase.pending'), color: 'pending' },
      design: { label: this.lang.t('phase.design'), color: 'design' },
      finishing: { label: this.lang.t('phase.finishing'), color: 'khart' },
      finished: { label: this.lang.t('phase.finished'), color: 'finished' },
      exited: { label: this.lang.t('phase.exited'), color: 'exited' },
    };
    return map[b];
  }

  formatDateTime(value: string): { date: string; time: string } {
    if (!value) return { date: '—', time: '' };
    try {
      const raw = String(value).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const [y, m, d] = raw.split('-').map(Number);
        const local = new Date(y, m - 1, d);
        return {
          date: local.toLocaleDateString('ar-EG-u-nu-latn', {
            day: 'numeric',
            month: 'numeric',
            year: 'numeric',
          }),
          time: '',
        };
      }
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) {
        const parts = raw.split(/\s+/);
        return { date: parts[0] || raw, time: parts.slice(1).join(' ') };
      }
      return {
        date: d.toLocaleDateString('ar-EG-u-nu-latn', {
          day: 'numeric',
          month: 'numeric',
          year: 'numeric',
        }),
        time: d.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }),
      };
    } catch {
      return { date: value, time: '' };
    }
  }

  caseReceivedStamp(c: DentalCase): string {
    return c.createdAt || c.receivedDateRaw || c.receivedDate || '';
  }

  formatNotifTime(at: number): string {
    try {
      return new Date(at).toLocaleString('ar-EG-u-nu-latn', {
        day: 'numeric',
        month: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    } catch {
      return '';
    }
  }
}
