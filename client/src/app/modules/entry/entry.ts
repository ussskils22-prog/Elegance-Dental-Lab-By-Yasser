import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { CaseApiService } from '../../core/services/case-api.service';
import { SharedCasesService } from '../../core/services/shared-cases.service';
import { UserApiService } from '../../core/services/user-api.service';
import { mapApiCaseToDentalCase } from '../../core/mappers/dental-case-api.mapper';
import {
  buildCasePayloadFromPrintForm,
  buildPrintData,
  formatPrintDate,
  formatWorkTypeForPrint,
} from '../../core/utils/print-job.util';
import { Subscription, catchError, switchMap, of } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { SocketService } from '../../core/services/socket.service';
import { LocalPrintControlService } from '../../core/services/local-print-control.service';
import { ThemeService } from '../../core/services/theme.service';
import { LanguageService } from '../../core/i18n/language.service';
import { TPipe } from '../../core/i18n/t.pipe';
import { environment } from '../../../environments/environment';
import { ToothChartComponent } from '../../shared/tooth-chart/tooth-chart';
import { AppOverflowMenuComponent } from '../../shared/app-overflow-menu/app-overflow-menu';
import { ToothAssignment, countByMaterial } from '../../shared/tooth-chart/tooth-chart.types';

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
    doctor: '',
    patient: '',
    workType: '',
    workDetail: '',
    color: '',
    branch: '',
    quantity: 1,
    date: todayYmd(),
    caseType: 'New' as 'New' | 'Modification' | 'Redo' | 'Empty',
  };
}

export interface PrintJobCard {
  _id: string;
  printData: {
    doctor: string;
    patient: string;
    branch?: string;
    caseType: string;
    workType: string;
    workDetail: string;
    color: string;
    quantity: number;
    caseNumber: string;
    printDate: string;
    intakeType?: string;
  };
  status: 'pending' | 'printing' | 'done' | 'failed';
  paperConfirmed?: 'pending' | 'yes' | 'no';
  errorMessage?: string;
  createdAt: string;
}

