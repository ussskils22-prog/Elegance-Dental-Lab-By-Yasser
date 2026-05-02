import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { AppRole } from '../../core/auth/auth.types';
import { AdminDashboardService } from '../../core/services/admin-dashboard.service';
import { AuthService } from '../../core/services/auth.service';
import { UserApiService } from '../../core/services/user-api.service';
import { CaseApiService } from '../../core/services/case-api.service';
import { Subject, merge } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import { SocketService } from '../../core/services/socket.service';

export interface StaffMember {
  id: string;
  name: string;
  email: string;
  password: string;
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
  requesterType?: 'doctor' | 'student';
  doctor?: string;
  doctorName?: string;
  clinic?: string;
  currentStage: string;
  priority: string;
  receivedDateDisplay?: string;
  receivedAt?: Date;
  deliveryDateDisplay?: string;
  dueDateDisplay: string;
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
  stage: string;
  salary: number;
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
  activeNav = 'patients';
  showStaffPassword = false;
  showStaffModal = false;
  staffModalError = '';
  staffSaving = false;
  staffLoadError = '';
  isEditMode = false;
  searchTerm = '';
  globalSearch = '';
  reportSearch = '';
  reportDoctorFilter = '';
  paymentFilter: 'all' | 'paid' | 'unpaid' = 'unpaid';
  financialYearFilter = '';
  financialMonthFilter = '';
  financialDoctorSearch = '';
  selectedDoctorName = '';
  showDoctorDetailsModal = false;
  financialSaveError = '';
  studentReportSearch = '';

