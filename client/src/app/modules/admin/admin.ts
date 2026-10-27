import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule, ActivatedRoute } from '@angular/router';
import { AppRole } from '../../core/auth/auth.types';
import { type ClientAccountKind } from '../../core/auth/client-account';
import type { TranslationKey } from '../../core/i18n/translations';
import { AdminDashboardService } from '../../core/services/admin-dashboard.service';
import { AuthService } from '../../core/services/auth.service';
import { UserApiService } from '../../core/services/user-api.service';
import { CaseApiService } from '../../core/services/case-api.service';
import { AiApiService } from '../../core/services/ai-api.service';
import { MonthArchiveApiService } from '../../core/services/month-archive-api.service';
import { Subject, merge } from 'rxjs';
import { debounceTime, filter, takeUntil } from 'rxjs/operators';
import { SocketService } from '../../core/services/socket.service';
import { ThemeService } from '../../core/services/theme.service';
import { LanguageService } from '../../core/i18n/language.service';
import { TPipe } from '../../core/i18n/t.pipe';
import { environment } from '../../../environments/environment';
import {
  LabConfigService,
  LabMaterial,
  LabBranding,
  LabWorkflow,
} from '../../core/services/lab-config.service';
import { FinancePanel } from './finance-panel/finance-panel';
import {
  isExcludedWorkPart,
  isWholeCaseExcluded,
  splitNormalizedCaseTypeParts,
} from '../../core/utils/case-type-parts.util';
import { ExocadApiService, ExocadDoctorMapping } from '../../core/services/exocad-api.service';

export interface StaffMember {
  id: string;
  name: string;
  email: string;
  password: string;
  /** Plaintext copy for admin display (doctors only). */
  loginPasswordVisible?: string;
  phone: string;
  position: string;
  status: 'active' | 'inactive';
  joinDate: string;
}

export interface PatientCase {
  id: string;
  caseNumber: string;
  patientName: string;
  doctorName: string;
  clinic: string;
  stage: string;
  payment: string;
}

export interface AdminCaseRow {
  id: string;
  caseNumber: string;
  patientName: string;
  assignedTo: string | null;
  requesterType?: 'doctor' | 'student' | 'lab';
  doctor?: string;
  doctorName?: string;
  clinic?: string;
  currentStage: string;
  priority: string;
  receivedDateDisplay?: string;
  receivedAt?: Date;
  deliveryDateDisplay?: string;
  dueDateDisplay: string;
  exitedAtDisplay?: string;
  caseType: string;
  salary: number;
  paid?: boolean;
  enteredBy?: string;
  secretaryName?: string;
  designerName?: string;
  finisherName?: string;
  secretaryInstructions?: string;
  designNotes?: string;
  source: 'shared' | 'case';
  // حقول إضافية من metadata
  color?: string;
  quantity?: number;
  deliveryDate?: string;
  deliveryTime?: string;
  rawNotes?: string;
  exitedAt?: Date;  // تاريخ الخروج الفعلي من stageTimestamps
}

export interface MonthlyDoctorSummary {
  doctorName: string;
  cases: number;
  totalSalary: number;
  paidCases: number;
  paidAmount: number;
}

export interface MonthlyFinancialSummary {
  monthKey: string;
  monthLabel: string;
  monthNumber: number;
  year: number;
  cases: number;
  totalSalary: number;
  paidCases: number;
  paidTotal: number;
  unpaidTotal: number;
  byDoctor: MonthlyDoctorSummary[];
}

export interface YearlyFinancialSummary {
  year: number;
  totalCases: number;
  paidCases: number;
  totalAmount: number;
  paidAmount: number;
  months: MonthlyFinancialSummary[];
}

export interface DoctorCaseRecord {
  id: string;
  caseNumber: string;
  patientName: string;
  caseType: string;
  receivedDate: string;
  exitedDate: string;
  stage: string;
  salary: number;
  dbSalary: number;
  paid: boolean;
}

export interface AdminPatient {
  id: string;
  name: string;
  email: string;
  phone: string;
  createdAt: Date;
  dateOfBirth: string;
  address: string;
}

export interface AiChatMessage {
  role: 'user' | 'assistant';
  text: string;
  createdAt: Date;
}

@Component({
  selector: 'app-admin',
  imports: [CommonModule, FormsModule, RouterModule, FinancePanel, TPipe],
  templateUrl: './admin.html',
  styleUrl: './admin.css',
  standalone: true
})
export class Admin implements OnInit, OnDestroy {
  private salaryDrafts: Record<string, string> = {};
  private salarySavingByCaseId: Record<string, boolean> = {};
  activeNav = 'dashboard';
  sidebarOpen = true;
  showStaffPassword = false;
  showStaffModal = false;
  staffModalError = '';
  staffSaving = false;
  staffLoadError = '';
  isEditMode = false;
  searchTerm = '';
  globalSearch = '';
  reportSearch = '';
  
  private _reportDoctorFilter = '';
  get reportDoctorFilter(): string {
    return this._reportDoctorFilter;
  }
  set reportDoctorFilter(val: string) {
    this._reportDoctorFilter = val;
    if (val) {
      this.reportSearch = '';
      this.loadCustomPricesForDoctor(val);
    }
  }

  paymentFilter: 'all' | 'paid' | 'unpaid' = 'all';

  doctorPricingsMap = new Map<string, any>();
  
  customEmaxPrice = 1000;
  customGermanZirconPrice = 850;
  customZirconPrice = 700;
  customTitaniumPrice = 2200;
  customPeekPrice = 1700;
  customPmmaPrice = 250;
  customNightGuardPrice = 300;
  customMockupPrice = 250;
  customWaxPrice = 0;
  customRingPrice = 0;
  customTryInPrice = 0;
  /** Dynamic per-doctor price overrides keyed by Material.key */
  customPricesMap: Record<string, number> = {};
  labMaterials: LabMaterial[] = [];
  labBranding: LabBranding = {
    labName: 'Elegance Dental Lab',
    logoUrl: '',
    primaryColor: '#2563eb',
  };
  labWorkflow: LabWorkflow = {
    enabledStages: [
      'waiting',
      'secretary',
      'design',
      'khart',
      'finishing',
      'completed',
      'exited',
    ],
    allowSkipSecretary: true,
    allowSkipKhart: true,
    allStages: [
      'waiting',
      'secretary',
      'design',
      'khart',
      'finishing',
      'completed',
      'exited',
    ],
  };
  labDefaultPrices: Record<string, number> = {};
  labMsg = '';
  labSaving = false;
  matSaving = false;
  matMsgError = false;
  matDraft: Partial<LabMaterial> = {
    label: '',
    key: '',
    defaultPrice: 0,
    matchKeywords: [],
    sortOrder: 100,
  };
  matKeywordsText = '';
  matMsg = '';
  readonly stageLabelsAr: Record<string, string> = {
    waiting: 'انتظار',
    secretary: 'سكرتارية',
    design: 'ديزاين',
    khart: 'خرط',
    finishing: 'فينيش',
    completed: 'منتهية',
    exited: 'خارجة',
  };

  currentPrintDate = new Date();

  pricingSaveSuccess = false;
  pricingSaveError = '';
  isPricingSaving = false;
  financialYearFilter = '';
  financialMonthFilter = '';
  financePanelYear = new Date().getFullYear();
  financePanelMonth = new Date().getMonth() + 1;
  financialDoctorSearch = '';
  reportYearFilter = String(new Date().getFullYear());
  reportMonthFilter = String(new Date().getMonth() + 1);
  /** Admin dashboard material counters — default current calendar month */
  dashYearFilter = String(new Date().getFullYear());
  dashMonthFilter = String(new Date().getMonth() + 1);
  aiYearFilter = '';
  aiMonthFilter = '';
  archiveYearFilter = String(new Date().getFullYear());
  archiveMonthFilter = String(new Date().getMonth() + 1);
  archiveConfirm = '';
  archiveLoading = false;
  archiveClosing = false;
  archiveError = '';
  archiveSuccess = '';
  archiveList: any[] = [];
  selectedDoctorName = '';
  showDoctorDetailsModal = false;
  financialSaveError = '';
  studentReportSearch = '';
  aiQuestion = '';
  aiLoading = false;
  aiError = '';
  aiMessages: AiChatMessage[] = [
    {
      role: 'assistant',
      text:
        'أنا مساعد المعمل الذكي. اسألني عن أي شيء:\n' +
        '• ملخص المعمل • كام حالة في التصميم؟ • حالات متأخرة • حالات محتاجة تعديل\n' +
        '• كام أرباح الشهر ده؟ • أعلى 5 دكاترة • غير المدفوعة\n' +
        '• ابحث برقم الحالة أو اسم المريض أو الدكتور\n' +
        '• الموظفين • الطباعة • اكتب "مساعدة" لكل الأوامر',
      createdAt: new Date(),
    },
  ];

  patientCases: PatientCase[] = [];
  patients: AdminPatient[] = [];
  adminCases: AdminCaseRow[] = [];
  reportCases: AdminCaseRow[] = [];
  /** Live DB stats for dashboard counters (all exited cases) */
  materialStats: Record<string, any> = {
    emax: 0,
    regularZircon: 0,
    germanZircon: 0,
    titanium: 0,
    peek: 0,
    pmma: 0,
    nightGuard: 0,
    mokup: 0,
    tryIn: 0,
    wax: 0,
    ring: 0,
    zircon: 0,
    jundiEmax: 0,
    jundiRegularZircon: 0,
    jundiGermanZircon: 0,
    jundiTitanium: 0,
    jundiPeek: 0,
    jundiZircon: 0,
  };
  doctorPayments: any[] = [];
  newPaymentAmount: number | null = null;
  newChargeAmount: number | null = null;
  newChargeNotes = '';
  chargeSaving = false;
  chargeError = '';
  newPaymentNotes = '';
  paymentSaving = false;
  paymentError = '';
  selectedPatient: AdminPatient | null = null;
  selectedCase: AdminCaseRow | null = null;
  selectedReportCase: AdminCaseRow | null = null;
  currentPage = 1;
  pageSize = 20;
  private destroy$ = new Subject<void>();

  private readonly userNameMap: Record<string, string> = {
    'sec-1': 'Secretary 1',
    'des-1': 'Designer 1',
    'des-2': 'Designer 2',
    'fin-1': 'Finisher 1',
    'fin-2': 'Finisher 2'
  };

  constructor(
    private caseApi: CaseApiService,
    private aiApi: AiApiService,
    private monthArchiveApi: MonthArchiveApiService,
    private adminDashboardService: AdminDashboardService,
    private auth: AuthService,
    private userApi: UserApiService,
    private router: Router,
    private route: ActivatedRoute,
    private socketService: SocketService,
    private http: HttpClient,
    public themeService: ThemeService,
    public lang: LanguageService,
    private labConfig: LabConfigService
  ) {}

