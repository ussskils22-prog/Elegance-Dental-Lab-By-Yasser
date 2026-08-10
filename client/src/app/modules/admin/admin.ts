import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { AppRole } from '../../core/auth/auth.types';
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
import { environment } from '../../../environments/environment';

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
  /** Lab name when case is a lab case */
  labName?: string;
  /** Name used for report grouping / pricing (lab or doctor) */
  accountName?: string;
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
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './admin.html',
  styleUrl: './admin.css',
  standalone: true
})
export class Admin implements OnInit, OnDestroy {
  private salaryDrafts: Record<string, string> = {};
  private salarySavingByCaseId: Record<string, boolean> = {};
  activeNav = 'dashboard';
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
      this.reportYearFilter = '';
      this.reportMonthFilter = '';
      this.reportSearch = '';
      // Refresh work-type list (adds/hides) then load this account's prices
      this.loadReportWorkTypes();
    }
  }

  trackByPriceFieldKey(_index: number, field: { key: string }): string {
    return field.key;
  }

  paymentFilter: 'all' | 'paid' | 'unpaid' = 'unpaid';

  doctorPricingsMap = new Map<string, any>();

  /** Bound in admin.html report pricing grid */
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

  /** Same defaults as secretary/doctor forms — merged with API customs */
  readonly defaultWorkTypeOptions = [
    'Zircon', 'German Zircon', 'Emax', 'Pmma Cad',
    'Peek', 'Titanium', 'Try in', 'Mokup',
    'Night Guard', 'Removable Denture', 'Wax', 'Ring',
  ];
  customWorkTypes: Array<{ _id: string; name: string }> = [];
  hiddenDefaultWorkTypes: string[] = [];
  /** Dynamic price inputs keyed by storage key (emax, germanZircon, ...) */
  customWorkTypePrices: Record<string, number> = {};
  reportPriceFields: Array<{ label: string; key: string }> = [];

  private readonly defaultPriceByKey: Record<string, number> = {
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
    removableDenture: 0,
  };

  private readonly legacyPriceKeyByName: Record<string, string> = {
    emax: 'emax',
    'german zircon': 'germanZircon',
    zircon: 'zircon',
    titanium: 'titanium',
    peek: 'peek',
    'pmma cad': 'pmma',
    pmma: 'pmma',
    'night guard': 'nightGuard',
    nightguard: 'nightGuard',
    mokup: 'mockup',
    mockup: 'mockup',
    wax: 'wax',
    ring: 'ring',
    'try in': 'tryIn',
    tryin: 'tryIn',
    'removable denture': 'removableDenture',
  };

  currentPrintDate = new Date();

  pricingSaveSuccess = false;
  pricingSaveError = '';
  isPricingSaving = false;
  financialYearFilter = '';
  financialMonthFilter = '';
  financialDoctorSearch = '';
  cashViewMode: 'day' | 'month' = 'day';
  cashDayFilter = '';
  cashMonthFilter = '';
  cashEntries: Array<{
    _id: string;
    type: 'income' | 'expense';
    amount: number;
    date: string | Date;
    category?: string;
    notes?: string;
    doctorPaymentId?: string | null;
  }> = [];
  cashLoading = false;
  cashSaving = false;
  cashError = '';
  cashFormType: 'income' | 'expense' = 'expense';
  cashFormAmount: number | null = null;
  cashFormDate = '';
  cashFormNotes = '';
  reportYearFilter = '';
  reportMonthFilter = '';
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
  doctorPayments: any[] = [];
  newPaymentAmount: number | null = null;
  newPaymentNotes = '';
  paymentSaving = false;
  paymentError = '';
  selectedPatient: AdminPatient | null = null;
  selectedCase: AdminCaseRow | null = null;
  selectedReportCase: AdminCaseRow | null = null;
  currentPage = 1;
  pageSize = 20;
  private destroy$ = new Subject<void>();
  /** Keeps admin-visible passwords after create/update when API returns them (or just-set values). */
  private readonly staffPasswordByEmail = new Map<string, string>();

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
    private socketService: SocketService,
    private http: HttpClient,
    public themeService: ThemeService
  ) {}

  logout(): void {
    this.auth.performLogout(this.router);
  }

  get adminDisplayName(): string {
    const session = this.auth.getSession();
    const name = String(session?.name || '').trim();
    // Hidden mentor admin account — show English brand name
    if (name.toLowerCase() === 'mentor') return 'Abdullah';
    return name || 'Abdullah';
  }

  get adminInitials(): string {
    const name = this.adminDisplayName;
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase() || 'AD';
  }

  private syncSessionNameIfCurrentUser(userId: string | undefined, fullName: string): void {
    const session = this.auth.getSession();
    if (!session || !userId) return;
    if (String(session.id) !== String(userId)) return;
    const name = String(fullName || '').trim();
    if (!name || name === session.name) return;
    this.auth.setSession({ ...session, name });
  }

  ngOnInit(): void {
    this.restoreActiveNav();
    this.loadCasesFromApi();
    this.loadFinancialReportFromApi();
    this.loadReportWorkTypes();
    this.loadDoctorPricings();
    this.loadStaffFromApi();
    if (this.activeNav === 'staff') {
      this.loadStaffFromApi();
    }
    if (this.activeNav === 'financials') {
      this.ensureCashFiltersInitialized();
      this.loadDoctorPayments();
      this.loadCashEntries();
    }
    this.connectCaseRealtime();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private connectCaseRealtime(): void {
    this.socketService.connect();
    merge(
      this.socketService.onCaseCreated(),
      this.socketService.onCaseAssigned(),
      this.socketService.onCaseReassigned(),
      this.socketService.onCaseMovedStage(),
      this.socketService.onCaseCompleted(),
      this.socketService.onCaseReleased(),
      this.socketService.onCaseUpdated(),
      this.socketService.onCaseDeleted()
    )
      .pipe(
        takeUntil(this.destroy$),
        filter((evt) => !!evt),
        debounceTime(2000)
      )
      .subscribe(() => {
        this.loadCasesFromApi();
        this.loadFinancialReportFromApi();
      });
  }

  staffMembers: StaffMember[] = [];
  doctorMembers: StaffMember[] = [];
  labMembers: StaffMember[] = [];
  doctorSearchTerm = '';
  doctorLoadError = '';
  labSearchTerm = '';
  labLoadError = '';
  showDoctorModal = false;
  isDoctorEditMode = false;
  doctorSaving = false;
  doctorModalError = '';
  showDoctorPassword = false;
  showLabModal = false;
  isLabEditMode = false;
  labSaving = false;
  labModalError = '';
  showLabPassword = false;
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
  currentLab: StaffMember = {
    id: '',
    name: '',
    email: '',
    password: '',
    phone: '',
    position: 'معمل',
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
  ] as const;

  get filteredStaff(): StaffMember[] {
    const staffOnly = this.staffMembers.filter(
      (s) => s.position !== 'دكتور' && s.position !== 'معمل'
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
    if (!this.doctorSearchTerm.trim()) return this.doctorMembers;
    const search = this.doctorSearchTerm.toLowerCase();
    return this.doctorMembers.filter(
      (d) =>
        d.name.toLowerCase().includes(search) ||
        d.email.toLowerCase().includes(search) ||
        d.phone.includes(search)
    );
  }

  get filteredLabs(): StaffMember[] {
    if (!this.labSearchTerm.trim()) return this.labMembers;
    const search = this.labSearchTerm.toLowerCase();
    return this.labMembers.filter(
      (d) =>
        d.name.toLowerCase().includes(search) ||
        d.email.toLowerCase().includes(search) ||
        d.phone.includes(search)
    );
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
    const d = c.exitedAt || c.receivedAt;
    if (!d) return false;
    const dt = d instanceof Date ? d : new Date(d);
    if (this.reportYearFilter && dt.getFullYear() !== Number(this.reportYearFilter)) return false;
    if (this.reportMonthFilter && dt.getMonth() + 1 !== Number(this.reportMonthFilter)) return false;
    return true;
  }

  /** Account shown in report list: lab name for lab cases, doctor otherwise */
  getReportAccountName(c: AdminCaseRow): string {
    const lab = (c.labName || '').trim();
    const isLab = c.requesterType === 'lab' || !!lab;
    if (isLab) {
      return this.normalizeDoctorName(lab || c.accountName || c.doctorName || c.assignedTo || 'غير محدد');
    }
    return this.normalizeDoctorName(c.accountName || c.doctorName || c.assignedTo || 'غير محدد');
  }

  isLabCaseRow(c: AdminCaseRow): boolean {
    return c.requesterType === 'lab' || !!(c.labName || '').trim();
  }

  /** Referring doctor for a case — never fall back to lab account name. */
  reportCaseDoctorName(c: AdminCaseRow | null | undefined): string {
    if (!c) return 'غير محدد';
    const doctor = String(c.doctor || c.doctorName || '').trim();
    const lab = String(c.labName || c.accountName || '').trim();
    if (doctor && (!lab || this.doctorGroupKey(doctor) !== this.doctorGroupKey(lab))) {
      return this.normalizeDoctorName(doctor);
    }
    if (doctor && !this.isLabCaseRow(c)) {
      return this.normalizeDoctorName(doctor);
    }
    const assigned = String(c.assignedTo || '').trim();
    if (assigned && (!lab || this.doctorGroupKey(assigned) !== this.doctorGroupKey(lab))) {
      return this.normalizeDoctorName(assigned);
    }
    return doctor ? this.normalizeDoctorName(doctor) : 'غير محدد';
  }

  /** True when the opened report account is a lab (show doctor + patient in case rows) */
  get isFilteredReportAccountLab(): boolean {
    if (!this.reportDoctorFilter) return false;
    const filterKey = this.doctorGroupKey(this.reportDoctorFilter);
    return this.reportCases.some((c) => {
      if (this.doctorGroupKey(this.getReportAccountName(c)) !== filterKey) return false;
      return this.isLabCaseRow(c);
    });
  }

  get reportWorkTypeOptions(): string[] {
    const hidden = new Set(this.hiddenDefaultWorkTypes.map((n) => n.toLowerCase()));
    const merged = this.defaultWorkTypeOptions.filter((n) => !hidden.has(n.toLowerCase()));
    for (const c of this.customWorkTypes) {
      if (c.name && !merged.some((x) => x.toLowerCase() === c.name.toLowerCase())) {
        merged.push(c.name);
      }
    }
    return merged;
  }

  workTypeToPriceKey(name: string): string {
    const lower = String(name || '').toLowerCase().trim();
    if (!lower) return '';
    if (this.legacyPriceKeyByName[lower]) return this.legacyPriceKeyByName[lower];
    return lower
      .replace(/[^a-z0-9]+(.)/g, (_m, c: string) => c.toUpperCase())
      .replace(/[^a-zA-Z0-9]/g, '');
  }

  private rebuildReportPriceFields(): void {
    this.reportPriceFields = this.reportWorkTypeOptions.map((label) => ({
      label,
      key: this.workTypeToPriceKey(label),
    }));
  }

  loadReportWorkTypes(): void {
    this.caseApi.getCustomWorkTypes().subscribe({
      next: (res) => {
        this.customWorkTypes = (res?.data ?? [])
          .map((x: any) => ({
            _id: String(x._id),
            name: String(x.name || '').trim(),
          }))
          .filter((x: { name: string }) => !!x.name);
        this.hiddenDefaultWorkTypes = (res?.hiddenDefaults ?? [])
          .map((n: any) => String(n || '').trim())
          .filter(Boolean);
        this.rebuildReportPriceFields();
        if (this.reportDoctorFilter) {
          this.loadCustomPricesForDoctor(this.reportDoctorFilter);
        }
      },
      error: () => {
        this.customWorkTypes = [];
        this.hiddenDefaultWorkTypes = [];
        this.rebuildReportPriceFields();
      },
    });
  }

  get reportFilteredCases(): AdminCaseRow[] {
    const search = this.reportSearch.toLowerCase().trim();
    return this.reportCases.filter(c => {
      let match = this.matchesReportPeriod(c);
      if (search) {
        match = match && [
          c.caseNumber,
          c.patientName,
          this.getReportAccountName(c),
          c.doctorName || '',
          c.labName || '',
          c.assignedTo || '',
          c.currentStage,
        ].some(value => value?.toLowerCase().includes(search));
      }
      if (this.reportDoctorFilter) {
        const key = this.doctorGroupKey(this.getReportAccountName(c));
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
      const name = this.getReportAccountName(c);
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
    }>();

    this.reportCases.forEach(c => {
      if (String(c.currentStage) !== 'exited') return;
      if (!this.matchesReportPeriod(c)) return;

      const name = this.getReportAccountName(c);
      const key = this.doctorGroupKey(name);

      const cost = this.calculateCaseCost(c);
      const paidAmount = c.paid ? (c.salary || 0) : 0;

      if (!doctorMap.has(key)) {
        doctorMap.set(key, {
          doctorName: name,
          totalCases: 0,
          totalDue: 0,
          totalPaid: 0,
          remaining: 0
        });
      }

      const docObj = doctorMap.get(key)!;
      docObj.totalCases += 1;
      docObj.totalDue += cost;
      docObj.totalPaid += paidAmount;
    });

    doctorMap.forEach((docObj, key) => {
      const generalPaymentsSum = this.doctorPayments
        .filter(p => this.doctorGroupKey(p.doctorName) === key)
        .reduce((sum, p) => sum + (p.amount || 0), 0);
      
      docObj.totalPaid += generalPaymentsSum;
      docObj.remaining = docObj.totalDue - docObj.totalPaid;
    });

    return Array.from(doctorMap.values()).sort((a, b) => a.doctorName.localeCompare(b.doctorName));
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

  private findDoctorReportSummary(doctorName: string) {
    const key = this.doctorGroupKey(doctorName);
    return this.doctorReportSummaries.find((d) => this.doctorGroupKey(d.doctorName) === key);
  }

  getDoctorTotalDue(doctorName: string): number {
    return this.findDoctorReportSummary(doctorName)?.totalDue || 0;
  }

  getDoctorTotalPaid(doctorName: string): number {
    return this.findDoctorReportSummary(doctorName)?.totalPaid || 0;
  }

  getDoctorRemainingBalance(doctorName: string): number {
    const summary = this.findDoctorReportSummary(doctorName);
    if (!summary) return 0;
    return Math.max(0, summary.totalDue - summary.totalPaid);
  }

  cashEntrySourceLabel(entry: {
    type: 'income' | 'expense';
    category?: string;
    notes?: string;
  }): string {
    const cat = String(entry.category || '').toLowerCase();
    if (cat === 'doctor_payment') return 'دفعة دكتور / معمل (تقارير)';
    if (cat === 'case_payment') return 'تأكيد دفع حالة';
    if (entry.type === 'income') return 'دخل يدوي';
    return 'مصروف يدوي';
  }

  private monthLabel(date: Date): string {
    const months = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    return `${months[date.getMonth()]} ${date.getFullYear()}`;
  }

  monthName(monthNumber: number): string {
    const months = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    return months[monthNumber - 1] || `شهر ${monthNumber}`;
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
        const d = this.normalizeDate(c.receivedAt) || this.parseDate(c.receivedDateDisplay);
        return d && d.getFullYear() === selectedYear;
      });
    }

    if (Number.isFinite(selectedMonth) && selectedMonth > 0) {
      cases = cases.filter(c => {
        const d = this.normalizeDate(c.receivedAt) || this.parseDate(c.receivedDateDisplay);
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
    return c.salary || 0;
  }

  getSalaryDraft(caseItem: AdminCaseRow): string {
    if (Object.prototype.hasOwnProperty.call(this.salaryDrafts, caseItem.id)) {
      return this.salaryDrafts[caseItem.id];
    }
    const defaultVal = caseItem.salary || this.calculateCaseCost(caseItem);
    return String(defaultVal || 0);
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
          this.loadCashEntries();
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
          this.loadCashEntries();
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

  /** الحالات الخارجة فقط وليست إعادة ولا تعديل */
  get exitedNonRedoCases(): AdminCaseRow[] {
    return this.adminCases.filter(c => {
      if (String(c.currentStage) !== 'exited') return false;
      
      const ct = (c.caseType || '').toLowerCase();
      // استبعاد الإعادة والتعديل
      const isRedo = ct.includes('redo') || ct.includes('remake') ||
                     ct.includes('modification') ||
                     ct.includes('اعاده') || ct.includes('إعادة');
      return !isRedo;
    });
  }

  /** عدد وحدات الزيركونيا الإجمالي الخارجة غير الإعادة */
  private readonly materialCounterPalette = [

    { color: '#6366f1', bg: '#eef2ff' },

    { color: '#0ea5e9', bg: '#e0f2fe' },

    { color: '#10b981', bg: '#ecfdf5' },

    { color: '#f59e0b', bg: '#fffbeb' },

    { color: '#ef4444', bg: '#fef2f2' },

    { color: '#8b5cf6', bg: '#f5f3ff' },

    { color: '#14b8a6', bg: '#f0fdfa' },

    { color: '#f97316', bg: '#fff7ed' },

    { color: '#64748b', bg: '#f8fafc' },

    { color: '#ec4899', bg: '#fdf2f8' },

  ];



  materialCounterColor(index: number): string {

    return this.materialCounterPalette[index % this.materialCounterPalette.length].color;

  }



  materialCounterBg(index: number): string {

    return this.materialCounterPalette[index % this.materialCounterPalette.length].bg;

  }



  /**

   * All material unit counters for the dashboard:

   * current work types (defaults + custom, minus hidden) plus any old types still on exited cases.

   */

  get dashboardMaterialCounters(): Array<{ name: string; count: number }> {

    const labels = [...this.reportWorkTypeOptions];

    const labelLower = new Set(labels.map((n) => n.toLowerCase()));



    // Discover old/deleted types still present on exited non-redo cases

    const discoveryMatchers = [...labels].sort((a, b) => b.length - a.length);

    for (const c of this.exitedNonRedoCases) {

      const parts = (c.caseType || '').split('+').map((p) => p.trim()).filter(Boolean);

      for (const part of parts) {

        const cleaned = part.replace(/\(\d+\)/g, '').trim();

        if (!cleaned) continue;

        const lower = cleaned.toLowerCase();

        const matchedExisting = discoveryMatchers.some(

          (lbl) => !!lbl && lower.includes(lbl.toLowerCase())

        );

        if (!matchedExisting && !labelLower.has(lower)) {

          labels.push(cleaned);

          labelLower.add(lower);

          discoveryMatchers.push(cleaned);

          discoveryMatchers.sort((a, b) => b.length - a.length);

        }

      }

    }



    // Longest first so "German Zircon" wins over "Zircon"

    const matchers = [...labels].sort((a, b) => b.length - a.length);

    const counts = new Map<string, number>();

    for (const name of labels) counts.set(name, 0);



    for (const c of this.exitedNonRedoCases) {

      const parts = (c.caseType || '').split('+').map((p) => p.trim()).filter(Boolean);

      const meta = this.parseNotesMeta(c.rawNotes || '');

      const caseOverallQuantity = Number(c.quantity ?? meta['quantity'] ?? 1) || 1;



      for (const part of parts) {

        const lowerPart = part.toLowerCase();

        const matchQty = part.match(/\((\d+)\)/);

        const qty = matchQty ? parseInt(matchQty[1], 10) : caseOverallQuantity;



        let matchedName = '';

        for (const label of matchers) {

          if (label && lowerPart.includes(label.toLowerCase())) {

            matchedName = label;

            break;

          }

        }

        if (!matchedName) {

          const cleaned = part.replace(/\(\d+\)/g, '').trim();

          if (cleaned && counts.has(cleaned)) matchedName = cleaned;

        }

        if (matchedName) {

          counts.set(matchedName, (counts.get(matchedName) || 0) + qty);

        }

      }

    }



    return labels.map((name) => ({ name, count: counts.get(name) || 0 }));

  }

  get dashboardMaterialTotal(): number {
    return this.dashboardMaterialCounters.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
  }

  get zirconCount(): number {
    return this.regularZirconCount + this.germanZirconCount + this.titaniumCount + this.peekCount;
  }

  get regularZirconCount(): number {
    return this.countUnitsByKeywords(['zircon'], ['german']);
  }

  get germanZirconCount(): number {
    return this.countUnitsByKeywords(['german zircon', 'german']);
  }

  get titaniumCount(): number {
    return this.countUnitsByKeywords(['titanium']);
  }

  get peekCount(): number {
    return this.countUnitsByKeywords(['peek']);
  }

  get financialCostEligibleCases(): AdminCaseRow[] {
    return this.adminCases.filter(c => {
      if (String(c.currentStage) !== 'exited') return false;

      const ct = (c.caseType || '').toLowerCase();
      // Skip redo, remake, modification, unknown (غير معروف)
      const isExcluded = ct.includes('redo') || ct.includes('remake') ||
                          ct.includes('modification') || ct.includes('تعديل') ||
                          ct.includes('اعاده') || ct.includes('إعادة') ||
                          ct.includes('غير معروف') || ct.includes('unknown');
      return !isExcluded;
    });
  }

  private priceForKey(custom: Record<string, any> | undefined, priceKey: string): number {
    const raw = custom?.[priceKey];
    if (raw !== undefined && raw !== null && Number.isFinite(Number(raw))) {
      return Number(raw);
    }
    return this.defaultPriceByKey[priceKey] ?? 0;
  }

  calculateCaseCost(c: AdminCaseRow): number {
    const account = this.getReportAccountName(c);

    const ct = (c.caseType || '').toLowerCase();
    const isExcluded = ct.includes('redo') || ct.includes('remake') ||
                       ct.includes('modification') || ct.includes('تعديل') ||
                       ct.includes('اعاده') || ct.includes('إعادة') ||
                       ct.includes('غير معروف') || ct.includes('unknown');
    if (isExcluded) return 0;

    const key = this.doctorGroupKey(account);
    const custom = this.doctorPricingsMap.get(key) || {};

    // Longer names first so "German Zircon" wins over "Zircon"
    const typeMatchers = [...this.reportWorkTypeOptions]
      .sort((a, b) => b.length - a.length)
      .map((label) => ({
        needle: label.toLowerCase(),
        priceKey: this.workTypeToPriceKey(label),
      }));

    let total = 0;
    const parts = (c.caseType || '').split('+').map(p => p.trim());
    const meta = this.parseNotesMeta(c.rawNotes || '');
    const caseOverallQuantity = Number(c.quantity ?? meta['quantity'] ?? 1) || 1;

    for (const part of parts) {
      const lowerPart = part.toLowerCase();
      const match = part.match(/\((\d+)\)/);
      const qty = match ? parseInt(match[1], 10) : caseOverallQuantity;

      let matchedKey = '';
      for (const m of typeMatchers) {
        if (m.needle && lowerPart.includes(m.needle)) {
          matchedKey = m.priceKey;
          break;
        }
      }

      // Fallback for deleted/hidden types still present on old cases
      if (!matchedKey) {
        if (lowerPart.includes('emax')) matchedKey = 'emax';
        else if (lowerPart.includes('german zircon') || lowerPart.includes('german')) matchedKey = 'germanZircon';
        else if (lowerPart.includes('zircon')) matchedKey = 'zircon';
        else if (lowerPart.includes('titanium')) matchedKey = 'titanium';
        else if (lowerPart.includes('peek')) matchedKey = 'peek';
        else if (lowerPart.includes('pmma')) matchedKey = 'pmma';
        else if (lowerPart.includes('night guard') || lowerPart.includes('nightguard')) matchedKey = 'nightGuard';
        else if (lowerPart.includes('mokup') || lowerPart.includes('mockup') || lowerPart.includes('موكب')) matchedKey = 'mockup';
        else if (lowerPart.includes('removable denture')) matchedKey = 'removableDenture';
        else if (lowerPart.includes('wax')) matchedKey = 'wax';
        else if (lowerPart.includes('ring')) matchedKey = 'ring';
        else if (lowerPart.includes('try in') || lowerPart.includes('tryin')) matchedKey = 'tryIn';
      }

      if (matchedKey) {
        total += qty * this.priceForKey(custom, matchedKey);
      }
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
      const parts = ct.split('+').map(p => p.trim());
      const meta = this.parseNotesMeta(c.rawNotes || '');
      const caseOverallQuantity = Number(c.quantity ?? meta['quantity'] ?? 1) || 1;

      for (const part of parts) {
        const lowerPart = part.toLowerCase();
        
        // Count quantity: e.g. "Zircon (3)" -> 3, or default to overall case quantity
        const match = part.match(/\((\d+)\)/);
        const qty = match ? parseInt(match[1], 10) : caseOverallQuantity;

        if (lowerPart.includes('emax')) {
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
        } else if (lowerPart.includes('try in') || lowerPart.includes('tryin')) {
          tryInQty += qty;
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
    const tryInTotal = tryInQty * 0;

    const grandTotal = emaxTotal + germanZirconTotal + zirconTotal + titaniumTotal + peekTotal + pmmaTotal + nightGuardTotal + waxTotal + ringTotal + tryInTotal;

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
      const parts = ct.split('+').map(p => p.trim());
      const meta = this.parseNotesMeta(c.rawNotes || '');
      const caseOverallQuantity = Number(c.quantity ?? meta['quantity'] ?? 1) || 1;

      for (const part of parts) {
        const lowerPart = part.toLowerCase();
        
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
    let total = 0;
    for (const c of this.exitedNonRedoCases) {
      const ct = c.caseType || '';
      const parts = ct.split('+').map(p => p.trim());
      const meta = this.parseNotesMeta(c.rawNotes || '');
      const caseOverallQuantity = Number(c.quantity ?? meta['quantity'] ?? 1) || 1;

      for (const part of parts) {
        if (part.toLowerCase().includes('emax')) {
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

  private loadCasesFromApi(): void {
    this.caseApi.getAllCases(1, 1500).subscribe({
      next: (res) => {
        const rows = (res?.data ?? []) as Record<string, unknown>[];
        this.adminCases = Array.isArray(rows) ? rows.map((row) => this.mapApiCaseToAdminCase(row)) : [];
        this.patients = this.buildPatientsFromCases(this.adminCases);
        this.currentPage = 1;
      },
      error: (err) => {
        console.error(err);
        this.adminCases = [];
        this.patients = [];
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

    const labName = String(parsedMeta['labName'] ?? '').trim();
    const doctorName = String(parsedMeta['doctor'] ?? parsedMeta['doctorName'] ?? '').trim();
    const requesterRaw = String(parsedMeta['requesterType'] ?? doc['requesterType'] ?? 'doctor').toLowerCase();
    const requesterType: AdminCaseRow['requesterType'] =
      requesterRaw === 'lab' || labName
        ? 'lab'
        : requesterRaw === 'student'
          ? 'student'
          : 'doctor';
    const accountName =
      requesterType === 'lab' ? labName || doctorName : doctorName;
    const exitedAt = this.normalizeDate(
      (doc['stageTimestamps'] as Record<string, unknown>)?.['exited'] ??
      (doc['stageTimestamps'] as Record<string, unknown>)?.['completed'] ??
      doc['updatedAt']
    );

    return {
      id: String(doc['_id'] ?? ''),
      caseNumber: String(doc['caseNumber'] ?? ''),
      patientName: String(doc['patientName'] ?? ''),
      assignedTo: assignedTo && assignedTo['fullName'] ? String(assignedTo['fullName']) : null,
      requesterType,
      doctor: doctorName,
      doctorName,
      labName,
      accountName,
      clinic: '',
      currentStage: forcedCompleted ? 'completed' : String(doc['currentStage'] ?? 'waiting'),
      priority: String(doc['priority'] ?? 'normal'),
      receivedDateDisplay: createdAt ? this.formatDateEn(createdAt) : 'غير متوفر',
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
      exitedAt,
      exitedAtDisplay: exitedAt ? this.formatDateEn(exitedAt) : 'غير متوفر',
    };
  }

  private mapFinancialReportRowToAdminCase(row: Record<string, unknown>): AdminCaseRow {
    const receivedAt = this.normalizeDate(row['receivedAt']);
    const dueDate = this.normalizeDate(row['dueDate']);
    const exitedAt = this.normalizeDate(row['exitedAt'] || row['updatedAt']);
    const salaryAmountRaw = Number(row['salaryAmount']);
    const salary = Number.isFinite(salaryAmountRaw) ? salaryAmountRaw : 0;
    const paid = String(row['paymentStatus'] ?? 'unpaid').toLowerCase() === 'paid';

    // استخراج notes من البيانات لو موجودة
    const notes = String(row['notes'] ?? '');
    const parsedMeta = this.parseNotesMeta(notes);

    const labName = String(row['labName'] ?? parsedMeta['labName'] ?? '').trim();
    const doctorName = String(row['doctorName'] ?? parsedMeta['doctor'] ?? '').trim();
    const requesterRaw = String(row['requesterType'] ?? parsedMeta['requesterType'] ?? 'doctor').toLowerCase();
    const requesterType: AdminCaseRow['requesterType'] =
      requesterRaw === 'lab' || labName
        ? 'lab'
        : requesterRaw === 'student'
          ? 'student'
          : 'doctor';
    const accountName = String(
      row['accountName'] ??
        (requesterType === 'lab' ? labName || doctorName : doctorName)
    ).trim();

    return {
      id: String(row['id'] ?? ''),
      caseNumber: String(row['caseNumber'] ?? ''),
      patientName: String(row['patientName'] ?? ''),
      assignedTo: String(row['assignedTo'] ?? '') || null,
      requesterType,
      doctor: doctorName,
      doctorName,
      labName,
      accountName,
      clinic: '',
      currentStage: String(row['currentStage'] ?? 'completed'),
      priority: 'normal',
      receivedDateDisplay: receivedAt ? this.formatDateEn(receivedAt) : 'غير متوفر',
      receivedAt: receivedAt || undefined,
      deliveryDateDisplay: dueDate ? dueDate.toLocaleString() : 'غير متوفر',
      dueDateDisplay: dueDate ? dueDate.toLocaleString() : 'N/A',
      exitedAt,
      exitedAtDisplay: exitedAt ? this.formatDateEn(exitedAt) : 'غير متوفر',
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
    if (nav === 'ai' || nav === 'whatsapp') {
      nav = 'dashboard';
    }
    this.activeNav = nav;
    this.persistActiveNav();
    if (nav === 'staff' || nav === 'doctors' || nav === 'labs') {
      this.loadStaffFromApi();
    } else if (nav === 'reports') {
      this.loadReportWorkTypes();
      this.loadDoctorPricings();
      this.loadFinancialReportFromApi();
    } else if (nav === 'financials') {
      this.ensureCashFiltersInitialized();
      this.loadDoctorPayments();
      this.loadCashEntries();
    } else if (nav === 'archive') {
      this.loadArchiveList();
    }
  }

  waEnabled = false;
  waProvider: 'ultramsg' | 'meta' = 'ultramsg';
  waInstanceId = '';
  waPhoneNumberId = '';
  waToken = '';
  waDailyHour = 18;
  waLabName = 'Elite Dental Lab';
  waHasToken = false;
  waLiveConfigured = false;
  waTestPhone = '';
  waMsg = '';
  waSaving = false;

  loadWhatsAppSettings(): void {
    this.waMsg = '';
    this.http.get<{ success?: boolean; settings?: any }>(`${environment.apiUrl}/settings/whatsapp`).subscribe({
      next: (res) => {
        const s = res?.settings || {};
        this.waEnabled = !!s.enabled;
        this.waProvider = s.provider === 'meta' ? 'meta' : 'ultramsg';
        this.waInstanceId = s.instanceId || '';
        this.waPhoneNumberId = s.phoneNumberId || '';
        this.waDailyHour = s.dailyHour ?? 18;
        this.waLabName = s.labName || 'Elite Dental Lab';
        this.waHasToken = !!s.hasToken;
        this.waLiveConfigured = !!s.liveConfigured;
        this.waToken = '';
      },
      error: () => {
        this.waMsg = 'تعذر تحميل إعدادات واتساب';
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
    };
    if (this.waToken.trim()) body['token'] = this.waToken.trim();
    this.http
      .put<{ success?: boolean; message?: string; liveConfigured?: boolean }>(
        `${environment.apiUrl}/settings/whatsapp`,
        body
      )
      .subscribe({
        next: (res) => {
          this.waSaving = false;
          this.waLiveConfigured = !!res.liveConfigured;
          this.waMsg = res.message || 'تم الحفظ';
          this.waToken = '';
          this.loadWhatsAppSettings();
        },
        error: (err) => {
          this.waSaving = false;
          this.waMsg = err?.error?.message || 'فشل الحفظ';
        },
      });
  }

  testWhatsApp(): void {
    this.waMsg = '';
    this.http
      .post<{ success?: boolean; message?: string }>(`${environment.apiUrl}/settings/whatsapp/test`, {
        phone: this.waTestPhone,
      })
      .subscribe({
        next: (res) => {
          this.waMsg = res.message || 'تم الإرسال';
        },
        error: (err) => {
          this.waMsg = err?.error?.message || 'فشل الاختبار';
        },
      });
  }

  runWhatsAppDailyNow(): void {
    this.waMsg = '';
    this.http
      .post<{ success?: boolean; message?: string }>(
        `${environment.apiUrl}/settings/whatsapp/daily-summary`,
        {}
      )
      .subscribe({
        next: (res) => {
          this.waMsg = res.message || 'تم إرسال الملخص';
        },
        error: (err) => {
          this.waMsg = err?.error?.message || 'فشل إرسال الملخص';
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
    const year = Number(this.reportYearFilter);
    const months = new Set<number>();
    this.reportCases.forEach((c) => {
      const d = c.exitedAt || c.receivedAt;
      if (!d) return;
      const dt = d instanceof Date ? d : new Date(d);
      if (dt.getFullYear() === year) months.add(dt.getMonth() + 1);
    });
    return Array.from(months).sort((a, b) => a - b);
  }

  onReportYearChange(value: string): void {
    this.reportYearFilter = value;
    if (!value) {
      this.reportMonthFilter = '';
      return;
    }
    if (!this.reportMonthsForSelectedYear.includes(Number(this.reportMonthFilter))) {
      this.reportMonthFilter = '';
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
        const filename = `Elite-Lab-Export-${year}-${String(month).padStart(2, '0')}.zip`;
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

  /** Hide placeholder phones like 0000000000 from the UI. */
  normalizeOptionalPhone(phone?: string): string {
    const p = String(phone || '').trim();
    if (!p || /^0+$/.test(p)) return '';
    return p;
  }

  openAddStaffModal() {
    this.isEditMode = false;
    this.staffModalError = '';
    this.showStaffPassword = true;
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
    this.showStaffPassword = true;
    this.currentStaff = {
      ...staff,
      phone: this.normalizeOptionalPhone(staff.phone),
      password: staff.loginPasswordVisible || '',
    };
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
        const visible = mapped.filter(
          (m) => String(m.email || '').trim().toLowerCase() !== 'mentor@dental.com'
        );
        this.doctorMembers = visible.filter((m) => m.position === 'دكتور');
        this.labMembers = visible.filter((m) => m.position === 'معمل');
        this.staffMembers = visible.filter(
          (m) => m.position !== 'دكتور' && m.position !== 'معمل'
        );
        const session = this.auth.getSession();
        if (session?.id) {
          const me = visible.find((m) => String(m.id) === String(session.id));
          if (me?.name) this.syncSessionNameIfCurrentUser(me.id, me.name);
        }
      },
      error: (err) => {
        console.error(err);
        this.staffLoadError = 'تعذر تحميل قائمة الموظفين من الخادم';
        this.doctorLoadError = 'تعذر تحميل قائمة الدكاترة من الخادم';
        this.labLoadError = 'تعذر تحميل قائمة المعامل من الخادم';
        this.staffMembers = [];
        this.doctorMembers = [];
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
    const email = String(u['email'] ?? '').trim().toLowerCase();
    const fromApi = String(u['loginPasswordVisible'] ?? '').trim();
    if (fromApi && email) this.staffPasswordByEmail.set(email, fromApi);
    const visiblePassword = fromApi || (email ? this.staffPasswordByEmail.get(email) || '' : '');

    return {
      id,
      name: String(u['fullName'] ?? ''),
      email: String(u['email'] ?? ''),
      password: '',
      loginPasswordVisible: visiblePassword,
      phone: this.normalizeOptionalPhone(String(u['phone'] ?? '')),
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
    if (p === 'lab' || p === 'معمل') return 'lab';
    if (p === 'scanner1' || p === 'سكان 1' || p === 'سكان١') return 'scanner1';
    if (p === 'scanner2' || p === 'سكان 2' || p === 'سكان٢') return 'scanner2';
    if (p === 'scanner3' || p === 'سكان 3' || p === 'سكان٣') return 'scanner3';
    return 'secretary';
  }

  openAddDoctorModal() {
    this.isDoctorEditMode = false;
    this.doctorModalError = '';
    this.showDoctorPassword = true;
    this.currentDoctor = {
      id: '',
      name: '',
      email: '',
      password: '',
      phone: '',
      position: 'دكتور',
      status: 'active',
      joinDate: new Date().toISOString().split('T')[0],
    };
    this.showDoctorModal = true;
  }

  openEditDoctorModal(doc: StaffMember) {
    this.isDoctorEditMode = true;
    this.doctorModalError = '';
    this.showDoctorPassword = true;
    this.currentDoctor = {
      ...doc,
      phone: this.normalizeOptionalPhone(doc.phone),
      password: doc.loginPasswordVisible || '',
      position: 'دكتور',
    };
    this.showDoctorModal = true;
  }

  /** From doctors directory → open that doctor's request portal (same URL as doctors use). */
  openDoctorAccountPage(doc: StaffMember): void {
    const name = (doc?.name || '').trim();
    if (!name) return;
    this.router.navigate(['/doctor/dashboard'], {
      queryParams: { as: name },
    });
  }

  closeDoctorModal() {
    this.showDoctorModal = false;
    this.showDoctorPassword = false;
    this.doctorModalError = '';
    this.doctorSaving = false;
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
    const ok = confirm(`هل أنت متأكد من حذف حساب دكتور ${doc.name} نهائياً؟`);
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
    const phone = this.normalizeOptionalPhone(this.currentDoctor.phone);
    if (!name) {
      this.doctorModalError = 'يرجى إدخال اسم الدكتور';
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
        role: 'doctor',
        department: 'دكتور',
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
        role: 'doctor',
        department: 'دكتور',
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

  openAddLabModal() {
    this.isLabEditMode = false;
    this.labModalError = '';
    this.showLabPassword = true;
    this.currentLab = {
      id: '',
      name: '',
      email: '',
      password: '',
      phone: '',
      position: 'معمل',
      status: 'active',
      joinDate: new Date().toISOString().split('T')[0],
    };
    this.showLabModal = true;
  }

  openEditLabModal(lab: StaffMember) {
    this.isLabEditMode = true;
    this.labModalError = '';
    this.showLabPassword = true;
    this.currentLab = {
      ...lab,
      phone: this.normalizeOptionalPhone(lab.phone),
      password: lab.loginPasswordVisible || '',
      position: 'معمل',
    };
    this.showLabModal = true;
  }

  /** From labs directory → open that lab's request portal (same screen as doctors). */
  openLabAccountPage(lab: StaffMember): void {
    const name = (lab?.name || '').trim();
    if (!name) return;
    this.router.navigate(['/doctor/dashboard'], {
      queryParams: { as: name },
    });
  }

  closeLabModal() {
    this.showLabModal = false;
    this.showLabPassword = false;
    this.labModalError = '';
    this.labSaving = false;
  }

  toggleLabActive(lab: StaffMember): void {
    if (!lab.id) return;
    const targetActive = lab.status !== 'active';
    this.userApi.updateUser(lab.id, { isActive: targetActive }).subscribe({
      next: () => this.loadStaffFromApi(),
      error: (err) => {
        console.error(err);
        this.labLoadError = 'تعذر تحديث حالة الحساب';
      },
    });
  }

  deleteLab(lab: StaffMember): void {
    if (!lab.id) return;
    const ok = confirm(`هل أنت متأكد من حذف حساب معمل ${lab.name} نهائياً؟`);
    if (!ok) return;
    this.userApi.deleteUser(lab.id).subscribe({
      next: () => this.loadStaffFromApi(),
      error: (err) => {
        console.error(err);
        this.labLoadError = 'تعذر حذف الحساب';
      },
    });
  }

  saveLab(): void {
    this.labModalError = '';
    const name = (this.currentLab.name || '').trim();
    const email = (this.currentLab.email || '').trim();
    const phone = this.normalizeOptionalPhone(this.currentLab.phone);
    if (!name) {
      this.labModalError = 'يرجى إدخال اسم المعمل';
      return;
    }
    if (!email) {
      this.labModalError = 'يرجى إدخال البريد الإلكتروني';
      return;
    }

    if (this.isLabEditMode) {
      if (!this.currentLab.id) return;
      const patch: Record<string, unknown> = {
        fullName: name,
        phone,
        role: 'lab',
        department: 'معمل',
        isActive: this.currentLab.status === 'active',
      };
      if (this.currentLab.password?.trim()) {
        if (this.currentLab.password.trim().length < 6) {
          this.labModalError = 'كلمة المرور يجب ألا تقل عن 6 أحرف';
          return;
        }
        patch['password'] = this.currentLab.password.trim();
      }
      this.labSaving = true;
      this.userApi.updateUser(this.currentLab.id, patch).subscribe({
        next: () => {
          this.labSaving = false;
          this.closeLabModal();
          this.loadStaffFromApi();
        },
        error: (err) => {
          this.labSaving = false;
          this.labModalError = err?.error?.message || 'تعذر تحديث الحساب';
        },
      });
      return;
    }

    if (!this.currentLab.password || this.currentLab.password.length < 6) {
      this.labModalError = 'كلمة المرور يجب ألا تقل عن 6 أحرف';
      return;
    }

    this.labSaving = true;
    this.auth
      .registerStaff({
        fullName: name,
        email: email.toLowerCase(),
        phone,
        password: this.currentLab.password,
        role: 'lab',
        department: 'معمل',
      })
      .subscribe({
        next: () => {
          this.labSaving = false;
          this.closeLabModal();
          this.loadStaffFromApi();
        },
        error: (err) => {
          this.labSaving = false;
          this.labModalError = err?.error?.message || 'تعذر إنشاء الحساب';
        },
      });
  }

  private formatStaffApiError(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      const msg = err.error?.message;
      if (msg && typeof msg === 'string') return msg;
      const errs = err.error?.errors;
      if (Array.isArray(errs) && errs[0]?.msg) {
        const first = String(errs[0].msg);
        const path = String(errs[0].path || errs[0].param || '');
        if (path === 'phone' || /phone/i.test(first)) {
          return 'السيرفر رافض الرقم الفارغ — لازم API بتاع Elite (مش Elegance) يكون متوصل من Vercel عبر ELITE_API_URL';
        }
        return first;
      }
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

    const phone = this.normalizeOptionalPhone(this.currentStaff.phone);

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
          const pw = this.currentStaff.password?.trim();
          if (pw) this.staffPasswordByEmail.set(email.toLowerCase(), pw);
          this.syncSessionNameIfCurrentUser(this.currentStaff.id, name);
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
    const newPassword = this.currentStaff.password;
    this.auth
      .registerStaff({
        fullName: name,
        email: email.toLowerCase(),
        phone,
        password: newPassword,
        role,
        department: this.currentStaff.position.trim(),
      })
      .subscribe({
        next: () => {
          this.staffSaving = false;
          if (newPassword) this.staffPasswordByEmail.set(email.toLowerCase(), newPassword);
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
    // localStorage removed
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
            this.doctorPricingsMap.set(key, item.prices);
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
    this.rebuildReportPriceFields();

    const prices: Record<string, number> = {};
    for (const field of this.reportPriceFields) {
      prices[field.key] = this.priceForKey(custom, field.key);
    }
    this.customWorkTypePrices = prices;
    this.syncMapIntoLegacyTemplatePrices(prices);
  }

  private syncMapIntoLegacyTemplatePrices(prices: Record<string, number>): void {
    this.customEmaxPrice = prices['emax'] ?? this.defaultPriceByKey['emax'] ?? 0;
    this.customGermanZirconPrice = prices['germanZircon'] ?? this.defaultPriceByKey['germanZircon'] ?? 0;
    this.customZirconPrice = prices['zircon'] ?? this.defaultPriceByKey['zircon'] ?? 0;
    this.customTitaniumPrice = prices['titanium'] ?? this.defaultPriceByKey['titanium'] ?? 0;
    this.customPeekPrice = prices['peek'] ?? this.defaultPriceByKey['peek'] ?? 0;
    this.customPmmaPrice = prices['pmma'] ?? this.defaultPriceByKey['pmma'] ?? 0;
    this.customNightGuardPrice = prices['nightGuard'] ?? this.defaultPriceByKey['nightGuard'] ?? 0;
    this.customMockupPrice = prices['mockup'] ?? this.defaultPriceByKey['mockup'] ?? 0;
    this.customWaxPrice = prices['wax'] ?? this.defaultPriceByKey['wax'] ?? 0;
    this.customRingPrice = prices['ring'] ?? this.defaultPriceByKey['ring'] ?? 0;
    this.customTryInPrice = prices['tryIn'] ?? this.defaultPriceByKey['tryIn'] ?? 0;
  }

  saveDoctorCustomPrices(): void {
    if (!this.reportDoctorFilter) return;
    this.isPricingSaving = true;
    this.pricingSaveSuccess = false;
    this.pricingSaveError = '';
    this.rebuildReportPriceFields();

    const prices: Record<string, number> = {};
    for (const field of this.reportPriceFields) {
      const raw = this.customWorkTypePrices[field.key];
      prices[field.key] = Number.isFinite(Number(raw)) ? Number(raw) : this.defaultPriceByKey[field.key] ?? 0;
    }
    this.customWorkTypePrices = { ...this.customWorkTypePrices, ...prices };
    this.syncMapIntoLegacyTemplatePrices(prices);

    this.caseApi.updateDoctorPricing(this.reportDoctorFilter, prices).subscribe({
      next: () => {
        this.isPricingSaving = false;
        this.pricingSaveSuccess = true;

        const key = this.doctorGroupKey(this.reportDoctorFilter);
        const prev = this.doctorPricingsMap.get(key) || {};
        this.doctorPricingsMap.set(key, { ...prev, ...prices });

        this.loadFinancialReportFromApi();
      },
      error: (err) => {
        this.isPricingSaving = false;
        this.pricingSaveError = 'تعذر حفظ الأسعار المخصصة';
        console.error('Failed to update doctor pricing:', err);
      }
    });
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

  private localYmd(d = new Date()): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private localYm(d = new Date()): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  ensureCashFiltersInitialized(): void {
    if (!this.cashDayFilter) this.cashDayFilter = this.localYmd();
    if (!this.cashMonthFilter) this.cashMonthFilter = this.localYm();
    if (!this.cashFormDate) this.cashFormDate = this.cashDayFilter || this.localYmd();
  }

  private cashRange(): { from: string; to: string } {
    if (this.cashViewMode === 'month') {
      const [y, m] = (this.cashMonthFilter || this.localYm()).split('-').map(Number);
      const last = new Date(y, m, 0).getDate();
      const mm = String(m).padStart(2, '0');
      return {
        from: `${y}-${mm}-01`,
        to: `${y}-${mm}-${String(last).padStart(2, '0')}`,
      };
    }
    const day = this.cashDayFilter || this.localYmd();
    return { from: day, to: day };
  }

  onCashFilterChange(): void {
    if (this.cashViewMode === 'day' && this.cashDayFilter) {
      this.cashFormDate = this.cashDayFilter;
    }
    this.loadCashEntries();
  }

  loadCashEntries(): void {
    this.ensureCashFiltersInitialized();
    this.cashLoading = true;
    this.cashError = '';
    const { from, to } = this.cashRange();
    this.caseApi.getCashEntries({ from, to }).subscribe({
      next: (res) => {
        this.cashEntries = res?.data ?? [];
        this.cashLoading = false;
      },
      error: (err) => {
        this.cashEntries = [];
        this.cashLoading = false;
        this.cashError = 'تعذر تحميل الحركات: ' + (err.error?.message || err.message || '');
      },
    });
  }

  get cashIncomeTotal(): number {
    return this.cashEntries
      .filter((e) => e.type === 'income')
      .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  }

  get cashExpenseTotal(): number {
    return this.cashEntries
      .filter((e) => e.type === 'expense')
      .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  }

  get cashProfitTotal(): number {
    return this.cashIncomeTotal - this.cashExpenseTotal;
  }

  formatCashDate(value: string | Date | undefined): string {
    if (!value) return '—';
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-GB');
  }

  addCashEntry(): void {
    const amount = Number(this.cashFormAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      this.cashError = 'أدخل مبلغًا صحيحًا أكبر من صفر';
      return;
    }
    this.cashSaving = true;
    this.cashError = '';
    this.caseApi
      .addCashEntry({
        type: this.cashFormType,
        amount,
        date: this.cashFormDate || this.localYmd(),
        notes: (this.cashFormNotes || '').trim(),
      })
      .subscribe({
        next: () => {
          this.cashSaving = false;
          this.cashFormAmount = null;
          this.cashFormNotes = '';
          this.loadCashEntries();
        },
        error: (err) => {
          this.cashSaving = false;
          this.cashError = 'تعذر إضافة الحركة: ' + (err.error?.message || err.message || '');
        },
      });
  }

  private resolveLinkedDoctorPaymentId(entry: {
    _id?: string;
    doctorPaymentId?: string | null;
    category?: string;
    amount?: number;
    date?: string | Date;
    notes?: string;
  }): string {
    const direct = String(entry?.doctorPaymentId || '').trim();
    if (direct) return direct;
    if (String(entry?.category || '').toLowerCase() !== 'doctor_payment') return '';

    const amount = Number(entry?.amount) || 0;
    const entryDay = this.formatCashDate(entry?.date);
    const notes = String(entry?.notes || '').toLowerCase();
    const match = this.doctorPayments.find((p: any) => {
      const sameAmount = Number(p?.amount) === amount;
      const sameDay = this.formatCashDate(p?.paymentDate || p?.createdAt) === entryDay;
      const name = String(p?.doctorName || '').trim().toLowerCase();
      const notesMatch = !name || notes.includes(name);
      return sameAmount && sameDay && notesMatch;
    });
    return String(match?._id || match?.id || '').trim();
  }

  deleteCashEntry(entry: {
    _id?: string;
    doctorPaymentId?: string | null;
    category?: string;
    amount?: number;
    date?: string | Date;
    notes?: string;
  }): void {
    const cashId = String(entry?._id || '').trim();
    const paymentId = this.resolveLinkedDoctorPaymentId(entry);
    if (!cashId && !paymentId) return;
    if (!confirm('هل أنت متأكد من حذف هذه الحركة؟')) return;

    this.cashError = '';
    // Report doctor/lab payments are mirrored into cash. Delete the source
    // payment first so the next cash sync cannot recreate the income row.
    const finish = () => {
      this.loadCashEntries();
      this.loadDoctorPayments();
    };

    if (paymentId) {
      this.caseApi.deleteDoctorPayment(paymentId).subscribe({
        next: () => {
          if (!cashId) {
            finish();
            return;
          }
          // Ensure the cash row is gone even if backend forgot the cascade.
          this.caseApi.deleteCashEntry(cashId).subscribe({
            next: () => finish(),
            error: () => finish(),
          });
        },
        error: (err) => {
          if (!cashId) {
            this.cashError = 'تعذر الحذف: ' + (err.error?.message || err.message || '');
            return;
          }
          this.caseApi.deleteCashEntry(cashId).subscribe({
            next: () => finish(),
            error: (err2) => {
              this.cashError =
                'تعذر الحذف: ' + (err2.error?.message || err.error?.message || err2.message || '');
            },
          });
        },
      });
      return;
    }

    this.caseApi.deleteCashEntry(cashId).subscribe({
      next: () => finish(),
      error: (err) => {
        this.cashError = 'تعذر الحذف: ' + (err.error?.message || err.message || '');
      },
    });
  }

  addDoctorPaymentOnAccount(): void {
    if (!this.reportDoctorFilter || !this.newPaymentAmount || this.newPaymentAmount <= 0) return;
    const amount = Number(this.newPaymentAmount);
    const remaining = this.getDoctorRemainingBalance(this.reportDoctorFilter);
    if (remaining <= 0) {
      this.paymentError = 'لا يوجد متبقي على فاتورة هذا الحساب';
      return;
    }
    if (!Number.isFinite(amount) || amount > remaining) {
      this.paymentError = `لا يمكن تسجيل دفعة أكبر من المتبقي (${remaining.toLocaleString('en-US')} EGP)`;
      return;
    }
    this.paymentSaving = true;
    this.paymentError = '';

    this.caseApi.addDoctorPayment(
      this.reportDoctorFilter,
      amount,
      this.newPaymentNotes,
      undefined,
      remaining
    ).subscribe({
      next: () => {
        this.paymentSaving = false;
        this.newPaymentAmount = null;
        this.newPaymentNotes = '';
        this.loadDoctorPayments();
        this.loadCashEntries();
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
        this.loadCashEntries();
      },
      error: (err) => {
        alert('تعذر حذف الدفعة: ' + (err.error?.message || err.message));
        console.error('Failed to delete doctor payment:', err);
      }
    });
  }

  getDoctorPaymentsList(doctorName: string): any[] {
    const key = this.doctorGroupKey(doctorName);
    return this.doctorPayments.filter(p => this.doctorGroupKey(p.doctorName) === key);
  }

  printDoctorReceipt(): void {
    if (!this.reportDoctorFilter) return;

    const now = new Date();
    const dateStr =
      now.toLocaleDateString('en-GB') +
      ' ' +
      now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const doctorName = this.reportDoctorFilter;
    const totalDue = this.getDoctorTotalDue(doctorName);
    const totalPaid = this.getDoctorTotalPaid(doctorName);
    const remaining = totalDue - totalPaid;
    const casesCount = this.reportFilteredCases.length;
    const payments = this.getDoctorPaymentsList(doctorName);
    const fmt = (n: number) =>
      n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

    let paymentsRows = '';
    if (payments.length === 0) {
      paymentsRows = `<tr><td colspan="3" style="text-align:center;font-style:italic;">لا توجد دفعات مسجلة</td></tr>`;
    } else {
      payments.forEach((p: any) => {
        const pDate = p.paymentDate ? new Date(p.paymentDate).toLocaleDateString('en-GB') : '—';
        const note = p.notes || '—';
        paymentsRows += `<tr>
          <td style="text-align:right;">${fmt(p.amount)} EGP</td>
          <td style="text-align:center;">${note}</td>
          <td style="text-align:left;">${pDate}</td>
        </tr>`;
      });
    }

    const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>كشف حساب — د. ${doctorName}</title>
  <style>
    @page { margin: 2mm; size: 80mm auto; }
    * { box-sizing: border-box; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
    html, body { margin: 0; padding: 0; background: #fff; color: #000; }
    body { width: 100%; max-width: 72mm; margin: 0 auto; padding: 4px 8px; font-size: 11px; }
    .center { text-align: center; }
    .bold { font-weight: bold; }
    .dash { border-top: 1px dashed #555; margin: 6px 0; }
    .solid { border-top: 2px solid #000; margin: 6px 0; }
    table { width: 100%; border-collapse: collapse; margin: 4px 0; }
    th { padding: 4px; font-weight: bold; border-bottom: 1px solid #000; }
    td { padding: 3px 4px; }
    .val-col { text-align: left; }
  </style>
</head>
<body>
  <div class="center bold" style="font-size:14px;">Elite Lab</div>
  <div class="center" style="font-size:10px;">Precision Dental Laboratories</div>
  <div class="solid"></div>
  <div class="center bold">كشف حساب — د. ${doctorName}</div>
  <div class="solid"></div>
  <table>
    <thead><tr><th>البيان</th><th class="val-col">القيمة</th></tr></thead>
    <tbody>
      <tr><td>عدد الحالات الخارجة</td><td class="val-col">${casesCount}</td></tr>
      <tr><td>إجمالي الحساب</td><td class="val-col">${fmt(totalDue)} EGP</td></tr>
      <tr><td>المبلغ المدفوع</td><td class="val-col">${fmt(totalPaid)} EGP</td></tr>
      <tr><td class="bold">المبلغ المستحق</td><td class="val-col bold">${fmt(remaining)} EGP</td></tr>
    </tbody>
  </table>
  <div class="dash"></div>
  <div class="center bold">سجل الدفعات</div>
  <table>
    <thead><tr><th>المبلغ</th><th>ملاحظات</th><th>تاريخ الدفع</th></tr></thead>
    <tbody>${paymentsRows}</tbody>
  </table>
  <div class="solid"></div>
  <table>
    <tr><td class="bold">إجمالي المتبقي</td><td class="val-col bold">${fmt(remaining)} EGP</td></tr>
    <tr><td>تاريخ طباعة الوصل</td><td class="val-col">${dateStr}</td></tr>
  </table>
  <div class="dash"></div>
  <div class="center" style="font-size:10px;">شكراً لتعاملكم معنا — Elite Dental Lab</div>
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

  private formatPdfCaseDate(value: Date | string | undefined | null): string {
    if (!value) return '—';
    const formatted = this.formatDateEn(value);
    return !formatted || formatted === 'غير متوفر' ? '—' : formatted;
  }

  private formatPdfCaseEntryDate(c: AdminCaseRow): string {
    const fromDate = this.formatPdfCaseDate(c.receivedAt);
    if (fromDate !== '—') return fromDate;
    const display = String(c.receivedDateDisplay || '').trim();
    if (display && display !== 'غير متوفر') return display;
    return '—';
  }

  private formatPdfCaseExitDate(c: AdminCaseRow): string {
    const fromDate = this.formatPdfCaseDate(c.exitedAt);
    if (fromDate !== '—') return fromDate;
    const display = String(c.exitedAtDisplay || '').trim();
    if (display && display !== 'غير متوفر') return display;
    return '—';
  }

  formatReportEntryDate(c: AdminCaseRow): string {
    const value = this.formatPdfCaseEntryDate(c);
    return value === '—' ? 'غير متوفر' : value;
  }

  formatReportExitDate(c: AdminCaseRow): string {
    const value = this.formatPdfCaseExitDate(c);
    return value === '—' ? 'غير متوفر' : value;
  }

  private escapePdfHtml(value: string): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private sortCasesForPdf(cases: AdminCaseRow[], includeDoctor: boolean): AdminCaseRow[] {
    return [...cases].sort((a, b) => {
      if (includeDoctor) {
        const byDoctor = this.reportCaseDoctorName(a).localeCompare(this.reportCaseDoctorName(b));
        if (byDoctor !== 0) return byDoctor;
      }
      const byPatient = String(a.patientName || '').localeCompare(String(b.patientName || ''));
      if (byPatient !== 0) return byPatient;
      return this.formatPdfCaseDate(a.receivedAt).localeCompare(this.formatPdfCaseDate(b.receivedAt));
    });
  }

  private buildAccountCasesPdfTable(cases: AdminCaseRow[], includeDoctor: boolean): string {
    const fmt = (n: number) =>
      n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    const th =
      'border:1px solid #222;background:#f3f4f6;padding:7px 6px;font-size:11px;font-weight:700;text-align:center;';
    const td = 'border:1px solid #333;padding:7px 6px;font-size:11px;vertical-align:top;';
    const sorted = this.sortCasesForPdf(cases, includeDoctor);
    const colCount = includeDoctor ? 7 : 6;

    if (!sorted.length) {
      return `<tr><td colspan="${colCount}" style="${td};text-align:center;color:#666;">لا توجد حالات</td></tr>`;
    }

    return sorted
      .map((c, index) => {
        const doctorCell = includeDoctor
          ? `<td style="${td};text-align:center;white-space:nowrap;">${this.escapePdfHtml(this.reportCaseDoctorName(c))}</td>`
          : '';
        return `<tr>
          <td style="${td};text-align:center;width:28px;">${index + 1}</td>
          ${doctorCell}
          <td style="${td};text-align:center;white-space:nowrap;">${this.escapePdfHtml(c.patientName || '—')}</td>
          <td style="${td};text-align:right;">${this.escapePdfHtml(this.translateCaseType(c.caseType) || '—')}</td>
          <td style="${td};text-align:center;white-space:nowrap;">${this.escapePdfHtml(this.formatPdfCaseEntryDate(c))}</td>
          <td style="${td};text-align:center;white-space:nowrap;">${this.escapePdfHtml(this.formatPdfCaseExitDate(c))}</td>
          <td style="${td};text-align:center;font-weight:700;white-space:nowrap;">${fmt(this.calculateCaseCost(c))}</td>
        </tr>`;
      })
      .join('');
  }

  async saveDoctorReceiptPdf(): Promise<void> {
    if (!this.reportDoctorFilter) return;

    const accountName = this.reportDoctorFilter;
    const isLabAccount = this.isFilteredReportAccountLab;
    const totalDue = this.getDoctorTotalDue(accountName);
    const totalPaid = this.getDoctorTotalPaid(accountName);
    const remaining = totalDue - totalPaid;
    const cases = this.reportFilteredCases;
    const casesCount = cases.length;
    const fmt = (n: number) =>
      n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    const safeFileName = String(accountName || 'account')
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ');
    const dateStr = this.formatDateEn(new Date());
    const accountLabel = isLabAccount
      ? `معمل: ${this.escapePdfHtml(accountName)}`
      : `دكتور: ${this.escapePdfHtml(accountName)}`;
    const doctorHeader = isLabAccount
      ? `<th style="border:1px solid #222;background:#f3f4f6;padding:7px 6px;font-size:11px;font-weight:700;text-align:center;">الدكتور</th>`
      : '';

    const container = document.createElement('div');
    container.setAttribute('dir', 'rtl');
    container.style.cssText =
      'position:fixed;left:-10000px;top:0;width:794px;background:#fff;color:#111;padding:24px 28px;font-family:"Segoe UI",Tahoma,Geneva,Verdana,sans-serif;font-size:13px;line-height:1.45;z-index:-1;';
    container.innerHTML = `
      <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
        <tr>
          <td style="padding:0 0 10px;border-bottom:2px solid #111;vertical-align:bottom;">
            <div style="font-size:20px;font-weight:800;">Elite Lab</div>
            <div style="font-size:12px;color:#555;">كشف حساب</div>
          </td>
          <td style="padding:0 0 10px;border-bottom:2px solid #111;text-align:left;vertical-align:bottom;">
            <div style="font-weight:800;font-size:14px;">${accountLabel}</div>
            <div style="color:#555;font-size:12px;margin-top:2px;">التاريخ: ${dateStr}</div>
          </td>
        </tr>
      </table>

      <table style="width:100%;border-collapse:collapse;table-layout:fixed;">
        <thead>
          <tr>
            <th style="border:1px solid #222;background:#f3f4f6;padding:7px 6px;font-size:11px;font-weight:700;text-align:center;width:36px;">#</th>
            ${doctorHeader}
            <th style="border:1px solid #222;background:#f3f4f6;padding:7px 6px;font-size:11px;font-weight:700;text-align:center;width:110px;">المريض</th>
            <th style="border:1px solid #222;background:#f3f4f6;padding:7px 6px;font-size:11px;font-weight:700;text-align:center;">نوع العمل</th>
            <th style="border:1px solid #222;background:#f3f4f6;padding:7px 6px;font-size:11px;font-weight:700;text-align:center;width:90px;">تاريخ الدخول</th>
            <th style="border:1px solid #222;background:#f3f4f6;padding:7px 6px;font-size:11px;font-weight:700;text-align:center;width:90px;">تاريخ الخروج</th>
            <th style="border:1px solid #222;background:#f3f4f6;padding:7px 6px;font-size:11px;font-weight:700;text-align:center;width:80px;">السعر</th>
          </tr>
        </thead>
        <tbody>${this.buildAccountCasesPdfTable(cases, isLabAccount)}</tbody>
      </table>

      <table style="width:100%;border-collapse:collapse;margin-top:14px;">
        <tr>
          <td style="border:1px solid #222;padding:8px 10px;width:25%;">
            <div style="font-size:11px;color:#555;">عدد الحالات</div>
            <div style="font-size:15px;font-weight:800;">${casesCount}</div>
          </td>
          <td style="border:1px solid #222;padding:8px 10px;width:25%;">
            <div style="font-size:11px;color:#555;">الإجمالي</div>
            <div style="font-size:15px;font-weight:800;">${fmt(totalDue)} EGP</div>
          </td>
          <td style="border:1px solid #222;padding:8px 10px;width:25%;">
            <div style="font-size:11px;color:#555;">المدفوع</div>
            <div style="font-size:15px;font-weight:800;">${fmt(totalPaid)} EGP</div>
          </td>
          <td style="border:1px solid #222;padding:8px 10px;width:25%;">
            <div style="font-size:11px;color:#555;">المتبقي</div>
            <div style="font-size:15px;font-weight:800;">${fmt(remaining)} EGP</div>
          </td>
        </tr>
      </table>

      <div style="text-align:center;font-size:11px;color:#555;margin-top:14px;">شكراً لتعاملكم معنا — Elite Dental Lab</div>
    `;

    document.body.appendChild(container);
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import('html2canvas'),
        import('jspdf'),
      ]);
      const canvas = await html2canvas(container, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true,
      });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 10;
      const imgWidth = pageWidth - margin * 2;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;

      let heightLeft = imgHeight;
      let position = margin;
      pdf.addImage(imgData, 'PNG', margin, position, imgWidth, imgHeight);
      heightLeft -= pageHeight - margin * 2;

      while (heightLeft > 0) {
        position = margin - (imgHeight - heightLeft);
        pdf.addPage();
        pdf.addImage(imgData, 'PNG', margin, position, imgWidth, imgHeight);
        heightLeft -= pageHeight - margin * 2;
      }

      pdf.save(`${safeFileName}.pdf`);
    } catch (err) {
      console.error(err);
      alert('تعذر حفظ ملف PDF، حاول مرة أخرى');
    } finally {
      container.remove();
    }
  }
}