  patientCases: PatientCase[] = [];
  patients: AdminPatient[] = [];
  adminCases: AdminCaseRow[] = [];
  reportCases: AdminCaseRow[] = [];
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
    private adminDashboardService: AdminDashboardService,
    private auth: AuthService,
    private userApi: UserApiService,
    private router: Router,
    private socketService: SocketService
  ) {}

  logout(): void {
    this.auth.performLogout(this.router);
  }
  ngOnInit(): void {
    this.restoreActiveNav();
    this.loadCasesFromApi();
    this.loadFinancialReportFromApi();
    this.loadStaffFromApi();
    if (this.activeNav === 'staff') {
      this.loadStaffFromApi();
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
        filter((evt) => !!evt)
      )
      .subscribe(() => {
        this.loadCasesFromApi();
        this.loadFinancialReportFromApi();
      });
  }

  staffMembers: StaffMember[] = [];

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

  readonly positions = ['مصمم', 'فني تشطيب', 'سكرتير', 'مدير'] as const;

  get filteredStaff(): StaffMember[] {
    if (!this.searchTerm.trim()) return this.staffMembers;
    const search = this.searchTerm.toLowerCase();
    return this.staffMembers.filter(staff =>
      staff.name.toLowerCase().includes(search) ||
      staff.email.toLowerCase().includes(search) ||
      staff.phone.includes(search)
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
    return this.adminCases.filter(c => c.currentStage === 'completed');
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

  get reportFilteredCases(): AdminCaseRow[] {
    const search = this.reportSearch.toLowerCase().trim();
    return this.reportCases.filter(c => {
      let match = true;
      if (search) {
        match = [c.caseNumber, c.patientName, c.doctorName || c.assignedTo || '', c.currentStage]
          .some(value => value?.toLowerCase().includes(search));
      }
      if (this.reportDoctorFilter) {
        match = match && (c.doctorName === this.reportDoctorFilter || c.assignedTo === this.reportDoctorFilter || false);
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

    this.completedCases.forEach(c => {
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
    const selectedYear = Number(this.financialYearFilter);
    if (!Number.isFinite(selectedYear)) {
      return;
    }

    const targetYear = this.groupedFinancialSummary.find(year => year.year === selectedYear);
    if (!targetYear) {
      return;
    }

    const selectedMonth = Number(this.financialMonthFilter);
    const months = Number.isFinite(selectedMonth) && selectedMonth > 0
      ? targetYear.months.filter(month => month.monthNumber === selectedMonth)
      : targetYear.months;

    if (!months.length) {
      return;
    }

    const rows = [
      'السنة/Year,الشهر/Month,إجمالي الحالات/Total Cases,الحالات المدفوعة/Paid Cases,إجمالي المبلغ/Total Amount,المبلغ المدفوع/Paid Amount,المبلغ غير المدفوع/Unpaid Amount'
    ];

    months.forEach(month => {
      rows.push([
        selectedYear,
        this.monthName(month.monthNumber),
        month.cases,
        month.paidCases,
        month.totalSalary,
        month.paidTotal,
        month.unpaidTotal
      ].join(','));
    });

    rows.push('');
    rows.push('السنة/Year,الشهر/Month,الدكتور/Doctor,الحالات المدفوعة/Paid Cases,المبلغ المدفوع/Paid Amount,إجمالي الحالات/Total Cases,إجمالي المبلغ/Total Amount');

    months.forEach(month => {
      month.byDoctor.forEach(doctor => {
        rows.push([
          selectedYear,
          this.monthName(month.monthNumber),
          `"${doctor.doctorName.replace(/"/g, '""')}"`,
          doctor.paidCases,
          doctor.paidAmount,
          doctor.cases,
          doctor.totalSalary
        ].join(','));
      });
    });

    if (typeof document === 'undefined') {
      return;
    }

    const csvContent = `\uFEFF${rows.join('\n')}`;
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const monthSuffix = Number.isFinite(selectedMonth) && selectedMonth > 0
      ? `-${String(selectedMonth).padStart(2, '0')}`
      : '-all-months';
    anchor.href = url;
    anchor.download = `financial-inventory-${selectedYear}${monthSuffix}.csv`;
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
    const records = this.completedCases
      .filter(c => this.doctorGroupKey(c.doctorName || c.assignedTo || 'غير محدد') === this.doctorGroupKey(this.selectedDoctorName))
      .map(c => ({
        id: c.id,
        caseNumber: c.caseNumber,
        patientName: c.patientName,
        caseType: c.caseType,
        receivedDate: c.receivedDateDisplay || 'غير متوفر',
        stage: c.currentStage,
        salary: c.salary || 0,
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
          totals.paidAmount += record.salary;
        }
        return totals;
      },
      { cases: 0, paidCases: 0, totalAmount: 0, paidAmount: 0 }
    );
  }

  get financialTotalsByDoctor() {
    const totals: Record<string, { cases: number; total: number }> = {};
    this.completedCases.forEach(c => {
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
    return String(caseItem.salary || 0);
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

  private loadCasesFromApi(): void {
    this.caseApi.getAllCases(1, 500).subscribe({
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
      requesterType: String(doc['requesterType'] ?? 'doctor') === 'student' ? 'student' : 'doctor',
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
      source: 'case',
    };
  }

  private mapFinancialReportRowToAdminCase(row: Record<string, unknown>): AdminCaseRow {
    const receivedAt = this.normalizeDate(row['receivedAt']);
    const dueDate = this.normalizeDate(row['dueDate']);
    const salaryAmountRaw = Number(row['salaryAmount']);
    const salary = Number.isFinite(salaryAmountRaw) ? salaryAmountRaw : 0;
    const paid = String(row['paymentStatus'] ?? 'unpaid').toLowerCase() === 'paid';

    return {
      id: String(row['id'] ?? ''),
      caseNumber: String(row['caseNumber'] ?? ''),
      patientName: String(row['patientName'] ?? ''),
      assignedTo: String(row['assignedTo'] ?? '') || null,
      requesterType: String(row['requesterType'] ?? 'doctor') === 'student' ? 'student' : 'doctor',
      doctor: String(row['doctorName'] ?? ''),
      doctorName: String(row['doctorName'] ?? ''),
      clinic: '',
      currentStage: String(row['currentStage'] ?? 'completed'),
      priority: 'normal',
      receivedDateDisplay: receivedAt ? receivedAt.toLocaleString() : 'غير متوفر',
      receivedAt: receivedAt || new Date(),
      deliveryDateDisplay: dueDate ? dueDate.toLocaleString() : 'غير متوفر',
      dueDateDisplay: dueDate ? dueDate.toLocaleString() : 'N/A',
      caseType: String(row['caseType'] ?? 'General'),
      salary,
      paid,
      enteredBy: 'غير معروف',
      secretaryName: 'غير معروف',
      designerName: '',
      finisherName: '',
      secretaryInstructions: '',
      designNotes: '',
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
    this.activeNav = nav;
    this.persistActiveNav();
    if (nav === 'staff') {
      this.loadStaffFromApi();
    } else if (nav === 'reports') {
      this.loadFinancialReportFromApi();
    }
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
    this.userApi.getAllUsers(undefined, undefined, true).subscribe({
      next: res => {
        const list = (res?.data ?? res?.users ?? []) as Record<string, unknown>[];
        this.staffMembers = Array.isArray(list) ? list.map(u => this.mapApiUserToStaff(u)) : [];
      },
      error: err => {
        console.error(err);
        this.staffLoadError = 'تعذر تحميل قائمة الموظفين من الخادم';
        this.staffMembers = [];
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
    const ok = confirm(`حذف ${staff.name}؟ سيتم تحويل الحساب إلى غير نشط.`);
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
    if (r === 'finisher') return 'فني تشطيب';
    return 'سكرتير';
  }

  private positionLabelToRole(position: string): AppRole {
    const p = (position || '').trim().toLowerCase();
    if (p === 'admin' || p === 'مدير') return 'admin';
    if (p === 'secretary' || p === 'سكرتير') return 'secretary';
    if (p === 'designer' || p === 'مصمم') return 'designer';
    if (p === 'finisher' || p === 'فني تشطيب') return 'finisher';
    return 'secretary';
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
    // localStorage removed
  }

  private persistActiveNav(): void {
    // localStorage removed
  }

}
