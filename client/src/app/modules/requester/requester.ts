import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { CaseApiService } from '../../core/services/case-api.service';
import { SharedCasesService } from '../../core/services/shared-cases.service';
import { mapApiCaseToDentalCase } from '../../core/mappers/dental-case-api.mapper';
import {
  buildCasePayloadFromPrintForm,
  buildPrintData,
  formatWorkTypeForPrint,
} from '../../core/utils/print-job.util';
import { Subscription, switchMap } from 'rxjs';
import { SocketService } from '../../core/services/socket.service';
import { ThemeService } from '../../core/services/theme.service';
import { LanguageService } from '../../core/i18n/language.service';
import { TPipe } from '../../core/i18n/t.pipe';
import { environment } from '../../../environments/environment';
import { AppOverflowMenuComponent } from '../../shared/app-overflow-menu/app-overflow-menu';
import { BrandLockupComponent } from '../../shared/brand-lockup/brand-lockup';

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

@Component({
  selector: 'app-requester',
  standalone: true,
  imports: [CommonModule, FormsModule, AppOverflowMenuComponent, BrandLockupComponent, TPipe],
  templateUrl: './requester.html',
  styleUrl: './requester.css',
})
export class RequesterComponent implements OnInit, OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly caseApi = inject(CaseApiService);
  private readonly sharedCases = inject(SharedCasesService);
  private readonly socketService = inject(SocketService);
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  public readonly themeService = inject(ThemeService);
  public readonly lang = inject(LanguageService);

  private readonly apiBase = environment.apiUrl;

  private readonly socketSubs: Subscription[] = [];

  readonly dialogOpen = signal(false);
  // Search & request handling
  public searchTerm: string = '';
  public allRequests: any[] = [];
  public requests: any[] = [];

  readonly saveInProgress = signal(false);
  readonly toast = signal<string | null>(null);
  readonly notificationsOpen = signal(false);

  formDraft = emptyDraft();

  // Work type state
  readonly workTypeOptions = [
    'Zircon',
    'Emax', 'Pmma Cad',
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

  // Work types that do NOT require a color
  readonly colorOptionalTypes = new Set(['Try in', 'Mokup', 'Night Guard', 'Wax', 'Ring']);

  /** Returns true when ALL selected work types are color-optional */
  get isColorOptional(): boolean {
    if (this.selectedWorkTypes.size === 0) return false;
    for (const wt of this.selectedWorkTypes) {
      if (!this.colorOptionalTypes.has(wt)) return false;
    }
    return true;
  }

  // Doctor autocomplete
  readonly showDoctorSuggestions = signal(false);
  readonly activeSuggestionIndex = signal(-1);
  private doctorSearchQuery = '';

  get filteredDoctors(): string[] {
    const allCases = this.sharedCases.cases();
    const doctors = Array.from(new Set(
      allCases.map(c => c.doctor?.trim()).filter((n): n is string => !!n)
    )).sort();
    const q = this.normalizeArabic(this.doctorSearchQuery);
    if (!q) return doctors.slice(0, 10);
    return doctors.filter(d => this.normalizeArabic(d).includes(q));
  }

  normalizeArabic(text: string): string {
    if (!text) return '';
    return text.trim()
      .replace(/[أإآا]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي')
      .replace(/\s+/g, ' ');
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
      this.formDraft.quantity = 0; // غير معروف → 0
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
    } else {
      if (type === 'Empty') {
        this.selectedWorkTypes.clear();
        this.workTypeQuantities = {};
        this.selectedWorkTypes.add('Empty');
        this.workTypeQuantities['Empty'] = 1;
        this.nightGuardType = '';
      } else {
        this.selectedWorkTypes.delete('Empty');
        delete this.workTypeQuantities['Empty'];
        this.selectedWorkTypes.add(type);
        this.workTypeQuantities[type] = 1;
        if (type === 'Night Guard') this.nightGuardType = 'Soft';
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

  ngOnInit(): void {
    this.loadRequests();
    this.socketService.connect();
  }

  loadRequests(): void {
    this.caseApi.getAllCases(1, 400, { scope: 'open' }).subscribe({
      next: res => {
        const rows = (res?.data ?? []) as Record<string, unknown>[];
        if (Array.isArray(rows)) {
          this.allRequests = rows.map(r => mapApiCaseToDentalCase(r));
          this.applySortingAndFilter();
        }
      },
      error: () => {}
    });
  }

  applySortingAndFilter(): void {
    // sort by createdAt descending (newest first)
    const sorted = this.allRequests.sort((a: any, b: any) => {
      const aDate = new Date((a as any).createdAt || (a as any).date);
      const bDate = new Date((b as any).createdAt || (b as any).date);
      return bDate.getTime() - aDate.getTime();
    });
    if (this.searchTerm) {
      const term = this.searchTerm.toLowerCase();
      this.requests = sorted.filter(r => (r.doctor || '').toLowerCase().includes(term));
    } else {
      this.requests = sorted;
    }
  }

  onSearchChange(): void {
    this.applySortingAndFilter();
  }

  ngOnDestroy(): void {
    this.socketSubs.forEach(s => s.unsubscribe());
  }

  openDialog(): void {
    this.formDraft = emptyDraft();
    this.selectedWorkTypes.clear();
    this.workTypeQuantities = {};
    this.workTypeError = '';
    this.nightGuardType = '';
    this.dialogOpen.set(true);
  }

  closeDialog(): void {
    this.dialogOpen.set(false);
  }

  save(): void {
    const d = this.formDraft;

    if (!d.doctor.trim()) { this.flash(this.lang.t('form.errDoctor')); return; }
    if (!d.patient?.trim()) { this.flash(this.lang.t('form.errPatient')); return; }
    if (!d.branch?.trim()) { this.flash(this.lang.t('form.errBranch')); return; }
    if (d.caseType !== 'Empty' && this.selectedWorkTypes.size === 0) {
      this.workTypeError = this.lang.t('form.errWorkTypeAtLeast');
      this.flash(this.lang.t('form.errWorkType'));
      return;
    }
    if (!this.isColorOptional && !d.color?.trim()) { this.flash(this.lang.t('form.errColor')); return; }

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
    };

    this.closeDialog();
    this.saveInProgress.set(true);

    const token = this.auth.getToken();
    const createThenPrint = token
      ? this.caseApi.createCase(buildCasePayloadFromPrintForm(draft, { entrySource: 'print' })).pipe(
          switchMap((res: { case?: { caseNumber?: string } }) => {
            const caseNumber = String(res?.case?.caseNumber ?? '');
            return this.http.post(`${this.apiBase}/print/job`, {
              printData: buildPrintData(draft, caseNumber),
            });
          })
        )
      : this.http.post(`${this.apiBase}/print/job`, {
          printData: buildPrintData(draft, ''),
        });

    createThenPrint.subscribe({
      next: () => {
        this.saveInProgress.set(false);
        this.flash(this.lang.t('requester.toast.sent'));
      },
      error: () => {
        this.saveInProgress.set(false);
        this.flash(this.lang.t('requester.toast.fail'));
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

  printCaseCard(c: any): void {
    const now = new Date();
    const printDate = now.toLocaleDateString('en-GB') + '  ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const workTypeDisplay = this.formatWorkTypeForDisplay(c.workType);
    const quantity = c.caseType === 'Empty' ? 0 : (c.quantity || 0);

    const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8">
  <title>ريكويست</title>
  <style>
    @page { size: A4; margin: 0mm 20mm 15mm 20mm; }
    html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    * { box-sizing: border-box; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
    html { height: 100%; }
    body { margin: 0; padding: 0; background: #fff; color: #000; font-size: 19px; }
    .section { margin: 22px 0; }
    .section-title { font-size: 17px; font-weight: bold; border-right: 4px solid #000; padding-right: 12px; margin-bottom: 12px; color: #222; }
    .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #eee; font-size: 18px; }
    .row:last-child { border-bottom: none; }
    .label { color: #666; }
    .value { font-weight: bold; text-align: left; }
    .footer { margin-top: 30px; padding-top: 14px; border-top: 2px solid #000; display: flex; justify-content: flex-end; font-size: 15px; color: #555; }
    .footer-brand { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
    .footer-brand-name { font-weight: bold; font-size: 16px; color: #222; }
    .footer-date { font-size: 13px; color: #666; }
    .teeth-section { margin-top: 36px; }
    .teeth-title { font-size: 17px; font-weight: bold; border-right: 4px solid #000; padding-right: 12px; margin-bottom: 14px; color: #222; }
    .teeth-table { width: 100%; border-collapse: collapse; font-size: 17px; }
    .teeth-table th { background: #2980b9; color: #fff; text-align: center; padding: 8px 0; font-size: 18px; font-weight: bold; width: 50%; }
    .teeth-table td { text-align: center; padding: 10px 2px; font-size: 18px; font-weight: bold; width: 6.25%; }
    .teeth-table .divider td { border-top: 2px solid #333; padding: 0; height: 0; }
    .center-line { border-right: 2px solid #333; }
  </style>
</head>
<body>

  <div class="section">
    <div class="section-title">بيانات الطبيب والمريض</div>
    <div class="row"><span class="label">الطبيب</span><span class="value">${c.doctor || '—'}</span></div>
    <div class="row"><span class="label">المريض</span><span class="value">${c.patient || '—'}</span></div>
    <div class="row"><span class="label">الفرع</span><span class="value">${c.branch || '—'}</span></div>
  </div>

  <div class="section">
    <div class="section-title">تفاصيل العمل</div>
    <div class="row"><span class="label">نوع العمل</span><span class="value">${workTypeDisplay || '—'}</span></div>
    ${c.workDetail ? `<div class="row"><span class="label">ملاحظات</span><span class="value">${c.workDetail}</span></div>` : ''}
    <div class="row"><span class="label">اللون</span><span class="value">${c.color || '—'}</span></div>
    <div class="row"><span class="label">إجمالي العدد</span><span class="value">${quantity}</span></div>
  </div>

  <div class="teeth-section">
    <div class="teeth-title">مخطط الأسنان</div>
    <table class="teeth-table" dir="ltr">
      <thead>
        <tr><th colspan="8">R</th><th colspan="8">L</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>8</td><td>7</td><td>6</td><td>5</td><td>4</td><td>3</td><td>2</td><td class="center-line">1</td>
          <td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td><td>7</td><td>8</td>
        </tr>
        <tr class="divider"><td colspan="16"></td></tr>
        <tr>
          <td>8</td><td>7</td><td>6</td><td>5</td><td>4</td><td>3</td><td>2</td><td class="center-line">1</td>
          <td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td><td>7</td><td>8</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="footer">
    <div class="footer-brand">
      <span class="footer-brand-name">Elegance Dental Lab</span>
      <span class="footer-date">تاريخ الطباعة: ${printDate}</span>
    </div>
  </div>
  <script>
    window.onload = function() { window.print(); window.onafterprint = function() { window.close(); }; };
  </script>
</body>
</html>`;

    const popup = window.open('', '_blank', 'width=800,height=900,toolbar=0,menubar=0,scrollbars=0');
    if (popup) {
      popup.document.write(html);
      popup.document.close();
    }
  }
}