  logout(): void {
    this.auth.performLogout(this.router);
  }

  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
  }

  get sidebarUserName(): string {
    return this.auth.getSession()?.name?.trim() || 'SE Yasser';
  }

  get sidebarInitials(): string {
    const parts = this.sidebarUserName.split(/\s+/).filter(Boolean).slice(0, 2);
    const letters = parts.map((part) => part.charAt(0)).join('');
    return letters.toUpperCase() || 'SY';
  }

  ngOnInit(): void {
    this.restoreActiveNav();
    this.loadCasesFromApi();
    this.loadFinancialReportFromApi();
    this.loadDoctorPricings();
    this.loadStaffFromApi();
    this.loadLabConfig();
    this.loadDeliveryAlerts();
    if (this.activeNav === 'staff') {
      this.loadStaffFromApi();
    }
    this.connectCaseRealtime();
  }

  ngOnDestroy(): void {
    this.stopWaWebPoll();
    this.destroy$.next();
    this.destroy$.complete();
  }

  private connectCaseRealtime(): void {
    this.socketService.connect();

    // Delete: drop case locally + recompute counters immediately (don't wait for debounce)
    this.socketService
      .onCaseDeleted()
      .pipe(takeUntil(this.destroy$), filter((evt) => !!evt))
      .subscribe((evt: { caseId?: string }) => {
        const id = String(evt?.caseId || '');
        if (id) {
          this.adminCases = this.adminCases.filter((c) => c.id !== id);
          this.patients = this.buildPatientsFromCases(this.adminCases);
        }
        this.refreshMaterialStatsFromLocalCases();
        this.loadMaterialStats();
        this.loadCasesFromApi();
        this.loadFinancialReportFromApi();
      });

    merge(
      this.socketService.onCaseCreated(),
      this.socketService.onCaseAssigned(),
      this.socketService.onCaseReassigned(),
      this.socketService.onCaseMovedStage(),
      this.socketService.onCaseCompleted(),
      this.socketService.onCaseReleased(),
      this.socketService.onCaseUpdated()
    )
      .pipe(
        takeUntil(this.destroy$),
        filter((evt) => !!evt),
        debounceTime(8000)
      )
      .subscribe(() => {
        this.loadCasesFromApi();
        this.loadFinancialReportFromApi();
      });
  }

  staffMembers: StaffMember[] = [];
  doctorMembers: StaffMember[] = [];
  studentMembers: StaffMember[] = [];
  labMembers: StaffMember[] = [];
  doctorSearchTerm = '';
  doctorLoadError = '';
  showDoctorModal = false;
  isDoctorEditMode = false;
  doctorSaving = false;
  doctorModalError = '';
  showDoctorPassword = false;

  /** Exocad doctor name mappings (admin) */
  exocadDoctorMappings: ExocadDoctorMapping[] = [];
  exocadMapInternalName = '';
  exocadMapExocadNames = '';
  exocadMapMessage = '';
  private readonly exocadApi = inject(ExocadApiService);
  currentDoctor: StaffMember = {
    id: '',
    name: '',
    email: '',
    password: '',
    phone: '',
    position: 'دكتور',
    status: 'active',
    joinDate: new Date().toISOString().split('T')[0],
  };

  currentStaff: StaffMember = {
    id: '',
    name: '',
    email: '',
    password: '',
    phone: '',
    position: '',
    status: 'active',
    joinDate: new Date().toISOString().split('T')[0],
  };

  readonly positions = [
    'سكرتير',
    'مدير',
    'سكان 1',
    'سكان 2',
    'سكان 3',
  ] as const;

  get filteredStaff(): StaffMember[] {
    const staffOnly = this.staffMembers.filter(
      (s) => s.position !== 'دكتور' && s.position !== 'طالب' && s.position !== 'معمل'
    );
    if (!this.searchTerm.trim()) return staffOnly;
    const search = this.searchTerm.toLowerCase();
    return staffOnly.filter(
      (staff) =>
        staff.name.toLowerCase().includes(search) ||
        staff.email.toLowerCase().includes(search) ||
        staff.phone.includes(search)
    );
  }

  get filteredDoctors(): StaffMember[] {
    return this.filteredDirectoryMembers;
  }

  isClientDirectoryNav(): boolean {
    return this.activeNav === 'doctors' || this.activeNav === 'students' || this.activeNav === 'labs';
  }

  get clientDirectoryKind(): ClientAccountKind {
    if (this.activeNav === 'students') return 'student';
    if (this.activeNav === 'labs') return 'lab';
    return 'doctor';
  }

  private clientDirPrefix(): 'admin.doctors' | 'admin.students' | 'admin.labs' {
    if (this.clientDirectoryKind === 'student') return 'admin.students';
    if (this.clientDirectoryKind === 'lab') return 'admin.labs';
    return 'admin.doctors';
  }

  tDir(suffix: string): TranslationKey {
    const mapped = suffix === 'role' && this.clientDirectoryKind === 'doctor' ? 'roleDoctor' : suffix;
    return `${this.clientDirPrefix()}.${mapped}` as TranslationKey;
  }

  private directoryMembers(): StaffMember[] {
    if (this.clientDirectoryKind === 'student') return this.studentMembers;
    if (this.clientDirectoryKind === 'lab') return this.labMembers;
    return this.doctorMembers;
  }

  get filteredDirectoryMembers(): StaffMember[] {
    const members = this.directoryMembers();
    if (!this.doctorSearchTerm.trim()) return members;
    const search = this.doctorSearchTerm.toLowerCase();
    return members.filter(
      (d) =>
        d.name.toLowerCase().includes(search) ||
        d.email.toLowerCase().includes(search) ||
        d.phone.includes(search)
    );
  }

  /** إجمالي أكونتات الدكاترة المسجّلة */
  get doctorAccountsCount(): number {
    return this.directoryMembers().length;
  }

  private clientPositionLabel(): string {
    if (this.clientDirectoryKind === 'student') return 'طالب';
    if (this.clientDirectoryKind === 'lab') return 'معمل';
    return 'دكتور';
  }

  get filteredCases(): AdminCaseRow[] {
    const sortedCases = [...this.adminCases].sort(
      (a, b) => this.getCaseTimestamp(b) - this.getCaseTimestamp(a)
    );
    if (!this.globalSearch.trim()) return sortedCases;
    const search = this.globalSearch.toLowerCase();
    return sortedCases.filter(c =>
      c.caseNumber.toLowerCase().includes(search) ||
      c.patientName.toLowerCase().includes(search) ||
      (c.assignedTo?.toLowerCase().includes(search) || false) ||
      c.caseType.toLowerCase().includes(search)
    );
  }

  get completedCases(): AdminCaseRow[] {
    return this.adminCases.filter(c => 
      c.currentStage === 'completed' || 
      c.currentStage === 'finished' || 
      c.currentStage === 'exited'
    );
  }

  get studentCases(): AdminCaseRow[] {
    return this.adminCases.filter(c => c.requesterType === 'student');
  }

  get studentReportCases(): AdminCaseRow[] {
    const search = this.studentReportSearch.trim().toLowerCase();
    const list = this.studentCases.filter((c) => {
      if (!search) return true;
      return [c.caseNumber, c.patientName, c.doctorName || '', c.currentStage, c.caseType]
        .some((v) => String(v || '').toLowerCase().includes(search));
    });
    return [...list].sort((a, b) => this.getCaseTimestamp(b) - this.getCaseTimestamp(a));
  }

  get studentFinancialSummary(): {
    totalCases: number;
    paidCases: number;
    unpaidCases: number;
    totalAmount: number;
    paidAmount: number;
    unpaidAmount: number;
  } {
    return this.studentCases.reduce(
      (acc, c) => {
        const salary = Number(c.salary || 0);
        acc.totalCases += 1;
        acc.totalAmount += salary;
        if (c.paid) {
          acc.paidCases += 1;
          acc.paidAmount += salary;
        } else {
          acc.unpaidCases += 1;
          acc.unpaidAmount += salary;
        }
        return acc;
      },
      {
        totalCases: 0,
        paidCases: 0,
        unpaidCases: 0,
        totalAmount: 0,
        paidAmount: 0,
        unpaidAmount: 0,
      }
    );
  }

  private matchesReportPeriod(c: AdminCaseRow): boolean {
    if (!this.reportYearFilter && !this.reportMonthFilter) return true;
    // Exited-case reports must use exit date only (never create/receive date)
    const d = c.exitedAt;
    if (!d) return false;
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return false;
    if (this.reportYearFilter && dt.getFullYear() !== Number(this.reportYearFilter)) return false;
    if (this.reportMonthFilter && dt.getMonth() + 1 !== Number(this.reportMonthFilter)) return false;
    return true;
  }

  private matchesPaymentPeriod(p: { paymentDate?: unknown; createdAt?: unknown }): boolean {
    if (!this.reportYearFilter && !this.reportMonthFilter) return true;
    const raw = p.paymentDate || p.createdAt;
    if (!raw) return false;
    const dt = raw instanceof Date ? raw : new Date(String(raw));
    if (Number.isNaN(dt.getTime())) return false;
    if (this.reportYearFilter && dt.getFullYear() !== Number(this.reportYearFilter)) return false;
    if (this.reportMonthFilter && dt.getMonth() + 1 !== Number(this.reportMonthFilter)) return false;
    return true;
  }

  get reportFilteredCases(): AdminCaseRow[] {
    const search = this.reportSearch.toLowerCase().trim();
    return this.reportCases.filter(c => {
      let match = this.matchesReportPeriod(c);
      if (search) {
        match = match && [c.caseNumber, c.patientName, c.doctorName || c.assignedTo || '', c.currentStage]
          .some(value => value?.toLowerCase().includes(search));
      }
      if (this.reportDoctorFilter) {
        const name = this.normalizeDoctorName(c.doctorName || c.assignedTo || 'غير محدد');
        const key = this.doctorGroupKey(name);
        const filterKey = this.doctorGroupKey(this.reportDoctorFilter);
        match = match && (key === filterKey);
      }
      if (this.paymentFilter === 'paid') {
        match = match && c.paid === true;
      }
      if (this.paymentFilter === 'unpaid') {
        match = match && !c.paid;
      }
      return match;
    });
  }

  get reportDoctors(): string[] {
    const doctors = new Map<string, string>();
    this.reportCases.forEach(c => {
      const name = this.normalizeDoctorName(c.doctorName || c.assignedTo || 'غير محدد');
      const key = this.doctorGroupKey(name);
      if (!doctors.has(key)) {
        doctors.set(key, name);
      }
    });
    return Array.from(doctors.values()).sort((a, b) => a.localeCompare(b));
  }

  get doctorReportSummaries() {
    const doctorMap = new Map<string, {
      doctorName: string;
      totalCases: number;
      totalDue: number;
      totalPaid: number;
      remaining: number;
      paidFromCases: number;
    }>();

    this.reportCases.forEach(c => {
      if (String(c.currentStage) !== 'exited') return;
      if (!this.matchesReportPeriod(c)) return;

      const name = this.normalizeDoctorName(c.doctorName || c.assignedTo || 'غير محدد');
      const key = this.doctorGroupKey(name);

      const cost = this.calculateCaseCost(c);
      // Unpaid: always prefer live custom prices (same as Doctor Accounts / Reports intent).
      // Paid: keep stored bill when present.
      const stored = Number((c as any).revenueAmount ?? c.salary ?? 0) || 0;
      const dueAmount = c.paid
        ? stored > 0
          ? stored
          : cost
        : cost > 0
          ? cost
          : stored;
      const paidFromCase = c.paid ? dueAmount : 0;

      if (!doctorMap.has(key)) {
        doctorMap.set(key, {
          doctorName: name,
          totalCases: 0,
          totalDue: 0,
          totalPaid: 0,
          remaining: 0,
          paidFromCases: 0,
        });
      }

      const docObj = doctorMap.get(key)!;
      docObj.totalCases += 1;
      docObj.totalDue += dueAmount;
      docObj.paidFromCases += paidFromCase;
    });

    // Include doctors who only have ledger entries (charges/payments) in THIS period
    this.doctorPayments.forEach((p) => {
      if (!this.matchesPaymentPeriod(p)) return;
      const name = this.normalizeDoctorName(p.doctorName || 'غير محدد');
      const key = this.doctorGroupKey(name);
      if (!doctorMap.has(key)) {
        doctorMap.set(key, {
          doctorName: name,
          totalCases: 0,
          totalDue: 0,
          totalPaid: 0,
          remaining: 0,
          paidFromCases: 0,
        });
      }
    });

    doctorMap.forEach((docObj, key) => {
      const ledger = this.doctorPayments.filter(
        (p) => this.doctorGroupKey(p.doctorName) === key && this.matchesPaymentPeriod(p)
      );
      // Case-linked payments are already counted via the case "paid" flag
      const paidFromPayments = ledger
        .filter((p) => this.isDoctorLedgerPayment(p) && !p.caseId)
        .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
      const charges = ledger
        .filter((p) => this.isDoctorLedgerCharge(p))
        .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
      docObj.totalDue += charges;
      // Case confirm-payment + account ledger payments both count (settling remaining must not wipe case-paid)
      docObj.totalPaid = docObj.paidFromCases + paidFromPayments;
      docObj.remaining = docObj.totalDue - docObj.totalPaid;
    });

    // Hide empty rows when a period is selected (no cases / payments / charges in that month)
    const periodScoped = !!(this.reportYearFilter || this.reportMonthFilter);
    const rows = Array.from(doctorMap.values()).filter((d) => {
      if (!periodScoped) return true;
      return d.totalCases > 0 || d.totalDue > 0 || d.totalPaid > 0;
    });

    return rows.sort((a, b) => a.doctorName.localeCompare(b.doctorName));
  }

  get filteredDoctorReportSummaries() {
    const search = this.reportSearch.toLowerCase().trim();
    return this.doctorReportSummaries
      .filter(d => {
        if (!search) return true;
        return d.doctorName.toLowerCase().includes(search);
      })
      .sort((a, b) => b.totalDue - a.totalDue);
  }

  get allDoctorsTotalDue(): number {
    return this.filteredDoctorReportSummaries.reduce((sum, d) => sum + d.totalDue, 0);
  }

  get allDoctorsTotalPaid(): number {
    return this.filteredDoctorReportSummaries.reduce((sum, d) => sum + d.totalPaid, 0);
  }

  get allDoctorsTotalRemaining(): number {
    return this.filteredDoctorReportSummaries.reduce((sum, d) => sum + d.remaining, 0);
  }

  get allDoctorsTotalCases(): number {
    return this.filteredDoctorReportSummaries.reduce((sum, d) => sum + d.totalCases, 0);
  }

  getDoctorTotalDue(doctorName: string): number {
    const summary = this.doctorReportSummaries.find(d => d.doctorName === doctorName);
    return summary ? summary.totalDue : 0;
  }

  getDoctorTotalPaid(doctorName: string): number {
    const summary = this.doctorReportSummaries.find(d => d.doctorName === doctorName);
    return summary ? summary.totalPaid : 0;
  }

  private monthLabel(date: Date): string {
    const months = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    return `${months[date.getMonth()]} ${date.getFullYear()}`;
  }

  monthName(monthNumber: number): string {
    const key = `month.${monthNumber}`;
    const label = this.lang.t(key);
    return label !== key ? label : String(monthNumber);
  }

  private parseDate(value?: string): Date | null {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed) : null;
  }

  private isValidDate(value: unknown): value is Date {
    return value instanceof Date && Number.isFinite(value.getTime());
  }

  private normalizeDate(value: unknown): Date | undefined {
    if (this.isValidDate(value)) {
      return value;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const parsed = new Date(value);
      if (this.isValidDate(parsed)) {
        return parsed;
      }
    }
    return undefined;
  }

  private getCaseTimestamp(caseItem: AdminCaseRow): number {
    const date =
      this.normalizeDate(caseItem.receivedAt) ||
      this.parseDate(caseItem.receivedDateDisplay) ||
      this.parseDate(caseItem.deliveryDateDisplay) ||
      new Date(0);
    return date.getTime();
  }

  private normalizePatientName(value?: string): string {
    return (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  private normalizeDoctorName(value?: string): string {
    return (value || 'غير محدد').trim().replace(/\s+/g, ' ');
  }

  private doctorGroupKey(value?: string): string {
    return this.normalizeDoctorName(value).toLowerCase();
  }

  private isForcedCompletedPatient(patientName?: string): boolean {
    return this.normalizePatientName(patientName) === 'mahmoud khaled';
  }

  get monthlyFinancialSummary(): MonthlyFinancialSummary[] {
    const groups: Record<string, MonthlyFinancialSummary> = {};

    this.adminCases.filter(c => c.currentStage === 'exited').forEach(c => {
      const date =
        this.normalizeDate(c.receivedAt) ||
        this.parseDate(c.receivedDateDisplay) ||
        new Date();
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      if (!groups[monthKey]) {
        groups[monthKey] = {
          monthKey,
          monthLabel: this.monthLabel(date),
          monthNumber: date.getMonth() + 1,
          year: date.getFullYear(),
          cases: 0,
          totalSalary: 0,
          paidCases: 0,
          paidTotal: 0,
          unpaidTotal: 0,
          byDoctor: []
        };
      }

      const group = groups[monthKey];
      const doctorName = this.normalizeDoctorName(c.doctorName || c.assignedTo || 'غير محدد');
      const doctorKey = this.doctorGroupKey(doctorName);
      const salary = c.salary || 0;
      group.cases += 1;
      group.totalSalary += salary;
      if (c.paid) {
        group.paidCases += 1;
        group.paidTotal += salary;
      } else {
        group.unpaidTotal += salary;
      }

      let doctorSummary = group.byDoctor.find(item => this.doctorGroupKey(item.doctorName) === doctorKey);
      if (!doctorSummary) {
        doctorSummary = { doctorName, cases: 0, totalSalary: 0, paidCases: 0, paidAmount: 0 };
        group.byDoctor.push(doctorSummary);
      }
      doctorSummary.cases += 1;
      doctorSummary.totalSalary += salary;
      if (c.paid) {
        doctorSummary.paidCases += 1;
        doctorSummary.paidAmount += salary;
      }
    });

    return Object.values(groups)
      .sort((a, b) => b.monthKey.localeCompare(a.monthKey))
      .map(group => ({
        ...group,
        byDoctor: group.byDoctor.sort((a, b) => b.cases - a.cases)
      }));
  }

  get financialYears(): number[] {
    const years = new Set<number>(this.monthlyFinancialSummary.map(item => item.year));
    return Array.from(years).sort((a, b) => b - a);
  }

  get financialMonthsForSelectedYear(): number[] {
    if (!this.financialYearFilter) {
      return [];
    }
    const year = Number(this.financialYearFilter);
    const months = new Set<number>(
      this.monthlyFinancialSummary
        .filter(item => item.year === year)
        .map(item => item.monthNumber)
    );
    return Array.from(months).sort((a, b) => a - b);
  }

  onFinancialYearChange(value: string): void {
    this.financialYearFilter = value;
    if (!value) {
      this.financialMonthFilter = '';
      return;
    }
    const selectedMonth = Number(this.financialMonthFilter);
    if (!selectedMonth || !this.financialMonthsForSelectedYear.includes(selectedMonth)) {
      this.financialMonthFilter = '';
    }
  }

  get groupedFinancialSummary(): YearlyFinancialSummary[] {
    const doctorSearch = this.financialDoctorSearch.trim().toLowerCase();

    const filteredMonths = this.monthlyFinancialSummary
      .filter(month => !this.financialYearFilter || month.year === Number(this.financialYearFilter))
      .filter(month => !this.financialMonthFilter || month.monthNumber === Number(this.financialMonthFilter))
      .map(month => {
        const filteredDoctors = doctorSearch
          ? month.byDoctor.filter(doctor => doctor.doctorName.toLowerCase().includes(doctorSearch))
          : month.byDoctor;

        const cases = filteredDoctors.reduce((sum, doctor) => sum + doctor.cases, 0);
        const totalSalary = filteredDoctors.reduce((sum, doctor) => sum + doctor.totalSalary, 0);
        const paidCases = filteredDoctors.reduce((sum, doctor) => sum + doctor.paidCases, 0);
        const paidTotal = filteredDoctors.reduce((sum, doctor) => sum + doctor.paidAmount, 0);

        return {
          ...month,
          byDoctor: filteredDoctors,
          cases,
          totalSalary,
          paidCases,
          paidTotal,
          unpaidTotal: totalSalary - paidTotal
        };
      })
      .filter(month => month.byDoctor.length > 0);

    const yearlyMap = new Map<number, YearlyFinancialSummary>();
    filteredMonths.forEach(month => {
      if (!yearlyMap.has(month.year)) {
        yearlyMap.set(month.year, {
          year: month.year,
          totalCases: 0,
          paidCases: 0,
          totalAmount: 0,
          paidAmount: 0,
          months: []
        });
      }
      const yearEntry = yearlyMap.get(month.year)!;
      yearEntry.totalCases += month.cases;
      yearEntry.paidCases += month.paidCases;
      yearEntry.totalAmount += month.totalSalary;
      yearEntry.paidAmount += month.paidTotal;
      yearEntry.months.push(month);
    });

    return Array.from(yearlyMap.values())
      .sort((a, b) => b.year - a.year)
      .map(year => ({
        ...year,
        months: year.months.sort((a, b) => a.monthNumber - b.monthNumber)
      }));
  }

  exportFinancialYearReport(): void {
    // فلترة الحالات الخارجة فقط
    let cases = this.adminCases.filter(c => c.currentStage === 'exited');

    const selectedYear = Number(this.financialYearFilter);
    const selectedMonth = Number(this.financialMonthFilter);
    const doctorSearch = this.financialDoctorSearch.trim().toLowerCase();

    if (doctorSearch) {
      cases = cases.filter(c => {
        const doctorName = this.normalizeDoctorName(c.doctorName || c.assignedTo || '');
        return doctorName.toLowerCase().includes(doctorSearch);
      });
    }

    if (Number.isFinite(selectedYear) && selectedYear > 0) {
      cases = cases.filter(c => {
        const d = this.normalizeDate(c.exitedAt) || this.normalizeDate(c.receivedAt) || this.parseDate(c.receivedDateDisplay);
        return d && d.getFullYear() === selectedYear;
      });
    }

    if (Number.isFinite(selectedMonth) && selectedMonth > 0) {
      cases = cases.filter(c => {
        const d = this.normalizeDate(c.exitedAt) || this.normalizeDate(c.receivedAt) || this.parseDate(c.receivedDateDisplay);
        return d && d.getMonth() + 1 === selectedMonth;
      });
    }

    if (!cases.length) {
      alert('لا توجد بيانات للتصدير');
      return;
    }

    const dataRows = cases.map(c => {
      const meta = this.parseNotesMeta(c.rawNotes || '');
      const quantity = Number(c.quantity ?? meta['quantity'] ?? 1) || 1;
      const color = String(c.color ?? meta['color'] ?? '');

      const salary = Number(c.salary || 0);
      const totalPrice = salary * quantity;
      const paidAmount = c.paid ? totalPrice : 0;
      const remaining = totalPrice - paidAmount;

      // تاريخ الخروج بأرقام إنجليزية
      const exitDateObj = c.exitedAt || this.normalizeDate(c.receivedAt) || this.parseDate(c.receivedDateDisplay);
      const date = exitDateObj
        ? exitDateObj.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '/')
        : (c.receivedDateDisplay || '');

      // تفاصيل السكرتير أو ملاحظات الحالة
      const details = String(meta['workDetail'] || '').trim();

      // ترجمة المصطلحات الإنجليزية للعربية
      let translatedCaseType = c.caseType || '';
      translatedCaseType = translatedCaseType
        .replace(/redo/gi, 'إعادة')
        .replace(/remake/gi, 'إعادة')
        .replace(/modification/gi, 'تعديل');

      return {
        date,
        patientName: c.patientName || '',
        caseType: translatedCaseType,
        quantity,
        color,
        salary,
        totalPrice,
        paid: c.paid ? totalPrice : 0,
        remaining,
        details
      };
    });

    let html = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="utf-8">
      <style>
        table { border-collapse: collapse; font-family: 'Calibri', sans-serif; }
        th { background-color: #A9D08E; color: #000; border: 1pt solid #000; font-weight: bold; text-align: center; padding: 5px; }
        td { border: 1pt solid #000; text-align: center; padding: 5px; }
        .row-data { background-color: #E2EFDA; }
        .text-red { color: #C00000; }
      </style>
    </head>
    <body dir="rtl">
      <table>
        <thead>
          <tr>
            <th>التاريخ</th>
            <th>المريض</th>
            <th>النوع</th>
            <th>العدد</th>
            <th>اللون</th>
            <th>سعر افرادي</th>
            <th>سعر اجمالي</th>
            <th>مدفوع</th>
            <th>الباقي</th>
            <th>نوع التسليم</th>
            <th>تفاصيل</th>
          </tr>
        </thead>
        <tbody>
    `;

    dataRows.forEach(r => {
      html += `
          <tr class="row-data">
            <td>${r.date}</td>
            <td>${r.patientName}</td>
            <td>${r.caseType}</td>
            <td>${r.quantity}</td>
            <td>${r.color}</td>
            <td>${r.salary > 0 ? r.salary : ''}</td>
            <td>${r.totalPrice > 0 ? r.totalPrice : ''}</td>
            <td>${r.paid > 0 ? r.paid : ''}</td>
            <td class="${r.remaining > 0 ? 'text-red' : ''}">${r.remaining > 0 ? r.remaining : (r.remaining === 0 && r.totalPrice > 0 ? 'مدفوع' : '')}</td>
            <td></td>
            <td style="text-align:right">${r.details}</td>
          </tr>
      `;
    });

    html += `
        </tbody>
      </table>
    </body>
    </html>
    `;

    if (typeof document === 'undefined') return;

    const blob = new Blob(['\uFEFF' + html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const baseName = doctorSearch ? doctorSearch.replace(/\s+/g, '-') : 'تقرير-مالي';
    const yearSuffix = selectedYear > 0 ? `-${selectedYear}` : '';
    const monthSuffix = selectedMonth > 0 ? `-${String(selectedMonth).padStart(2, '0')}` : '';
    anchor.href = url;
    anchor.download = `${baseName}${yearSuffix}${monthSuffix}.xls`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  openDoctorDetails(doctorName: string): void {
    this.selectedDoctorName = doctorName;
    this.showDoctorDetailsModal = true;
  }

  closeDoctorDetails(): void {
    this.showDoctorDetailsModal = false;
    this.selectedDoctorName = '';
  }

  get selectedDoctorRecords(): DoctorCaseRecord[] {
    if (!this.selectedDoctorName) {
      return [];
    }
    const records = this.adminCases.filter(c => c.currentStage === 'exited')
      .filter(c => this.doctorGroupKey(c.doctorName || c.assignedTo || 'غير محدد') === this.doctorGroupKey(this.selectedDoctorName))
      .map(c => ({
        id: c.id,
        caseNumber: c.caseNumber,
        patientName: c.patientName,
        caseType: c.caseType,
        receivedDate: c.receivedDateDisplay || 'غير متوفر',
        exitedDate: this.formatDateEn(c.exitedAt || c.receivedAt),
        stage: c.currentStage,
        salary: this.calculateCaseCost(c),
        dbSalary: c.salary || 0,
        paid: !!c.paid
      }));

    return records.sort((a, b) => b.caseNumber.localeCompare(a.caseNumber));
  }

  get selectedDoctorTotals(): { cases: number; paidCases: number; totalAmount: number; paidAmount: number } {
    return this.selectedDoctorRecords.reduce(
      (totals, record) => {
        totals.cases += 1;
        totals.totalAmount += record.salary;
        if (record.paid) {
          totals.paidCases += 1;
          totals.paidAmount += record.dbSalary;
        }
        return totals;
      },
      { cases: 0, paidCases: 0, totalAmount: 0, paidAmount: 0 }
    );
  }

  get financialTotalsByDoctor() {
    const totals: Record<string, { cases: number; total: number }> = {};
    this.adminCases.filter(c => c.currentStage === 'exited').forEach(c => {
      const doctorName = this.doctorGroupKey(c.doctorName || c.assignedTo || 'غير محدد');
      const salary = c.salary || 0;
      if (!totals[doctorName]) {
        totals[doctorName] = { cases: 0, total: 0 };
      }
      totals[doctorName].cases += 1;
      totals[doctorName].total += salary;
    });
    return totals;
  }

  get totalFinancialAmount(): number {
    return Object.values(this.financialTotalsByDoctor).reduce((sum, item) => sum + item.total, 0);
  }

  getSalaryForCase(c: AdminCaseRow): number {
    return this.caseBillDisplay(c);
  }

  /** Live doctor price is source of truth for unpaid (incl. Try in = 0). */
  caseBillDisplay(c: AdminCaseRow): number {
    const live = Number(this.calculateCaseCost(c));
    const liveOk = Number.isFinite(live);
    // Unpaid: never fall back to a stale stored salary (e.g. old zircon price on try-in).
    if (!c.paid && liveOk) return live;
    if (liveOk && live > 0) return live;
    const stored = Number(c.salary || 0) || 0;
    if (stored > 0) return stored;
    return liveOk ? live : 0;
  }

  getSalaryDraft(caseItem: AdminCaseRow): string {
    if (Object.prototype.hasOwnProperty.call(this.salaryDrafts, caseItem.id)) {
      return this.salaryDrafts[caseItem.id];
    }
    return String(this.caseBillDisplay(caseItem) || 0);
  }

  setSalaryDraft(caseItem: AdminCaseRow, value: string): void {
    this.salaryDrafts[caseItem.id] = value;
  }

  canConfirmPayment(caseItem: AdminCaseRow): boolean {
    const parsed = Number(this.getSalaryDraft(caseItem));
    return Number.isFinite(parsed) && parsed > 0;
  }

  isSalarySaving(caseItem: AdminCaseRow): boolean {
    return this.salarySavingByCaseId[caseItem.id] === true;
  }

  canEditPaidSalary(caseItem: AdminCaseRow): boolean {
    if (!caseItem.paid) return false;
    const parsed = Number(this.getSalaryDraft(caseItem));
    if (!Number.isFinite(parsed) || parsed <= 0) return false;
    if (this.isSalarySaving(caseItem)) return false;
    return parsed !== Number(caseItem.salary || 0);
  }

  confirmPayment(caseItem: AdminCaseRow): void {
    const parsed = Number(this.getSalaryDraft(caseItem));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return;
    }
    this.financialSaveError = '';
    this.caseApi
      .updateCaseFinancials(caseItem.id, { salaryAmount: parsed, paymentStatus: 'paid' })
      .subscribe({
        next: () => {
          caseItem.salary = parsed;
          caseItem.paid = true;
          delete this.salaryDrafts[caseItem.id];
          this.loadCasesFromApi();
          this.loadFinancialReportFromApi();
        },
        error: (err) => {
          console.error(err);
          this.financialSaveError = 'تعذر حفظ بيانات الدفع';
        },
      });
  }

  editPaidSalary(caseItem: AdminCaseRow): void {
    const parsed = Number(this.getSalaryDraft(caseItem));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      this.financialSaveError = 'قيمة السعر غير صحيحة';
      return;
    }
    this.financialSaveError = '';
    this.salarySavingByCaseId[caseItem.id] = true;
    this.caseApi
      .updateCaseFinancials(caseItem.id, { salaryAmount: parsed, paymentStatus: 'paid' })
      .subscribe({
        next: () => {
          caseItem.salary = parsed;
          caseItem.paid = true;
          delete this.salaryDrafts[caseItem.id];
          this.salarySavingByCaseId[caseItem.id] = false;
          this.loadCasesFromApi();
          this.loadFinancialReportFromApi();
        },
        error: (err) => {
          console.error(err);
          this.salarySavingByCaseId[caseItem.id] = false;
          this.financialSaveError = 'تعذر تعديل سعر الحالة المدفوعة';
        },
      });
  }

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.filteredCases.length / this.pageSize));
  }

  get pageNumbers(): number[] {
    return Array.from({ length: this.totalPages }, (_, i) => i + 1);
  }

  get pagedCases(): AdminCaseRow[] {
    const startIndex = (this.currentPage - 1) * this.pageSize;
    return this.filteredCases.slice(startIndex, startIndex + this.pageSize);
  }

  get dashboardMetrics() {
    return this.adminDashboardService.calculateMetrics(this.patients.length, this.adminCases, this.staffMembers);
  }

  get totalRevenueAmount(): number {
    return this.dashboardMetrics.totalRevenue;
  }

  get staffEfficiencyPercent(): number {
    return this.dashboardMetrics.staffEfficiency;
  }

  /** الحالات الخارجة التي فيها جزء قابل للفوترة (مش كلها redo/mod/empty) — scoped by dashboard month */
  get exitedNonRedoCases(): AdminCaseRow[] {
    return this.adminCases.filter(c => {
      if (String(c.currentStage) !== 'exited') return false;
      if (!this.matchesDashPeriod(c)) return false;
      return !isWholeCaseExcluded(c.caseType || '');
    });
  }

  private matchesDashPeriod(c: AdminCaseRow): boolean {
    if (!this.dashYearFilter && !this.dashMonthFilter) return true;
    // Material counters for exited cases — exit date only
    const d = c.exitedAt;
    if (!d) return false;
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return false;
    if (this.dashYearFilter && dt.getFullYear() !== Number(this.dashYearFilter)) return false;
    if (this.dashMonthFilter && dt.getMonth() + 1 !== Number(this.dashMonthFilter)) return false;
    return true;
  }

  get dashYears(): number[] {
    const years = new Set<number>();
    const current = new Date().getFullYear();
    years.add(current);
    for (let y = current - 1; y >= current - 5; y -= 1) years.add(y);
    this.adminCases.forEach((c) => {
      const d = c.exitedAt || c.receivedAt;
      if (d) years.add((d instanceof Date ? d : new Date(d)).getFullYear());
    });
    return Array.from(years).sort((a, b) => b - a);
  }

  get dashMonths(): number[] {
    return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  }

  onDashYearChange(value: string): void {
    this.dashYearFilter = value;
    if (!value) {
      this.dashMonthFilter = '';
    } else if (!this.dashMonthFilter) {
      const now = new Date();
      this.dashMonthFilter =
        Number(value) === now.getFullYear() ? String(now.getMonth() + 1) : '1';
    }
    this.refreshMaterialStatsFromLocalCases();
    this.loadMaterialStats();
  }

  onDashMonthChange(value: string): void {
    this.dashMonthFilter = value;
    this.refreshMaterialStatsFromLocalCases();
    this.loadMaterialStats();
  }

  /** عدد وحدات الزيركونيا الإجمالي الخارجة غير الإعادة */
  get zirconCount(): number {
    return this.materialStats['zircon'] || 0;
  }

  get regularZirconCount(): number {
    return this.materialStats['regularZircon'] || 0;
  }

  get germanZirconCount(): number {
    return this.materialStats['germanZircon'] || 0;
  }

  get titaniumCount(): number {
    return this.materialStats['titanium'] || 0;
  }

  get peekCount(): number {
    return this.materialStats['peek'] || 0;
  }

  /** عدادات الماتريال الخارجة. Wax و Ring يختفوا طول ما رقمهم صفر. */
  get exitedMaterialCounters(): { label: string; qty: number; color: string }[] {
    const rows = [
      { label: 'Pmma Cad', qty: this.materialStats['pmma'] || 0, color: '#14b8a6' },
      { label: 'Try in', qty: this.materialStats['tryIn'] || 0, color: '#f59e0b' },
      { label: 'Mokup', qty: this.materialStats['mokup'] || 0, color: '#ec4899' },
      { label: 'Night Guard', qty: this.materialStats['nightGuard'] || 0, color: '#8b5cf6' },
      { label: 'Wax', qty: this.materialStats['wax'] || 0, color: '#a16207' },
      { label: 'Ring', qty: this.materialStats['ring'] || 0, color: '#ef4444' },
    ];
    return rows.filter((row) => (row.label !== 'Wax' && row.label !== 'Ring') || row.qty > 0);
  }

  /** الزيركون والإيماكس. التيتانيوم والبيك يظهروا لما يكون لهم رقم. */
  get productionCounters(): { label: string; qty: number; color: string }[] {
    const rows = [
      { label: 'Zircon', qty: this.regularZirconCount, color: '#6366f1' },
      { label: 'German Zircon', qty: this.germanZirconCount, color: '#4f46e5' },
      { label: 'Emax', qty: this.emaxCount, color: '#0ea5e9' },
    ];
    if (this.titaniumCount > 0) rows.push({ label: 'Titanium', qty: this.titaniumCount, color: '#71717a' });
    if (this.peekCount > 0) rows.push({ label: 'Peek', qty: this.peekCount, color: '#0f766e' });
    return rows;
  }

  get kindNewCount(): number {
    const k = this.materialStats['kindStats'] as { New?: number } | undefined;
    return Number(k?.New) || 0;
  }
  get kindRedoCount(): number {
    const k = this.materialStats['kindStats'] as { Redo?: number } | undefined;
    return Number(k?.Redo) || 0;
  }
  get kindModificationCount(): number {
    const k = this.materialStats['kindStats'] as { Modification?: number } | undefined;
    return Number(k?.Modification) || 0;
  }

  deliveryAlerts: {
    overdue: Array<{ caseNumber: string; patientName: string; doctorName: string; dueDate: string; hoursOverdue: number }>;
    dueSoon: Array<{ caseNumber: string; patientName: string; doctorName: string; dueDate: string }>;
    overdueCount: number;
    dueSoonCount: number;
  } = { overdue: [], dueSoon: [], overdueCount: 0, dueSoonCount: 0 };

  private loadDeliveryAlerts(): void {
    this.caseApi.getDeliveryAlerts().subscribe({
      next: (res) => {
        const data = res?.data;
        if (!data) return;
        this.deliveryAlerts = {
          overdue: Array.isArray(data.overdue) ? data.overdue : [],
          dueSoon: Array.isArray(data.dueSoon) ? data.dueSoon : [],
          overdueCount: Number(data.overdueCount) || 0,
          dueSoonCount: Number(data.dueSoonCount) || 0,
        };
      },
      error: () => {
        /* optional endpoint */
      },
    });
  }

  get financialCostEligibleCases(): AdminCaseRow[] {
    return this.adminCases.filter(c => {
      if (String(c.currentStage) !== 'exited') return false;
      
      // Skip Jundi (الجندي)
      const doctor = (c.doctorName || c.assignedTo || '').toLowerCase();
      const isJundi = doctor.includes('الجندي') || doctor.includes('jundi') || doctor.includes('gundi');
      if (isJundi) return false;

      return !isWholeCaseExcluded(c.caseType || '');
    });
  }

  /**
   * Try-in phase labels (any casing): "try in before Zircon", "Try in", "TRYIN"...
   * Not "Emax after try in" — that bills as the final material.
   */
  private isTryInPart(lowerPart: string): boolean {
    const s = String(lowerPart || '').toLowerCase();
    if (/\bafter\s+try\s*in\b|\bafter\s+tray\s*in\b|\bafter\s+tary\s*in\b/.test(s)) {
      return false;
    }
    return /try\s*in|tryin|tray\s*in|tary\s*in/.test(s);
  }

  /** Align with backend: collapse "try in before X" so zircon/emax keywords cannot win. */
  private normalizeMaterialPartForPricing(lowerPart: string): string {
    let lower = String(lowerPart || '').toLowerCase();
    if (/try\s*in\s+before|tray\s*in\s+before|tary\s*in\s+before/.test(lower)) {
      return 'try in';
    }
    return lower
      .replace(/\s+after\s+try\s*in/gi, '')
      .replace(/\s+after\s+tray\s*in/gi, '')
      .replace(/\s+after\s+tary\s*in/gi, '')
      .trim();
  }

  calculateCaseCost(c: AdminCaseRow): number {
    if (isWholeCaseExcluded(c.caseType || '')) return 0;

    const doctor = c.doctorName || c.assignedTo || 'غير محدد';
    const key = this.doctorGroupKey(doctor);
    const custom = this.doctorPricingsMap.get(key) || {};
    const prices: Record<string, number> = { ...this.labDefaultPrices };
    for (const [k, v] of Object.entries(custom)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) {
        prices[k] = n;
        prices[String(k).toLowerCase()] = n;
      }
    }
    // Legacy fallbacks if materials not loaded yet
    if (!Object.keys(prices).length) {
      Object.assign(prices, {
        emax: 1000,
        germanZircon: 850,
        zircon: 700,
        titanium: 2200,
        peek: 1700,
        pmma: 250,
        nightGuard: 300,
        mockup: 250,
        wax: 0,
        ring: 0,
        tryIn: 0,
        tryin: 0,
      });
    }

    const priceOf = (materialKey: string, fallback = 0): number => {
      if (prices[materialKey] !== undefined) return Number(prices[materialKey]) || 0;
      const lower = String(materialKey).toLowerCase();
      if (prices[lower] !== undefined) return Number(prices[lower]) || 0;
      for (const [k, v] of Object.entries(prices)) {
        if (String(k).toLowerCase() === lower) return Number(v) || 0;
      }
      return fallback;
    };

    let total = 0;
    const parts = splitNormalizedCaseTypeParts(c.caseType || '');
    const meta = this.parseNotesMeta(c.rawNotes || '');
    const caseOverallQuantity = Number(c.quantity ?? meta['quantity'] ?? 1) || 1;
    const materials =
      this.labMaterials.length > 0
        ? this.labMaterials
        : ([
            { key: 'emax', label: 'Emax', matchKeywords: ['emax'], defaultPrice: 1000 },
            {
              key: 'germanZircon',
              label: 'German Zircon',
              matchKeywords: ['german zircon', 'german'],
              defaultPrice: 850,
            },
            { key: 'zircon', label: 'Zircon', matchKeywords: ['zircon'], defaultPrice: 700 },
            { key: 'titanium', label: 'Titanium', matchKeywords: ['titanium'], defaultPrice: 2200 },
            { key: 'peek', label: 'Peek', matchKeywords: ['peek'], defaultPrice: 1700 },
            { key: 'pmma', label: 'Pmma Cad', matchKeywords: ['pmma cad', 'pmma'], defaultPrice: 250 },
            {
              key: 'nightGuard',
              label: 'Night Guard',
              matchKeywords: ['night guard', 'nightguard', 'guard'],
              defaultPrice: 300,
            },
            {
              key: 'mockup',
              label: 'Mockup',
              matchKeywords: ['mokup', 'mockup', 'mock up', 'موكب'],
              defaultPrice: 250,
            },
            { key: 'wax', label: 'Wax', matchKeywords: ['wax'], defaultPrice: 0 },
            { key: 'ring', label: 'Ring', matchKeywords: ['ring'], defaultPrice: 0 },
            {
              key: 'tryIn',
              label: 'Try in',
              matchKeywords: ['try in before', 'try in', 'tryin', 'tray in before'],
              defaultPrice: 0,
            },
          ] as LabMaterial[]);

    const tryInMaterial =
      materials.find((m) => String(m.key).toLowerCase() === 'tryin') ||
      ({
        key: 'tryIn',
        label: 'Try in',
        matchKeywords: ['try in before', 'try in', 'tryin', 'tray in before'],
        defaultPrice: 0,
      } as LabMaterial);

    for (const part of parts) {
      if (isExcludedWorkPart(part)) continue;
      const lowerPart = part.toLowerCase();
      const match = part.match(/\((\d+)\)/);
      const qty = match ? parseInt(match[1], 10) : caseOverallQuantity;

      // Try-in ALWAYS wins over embedded material names (zircon/emax), any casing.
      let best: LabMaterial | null = null;
      if (this.isTryInPart(lowerPart)) {
        best = tryInMaterial;
      } else {
        const normalized = this.normalizeMaterialPartForPricing(lowerPart);
        let bestLen = -1;
        for (const m of materials) {
          if (String(m.key).toLowerCase() === 'tryin') continue;
          for (const kw of m.matchKeywords || []) {
            const k = String(kw).toLowerCase();
            if (k && normalized.includes(k) && k.length > bestLen) {
              bestLen = k.length;
              best = m;
            }
          }
        }
      }
      if (!best) continue;
      const unit = priceOf(best.key, Number(best.defaultPrice) || 0);
      total += qty * unit;
    }
    return total;
  }

  get totalDoctorsCostBreakdown() {
    const cases = this.financialCostEligibleCases;
    
    let emaxQty = 0;
    let germanZirconQty = 0;
    let zirconQty = 0;
    let titaniumQty = 0;
    let peekQty = 0;
    let pmmaQty = 0;
    let nightGuardQty = 0;
    let waxQty = 0;
    let ringQty = 0;
    let tryInQty = 0;

    for (const c of cases) {
      const ct = c.caseType || '';
      const parts = splitNormalizedCaseTypeParts(ct);
      const meta = this.parseNotesMeta(c.rawNotes || '');
      const caseOverallQuantity = Number(c.quantity ?? meta['quantity'] ?? 1) || 1;

      for (const part of parts) {
        if (isExcludedWorkPart(part)) continue;
        const lowerPart = part.toLowerCase();
        
        // Count quantity: e.g. "Zircon (3)" -> 3, or default to overall case quantity
        const match = part.match(/\((\d+)\)/);
        const qty = match ? parseInt(match[1], 10) : caseOverallQuantity;

        // Try-in first — do not count as final material (e.g. "try in before Zircon").
        if (this.isTryInPart(lowerPart)) {
          tryInQty += qty;
        } else if (lowerPart.includes('emax')) {
          emaxQty += qty;
        } else if (lowerPart.includes('german zircon') || lowerPart.includes('german')) {
          germanZirconQty += qty;
        } else if (lowerPart.includes('zircon')) {
          zirconQty += qty;
        } else if (lowerPart.includes('titanium')) {
          titaniumQty += qty;
        } else if (lowerPart.includes('peek')) {
          peekQty += qty;
        } else if (lowerPart.includes('pmma cad') || lowerPart.includes('pmma')) {
          pmmaQty += qty;
        } else if (lowerPart.includes('night guard') || lowerPart.includes('nightguard') || lowerPart.includes('guard')) {
          nightGuardQty += qty;
        } else if (lowerPart.includes('wax')) {
          waxQty += qty;
        } else if (lowerPart.includes('ring')) {
          ringQty += qty;
        }
      }
    }

    const emaxTotal = emaxQty * 1000;
    const germanZirconTotal = germanZirconQty * 850;
    const zirconTotal = zirconQty * 700;
    const titaniumTotal = titaniumQty * 2200;
    const peekTotal = peekQty * 1700;
    const pmmaTotal = pmmaQty * 250;
    const nightGuardTotal = nightGuardQty * 300;
    const waxTotal = waxQty * 0;
    const ringTotal = ringQty * 0;
    const tryInUnit =
      Number(
        this.labDefaultPrices['tryIn'] ??
          this.labDefaultPrices['tryin'] ??
          this.customTryInPrice ??
          0
      ) || 0;
    const tryInTotal = tryInQty * tryInUnit;

    // Prefer sum of live case bills (per-doctor try-in/custom prices) over flat lab defaults.
    const liveGrand = cases.reduce((sum, c) => sum + (this.caseBillDisplay(c) || 0), 0);
    const materialGrand =
      emaxTotal +
      germanZirconTotal +
      zirconTotal +
      titaniumTotal +
      peekTotal +
      pmmaTotal +
      nightGuardTotal +
      waxTotal +
      ringTotal +
      tryInTotal;
    const grandTotal = liveGrand > 0 ? liveGrand : materialGrand;

    return {
      emaxQty, emaxTotal,
      germanZirconQty, germanZirconTotal,
      zirconQty, zirconTotal,
      titaniumQty, titaniumTotal,
      peekQty, peekTotal,
      pmmaQty, pmmaTotal,
      nightGuardQty, nightGuardTotal,
      waxQty, waxTotal,
      ringQty, ringTotal,
      tryInQty, tryInTotal,
      grandTotal
    };
  }

  private countUnitsByKeywords(includeKeywords: string[], excludeKeywords: string[] = []): number {
    let total = 0;
    for (const c of this.exitedNonRedoCases) {
      const ct = c.caseType || '';
      const parts = splitNormalizedCaseTypeParts(ct);
      const meta = this.parseNotesMeta(c.rawNotes || '');
      const caseOverallQuantity = Number(c.quantity ?? meta['quantity'] ?? 1) || 1;

      for (const part of parts) {
        if (isExcludedWorkPart(part)) continue;
        const lowerPart = part.toLowerCase();
        // Try-in must not inflate material unit counters (zircon/emax/…).
        if (this.isTryInPart(lowerPart)) continue;

        const hasInclude = includeKeywords.some(kw => lowerPart.includes(kw));
        const hasExclude = excludeKeywords.some(kw => lowerPart.includes(kw));
        
        if (hasInclude && !hasExclude) {
          const match = part.match(/\((\d+)\)/);
          if (match) {
            total += parseInt(match[1], 10);
          } else {
            total += caseOverallQuantity;
          }
        }
      }
    }
    return total;
  }

  /** عدد وحدات الإيماكس الخارجة غير الإعادة */
  get emaxCount(): number {
    return this.materialStats['emax'] || 0;
  }

  /** الحالات الخارجة للدكتور الجندي فقط (بدون إعادة أو تعديل) */
  get jundiExitedNonRedoCases(): AdminCaseRow[] {
    return this.exitedNonRedoCases.filter(c => {
      const doctor = (c.doctorName || c.assignedTo || '').toLowerCase();
      return doctor.includes('الجندي') || doctor.includes('jundi') || doctor.includes('gundi');
    });
  }

  /** عداد زيركون الجندي */
  get jundiZirconCount(): number {
    return this.materialStats['jundiZircon'] || 0;
  }

  get jundiRegularZirconCount(): number {
    return this.materialStats['jundiRegularZircon'] || 0;
  }

  get jundiGermanZirconCount(): number {
    return this.materialStats['jundiGermanZircon'] || 0;
  }

  get jundiTitaniumCount(): number {
    return this.materialStats['jundiTitanium'] || 0;
  }

  get jundiPeekCount(): number {
    return this.materialStats['jundiPeek'] || 0;
  }

  /** عداد إيماكس الجندي */
  get jundiEmaxCount(): number {
    return this.materialStats['jundiEmax'] || 0;
  }

  private countUnitsByKeywordsFromCases(cases: AdminCaseRow[], includeKeywords: string[], excludeKeywords: string[]): number {
    let total = 0;
    for (const c of cases) {
      const ct = c.caseType || '';
      const parts = splitNormalizedCaseTypeParts(ct);
      const meta = this.parseNotesMeta(c.rawNotes || '');
      const caseOverallQuantity = Number(c.quantity ?? meta['quantity'] ?? 1) || 1;

      for (const part of parts) {
        if (isExcludedWorkPart(part)) continue;
        const lowerPart = part.toLowerCase();
        const countingTryIn = includeKeywords.some((kw) => /try\s*in/i.test(String(kw)));
        // Try-in parts must not inflate zircon/emax counters; still count when querying try-in itself.
        if (this.isTryInPart(lowerPart) && !countingTryIn) continue;
        const hasInclude = includeKeywords.some(kw => lowerPart.includes(kw));
        const hasExclude = excludeKeywords.some(kw => lowerPart.includes(kw));
        if (hasInclude && !hasExclude) {
          const match = part.match(/\((\d+)\)/);
          total += match ? parseInt(match[1], 10) : caseOverallQuantity;
        }
      }
    }
    return total;
  }

  private loadCasesFromApi(): void {
    const now = new Date();
    this.caseApi
      .getAllCases(1, 800, {
        scope: 'board',
        year: now.getFullYear(),
        month: now.getMonth() + 1,
      })
      .subscribe({
      next: (res) => {
        const rows = (res?.data ?? []) as Record<string, unknown>[];
        this.adminCases = Array.isArray(rows) ? rows.map((row) => this.mapApiCaseToAdminCase(row)) : [];
        this.patients = this.buildPatientsFromCases(this.adminCases);
        this.currentPage = 1;
        this.refreshMaterialStatsFromLocalCases();
        this.loadMaterialStats();
      },
      error: (err) => {
        console.error(err);
        this.adminCases = [];
        this.patients = [];
        this.refreshMaterialStatsFromLocalCases();
      },
    });
  }

  /** Instant counters from loaded cases (updates right after delete / list refresh). */
  private refreshMaterialStatsFromLocalCases(): void {
    const all = this.exitedNonRedoCases;
    const jundi = this.jundiExitedNonRedoCases;
    const regularZircon = this.countUnitsByKeywordsFromCases(all, ['zircon'], ['german']);
    const germanZircon = this.countUnitsByKeywordsFromCases(all, ['german zircon', 'german'], []);
    const titanium = this.countUnitsByKeywordsFromCases(all, ['titanium'], []);
    const peek = this.countUnitsByKeywordsFromCases(all, ['peek'], []);
    const jundiRegularZircon = this.countUnitsByKeywordsFromCases(jundi, ['zircon'], ['german']);
    const jundiGermanZircon = this.countUnitsByKeywordsFromCases(jundi, ['german zircon', 'german'], []);
    const jundiTitanium = this.countUnitsByKeywordsFromCases(jundi, ['titanium'], []);
    const jundiPeek = this.countUnitsByKeywordsFromCases(jundi, ['peek'], []);

    this.materialStats = {
      emax: this.countUnitsByKeywordsFromCases(all, ['emax'], []),
      regularZircon,
      germanZircon,
      titanium,
      peek,
      pmma: this.countUnitsByKeywordsFromCases(all, ['pmma cad', 'pmma'], []),
      nightGuard: this.countUnitsByKeywordsFromCases(all, ['night guard', 'nightguard', 'guard'], []),
      mokup: this.countUnitsByKeywordsFromCases(all, ['mokup', 'mockup', 'mock up', 'موكب'], []),
      tryIn: this.countUnitsByKeywordsFromCases(all, ['try in', 'tryin'], []),
      wax: this.countUnitsByKeywordsFromCases(all, ['wax'], []),
      ring: this.countUnitsByKeywordsFromCases(all, ['ring'], []),
      zircon: regularZircon + germanZircon + titanium + peek,
      jundiEmax: this.countUnitsByKeywordsFromCases(jundi, ['emax'], []),
      jundiRegularZircon,
      jundiGermanZircon,
      jundiTitanium,
      jundiPeek,
      jundiZircon: jundiRegularZircon + jundiGermanZircon + jundiTitanium + jundiPeek,
    };
  }

  private loadMaterialStats(): void {
    const year = this.dashYearFilter ? Number(this.dashYearFilter) : undefined;
    const month = this.dashMonthFilter ? Number(this.dashMonthFilter) : undefined;
    // Local recompute already scopes by month. Never let an unfiltered API response
    // overwrite October (etc.) with all-time totals.
    this.caseApi.getExitedMaterialStats({ year, month }).subscribe({
      next: (res) => {
        const data = (res?.data ?? {}) as Record<string, unknown>;
        if (!data || typeof data !== 'object') return;
        if (year || month) {
          const apiYear = data['year'] == null ? null : Number(data['year']);
          const apiMonth = data['month'] == null ? null : Number(data['month']);
          const yearOk = !year || apiYear === year;
          const monthOk = !month || apiMonth === month;
          if (!yearOk || !monthOk) {
            // Old backend without period echo — keep local filtered counters
            return;
          }
        }
        const { year: _y, month: _m, totalExitedCases: _t, ...stats } = data as Record<
          string,
          number
        > & { year?: number; month?: number; totalExitedCases?: number };
        this.materialStats = {
          ...this.materialStats,
          ...stats,
        };
      },
      error: (err) => {
        // Keep local recomputed stats if API not deployed yet / offline
        console.error('material-stats', err);
      },
    });
  }

  private loadFinancialReportFromApi(): void {
    this.caseApi.getFinancialReport().subscribe({
      next: (res) => {
        const rows = (res?.data ?? []) as Record<string, unknown>[];
        this.reportCases = Array.isArray(rows)
          ? rows.map((row) => this.mapFinancialReportRowToAdminCase(row))
          : [];
        // Fill stale salary=0 (legacy try-in free) from live doctor prices.
        for (const c of this.reportCases) {
          if (c.paid) continue;
          const live = this.calculateCaseCost(c);
          if (live > 0 && !(Number(c.salary) > 0)) {
            c.salary = live;
          }
        }
      },
      error: (err) => {
        console.error(err);
        this.reportCases = [];
      },
    });
    this.loadDoctorPayments();
  }

  private mapApiCaseToAdminCase(doc: Record<string, unknown>): AdminCaseRow {
    const forcedCompleted = this.isForcedCompletedPatient(String(doc['patientName'] ?? ''));
    const salaryAmountRaw = Number(doc['salaryAmount']);
    const salary = Number.isFinite(salaryAmountRaw) ? salaryAmountRaw : 0;
    const paid = String(doc['paymentStatus'] ?? 'unpaid').toLowerCase() === 'paid';

    const createdBy = doc['createdBy'] as Record<string, unknown> | undefined;
    const assignedTo = doc['assignedTo'] as Record<string, unknown> | undefined;
    const notes = String(doc['notes'] ?? '');
    const parsedMeta = this.parseNotesMeta(notes);

    const createdAt = this.normalizeDate(doc['createdAt']);
    const dueDate = this.normalizeDate(doc['dueDate']);

    return {
      id: String(doc['_id'] ?? ''),
      caseNumber: String(doc['caseNumber'] ?? ''),
      patientName: String(doc['patientName'] ?? ''),
      assignedTo: assignedTo && assignedTo['fullName'] ? String(assignedTo['fullName']) : null,
      requesterType:
        String(doc['requesterType'] ?? 'doctor') === 'student'
          ? 'student'
          : String(doc['requesterType'] ?? '') === 'lab'
            ? 'lab'
            : 'doctor',
      doctor: String(parsedMeta['doctor'] ?? ''),
      doctorName: String(parsedMeta['doctor'] ?? ''),
      clinic: '',
      currentStage: forcedCompleted ? 'completed' : String(doc['currentStage'] ?? 'waiting'),
      priority: String(doc['priority'] ?? 'normal'),
      receivedDateDisplay: createdAt ? createdAt.toLocaleString() : 'غير متوفر',
      receivedAt: createdAt,
      deliveryDateDisplay: dueDate ? dueDate.toLocaleString() : 'غير متوفر',
      dueDateDisplay: dueDate ? dueDate.toLocaleString() : 'N/A',
      caseType: String(doc['caseType'] ?? 'General'),
      salary,
      paid,
      enteredBy: createdBy && createdBy['fullName'] ? String(createdBy['fullName']) : 'غير معروف',
      secretaryName: createdBy && createdBy['fullName'] ? String(createdBy['fullName']) : 'غير معروف',
      designerName: String(parsedMeta['designerName'] ?? ''),
      finisherName: String(parsedMeta['finisherName'] ?? ''),
      secretaryInstructions: String(parsedMeta['instructions'] ?? ''),
      designNotes: String(parsedMeta['designNotes'] ?? ''),
      color: String(parsedMeta['color'] ?? ''),
      quantity: Number(parsedMeta['quantity'] ?? 1) || 1,
      deliveryDate: String(parsedMeta['deliveryDate'] ?? ''),
      deliveryTime: String(parsedMeta['deliveryTime'] ?? ''),
      rawNotes: notes,
      source: 'case',
      exitedAt: this.normalizeDate(
        (doc['stageTimestamps'] as Record<string, unknown>)?.['exited'] ?? doc['updatedAt']
      ),
    };
  }

  private mapFinancialReportRowToAdminCase(row: Record<string, unknown>): AdminCaseRow {
    const receivedAt = this.normalizeDate(row['receivedAt']);
    const dueDate = this.normalizeDate(row['dueDate']);
    const exitedAt = this.normalizeDate(row['exitedAt']);
    const salaryAmountRaw = Number(row['salaryAmount']);
    const pricedRaw = Number(row['pricedAmount']);
    const storedOk = Number.isFinite(salaryAmountRaw) && salaryAmountRaw > 0;
    const pricedOk = Number.isFinite(pricedRaw) && pricedRaw > 0;
    const salary = storedOk ? salaryAmountRaw : pricedOk ? pricedRaw : 0;
    const paid = String(row['paymentStatus'] ?? 'unpaid').toLowerCase() === 'paid';

    // استخراج notes من البيانات لو موجودة
    const notes = String(row['notes'] ?? '');
    const parsedMeta = this.parseNotesMeta(notes);

    return {
      id: String(row['id'] ?? ''),
      caseNumber: String(row['caseNumber'] ?? ''),
      patientName: String(row['patientName'] ?? ''),
      assignedTo: String(row['assignedTo'] ?? '') || null,
      requesterType:
        String(row['requesterType'] ?? 'doctor') === 'student'
          ? 'student'
          : String(row['requesterType'] ?? '') === 'lab'
            ? 'lab'
            : 'doctor',
      doctor: String(row['doctorName'] ?? ''),
      doctorName: String(row['doctorName'] ?? ''),
      clinic: '',
      currentStage: String(row['currentStage'] ?? 'completed'),
      priority: 'normal',
      receivedDateDisplay: receivedAt ? receivedAt.toLocaleString() : 'غير متوفر',
      receivedAt: receivedAt || new Date(),
      deliveryDateDisplay: dueDate ? dueDate.toLocaleString() : 'غير متوفر',
      dueDateDisplay: dueDate ? dueDate.toLocaleString() : 'N/A',
      exitedAtDisplay: this.formatDateEn(exitedAt),
      exitedAt,
      caseType: String(row['caseType'] ?? 'General'),
      salary,
      paid,
      enteredBy: 'غير معروف',
      secretaryName: 'غير معروف',
      designerName: '',
      finisherName: '',
      secretaryInstructions: '',
      designNotes: '',
      color: String(parsedMeta['color'] ?? ''),
      quantity: Number(parsedMeta['quantity'] ?? 1) || 1,
      deliveryDate: String(parsedMeta['deliveryDate'] ?? ''),
      deliveryTime: String(parsedMeta['deliveryTime'] ?? ''),
      rawNotes: notes,
      source: 'case',
    };
  }

  private buildPatientsFromCases(cases: AdminCaseRow[]): AdminPatient[] {
    const byName = new Map<string, AdminPatient>();
    for (const c of cases) {
      const key = this.normalizePatientName(c.patientName);
      if (!key) continue;
      if (!byName.has(key)) {
        byName.set(key, {
          id: key,
          name: c.patientName,
          email: 'غير متوفر',
          phone: 'غير متوفر',
          createdAt: c.receivedAt || new Date(),
          dateOfBirth: 'غير متوفر',
          address: 'غير متوفر',
        });
      }
    }
    return Array.from(byName.values());
  }

  private parseNotesMeta(notes: string): Record<string, unknown> {
    const prefix = '__META__\n';
    if (!notes || !notes.startsWith(prefix)) return {};
    try {
      return JSON.parse(notes.slice(prefix.length)) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  formatDateEn(date: Date | string | undefined | null): string {
    if (!date) return 'غير متوفر';
    const d = this.normalizeDate(date);
    if (!d || isNaN(d.getTime())) return 'غير متوفر';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}/${m}/${day}`;
  }

  translateCaseType(type: string): string {
    if (!type) return '';
    return type
      .replace(/modification/gi, 'تعديل')
      .replace(/redo/gi, 'إعادة')
      .replace(/remake/gi, 'إعادة')
      .replace(/unknown/gi, 'غير معروف');
  }

  setPage(page: number): void {
    if (page < 1 || page > this.totalPages) return;
    this.currentPage = page;
  }

  previousPage(): void {
    this.setPage(this.currentPage - 1);
  }

  nextPage(): void {
    this.setPage(this.currentPage + 1);
  }

  trackByCaseId(_index: number, item: AdminCaseRow): string {
    return item.id;
  }

  private resolveUserName(idOrName?: string): string | undefined {
    if (!idOrName) return undefined;
    return this.userNameMap[idOrName] || idOrName;
  }

  showPatientDetails(selectedCase: AdminCaseRow): void {
    this.selectedCase = selectedCase;
    const patient = this.patients.find(p => p.name === selectedCase.patientName);
    if (patient) {
      this.selectedPatient = patient;
      return;
    }

    this.selectedPatient = {
      id: 'unknown',
      name: selectedCase.patientName,
      email: 'غير متوفر',
      phone: 'غير متوفر',
      createdAt: new Date(),
      dateOfBirth: 'غير متوفر',
      address: 'غير متوفر'
    };
  }

  closePatientDetails(): void {
    this.selectedPatient = null;
    this.selectedCase = null;
  }

  openReportCaseDetails(caseItem: AdminCaseRow): void {
    this.selectedReportCase = caseItem;
  }

  closeReportCaseDetails(): void {
    this.selectedReportCase = null;
  }

  setNav(nav: string) {
    if (nav === 'ai') {
      nav = 'dashboard';
    }
    this.activeNav = nav;
    this.persistActiveNav();
    if (nav === 'staff' || nav === 'doctors' || nav === 'students' || nav === 'labs') {
      this.loadStaffFromApi();
      if (nav === 'doctors') this.loadExocadDoctorMappings();
    } else if (nav === 'reports' || nav === 'financials') {
      this.loadFinancialReportFromApi();
      if (nav === 'financials') {
        this.syncFinancePanelPeriod();
      }
    } else if (nav === 'archive') {
      this.loadArchiveList();
    } else if (nav === 'whatsapp') {
      this.loadWhatsAppSettings();
    } else if (nav === 'lab') {
      this.loadLabConfig();
    }
  }

  loadExocadDoctorMappings(): void {
    this.exocadApi.listDoctorMappings().subscribe({
      next: (res) => {
        this.exocadDoctorMappings = res?.data || [];
      },
      error: () => {
        this.exocadDoctorMappings = [];
      },
    });
  }

  saveExocadDoctorMapping(): void {
    const internalDoctorName = this.exocadMapInternalName.trim();
    const exocadNames = this.exocadMapExocadNames
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!internalDoctorName || !exocadNames.length) {
      this.exocadMapMessage = 'اكتب اسم النظام واسم Exocad';
      return;
    }
    this.exocadApi.saveDoctorMapping({ internalDoctorName, exocadNames, active: true }).subscribe({
      next: () => {
        this.exocadMapMessage = 'تم حفظ الربط';
        this.exocadMapInternalName = '';
        this.exocadMapExocadNames = '';
        this.loadExocadDoctorMappings();
      },
      error: (err) => {
        this.exocadMapMessage = err?.error?.message || 'تعذر الحفظ';
      },
    });
  }

  deleteExocadDoctorMapping(id: string): void {
    if (!id) return;
    this.exocadApi.deleteDoctorMapping(id).subscribe({
      next: () => this.loadExocadDoctorMappings(),
      error: () => {
        this.exocadMapMessage = 'تعذر الحذف';
      },
    });
  }

  syncFinancePanelPeriod(): void {
    const now = new Date();
    this.financePanelYear = Number(this.financialYearFilter) || now.getFullYear();
    this.financePanelMonth = Number(this.financialMonthFilter) || now.getMonth() + 1;
  }

  onFinancePanelYearChange(year: number | string): void {
    this.financePanelYear = Number(year) || new Date().getFullYear();
    this.onFinancialYearChange(String(this.financePanelYear));
  }

  waEnabled = false;
  waProvider: 'ultramsg' | 'meta' | 'waweb' = 'waweb';
  waInstanceId = '';
  waPhoneNumberId = '';
  waToken = '';
  waDailyHour = 18;
  waLabName = 'Elegance Dental Lab';
  waMsgCompleted =
    '{lab}\nحالة ({patient})\n{workType} — {quantity} قطعة\nجاهزة للاستلام تواصل مع المعمل لاستلام الحالة';
  waMsgExited =
    '{lab}\nحالة ({patient})\n{workType} — {quantity} قطعة\nتم التسليم / خرجت من المعمل';
  waMsgDaily = '{lab} — ملخص يومي\nعندك {count} حالات جاهزة للاستلام.\n{list}';
  waAlertPhones = '';
  waHasToken = false;
  waLiveConfigured = false;
  waTestPhone = '';
  waTestMessage = '';
  waMsg = '';
  waSaving = false;
  waWebStatus = 'disconnected';
  waWebQr = '';
  waWebError = '';
  waWebBusy = false;
  /** Linked lab WhatsApp digits (from status / settings.web.linkedPhone). */
  waWebLinkedPhone = '';
  private waWebPollTimer: ReturnType<typeof setInterval> | null = null;

  get waWebConnected(): boolean {
    return this.waWebStatus === 'open';
  }

  get waWebStatusLabel(): string {
    switch (this.waWebStatus) {
      case 'open':
        return this.lang.t('admin.wa.statusOpen');
      case 'qr':
        return this.lang.t('admin.wa.statusQr');
      case 'connecting':
        return this.lang.t('admin.wa.statusConnecting');
      default:
        return this.lang.t('admin.wa.statusClosed');
    }
  }

  private applyWaWebStatus(web?: {
    status?: string;
    connected?: boolean;
    qr?: string;
    error?: string;
    linkedPhone?: string;
  }): void {
    if (!web) return;
    this.waWebStatus = String(web.status || (web.connected ? 'open' : 'disconnected'));
    this.waWebQr = web.qr || '';
    this.waWebError = web.error || '';
    if (web.linkedPhone != null && String(web.linkedPhone).trim()) {
      this.waWebLinkedPhone = String(web.linkedPhone).trim();
    }
    if (this.waWebStatus === 'open') {
      this.waLiveConfigured = true;
      this.stopWaWebPoll();
    } else if (this.waWebStatus === 'qr' || this.waWebStatus === 'connecting') {
      this.startWaWebPoll();
    }
  }

  private startWaWebPoll(): void {
    if (this.waWebPollTimer) return;
    this.waWebPollTimer = setInterval(() => this.refreshWhatsAppWebStatus(), 2500);
  }

  private stopWaWebPoll(): void {
    if (this.waWebPollTimer) {
      clearInterval(this.waWebPollTimer);
      this.waWebPollTimer = null;
    }
  }

  onWaProviderChange(): void {
    if (this.waProvider !== 'waweb') {
      this.stopWaWebPoll();
      this.waWebQr = '';
    } else {
      this.refreshWhatsAppWebStatus();
    }
  }

  loadWhatsAppSettings(): void {
    this.waMsg = '';
    this.http.get<{ success?: boolean; settings?: any }>(`${environment.apiUrl}/settings/whatsapp`).subscribe({
      next: (res) => {
        const s = res?.settings || {};
        this.waEnabled = !!s.enabled;
        const p = String(s.provider || 'waweb');
        this.waProvider = p === 'meta' || p === 'ultramsg' || p === 'waweb' ? p : 'waweb';
        this.waInstanceId = s.instanceId || '';
        this.waPhoneNumberId = s.phoneNumberId || '';
        this.waDailyHour = s.dailyHour ?? 18;
        this.waLabName = s.labName || 'Elegance Dental Lab';
        this.waMsgCompleted =
          s.msgCompleted ||
          '{lab}\nحالة ({patient})\n{workType} — {quantity} قطعة\nجاهزة للاستلام تواصل مع المعمل لاستلام الحالة';
        this.waMsgExited =
          s.msgExited ||
          '{lab}\nحالة ({patient})\n{workType} — {quantity} قطعة\nتم التسليم / خرجت من المعمل';
        this.waMsgDaily =
          s.msgDaily || '{lab} — ملخص يومي\nعندك {count} حالات جاهزة للاستلام.\n{list}';
        this.waAlertPhones = s.alertPhones || '';
        this.waHasToken = !!s.hasToken;
        this.waLiveConfigured = !!s.liveConfigured;
        this.waToken = '';
        if (this.waProvider === 'waweb') {
          this.applyWaWebStatus(s.web);
          this.refreshWhatsAppWebStatus();
        } else {
          this.stopWaWebPoll();
        }
      },
      error: (err: any) => {
        const status = err?.status;
        if (status === 404) {
          this.waMsg = 'تعذر تحميل إعدادات واتساب — الباكند قديم أو مش متحدث (مسار /settings/whatsapp غير موجود)';
        } else if (status === 401 || status === 403) {
          this.waMsg = 'تعذر تحميل إعدادات واتساب — صلاحية الأدمن مطلوبة';
        } else {
          this.waMsg = 'تعذر تحميل إعدادات واتساب';
        }
      },
    });
  }

  refreshWhatsAppWebStatus(): void {
    this.http
      .get<{
        success?: boolean;
        status?: string;
        connected?: boolean;
        qr?: string;
        error?: string;
        linkedPhone?: string;
      }>(`${environment.apiUrl}/settings/whatsapp/web/status`)
      .subscribe({
        next: (res) => this.applyWaWebStatus(res),
        error: () => {
          /* ignore poll errors */
        },
      });
  }

  startWhatsAppWeb(force = false): void {
    this.waWebBusy = true;
    this.waMsg = '';
    this.http
      .post<{ success?: boolean; status?: string; connected?: boolean; qr?: string; error?: string; message?: string }>(
        `${environment.apiUrl}/settings/whatsapp/web/start`,
        { force: !!force }
      )
      .subscribe({
        next: (res) => {
          this.waWebBusy = false;
          this.applyWaWebStatus(res);
          this.waMsg = res.connected
            ? 'واتساب Web متصل'
            : res.qr
              ? 'امسح رمز QR من واتساب المعمل'
              : 'جاري تجهيز الاتصال…';
          this.startWaWebPoll();
        },
        error: (err) => {
          this.waWebBusy = false;
          this.waMsg = err?.error?.message || this.lang.t('admin.wa.errStart');
        },
      });
  }

  logoutWhatsAppWeb(): void {
    this.waWebBusy = true;
    this.http
      .post<{ success?: boolean; status?: string; message?: string }>(
        `${environment.apiUrl}/settings/whatsapp/web/logout`,
        {}
      )
      .subscribe({
        next: (res) => {
          this.waWebBusy = false;
          this.stopWaWebPoll();
          this.waWebStatus = 'disconnected';
          this.waWebQr = '';
          this.waWebError = '';
          this.waWebLinkedPhone = '';
          this.waLiveConfigured = false;
          this.waMsg = res.message || this.lang.t('admin.wa.loggedOut');
        },
        error: (err) => {
          this.waWebBusy = false;
          this.waMsg = err?.error?.message || this.lang.t('admin.wa.errLogout');
        },
      });
  }

  saveWhatsAppSettings(): void {
    this.waSaving = true;
    this.waMsg = '';
    const body: Record<string, unknown> = {
      enabled: this.waEnabled,
      provider: this.waProvider,
      instanceId: this.waInstanceId,
      phoneNumberId: this.waPhoneNumberId,
      dailyHour: this.waDailyHour,
      labName: this.waLabName,
      msgCompleted: this.waMsgCompleted,
      msgExited: this.waMsgExited,
      msgDaily: this.waMsgDaily,
      alertPhones: this.waAlertPhones,
    };
    if (this.waProvider !== 'waweb' && this.waToken.trim()) body['token'] = this.waToken.trim();
    this.http.put<{ success?: boolean; message?: string; liveConfigured?: boolean; web?: any }>(
      `${environment.apiUrl}/settings/whatsapp`,
      body
    ).subscribe({
      next: (res) => {
        this.waSaving = false;
        this.waLiveConfigured = !!res.liveConfigured;
        this.waMsg = res.message || this.lang.t('admin.wa.saved');
        this.waToken = '';
        this.applyWaWebStatus(res.web);
        this.loadWhatsAppSettings();
        if (this.waProvider === 'waweb' && this.waEnabled) {
          this.startWhatsAppWeb();
        }
      },
      error: (err) => {
        this.waSaving = false;
        this.waMsg = err?.error?.message || this.lang.t('admin.wa.errSave');
      },
    });
  }

  testWhatsApp(): void {
    this.waMsg = '';
    this.http
      .post<{ success?: boolean; message?: string; to?: string }>(
        `${environment.apiUrl}/settings/whatsapp/test`,
        {
          phone: this.waTestPhone,
          message: this.waTestMessage,
        }
      )
      .subscribe({
        next: (res) => {
          let msg = res.message || this.lang.t('admin.wa.sent');
          if (res.to) {
            msg = `${msg} — ${res.to}`;
          }
          this.waMsg = msg;
        },
        error: (err) => {
          const body = err?.error;
          let msg = body?.message || this.lang.t('admin.wa.errTest');
          if (body?.detail?.self) {
            msg =
              '⛔ هذا رقم واتساب المعمل المربوط نفسه — الرسائل المرسلة لنفس الرقم مش هتظهر كإشعار على الموبايل. جرّب رقم موبايل تاني عليه واتساب للاختبار.' +
              (this.waWebLinkedPhone ? ` (الرقم المربوط: ${this.waWebLinkedPhone})` : '') +
              (body?.message ? `\n${body.message}` : '');
          }
          this.waMsg = msg;
        },
      });
  }

  runWhatsAppDailyNow(): void {
    this.waMsg = '';
    this.http.post<{ success?: boolean; message?: string }>(
      `${environment.apiUrl}/settings/whatsapp/daily-summary`,
      {}
    ).subscribe({
      next: (res) => {
        this.waMsg = res.message || this.lang.t('admin.wa.dailySent');
      },
      error: (err) => {
        this.waMsg = err?.error?.message || this.lang.t('admin.wa.errDaily');
      },
    });
  }

  get archiveYears(): number[] {
    const y = new Date().getFullYear();
    return [y, y - 1, y - 2, y - 3];
  }

  get archiveMonths(): number[] {
    return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  }

  get reportYears(): number[] {
    const years = new Set<number>();
    this.reportCases.forEach((c) => {
      const d = c.exitedAt || c.receivedAt;
      if (d) years.add((d instanceof Date ? d : new Date(d)).getFullYear());
    });
    const current = new Date().getFullYear();
    years.add(current);
    return Array.from(years).sort((a, b) => b - a);
  }

  get reportMonthsForSelectedYear(): number[] {
    if (!this.reportYearFilter) return [];
    return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  }

  onReportYearChange(value: string): void {
    this.reportYearFilter = value;
    if (!value) {
      this.reportMonthFilter = '';
      return;
    }
    const now = new Date();
    if (!this.reportMonthFilter) {
      this.reportMonthFilter =
        Number(value) === now.getFullYear() ? String(now.getMonth() + 1) : '1';
      return;
    }
    if (!this.reportMonthsForSelectedYear.includes(Number(this.reportMonthFilter))) {
      this.reportMonthFilter =
        Number(value) === now.getFullYear() ? String(now.getMonth() + 1) : '1';
    }
  }

  loadArchiveList(): void {
    this.monthArchiveApi.listArchives().subscribe({
      next: (res) => {
        this.archiveList = res?.data || [];
      },
      error: () => {
        this.archiveList = [];
      },
    });
  }

  downloadMonthArchive(): void {
    const year = Number(this.archiveYearFilter);
    const month = Number(this.archiveMonthFilter);
    if (!year || !month) {
      this.archiveError = 'اختر السنة والشهر أولاً';
      return;
    }
    this.archiveError = '';
    this.archiveSuccess = '';
    this.archiveLoading = true;
    this.monthArchiveApi.exportZip(year, month).subscribe({
      next: (blob) => {
        this.archiveLoading = false;
        const filename = `Elegance-Lab-Export-${year}-${String(month).padStart(2, '0')}.zip`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        this.archiveSuccess = `تم التحميل: ${filename} — لو الملف مش ظاهر، شوف مجلد Downloads`;
        this.loadArchiveList();
      },
      error: (err: unknown) => {
        this.archiveLoading = false;
        const message =
          err instanceof Error
            ? err.message
            : err instanceof HttpErrorResponse
              ? String(err.error?.message || err.message || 'فشل التحميل')
              : 'فشل التحميل';
        this.archiveError = message;
      },
    });
  }

  downloadJsonBackup(): void {
    const year = Number(this.archiveYearFilter);
    const month = Number(this.archiveMonthFilter);
    if (!year || !month) {
      this.archiveError = 'اختر السنة والشهر أولاً';
      return;
    }
    this.archiveError = '';
    this.archiveSuccess = '';
    this.archiveLoading = true;
    this.monthArchiveApi.exportJsonBackup(year, month).subscribe({
      next: (blob) => {
        this.archiveLoading = false;
        const filename = `elegance-backup-${year}-${String(month).padStart(2, '0')}.json`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        this.archiveSuccess = `تم تنزيل النسخة الاحتياطية: ${filename}`;
      },
      error: (err: unknown) => {
        this.archiveLoading = false;
        this.archiveError = err instanceof Error ? err.message : 'فشل النسخ الاحتياطي';
      },
    });
  }

  closeSelectedMonth(): void {
    const year = Number(this.archiveYearFilter);
    const month = Number(this.archiveMonthFilter);
    const expected = `${year}-${String(month).padStart(2, '0')}`;
    if (this.archiveConfirm.trim() !== expected) {
      this.archiveError = `للتأكيد اكتب: ${expected}`;
      return;
    }
    if (
      !confirm(
        `سيتم حذف كل الحالات الخارجة وتصفير الدفعات. الحالات اللي لسه في الكل/الجديدة/المنتهية هتفضل. متأكد؟`
      )
    ) {
      return;
    }
    this.archiveError = '';
    this.archiveSuccess = '';
    this.archiveClosing = true;
    this.monthArchiveApi
      .closeMonth({ year, month, confirm: expected })
      .subscribe({
        next: (res) => {
          this.archiveClosing = false;
          this.archiveConfirm = '';
          this.archiveSuccess =
            res?.message ||
            `تم الإغلاق. محذوف ${res?.data?.deletedExitedCases || 0} حالة خارجة. متبقي شغّال: ${res?.data?.activeCasesKept || 0}`;
          this.loadArchiveList();
          this.loadFinancialReportFromApi();
          this.loadCasesFromApi();
        },
        error: (err: unknown) => {
          this.archiveClosing = false;
          this.archiveError =
            err instanceof HttpErrorResponse
              ? String(err.error?.message || err.message || 'فشل إغلاق الشهر')
              : 'فشل إغلاق الشهر';
        },
      });
  }

  askAi(presetQuestion?: string): void {
    const question = (presetQuestion ?? this.aiQuestion).trim();
    if (!question || this.aiLoading) return;

    this.aiError = '';
    this.aiMessages = [
      ...this.aiMessages,
      { role: 'user', text: question, createdAt: new Date() },
    ];
    this.aiQuestion = '';
    this.aiLoading = true;

    const year = this.aiYearFilter ? Number(this.aiYearFilter) : null;
    const month = this.aiMonthFilter ? Number(this.aiMonthFilter) : null;
    this.aiApi.askAssistant(question, year, month).subscribe({
      next: (res) => {
        this.aiLoading = false;
        this.aiMessages = [
          ...this.aiMessages,
          {
            role: 'assistant',
            text: String(res?.answer || 'تعذر توليد الإجابة'),
            createdAt: new Date(),
          },
        ];
      },
      error: (err: unknown) => {
        this.aiLoading = false;
        const message =
          err instanceof HttpErrorResponse
            ? String(err.error?.message || err.message || 'تعذر تحليل السؤال')
            : 'تعذر تحليل السؤال';
        this.aiError = message;
        this.aiMessages = [
          ...this.aiMessages,
          {
            role: 'assistant',
            text: `تعذر الرد الآن: ${message}`,
            createdAt: new Date(),
          },
        ];
      },
    });
  }

  openAddStaffModal() {
    this.isEditMode = false;
    this.staffModalError = '';
    this.showStaffPassword = false;
    this.currentStaff = {
      id: '',
      name: '',
      email: '',
      password: '',
      phone: '',
      position: '',
      status: 'active',
      joinDate: new Date().toISOString().split('T')[0],
    };
    this.showStaffModal = true;
  }

  openEditStaffModal(staff: StaffMember) {
    this.isEditMode = true;
    this.staffModalError = '';
    this.showStaffPassword = false;
    this.currentStaff = { ...staff, password: '' };
    this.showStaffModal = true;
  }

  closeStaffModal() {
    this.showStaffModal = false;
    this.showStaffPassword = false;
    this.staffModalError = '';
    this.staffSaving = false;
  }

  loadStaffFromApi(): void {
    this.staffLoadError = '';
    this.doctorLoadError = '';
    this.userApi.getAllUsers(undefined, undefined, true).subscribe({
      next: (res) => {
        const list = (res?.data ?? res?.users ?? []) as Record<string, unknown>[];
        const mapped = Array.isArray(list) ? list.map((u) => this.mapApiUserToStaff(u)) : [];
        this.doctorMembers = mapped.filter((m) => m.position === 'دكتور');
        this.studentMembers = mapped.filter((m) => m.position === 'طالب');
        this.labMembers = mapped.filter((m) => m.position === 'معمل');
        this.staffMembers = mapped.filter(
          (m) => m.position !== 'دكتور' && m.position !== 'طالب' && m.position !== 'معمل'
        );
      },
      error: (err) => {
        console.error(err);
        this.staffLoadError = 'تعذر تحميل قائمة الموظفين من الخادم';
        this.doctorLoadError = 'تعذر تحميل قائمة الحسابات من الخادم';
        this.staffMembers = [];
        this.doctorMembers = [];
        this.studentMembers = [];
        this.labMembers = [];
      },
    });
  }

  toggleStaffActive(staff: StaffMember): void {
    if (!staff.id) return;
    const targetActive = staff.status !== 'active';
    this.userApi
      .updateUser(staff.id, { isActive: targetActive })
      .subscribe({
        next: () => this.loadStaffFromApi(),
        error: (err) => {
          console.error(err);
          this.staffLoadError = 'تعذر تحديث حالة الموظف';
        },
      });
  }

  deleteStaff(staff: StaffMember): void {
    if (!staff.id) return;
    const ok = confirm(`هل أنت متأكد من حذف ${staff.name} نهائياً؟ لا يمكن التراجع عن هذا الإجراء.`);
    if (!ok) return;
    this.userApi.deleteUser(staff.id).subscribe({
      next: () => this.loadStaffFromApi(),
      error: (err) => {
        console.error(err);
        this.staffLoadError = 'تعذر حذف الموظف';
      },
    });
  }

  private mapApiUserToStaff(u: Record<string, unknown>): StaffMember {
    const id = String(u['_id'] ?? u['id'] ?? '');
    const role = String(u['role'] ?? 'secretary');
    const created = u['createdAt'] as string | undefined;
    let joinDate = new Date().toISOString().split('T')[0];
    if (created) {
      try {
        joinDate = new Date(created).toISOString().split('T')[0];
      } catch {
        /* ignore */
      }
    }
    return {
      id,
      name: String(u['fullName'] ?? ''),
      email: String(u['email'] ?? ''),
      password: '',
      loginPasswordVisible: String(u['loginPasswordVisible'] ?? ''),
      phone: String(u['phone'] ?? ''),
      position: this.roleToPositionLabel(role),
      status: u['isActive'] === false ? 'inactive' : 'active',
      joinDate,
    };
  }

  private roleToPositionLabel(role: string): string {
    const r = (role || '').toLowerCase();
    if (r === 'admin') return 'مدير';
    if (r === 'secretary') return 'سكرتير';
    if (r === 'designer') return 'مصمم';
    if (r === 'finisher') return 'مسؤول الطباعة';
    if (r === 'requester') return 'ريكويست';
    if (r === 'doctor') return 'دكتور';
    if (r === 'student') return 'طالب';
    if (r === 'lab') return 'معمل';
    if (r === 'scanner1') return 'سكان 1';
    if (r === 'scanner2') return 'سكان 2';
    if (r === 'scanner3') return 'سكان 3';
    return 'سكرتير';
  }

  private positionLabelToRole(position: string): AppRole {
    const p = (position || '').trim().toLowerCase();
    if (p === 'admin' || p === 'مدير') return 'admin';
    if (p === 'secretary' || p === 'سكرتير') return 'secretary';
    if (p === 'designer' || p === 'مصمم') return 'designer';
    if (p === 'finisher' || p === 'مسؤول الطباعة' || p === 'فني تشطيب') return 'finisher';
    if (p === 'requester' || p === 'ريكويست') return 'requester';
    if (p === 'doctor' || p === 'دكتور') return 'doctor';
    if (p === 'student' || p === 'طالب') return 'student';
    if (p === 'lab' || p === 'معمل') return 'lab';
    if (p === 'scanner1' || p === 'سكان 1' || p === 'سكان١') return 'scanner1';
    if (p === 'scanner2' || p === 'سكان 2' || p === 'سكان٢') return 'scanner2';
    if (p === 'scanner3' || p === 'سكان 3' || p === 'سكان٣') return 'scanner3';
    return 'secretary';
  }

  openAddDoctorModal() {
    this.isDoctorEditMode = false;
    this.doctorModalError = '';
    this.showDoctorPassword = false;
    this.currentDoctor = {
      id: '',
      name: '',
      email: '',
      password: '',
      phone: '',
      position: this.clientPositionLabel(),
      status: 'active',
      joinDate: new Date().toISOString().split('T')[0],
    };
    this.showDoctorModal = true;
  }

  openEditDoctorModal(doc: StaffMember) {
    this.isDoctorEditMode = true;
    this.doctorModalError = '';
    this.showDoctorPassword = true;
    this.currentDoctor = { ...doc, password: '', position: this.clientPositionLabel() };
    this.showDoctorModal = true;
  }

  /** From doctors/students/labs directory → open that account's portal. */
  openDoctorAccountPage(doc: StaffMember): void {
    const name = (doc?.name || '').trim();
    if (!name) return;
    const kind = this.clientDirectoryKind;
    this.router.navigate(['/doctor/dashboard'], {
      queryParams: kind === 'doctor' ? { as: name } : { as: name, kind },
    });
  }

  closeDoctorModal() {
    this.showDoctorModal = false;
    this.showDoctorPassword = false;
    this.doctorModalError = '';
    this.doctorSaving = false;
  }

  convertingAccountId = '';

  convertDirectoryAccount(doc: StaffMember, kind: ClientAccountKind): void {
    if (!doc.id || kind === this.clientDirectoryKind || this.convertingAccountId) return;
    const kindLabel =
      kind === 'student'
        ? this.lang.t('secretary.clients.toStudent')
        : kind === 'lab'
          ? this.lang.t('secretary.clients.toLab')
          : this.lang.t('secretary.clients.toDoctor');
    const ok = confirm(
      this.lang
        .t('secretary.clients.convertConfirm')
        .replace('{name}', doc.name)
        .replace('{kind}', kindLabel)
    );
    if (!ok) return;
    this.convertingAccountId = doc.id;
    this.userApi.convertClientRole(doc.id, kind).subscribe({
      next: (res) => {
        this.convertingAccountId = '';
        const n = Number(res?.updatedCases ?? 0);
        this.doctorLoadError = '';
        this.loadStaffFromApi();
        alert(this.lang.t('secretary.clients.convertDone').replace('{n}', String(n)));
      },
      error: (err) => {
        this.convertingAccountId = '';
        const raw = String(err?.error?.message || '').trim();
        this.doctorLoadError = /route not found/i.test(raw)
          ? this.lang.t('secretary.clients.convertNeedDeploy')
          : raw || 'تعذر تحويل الحساب';
      },
    });
  }

  toggleDoctorActive(doc: StaffMember): void {
    if (!doc.id) return;
    const targetActive = doc.status !== 'active';
    this.userApi.updateUser(doc.id, { isActive: targetActive }).subscribe({
      next: () => this.loadStaffFromApi(),
      error: (err) => {
        console.error(err);
        this.doctorLoadError = 'تعذر تحديث حالة الحساب';
      },
    });
  }

  deleteDoctor(doc: StaffMember): void {
    if (!doc.id) return;
    const kindLabel = this.clientPositionLabel();
    const ok = confirm(`هل أنت متأكد من حذف حساب ${kindLabel} ${doc.name} نهائياً؟`);
    if (!ok) return;
    this.userApi.deleteUser(doc.id).subscribe({
      next: () => this.loadStaffFromApi(),
      error: (err) => {
        console.error(err);
        this.doctorLoadError = 'تعذر حذف الحساب';
      },
    });
  }

  saveDoctor(): void {
    this.doctorModalError = '';
    const name = (this.currentDoctor.name || '').trim();
    const email = (this.currentDoctor.email || '').trim();
    const phone = (this.currentDoctor.phone || '').trim() || '0000000000';
    if (!name) {
      this.doctorModalError =
        this.clientDirectoryKind === 'student'
          ? 'يرجى إدخال اسم الطالب'
          : this.clientDirectoryKind === 'lab'
            ? 'يرجى إدخال اسم المعمل'
            : 'يرجى إدخال اسم الدكتور';
      return;
    }
    if (!email) {
      this.doctorModalError = 'يرجى إدخال البريد الإلكتروني';
      return;
    }

    if (this.isDoctorEditMode) {
      if (!this.currentDoctor.id) return;
      const patch: Record<string, unknown> = {
        fullName: name,
        phone,
        role: this.clientDirectoryKind,
        department: this.clientPositionLabel(),
        isActive: this.currentDoctor.status === 'active',
      };
      if (this.currentDoctor.password?.trim()) {
        if (this.currentDoctor.password.trim().length < 6) {
          this.doctorModalError = 'كلمة المرور يجب ألا تقل عن 6 أحرف';
          return;
        }
        patch['password'] = this.currentDoctor.password.trim();
      }
      this.doctorSaving = true;
      this.userApi.updateUser(this.currentDoctor.id, patch).subscribe({
        next: () => {
          this.doctorSaving = false;
          this.closeDoctorModal();
          this.loadStaffFromApi();
        },
        error: (err) => {
          this.doctorSaving = false;
          this.doctorModalError = err?.error?.message || 'تعذر تحديث الحساب';
        },
      });
      return;
    }

    if (!this.currentDoctor.password || this.currentDoctor.password.length < 6) {
      this.doctorModalError = 'كلمة المرور يجب ألا تقل عن 6 أحرف';
      return;
    }

    this.doctorSaving = true;
    this.auth
      .registerStaff({
        fullName: name,
        email: email.toLowerCase(),
        phone,
        password: this.currentDoctor.password,
        role: this.clientDirectoryKind,
        department: this.clientPositionLabel(),
      })
      .subscribe({
        next: () => {
          this.doctorSaving = false;
          this.closeDoctorModal();
          this.loadStaffFromApi();
        },
        error: (err) => {
          this.doctorSaving = false;
          this.doctorModalError = err?.error?.message || 'تعذر إنشاء الحساب';
        },
      });
  }

  private formatStaffApiError(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      const msg = err.error?.message;
      if (msg && typeof msg === 'string') return msg;
      const errs = err.error?.errors;
      if (Array.isArray(errs) && errs[0]?.msg) return String(errs[0].msg);
      if (err.status === 403) return 'غير مصرح — يجب تسجيل الدخول كمدير';
      if (err.status === 400) return 'بيانات غير صالحة أو المستخدم موجود بالفعل';
    }
    return 'حدث خطأ أثناء الحفظ';
  }

  saveStaff(): void {
    this.staffModalError = '';
    const name = this.currentStaff.name?.trim();
    const email = this.currentStaff.email?.trim();
    if (!name || !email) {
      this.staffModalError = 'الاسم والبريد مطلوبان';
      return;
    }
    if (!this.isEditMode) {
      if (!this.currentStaff.password?.trim()) {
        this.staffModalError = 'كلمة المرور مطلوبة للمستخدم الجديد';
        return;
      }
      if (this.currentStaff.password.length < 6) {
        this.staffModalError = 'كلمة المرور يجب أن تكون 6 أحرف على الأقل';
        return;
      }
    } else {
      const pw = this.currentStaff.password?.trim();
      if (pw && pw.length < 6) {
        this.staffModalError = 'كلمة المرور يجب أن تكون 6 أحرف على الأقل';
        return;
      }
    }
    if (!this.currentStaff.position?.trim()) {
      this.staffModalError = 'اختر المنصب';
      return;
    }

    const phone = this.currentStaff.phone?.trim() || '0000000000';

    if (this.isEditMode) {
      if (!this.currentStaff.id) return;
      this.staffSaving = true;
      const body: Record<string, unknown> = {
        fullName: name,
        phone,
        department: this.currentStaff.position.trim(),
        role: this.positionLabelToRole(this.currentStaff.position),
        isActive: this.currentStaff.status === 'active',
      };
      if (this.currentStaff.password?.trim()) {
        body['password'] = this.currentStaff.password;
      }
      this.userApi.updateUser(this.currentStaff.id, body).subscribe({
        next: () => {
          this.staffSaving = false;
          this.closeStaffModal();
          this.loadStaffFromApi();
        },
        error: (err: unknown) => {
          this.staffSaving = false;
          this.staffModalError = this.formatStaffApiError(err);
        },
      });
      return;
    }

    const role = this.positionLabelToRole(this.currentStaff.position);
    this.staffSaving = true;
    this.auth
      .registerStaff({
        fullName: name,
        email: email.toLowerCase(),
        phone,
        password: this.currentStaff.password,
        role,
        department: this.currentStaff.position.trim(),
      })
      .subscribe({
        next: () => {
          this.staffSaving = false;
          this.closeStaffModal();
          this.loadStaffFromApi();
        },
        error: (err: unknown) => {
          this.staffSaving = false;
          this.staffModalError = this.formatStaffApiError(err);
        },
      });
  }

  private restoreActiveNav(): void {
    const nav = (this.route.snapshot.queryParamMap.get('nav') || '').trim();
    const allowed = new Set([
      'dashboard',
      'staff',
      'doctors',
      'students',
      'labs',
      'financials',
      'reports',
      'archive',
      'whatsapp',
      'lab',
      'case-management',
    ]);
    if (nav && allowed.has(nav)) {
      this.setNav(nav);
    }
  }

  private persistActiveNav(): void {
    // localStorage removed
  }

  loadDoctorPricings(): void {
    this.caseApi.getDoctorPricings().subscribe({
      next: (res) => {
        const list = res?.data || [];
        this.doctorPricingsMap.clear();
        list.forEach((item: any) => {
          if (item.doctorName) {
            const key = this.doctorGroupKey(item.doctorName);
            const prev = this.doctorPricingsMap.get(key) || {};
            const next = { ...prev, ...(item.prices || {}) };
            // case-insensitive aliases
            for (const [pk, pv] of Object.entries(item.prices || {})) {
              const n = Number(pv);
              if (!Number.isFinite(n) || n < 0) continue;
              next[pk] = n;
              next[String(pk).toLowerCase()] = n;
            }
            this.doctorPricingsMap.set(key, next);
          }
        });
        if (this.reportDoctorFilter) {
          this.loadCustomPricesForDoctor(this.reportDoctorFilter);
        }
      },
      error: (err) => {
        console.error('Failed to load doctor pricings:', err);
      }
    });
  }

  loadCustomPricesForDoctor(doctorName: string): void {
    const key = this.doctorGroupKey(doctorName);
    const custom = this.doctorPricingsMap.get(key) || {};
    this.pricingSaveSuccess = false;
    this.pricingSaveError = '';
    this.customPricesMap = {};
    const customLookup = (materialKey: string): number | undefined => {
      if (custom[materialKey] !== undefined && custom[materialKey] !== null && custom[materialKey] !== '') {
        return Number(custom[materialKey]);
      }
      const lower = materialKey.toLowerCase();
      if (custom[lower] !== undefined && custom[lower] !== null && custom[lower] !== '') {
        return Number(custom[lower]);
      }
      for (const [k, v] of Object.entries(custom)) {
        if (String(k).toLowerCase() === lower) return Number(v);
      }
      return undefined;
    };
    for (const m of this.labMaterials) {
      const def = this.labDefaultPrices[m.key] ?? (Number(m.defaultPrice) || 0);
      const fromCustom = customLookup(m.key);
      this.customPricesMap[m.key] = Number.isFinite(fromCustom as number)
        ? (fromCustom as number)
        : def;
      // Keep camelCase alias for older billing paths
      if (m.key !== m.key.toLowerCase()) {
        this.customPricesMap[m.key.toLowerCase()] = this.customPricesMap[m.key];
      }
    }
    this.customEmaxPrice = this.customPricesMap['emax'] ?? customLookup('emax') ?? 1000;
    this.customGermanZirconPrice =
      this.customPricesMap['germanZircon'] ??
      this.customPricesMap['germanzircon'] ??
      customLookup('germanZircon') ??
      850;
    this.customZirconPrice = this.customPricesMap['zircon'] ?? customLookup('zircon') ?? 700;
    this.customTitaniumPrice = this.customPricesMap['titanium'] ?? customLookup('titanium') ?? 2200;
    this.customPeekPrice = this.customPricesMap['peek'] ?? customLookup('peek') ?? 1700;
    this.customPmmaPrice =
      this.customPricesMap['pmma'] ?? this.customPricesMap['pmmaCad'] ?? customLookup('pmma') ?? 250;
    this.customNightGuardPrice =
      this.customPricesMap['nightGuard'] ??
      this.customPricesMap['nightguard'] ??
      customLookup('nightGuard') ??
      300;
    this.customMockupPrice =
      this.customPricesMap['mockup'] ??
      this.customPricesMap['mokup'] ??
      customLookup('mockup') ??
      250;
    this.customWaxPrice = this.customPricesMap['wax'] ?? customLookup('wax') ?? 0;
    this.customRingPrice = this.customPricesMap['ring'] ?? customLookup('ring') ?? 0;
    this.customTryInPrice =
      this.customPricesMap['tryIn'] ?? this.customPricesMap['tryin'] ?? customLookup('tryIn') ?? 0;
  }

  saveDoctorCustomPrices(): void {
    if (!this.reportDoctorFilter) return;
    this.isPricingSaving = true;
    this.pricingSaveSuccess = false;
    this.pricingSaveError = '';

    const prices: Record<string, number> =
      Object.keys(this.customPricesMap).length > 0
        ? { ...this.customPricesMap }
        : {
            emax: this.customEmaxPrice,
            germanZircon: this.customGermanZirconPrice,
            zircon: this.customZirconPrice,
            titanium: this.customTitaniumPrice,
            peek: this.customPeekPrice,
            pmma: this.customPmmaPrice,
            nightGuard: this.customNightGuardPrice,
            mockup: this.customMockupPrice,
            wax: this.customWaxPrice,
            ring: this.customRingPrice,
            tryIn: this.customTryInPrice,
          };

    this.caseApi.updateDoctorPricing(this.reportDoctorFilter, prices).subscribe({
      next: () => {
        this.isPricingSaving = false;
        this.pricingSaveSuccess = true;
        const key = this.doctorGroupKey(this.reportDoctorFilter);
        this.doctorPricingsMap.set(key, prices);
        this.loadFinancialReportFromApi();
      },
      error: (err) => {
        this.isPricingSaving = false;
        this.pricingSaveError = 'تعذر حفظ الأسعار المخصصة';
        console.error('Failed to update doctor pricing:', err);
      },
    });
  }

  loadLabConfig(): void {
    this.labMsg = '';
    this.matMsg = '';
    this.matMsgError = false;
    // Materials first — this is what the admin page needs
    this.labConfig.listMaterials(false).subscribe({
      next: (materials) => {
        this.labMaterials = materials || [];
        this.labDefaultPrices = {};
        for (const m of this.labMaterials) {
          this.labDefaultPrices[m.key] = Number(m.defaultPrice) || 0;
        }
        if (this.reportDoctorFilter) {
          this.loadCustomPricesForDoctor(this.reportDoctorFilter);
        }
      },
      error: (err) => {
        const status = err?.status;
        this.labMsg =
          status === 404
            ? 'الباكند لسه مش محدّث على Railway — مسار الماتريال غير موجود. لازم نشر الباكند.'
            : 'تعذر تحميل قائمة الماتريال';
        console.error(err);
      },
    });
    // Optional branding/workflow (ignore failures)
    this.labConfig.getLabSettings().subscribe({
      next: (res) => {
        this.labBranding = { ...res.branding };
        this.labWorkflow = { ...res.workflow };
        if (res.defaultPrices) this.labDefaultPrices = { ...res.defaultPrices };
      },
      error: () => {
        /* branding optional */
      },
    });
  }

  isStageEnabled(stage: string): boolean {
    return (this.labWorkflow.enabledStages || []).includes(stage);
  }

  toggleStage(stage: string, enabled: boolean): void {
    const locked = stage === 'waiting' || stage === 'completed' || stage === 'exited';
    if (locked) return;
    const all = this.labWorkflow.allStages || [];
    const set = new Set(this.labWorkflow.enabledStages || []);
    if (enabled) set.add(stage);
    else set.delete(stage);
    this.labWorkflow.enabledStages = all.filter((s) => set.has(s));
  }

  saveLabSettings(): void {
    this.labSaving = true;
    this.labMsg = '';
    this.labConfig
      .updateLabSettings({
        branding: this.labBranding,
        workflow: {
          enabledStages: this.labWorkflow.enabledStages,
          allowSkipSecretary: this.labWorkflow.allowSkipSecretary,
          allowSkipKhart: this.labWorkflow.allowSkipKhart,
        },
      })
      .subscribe({
        next: () => {
          this.labSaving = false;
          this.labMsg = 'تم حفظ إعدادات المعمل';
          this.waLabName = this.labBranding.labName;
        },
        error: (err) => {
          this.labSaving = false;
          this.labMsg = err?.error?.message || 'تعذر حفظ الإعدادات';
        },
      });
  }

  addMaterial(): void {
    this.matMsg = '';
    this.matMsgError = false;
    const label = String(this.matDraft.label || '').trim();
    if (!label) {
      this.matMsg = 'اكتب اسم الماتريال';
      this.matMsgError = true;
      return;
    }
    this.matSaving = true;
    const keywords = this.matKeywordsText
      .split(/[,|\n]/)
      .map((k) => k.trim())
      .filter(Boolean);
    this.labConfig
      .createMaterial({
        label,
        key: this.matDraft.key || label,
        labelAr: this.matDraft.labelAr || '',
        defaultPrice: Number(this.matDraft.defaultPrice) || 0,
        matchKeywords: keywords.length ? keywords : [label.toLowerCase()],
        sortOrder: Number(this.matDraft.sortOrder) || 100,
        active: true,
        showInWorkTypes: true,
        showInCounters: true,
      })
      .subscribe({
        next: () => {
          this.matSaving = false;
          this.matDraft = { label: '', key: '', defaultPrice: 0, matchKeywords: [], sortOrder: 100 };
          this.matKeywordsText = '';
          this.matMsg = 'تمت إضافة الماتريال';
          this.loadLabConfig();
        },
        error: (err) => {
          this.matSaving = false;
          this.matMsgError = true;
          this.matMsg =
            err?.status === 404
              ? 'الباكند مش محدّث — انشر Railway الأول'
              : err?.error?.message || 'تعذر الإضافة';
        },
      });
  }

  saveMaterialRow(m: LabMaterial): void {
    if (!m._id) return;
    this.matSaving = true;
    this.matMsgError = false;
    this.labConfig
      .updateMaterial(m._id, {
        label: m.label,
        labelAr: m.labelAr,
        defaultPrice: Number(m.defaultPrice) || 0,
        matchKeywords: m.matchKeywords?.length ? m.matchKeywords : [String(m.label || '').toLowerCase()],
        active: m.active,
        sortOrder: Number(m.sortOrder) || 100,
        showInWorkTypes: m.showInWorkTypes,
        showInCounters: m.showInCounters,
      })
      .subscribe({
        next: () => {
          this.matSaving = false;
          this.matMsg = `تم حفظ «${m.label}»`;
          this.loadLabConfig();
        },
        error: (err) => {
          this.matSaving = false;
          this.matMsgError = true;
          this.matMsg = err?.error?.message || 'تعذر الحفظ';
        },
      });
  }

  removeMaterial(m: LabMaterial): void {
    if (!m._id) return;
    if (!confirm(`حذف الماتريال «${m.label}»؟`)) return;
    this.matSaving = true;
    this.matMsgError = false;
    this.labConfig.deleteMaterial(m._id).subscribe({
      next: () => {
        this.matSaving = false;
        this.matMsg = 'تم الحذف';
        this.loadLabConfig();
      },
      error: (err) => {
        this.matSaving = false;
        this.matMsgError = true;
        this.matMsg = err?.error?.message || 'تعذر الحذف';
      },
    });
  }

  keywordsToText(m: LabMaterial): string {
    return (m.matchKeywords || []).join(', ');
  }

  setMaterialKeywords(m: LabMaterial, text: string): void {
    m.matchKeywords = String(text || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  }

  loadDoctorPayments(): void {
    this.caseApi.getDoctorPayments().subscribe({
      next: (res) => {
        this.doctorPayments = res?.data ?? [];
      },
      error: (err) => {
        console.error('Error loading doctor payments:', err);
        this.doctorPayments = [];
      }
    });
  }

  addDoctorPaymentOnAccount(): void {
    if (!this.reportDoctorFilter || !this.newPaymentAmount || this.newPaymentAmount <= 0) return;
    this.paymentSaving = true;
    this.paymentError = '';

    this.caseApi.addDoctorPayment(
      this.reportDoctorFilter,
      this.newPaymentAmount,
      this.newPaymentNotes
    ).subscribe({
      next: () => {
        this.paymentSaving = false;
        this.newPaymentAmount = null;
        this.newPaymentNotes = '';
        this.loadDoctorPayments();
      },
      error: (err) => {
        this.paymentSaving = false;
        this.paymentError = 'تعذر تسجيل الدفعة المالية: ' + (err.error?.message || err.message);
        console.error('Failed to add doctor payment:', err);
      }
    });
  }

  deleteDoctorPaymentOnAccount(id: string): void {
    if (!confirm('هل أنت متأكد من حذف هذه الدفعة المالية؟')) return;
    this.caseApi.deleteDoctorPayment(id).subscribe({
      next: () => {
        this.loadDoctorPayments();
      },
      error: (err) => {
        alert('تعذر حذف الدفعة: ' + (err.error?.message || err.message));
        console.error('Failed to delete doctor payment:', err);
      }
    });
  }

  /** Ledger payment (reduces due) — not an invoice charge. */
  private isDoctorLedgerPayment(p: any): boolean {
    return !this.isDoctorLedgerCharge(p);
  }

  /** Invoice increase — must never count as received payment. */
  private isDoctorLedgerCharge(p: any): boolean {
    const type = String(p?.entryType || '').toLowerCase().trim();
    if (type === 'charge') return true;
    // Safety net if an older API stripped entryType but kept the charge marker in notes
    const notes = String(p?.notes || '');
    return notes.startsWith('[CHARGE]') || notes.startsWith('[زيادة]');
  }

  getDoctorPaymentsList(doctorName: string): any[] {
    const key = this.doctorGroupKey(doctorName);
    return this.doctorPayments.filter(
      (p) => this.doctorGroupKey(p.doctorName) === key && this.isDoctorLedgerPayment(p)
    );
  }

  getDoctorChargesList(doctorName: string): any[] {
    const key = this.doctorGroupKey(doctorName);
    return this.doctorPayments.filter(
      (p) => this.doctorGroupKey(p.doctorName) === key && this.isDoctorLedgerCharge(p)
    );
  }

  addDoctorChargeOnAccount(): void {
    if (!this.reportDoctorFilter || !this.newChargeAmount || this.newChargeAmount <= 0) return;
    this.chargeSaving = true;
    this.chargeError = '';

    const rawNotes = String(this.newChargeNotes || '').trim();
    const notesWithMarker = rawNotes
      ? rawNotes.startsWith('[CHARGE]') || rawNotes.startsWith('[زيادة]')
        ? rawNotes
        : `[CHARGE] ${rawNotes}`
      : '[CHARGE]';

    this.caseApi
      .addDoctorPayment(
        this.reportDoctorFilter,
        this.newChargeAmount,
        notesWithMarker,
        undefined,
        'charge'
      )
      .subscribe({
        next: (res) => {
          // HttpClient body may be { success, data } or the document itself
          const saved = res?.data ?? res;
          const looksLikeCharge = this.isDoctorLedgerCharge(saved);
          // Roll back only when neither entryType nor [CHARGE] notes marker survived
          if (saved?._id && !looksLikeCharge) {
            this.caseApi.deleteDoctorPayment(saved._id).subscribe({
              next: () => {
                this.chargeSaving = false;
                this.chargeError =
                  'السيرفر حفظ الزيادة كدفعة بالخطأ وتم التراجع. حدّث الباك اند ثم أعد المحاولة.';
              },
              error: () => {
                this.chargeSaving = false;
                this.chargeError =
                  'الزيادة اتسجلت كدفعة بالخطأ. احذفها من جدول الدفعات وحدّث الباك اند.';
                this.loadDoctorPayments();
              },
            });
            return;
          }
          this.chargeSaving = false;
          this.newChargeAmount = null;
          this.newChargeNotes = '';
          this.loadDoctorPayments();
        },
        error: (err) => {
          this.chargeSaving = false;
          this.chargeError =
            'تعذر تسجيل الزيادة على الفاتورة: ' + (err.error?.message || err.message);
          console.error('Failed to add doctor charge:', err);
        },
      });
  }

  deleteDoctorChargeOnAccount(id: string): void {
    if (!confirm('هل أنت متأكد من حذف هذه الزيادة على الفاتورة؟')) return;
    this.caseApi.deleteDoctorPayment(id).subscribe({
      next: () => this.loadDoctorPayments(),
      error: (err) => {
        alert('تعذر حذف الزيادة: ' + (err.error?.message || err.message));
        console.error('Failed to delete doctor charge:', err);
      },
    });
  }

  printDoctorReceipt(): void {
    if (!this.reportDoctorFilter) return;

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-GB') + '  ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const doctorName = this.reportDoctorFilter;
    const totalDue = this.getDoctorTotalDue(doctorName);
    const totalPaid = this.getDoctorTotalPaid(doctorName);
    const remaining = totalDue - totalPaid;
    const casesCount = this.reportFilteredCases.length;
    const payments = this.getDoctorPaymentsList(doctorName);
    const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

    let paymentsRows = '';
    if (payments.length === 0) {
      paymentsRows = `<tr><td colspan="3" style="text-align:center;font-style:italic;padding:6px 0;">لا توجد دفعات مسجلة</td></tr>`;
    } else {
      payments.forEach((p: any) => {
        const pDate = p.paymentDate ? new Date(p.paymentDate).toLocaleDateString('en-GB') : '—';
        const note = p.notes || '—';
        paymentsRows += `<tr>
          <td style="text-align:right;padding:4px 2px;border-bottom:1px dotted #999;">${fmt(p.amount)} EGP</td>
          <td style="text-align:center;padding:4px 2px;border-bottom:1px dotted #999;">${note}</td>
          <td style="text-align:left;padding:4px 2px 4px 6px;border-bottom:1px dotted #999;white-space:nowrap;">${pDate}</td>
        </tr>`;
      });
    }

    const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8">
  <title>كشف حساب — د. ${doctorName}</title>
  <style>
    @page { margin: 2mm; size: 80mm auto; }
    * { box-sizing: border-box; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
    html, body { margin: 0; padding: 0; background: #fff; color: #000; }
    body {
      width: 100%;
      max-width: 72mm;
      margin: 0 auto;
      padding: 4px 8px;
      font-size: 11px;
    }
    .center { text-align: center; }
    .bold { font-weight: bold; }
    .dash { border-top: 1px dashed #555; margin: 6px 0; }
    .solid { border-top: 2px solid #000; margin: 6px 0; }
    table { width: 100%; border-collapse: collapse; margin: 4px 0; }
    th { padding: 4px 4px; font-weight: bold; border-bottom: 1px solid #000; }
    td { padding: 3px 4px; }
    .val-col { text-align: left; padding-left: 6px !important; }
  </style>
</head>
<body>
  <div style="margin-bottom:6px;">
    <div class="center bold" style="font-size:18px;letter-spacing:1px;">Elegance Lab</div>
    <div class="center" style="font-size:9px;color:#333;">Precision Dental Laboratories</div>
  </div>
  <div class="solid"></div>
  <div class="center bold" style="font-size:13px;padding:2px 0;">كشف حساب — د. ${doctorName}</div>
  <div class="solid"></div>
  <table>
    <thead>
      <tr><th style="text-align:right;">البيان</th><th class="val-col">القيمة</th></tr>
    </thead>
    <tbody>
      <tr><td style="text-align:right;">عدد الحالات الخارجة</td><td class="bold val-col">${casesCount}</td></tr>
      <tr><td style="text-align:right;">إجمالي الحساب</td><td class="bold val-col">${fmt(totalDue)} EGP</td></tr>
      <tr><td style="text-align:right;">المبلغ المدفوع</td><td class="bold val-col">${fmt(totalPaid)} EGP</td></tr>
      <tr><td style="text-align:right;border-top:1px solid #000;padding-top:4px;" class="bold">المبلغ المستحق</td><td class="bold val-col" style="border-top:1px solid #000;padding-top:4px;">${fmt(remaining)} EGP</td></tr>
    </tbody>
  </table>
  <div class="dash"></div>
  <div class="center bold" style="margin:4px 0;font-size:12px;">سجل الدفعات</div>
  <table>
    <thead>
      <tr>
        <th style="text-align:right;">المبلغ</th>
        <th style="text-align:center;">ملاحظات</th>
        <th class="val-col" style="white-space:nowrap;">تاريخ الدفع</th>
      </tr>
    </thead>
    <tbody>
      ${paymentsRows}
    </tbody>
  </table>
  <div class="solid"></div>
  <table>
    <tbody>
      <tr><td style="text-align:right;font-size:12px;" class="bold">إجمالي المتبقي</td><td class="bold val-col" style="font-size:12px;">${fmt(remaining)} EGP</td></tr>
      <tr><td style="text-align:right;color:#444;" class="bold">تاريخ طباعة الوصل</td><td class="bold val-col" style="color:#444;white-space:nowrap;">${dateStr}</td></tr>
    </tbody>
  </table>
  <div class="dash"></div>
  <div class="center" style="font-size:10px;margin-top:6px;">شكراً لتعاملكم معنا — Elegance Dental Lab</div>
  <script>
    window.onload = function() {
      window.print();
      window.onafterprint = function() { window.close(); };
    };
  </script>
</body>
</html>`;

    const popup = window.open('', '_blank', 'width=380,height=650,toolbar=0,menubar=0,scrollbars=0');
    if (popup) {
      popup.document.write(html);
      popup.document.close();
    }
  }
}