@Component({
  selector: 'app-entry',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, ToothChartComponent, AppOverflowMenuComponent, TPipe],
  templateUrl: './entry.html',
  styleUrl: './entry.css',
})
export class EntryComponent implements OnInit, OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly caseApi = inject(CaseApiService);
  private readonly sharedCases = inject(SharedCasesService);
  private readonly userApi = inject(UserApiService);
  private readonly socketService = inject(SocketService);
  readonly localPrint = inject(LocalPrintControlService);
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  public readonly themeService = inject(ThemeService);
  public readonly lang = inject(LanguageService);

  private readonly apiBase = environment.apiUrl;
  private readonly socketSubs: Subscription[] = [];
  private jobsPollTimer: ReturnType<typeof setInterval> | null = null;
  private onVisibilityChange: (() => void) | null = null;

  readonly dialogOpen = signal(false);
  readonly saveInProgress = signal(false);
  readonly toast = signal<string | null>(null);
  readonly notificationsOpen = signal(false);
  readonly jobsLoading = signal(true);
  readonly showReceptionHub = signal(false);
  readonly printAgentOnline = signal<boolean | null>(null);
  private printAgentPollTimer: ReturnType<typeof setInterval> | null = null;

  isAdminUser(): boolean {
    return this.auth.getSession()?.role === 'admin';
  }

  // Today's print jobs list
  readonly printJobs = signal<PrintJobCard[]>([]);

  // Search filter
  readonly searchTerm = signal<string>('');

  readonly filteredJobs = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const jobs = this.printJobs();
    if (!term) return jobs;
    return jobs.filter(j =>
      (j.printData.doctor || '').toLowerCase().includes(term) ||
      (j.printData.patient || '').toLowerCase().includes(term) ||
      (j.printData.branch || '').toLowerCase().includes(term)
    );
  });

  readonly doneJobsCount = computed(() =>
    this.printJobs().filter(j => j.status === 'done' && j.paperConfirmed === 'yes').length
  );
  readonly awaitingConfirmCount = computed(() =>
    this.printJobs().filter(j => j.status === 'done' && (j.paperConfirmed || 'pending') !== 'yes').length
  );
  readonly pendingJobsCount = computed(() =>
    this.printJobs().filter(j => j.status === 'pending' || j.status === 'printing').length
  );
  readonly failedJobsCount = computed(() => this.printJobs().filter(j => j.status === 'failed').length);

  formDraft = emptyDraft();

  // Work type state
  readonly workTypeOptions = [
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

  selectedWorkTypes = new Set<string>();
  workTypeQuantities: Record<string, number> = {};
  nightGuardType: 'Soft' | 'Hard' | '' = '';
  workTypeError = '';
  patientWarning = '';
  intakeType: 'impression' | 'scan' | '' = '';
  selectedPlyFile: File | null = null;
  plyScanLink = '';
  toothAssignments: ToothAssignment[] = [];
  toothLinkMode: 'connected' | 'separate' = 'separate';
  activeToothMaterial = '';

  // Doctor autocomplete — اقتراحات من أكونتات الدكاترة فقط (الكتابة الحرة مسموحة)
  readonly accountDoctors = signal<string[]>([]);
  readonly showDoctorSuggestions = signal(false);
  readonly activeSuggestionIndex = signal(-1);
  private doctorSearchQuery = '';

  get filteredDoctors(): string[] {
    const doctors = [...this.accountDoctors()].sort((a, b) => a.localeCompare(b, 'ar'));
    const q = this.normalizeArabic(this.doctorSearchQuery);
    if (!q) return doctors.slice(0, 10);
    return doctors.filter((d) => this.normalizeArabic(d).includes(q));
  }

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
      error: () => this.accountDoctors.set([]),
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

  onPatientInputChange(): void {
    const name = (this.formDraft.patient || '').trim();
    if (!name) {
      this.patientWarning = '';
      return;
    }
    const parts = name.split(/\s+/).filter((p) => p);
    this.patientWarning =
      parts.length < 2 ? this.lang.t('form.patientDualWarning') : '';
  }

  onPlyFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      this.selectedPlyFile = null;
      return;
    }
    if (!/\.(ply|stl|obj|rar|zip)$/i.test(file.name)) {
      this.flash(this.lang.t('form.errFileType'));
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
    const el = document.getElementById('entryPlyInput') as HTMLInputElement | null;
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
      next: () => this.loadTodayJobs(),
      error: () => {
        this.flash(this.lang.t('entry.toast.saveFail'));
        this.loadTodayJobs();
      },
    });
  }

  onDoctorInputChange(): void {
    this.doctorSearchQuery = this.formDraft.doctor || '';
    this.activeSuggestionIndex.set(-1);
    this.showDoctorSuggestions.set(true);
  }

  onDoctorInputFocus(): void {
    this.doctorSearchQuery = this.formDraft.doctor || '';
    this.showDoctorSuggestions.set(true);
    this.activeSuggestionIndex.set(-1);
  }

  onDoctorInputBlur(): void {
    setTimeout(() => this.showDoctorSuggestions.set(false), 200);
  }

  selectDoctor(doc: string): void {
    this.formDraft.doctor = doc;
    this.doctorSearchQuery = doc;
    this.showDoctorSuggestions.set(false);
    this.activeSuggestionIndex.set(-1);
  }

  onDoctorInputKeydown(event: KeyboardEvent): void {
    const list = this.filteredDoctors;
    if (!this.showDoctorSuggestions() || list.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.activeSuggestionIndex.set((this.activeSuggestionIndex() + 1) % list.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.activeSuggestionIndex.set((this.activeSuggestionIndex() - 1 + list.length) % list.length);
    } else if (event.key === 'Enter') {
      const idx = this.activeSuggestionIndex();
      if (idx >= 0 && idx < list.length) {
        event.preventDefault();
        this.selectDoctor(list[idx]);
      }
    } else if (event.key === 'Escape') {
      this.showDoctorSuggestions.set(false);
    }
  }

  // Work type logic
  onCaseTypeChange(): void {
    if (this.formDraft.caseType === 'Empty') {
      this.selectedWorkTypes.clear();
      this.workTypeQuantities = {};
      this.nightGuardType = '';
      this.formDraft.workType = 'Empty';
      this.formDraft.quantity = 0;
      this.toothAssignments = [];
      this.activeToothMaterial = '';
    } else {
      this.updateWorkTypeString();
    }
  }

  toggleWorkType(type: string): void {
    this.workTypeError = '';
    if (this.selectedWorkTypes.has(type)) {
      this.selectedWorkTypes.delete(type);
      delete this.workTypeQuantities[type];
      if (type === 'Night Guard') this.nightGuardType = '';
      this.toothAssignments = this.toothAssignments.filter((t) => t.material !== type);
      if (this.activeToothMaterial === type) {
        this.activeToothMaterial = this.chartMaterials[0] || '';
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
      } else {
        this.selectedWorkTypes.delete('Empty');
        delete this.workTypeQuantities['Empty'];
        this.selectedWorkTypes.add(type);
        this.workTypeQuantities[type] = 1;
        if (type === 'Night Guard') this.nightGuardType = 'Soft';
        if (!this.activeToothMaterial) this.activeToothMaterial = type;
      }
    }
    this.updateWorkTypeString();
  }

  isWorkTypeSelected(type: string): boolean {
    return this.selectedWorkTypes.has(type);
  }

  get hasWorkTypesWithQuantity(): boolean {
    for (const wt of this.selectedWorkTypes) {
      if (wt !== 'Remake' && wt !== 'Empty') return true;
    }
    return false;
  }

  get chartMaterials(): string[] {
    return [...this.selectedWorkTypes].filter((wt) => wt !== 'Remake' && wt !== 'Empty');
  }

  onToothAssignmentsChange(list: ToothAssignment[]): void {
    this.toothAssignments = list || [];
    const counts = countByMaterial(this.toothAssignments);
    for (const [mat, n] of Object.entries(counts)) {
      if (this.selectedWorkTypes.has(mat) && n > 0) {
        this.workTypeQuantities[mat] = n;
      }
    }
    for (const wt of this.selectedWorkTypes) {
      if (wt === 'Remake' || wt === 'Empty') continue;
      if (!(wt in counts) && (this.workTypeQuantities[wt] == null || this.workTypeQuantities[wt] < 1)) {
        this.workTypeQuantities[wt] = 1;
      }
    }
    this.updateWorkTypeString();
  }

  onActiveToothMaterialChange(mat: string): void {
    this.activeToothMaterial = mat || '';
  }

  onToothLinkModeChange(mode: 'connected' | 'separate'): void {
    this.toothLinkMode = mode;
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
    for (const wt of this.selectedWorkTypes) {
      const q = Number(this.workTypeQuantities[wt]) || 1;
      total += q;
      let displayName = wt;
      if (wt === 'Night Guard') {
        displayName = this.nightGuardType ? `Night Guard ${this.nightGuardType}` : 'Night Guard';
      }
      if (this.selectedWorkTypes.size > 1 || q > 1) {
        parts.push(`${displayName} (${q})`);
      } else {
        parts.push(displayName);
      }
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

  private sortJobs(jobs: PrintJobCard[]): PrintJobCard[] {
    const rank = (j: PrintJobCard) => {
      if (j.status === 'failed') return 0;
      if (j.status === 'done' && (j.paperConfirmed || 'pending') !== 'yes') return 1;
      if (j.status === 'printing' || j.status === 'pending') return 2;
      return 3;
    };
    return [...jobs].sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }

  private loadTodayJobs(opts?: { silent?: boolean }): void {
    if (!opts?.silent) this.jobsLoading.set(true);
    this.http.get<{ success: boolean; jobs: PrintJobCard[] }>(`${this.apiBase}/print/jobs/today`).subscribe({
      next: res => {
        if (res.success) this.printJobs.set(this.sortJobs(res.jobs));
        this.jobsLoading.set(false);
      },
      error: () => this.jobsLoading.set(false),
    });
  }

  ngOnInit(): void {
    const role = this.auth.getSession()?.role;
    this.showReceptionHub.set(role === 'secretary' || role === 'admin');
    this.loadAccountDoctors();
    this.startPrintAgentStatusWatch();

    // Load cases (for list context / shared state)
    this.caseApi.getAllCases(1, 1500).subscribe({
      next: res => {
        const rows = (res?.data ?? []) as Record<string, unknown>[];
        if (Array.isArray(rows)) {
          this.sharedCases.setCasesFromServer(rows.map(r => mapApiCaseToDentalCase(r)));
        }
      },
      error: () => {}
    });

    // Load today's print jobs
    this.loadTodayJobs();

    // Poll so jobs still appear if the agent PC slept or the socket missed events
    this.jobsPollTimer = setInterval(() => this.loadTodayJobs({ silent: true }), 30000);

    this.onVisibilityChange = () => {
      if (document.visibilityState === 'visible') this.loadTodayJobs({ silent: true });
    };
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    // Real-time print jobs (via SocketService — never bind to a discarded socket)
    this.socketService.connect();
    this.socketSubs.push(
      this.socketService.onPrintJobCreated().subscribe((job: PrintJobCard & { jobId?: string }) => {
        const normalized: PrintJobCard = {
          ...job,
          _id: job._id || job.jobId || '',
        };
        if (!normalized._id) return;
        this.printJobs.update((jobs) => {
          if (jobs.some((j) => j._id === normalized._id)) return jobs;
          return this.sortJobs([...jobs, normalized]);
        });
      }),
      this.socketService.onPrintJobStatusUpdated().subscribe(
        (data: {
          jobId: string;
          status: string;
          paperConfirmed?: PrintJobCard['paperConfirmed'];
          errorMessage?: string;
        }) => {
          if (!data?.jobId) return;
          this.printJobs.update((jobs) =>
            this.sortJobs(
              jobs.map((j) =>
                j._id === data.jobId
                  ? {
                      ...j,
                      status: data.status as PrintJobCard['status'],
                      paperConfirmed: data.paperConfirmed ?? j.paperConfirmed,
                      errorMessage: data.errorMessage ?? j.errorMessage,
                    }
                  : j
              )
            )
          );
        }
      ),
      this.socketService.onPrintJobDeleted().subscribe((data: { jobId: string }) => {
        if (!data?.jobId) return;
        this.printJobs.update((jobs) => jobs.filter((j) => j._id !== data.jobId));
      }),
      this.socketService.onPrintAllJobsCleared().subscribe(() => {
        this.printJobs.set([]);
      })
    );
  }

  ngOnDestroy(): void {
    this.socketSubs.forEach(s => s.unsubscribe());
    if (this.jobsPollTimer) {
      clearInterval(this.jobsPollTimer);
      this.jobsPollTimer = null;
    }
    if (this.printAgentPollTimer) {
      clearInterval(this.printAgentPollTimer);
      this.printAgentPollTimer = null;
    }
    if (this.onVisibilityChange) {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
      this.onVisibilityChange = null;
    }
  }

  private startPrintAgentStatusWatch(): void {
    this.socketService.connect();
    this.refreshPrintAgentStatus();
    void this.localPrint.refresh();
    this.printAgentPollTimer = setInterval(() => {
      this.refreshPrintAgentStatus();
      void this.localPrint.refresh();
    }, 10000);
    this.socketSubs.push(
      this.socketService.onPrintAgentStatus().subscribe((evt) => {
        if (evt && typeof evt.online === 'boolean') {
          this.printAgentOnline.set(evt.online);
        }
      })
    );
  }

  private refreshPrintAgentStatus(): void {
    this.http
      .get<{ success?: boolean; online?: boolean }>(`${this.apiBase}/print/agent-status`)
      .subscribe({
        next: (res) => this.printAgentOnline.set(Boolean(res?.online)),
        error: () => {},
      });
  }

  async startLocalPrinting(): Promise<void> {
    const st = await this.localPrint.start();
    if (!st.reachable) {
      this.flash(this.lang.t('print.controlUnavailable'));
      return;
    }
    this.flash(this.lang.t('print.startedToast'));
    setTimeout(() => this.refreshPrintAgentStatus(), 1500);
  }

  async stopLocalPrinting(): Promise<void> {
    const st = await this.localPrint.stop();
    if (!st.reachable && this.localPrint.lastError() === 'unreachable') {
      this.flash(this.lang.t('print.controlUnavailable'));
      return;
    }
    this.printAgentOnline.set(false);
    this.flash(this.lang.t('print.stoppedToast'));
  }

  openDialog(): void {
    this.formDraft = emptyDraft();
    this.selectedWorkTypes.clear();
    this.workTypeQuantities = {};
    this.workTypeError = '';
    this.nightGuardType = '';
    this.patientWarning = '';
    this.intakeType = '';
    this.toothAssignments = [];
    this.activeToothMaterial = '';
    this.toothLinkMode = 'separate';
    this.plyScanLink = '';
    this.clearPlySelection();
    this.dialogOpen.set(true);
  }

  closeDialog(): void {
    this.dialogOpen.set(false);
    this.plyScanLink = '';
    this.clearPlySelection();
  }

  save(): void {
    const d = this.formDraft;

    if (!d.doctor.trim()) { this.flash(this.lang.t('form.errDoctor')); return; }
    if (!d.patient?.trim()) { this.flash(this.lang.t('form.errPatient')); return; }
    const patientParts = d.patient.trim().split(/\s+/).filter((p) => p);
    if (patientParts.length < 2) {
      this.patientWarning = this.lang.t('form.patientDualWarning');
      this.flash(this.lang.t('form.errPatientDual'));
      return;
    }
    if (!d.branch?.trim()) { this.flash(this.lang.t('form.errBranch')); return; }
    if (!this.intakeType) {
      this.flash(this.lang.t('form.errIntake'));
      return;
    }
    if (this.intakeType === 'scan' && this.plyScanLink.trim() && !this.isValidScanLink(this.plyScanLink)) {
      this.flash(this.lang.t('form.errScanLink'));
      return;
    }
    if (d.caseType !== 'Empty' && this.selectedWorkTypes.size === 0) {
      this.workTypeError = this.lang.t('form.errWorkTypeAtLeast');
      this.flash(this.lang.t('form.errWorkType'));
      return;
    }

    this.updateWorkTypeString();
    const draft = {
      doctor: d.doctor.trim(),
      patient: d.patient.trim(),
      branch: d.branch.trim(),
      caseType: d.caseType,
      workType: d.workType.trim(),
      workDetail: (d.workDetail || '').trim(),
      color: (d.color || '').trim(),
      quantity: d.caseType === 'Empty' ? 0 : (d.quantity || 1),
      date: d.date,
      intakeType: (this.intakeType === 'scan' || this.intakeType === 'impression'
        ? this.intakeType
        : undefined) as 'impression' | 'scan' | undefined,
      teeth: this.toothAssignments.length ? this.toothAssignments : undefined,
    };
    const ply = this.intakeType === 'scan' ? this.selectedPlyFile : null;
    const plyLink = this.intakeType === 'scan' && !ply ? this.plyScanLink.trim() : '';

    this.closeDialog();
    this.saveInProgress.set(true);

    this.caseApi
      .createCase(buildCasePayloadFromPrintForm(draft, { entrySource: 'print' }))
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
            this.printAgentOnline() === false
              ? this.lang.t('entry.toast.savedOffline')
              : this.lang.t('entry.toast.saved')
          );
          this.loadTodayJobs();
        },
        error: () => {
          this.saveInProgress.set(false);
          this.flash(this.lang.t('entry.toast.saveFail'));
        },
      });
  }

  logout(): void {
    this.auth.performLogout(this.router);
  }

  toggleNotifications(e: Event): void {
    e.stopPropagation();
    this.notificationsOpen.update(v => !v);
  }

  private flash(msg: string): void {
    this.toast.set(msg);
    setTimeout(() => this.toast.set(null), 3500);
  }

  formatWorkTypeForDisplay(wt: string): string {
    return formatWorkTypeForPrint(wt);
  }

  formatTime(dateStr: string): string {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }

  formatDate(dateStr: string): string {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
  }

  needsPaperConfirm(job: PrintJobCard): boolean {
    return job.status === 'done' && (job.paperConfirmed || 'pending') !== 'yes';
  }

  getStatusLabel(jobOrStatus: PrintJobCard | string): string {
    if (typeof jobOrStatus === 'string') {
      switch (jobOrStatus) {
        case 'pending': return this.lang.t('entry.status.pending');
        case 'printing': return this.lang.t('entry.status.printing');
        case 'done': return this.lang.t('entry.status.done');
        case 'failed': return this.lang.t('entry.status.failed');
        default: return jobOrStatus;
      }
    }
    const job = jobOrStatus;
    if (job.status === 'done' && job.paperConfirmed === 'yes') return this.lang.t('entry.status.confirmed');
    if (job.status === 'done') return this.lang.t('entry.status.awaitingPaper');
    if (job.status === 'failed' && job.paperConfirmed === 'no') return this.lang.t('entry.status.notPrinted');
    switch (job.status) {
      case 'pending': return this.lang.t('entry.status.pending');
      case 'printing': return this.lang.t('entry.status.printing');
      case 'failed': return this.lang.t('entry.status.failed');
      default: return job.status;
    }
  }

  getStatusColor(jobOrStatus: PrintJobCard | string): string {
    if (typeof jobOrStatus === 'string') {
      switch (jobOrStatus) {
        case 'pending': return 'status-pending';
        case 'printing': return 'status-printing';
        case 'done': return 'status-done';
        case 'failed': return 'status-failed';
        default: return '';
      }
    }
    const job = jobOrStatus;
    if (job.status === 'done' && job.paperConfirmed === 'yes') return 'status-done';
    if (job.status === 'done') return 'status-awaiting';
    if (job.status === 'failed') return 'status-failed';
    if (job.status === 'printing') return 'status-printing';
    return 'status-pending';
  }

  confirmPaper(job: PrintJobCard, confirmed: boolean): void {
    const msg = (confirmed
      ? this.lang.t('entry.confirmPaperOut')
      : this.lang.t('entry.confirmPaperFail')
    ).replace('{patient}', job.printData.patient);
    if (!confirm(msg)) return;

    this.http
      .patch<{ success: boolean; job?: PrintJobCard; message?: string }>(
        `${this.apiBase}/print/job/${job._id}/confirm`,
        { confirmed }
      )
      .subscribe({
        next: (res) => {
          if (res.job) {
            this.printJobs.update((jobs) =>
              this.sortJobs(jobs.map((j) => (j._id === job._id ? { ...j, ...res.job } : j)))
            );
          } else {
            this.loadTodayJobs({ silent: true });
          }
          this.flash(
            confirmed
              ? this.lang.t('entry.toast.paperConfirmed')
              : this.lang.t('entry.toast.paperNotPrinted')
          );
        },
        error: () => this.flash(this.lang.t('entry.toast.confirmFail')),
      });
  }

  /** Reprint via Print Agent only (same path/format as doctor request link). Never browser-print. */
  reprintJob(job: PrintJobCard): void {
    this.http
      .post(`${this.apiBase}/print/job`, {
        printData: { ...job.printData, printDate: formatPrintDate() },
      })
      .subscribe({
        next: () => {
          this.flash(
            this.printAgentOnline() === false
              ? this.lang.t('entry.toast.savedOffline')
              : this.lang.t('entry.toast.reprinted')
          );
          this.loadTodayJobs();
        },
        error: () => this.flash(this.lang.t('entry.toast.reprintFail')),
      });
  }

  deleteJob(jobId: string): void {
    if (!confirm(this.lang.t('entry.confirmDelete'))) return;
    this.http.delete<{ success: boolean }>(`${this.apiBase}/print/job/${jobId}`).subscribe({
      next: () => {
        this.printJobs.update(jobs => jobs.filter(j => j._id !== jobId));
        this.flash(this.lang.t('entry.toast.deleted'));
      },
      error: () => this.flash(this.lang.t('entry.toast.deleteFail')),
    });
  }

  clearAllJobs(): void {
    if (!confirm(this.lang.t('entry.confirmClearAll'))) return;
    this.http.delete<{ success: boolean }>(`${this.apiBase}/print/jobs/all`).subscribe({
      next: () => {
        this.printJobs.set([]);
        this.flash(this.lang.t('entry.toast.cleared'));
      },
      error: () => this.flash(this.lang.t('entry.toast.clearFail')),
    });
  }
}
