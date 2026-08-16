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

import { Subscription, forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { SocketService } from '../../core/services/socket.service';
import { CaseDraft, SecretaryService } from './secretary.service';
import { PatientLabelPipe } from './patient-label.pipe';
import { SizeFormatPipe } from './size-format.pipe';
import { ThemeService } from '../../core/services/theme.service';

function emptyDraft(): CaseDraft {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');

  return {
    labName: '',
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
  imports: [CommonModule, FormsModule, PatientLabelPipe],
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
  private readonly socketService = inject(SocketService);
  private readonly router = inject(Router);
  public readonly themeService = inject(ThemeService);
  private readonly socketSubs: Subscription[] = [];
  readonly activeFilter = signal<
    'all' | 'urgent' | 'pending' | 'design' | 'finishing' | 'finished' | 'exited'
  >('all');
  readonly casesLoading = signal(false);
  readonly saveInProgress = signal(false);
  /** Multi-select for bulk exit only (edit/delete stay per-case). */
  readonly selectedExitIds = signal<Set<string>>(new Set());
  readonly bulkExiting = signal(false);

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
    const now = Date.now();
    const fourDaysMs = 4 * 24 * 60 * 60 * 1000;
    return this.sharedCases
      .cases()
      .filter((c) => c.status !== 'exited')
      .map((c) => {
        const receivedAt = this.parseCaseReceivedDate(c);
        return { id: c.id, doctor: c.doctor || 'غير محدد', patient: c.patient || '—', receivedAt };
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
    const allCases = this.sharedCases.cases();
    const pending = allCases.filter((c) => this.caseBucket(c) === 'pending').length;
    const design = allCases.filter((c) => this.caseBucket(c) === 'design').length;
    const finishing = allCases.filter((c) => this.caseBucket(c) === 'finishing').length;
    const finished = allCases.filter((c) => this.caseBucket(c) === 'finished').length;
    const exited = allCases.filter((c) => this.caseBucket(c) === 'exited').length;

    return [
      { label: 'إجمالي الحالات', value: allCases.length, color: 'purple' as const },
      { label: 'الحالات الجديدة', value: pending, color: 'amber' as const },
      { label: 'تحت الديزاين', value: design, color: 'blue' as const },
      { label: 'تحت الفينيش', value: finishing, color: 'teal' as const },
      { label: 'الحالات المنتهية', value: finished, color: 'emerald' as const },
      { label: 'الحالات الخارجة', value: exited, color: 'rose' as const },
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
  /** Create-flow kind; edit derives from existing case */
  readonly createRequesterKind = signal<'doctor' | 'lab'>('doctor');
  editingId: string | null = null;
  formDraft: any = emptyDraft();

  // Autocomplete Doctor logic
  readonly uniqueDoctors = computed(() => {
    const allCases = this.sharedCases.cases();
    const doctors = allCases
      .map(c => c.doctor?.trim())
      .filter((name): name is string => !!name);
    return Array.from(new Set(doctors)).sort();
  });

  readonly doctorSearchQuery = signal('');
  readonly showDoctorSuggestions = signal(false);
  readonly activeSuggestionIndex = signal(-1);

  normalizeArabic(text: string): string {
    if (!text) return '';
    return text
      .trim()
      .replace(/[أإآا]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي')
      .replace(/\s+/g, ' ');
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

  // Autocomplete Lab logic (same pattern as doctors)
  readonly uniqueLabs = computed(() => {
    const allCases = this.sharedCases.cases();
    const labs = allCases
      .map((c) => c.labName?.trim())
      .filter((name): name is string => !!name);
    return Array.from(new Set(labs)).sort();
  });

  readonly labSearchQuery = signal('');
  readonly showLabSuggestions = signal(false);
  readonly activeLabSuggestionIndex = signal(-1);

  readonly filteredLabs = computed(() => {
    const input = this.labSearchQuery();
    const unique = this.uniqueLabs();
    const normalizedInput = this.normalizeArabic(input);
    if (!normalizedInput) {
      return unique.slice(0, 10);
    }
    return unique.filter((lab) => this.normalizeArabic(lab).includes(normalizedInput));
  });

  onLabInputChange(): void {
    this.labSearchQuery.set(this.formDraft.labName || '');
    this.activeLabSuggestionIndex.set(-1);
    this.showLabSuggestions.set(true);
  }

  onLabInputFocus(): void {
    this.labSearchQuery.set(this.formDraft.labName || '');
    this.showLabSuggestions.set(true);
    this.activeLabSuggestionIndex.set(-1);
  }

  onLabInputBlur(): void {
    setTimeout(() => {
      this.showLabSuggestions.set(false);
    }, 200);
  }

  selectLab(lab: string): void {
    this.formDraft.labName = lab;
    this.labSearchQuery.set(lab);
    this.showLabSuggestions.set(false);
    this.activeLabSuggestionIndex.set(-1);
  }

  onLabInputKeydown(event: KeyboardEvent): void {
    const list = this.filteredLabs();
    if (!this.showLabSuggestions() || list.length === 0) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const nextIdx = (this.activeLabSuggestionIndex() + 1) % list.length;
      this.activeLabSuggestionIndex.set(nextIdx);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const prevIdx = (this.activeLabSuggestionIndex() - 1 + list.length) % list.length;
      this.activeLabSuggestionIndex.set(prevIdx);
    } else if (event.key === 'Enter') {
      const activeIdx = this.activeLabSuggestionIndex();
      if (activeIdx >= 0 && activeIdx < list.length) {
        event.preventDefault();
        this.selectLab(list[activeIdx]);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.showLabSuggestions.set(false);
    }
  }

  /** ملف مسح .ply اختياري عند الإنشاء/التعديل */
  selectedPlyFile: File | null = null;
  /** اسم ملف PLY المحفوظ مسبقاً (وضع التعديل) */
  existingPlyFileName: string | null = null;

  /** Built-in work type chips; customs merge via getter */
  readonly defaultWorkTypeOptions = [
    'Zircon', 'German Zircon', 'Emax', 'Pmma Cad',
    'Peek', 'Titanium', 'Try in', 'Mokup',
    'Night Guard', 'Removable Denture', 'Wax', 'Ring'
  ];
  customWorkTypes: Array<{ _id: string; name: string }> = [];
  hiddenDefaultWorkTypes: string[] = [];
  newCustomWorkType = '';
  customWorkTypeError = '';
  customWorkTypeSaving = false;
  workTypesEditMode = false;

  get workTypeOptions(): string[] {
    const hidden = new Set(this.hiddenDefaultWorkTypes.map((n) => n.toLowerCase()));
    const merged = this.defaultWorkTypeOptions.filter((n) => !hidden.has(n.toLowerCase()));
    for (const c of this.customWorkTypes) {
      if (c.name && !merged.some((x) => x.toLowerCase() === c.name.toLowerCase())) {
        merged.push(c.name);
      }
    }
    return merged;
  }

  isCustomWorkType(name: string): boolean {
    return this.customWorkTypes.some((c) => c.name.toLowerCase() === name.toLowerCase());
  }

  isDefaultWorkType(name: string): boolean {
    return this.defaultWorkTypeOptions.some((d) => d.toLowerCase() === name.toLowerCase());
  }

  readonly caseTypeOptions = [
    { value: 'New', label: 'جديد' },
    { value: 'Modification', label: 'تعديل' },
    { value: 'Redo', label: 'اعادة' },
    { value: 'Empty', label: 'غير معروف' }
  ];

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
    if (wt === 'Empty') return 'غير معروف';
    if (wt === 'Modification') return 'تعديل';
    if (wt === 'Redo' || wt === 'Remake') return 'اعادة';
    
    let display = wt;
    if (display.startsWith('Modification - ')) {
      display = display.replace('Modification - ', 'تعديل - ');
    } else if (display.startsWith('Redo - ')) {
      display = display.replace('Redo - ', 'اعادة - ');
    } else if (display.startsWith('Remake - ')) {
      display = display.replace('Remake - ', 'اعادة - ');
    }
    return display;
  }

  onCaseTypeChange(): void {
    if (this.formDraft.caseType === 'Empty') {
      this.selectedWorkTypes.clear();
      this.workTypeQuantities = {};
      this.nightGuardType = '';
      this.removableDentureType = '';
      this.formDraft.workType = 'Empty';
      this.formDraft.quantity = 0;
    } else {
      this.updateWorkTypeString();
    }
  }

  selectedWorkTypes = new Set<string>();
  workTypeQuantities: Record<string, number> = {};
  workTypeError = '';
  nightGuardType: 'Soft' | 'Hard' | '' = '';
  removableDentureType: 'Acrylic' | 'Flex' | '' = '';
  patientWarning = '';

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
      this.passwordError = 'كلمة المرور غير صحيحة!';
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

  setRemovableDentureType(type: 'Acrylic' | 'Flex'): void {
    this.removableDentureType = type;
    this.updateWorkTypeString();
  }

  loadCustomWorkTypes(): void {
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
      },
      error: () => {
        this.customWorkTypes = [];
        this.hiddenDefaultWorkTypes = [];
      },
    });
  }

  addCustomWorkType(): void {
    const name = (this.newCustomWorkType || '').trim();
    if (!name) {
      this.customWorkTypeError = 'اكتب اسم نوع العمل';
      return;
    }
    if (this.workTypeOptions.some((x) => x.toLowerCase() === name.toLowerCase())) {
      this.customWorkTypeError = 'النوع موجود بالفعل';
      return;
    }
    this.customWorkTypeSaving = true;
    this.customWorkTypeError = '';
    this.caseApi.addCustomWorkType(name).subscribe({
      next: (res) => {
        this.customWorkTypeSaving = false;
        this.newCustomWorkType = '';
        if (res?.restoredDefault) {
          this.hiddenDefaultWorkTypes = this.hiddenDefaultWorkTypes.filter(
            (n) => n.toLowerCase() !== name.toLowerCase()
          );
        } else {
          const item = res?.data;
          if (item?._id && item?.name) {
            if (!this.customWorkTypes.some((c) => c._id === item._id)) {
              this.customWorkTypes = [
                ...this.customWorkTypes,
                { _id: String(item._id), name: String(item.name) },
              ];
            }
          } else {
            this.loadCustomWorkTypes();
          }
        }
        this.selectedWorkTypes.add(name);
        this.workTypeQuantities[name] = 1;
        this.updateWorkTypeString();
      },
      error: (err: any) => {
        this.customWorkTypeSaving = false;
        this.customWorkTypeError = err?.error?.message || 'تعذر إضافة نوع العمل';
      },
    });
  }

  removeWorkTypeOption(name: string, ev?: Event): void {
    ev?.stopPropagation();
    if (!confirm(`حذف نوع العمل "${name}" من القائمة؟`)) return;

    const custom = this.customWorkTypes.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (custom) {
      this.caseApi.deleteCustomWorkType(custom._id).subscribe({
        next: () => {
          this.customWorkTypes = this.customWorkTypes.filter((c) => c._id !== custom._id);
          this.clearSelectedWorkType(name);
        },
        error: (err: any) => {
          this.customWorkTypeError = err?.error?.message || 'تعذر حذف نوع العمل';
        },
      });
      return;
    }

    if (this.isDefaultWorkType(name)) {
      this.caseApi.hideDefaultWorkType(name).subscribe({
        next: () => {
          if (!this.hiddenDefaultWorkTypes.some((n) => n.toLowerCase() === name.toLowerCase())) {
            this.hiddenDefaultWorkTypes = [...this.hiddenDefaultWorkTypes, name];
          }
          this.clearSelectedWorkType(name);
        },
        error: (err: any) => {
          this.customWorkTypeError = err?.error?.message || 'تعذر حذف نوع العمل';
        },
      });
    }
  }

  private clearSelectedWorkType(name: string): void {
    if (this.selectedWorkTypes.has(name)) {
      this.selectedWorkTypes.delete(name);
      delete this.workTypeQuantities[name];
      if (name === 'Night Guard') this.nightGuardType = '';
      if (name === 'Removable Denture') this.removableDentureType = '';
      this.updateWorkTypeString();
    }
  }

  onPatientInputChange(): void {
    const name = (this.formDraft.patient || '').trim();
    const doc = (this.formDraft.doctor || '').trim();
    
    if (!name) {
      this.patientWarning = '';
      return;
    }
    
    const parts = name.split(/\s+/).filter((p: string) => p);
    const isSingleWord = parts.length === 1;
    
    const exists = this.sharedCases.cases().some(c => 
      c.status !== 'exited' &&
      c.doctor?.trim().toLowerCase() === doc.toLowerCase() &&
      c.patient?.trim().toLowerCase() === name.toLowerCase() &&
      c.id !== this.editingId
    );
    
    if (isSingleWord && exists) {
      this.patientWarning = 'يرجى كتابة الاسم ثنائي. يوجد مريض بنفس الاسم لنفس الدكتور وسيتم ترقيمه تلقائياً.';
    } else if (isSingleWord) {
      this.patientWarning = 'يرجى كتابة الاسم ثنائي (مثال: محمد أحمد).';
    } else if (exists) {
      this.patientWarning = 'تنبيه: يوجد مريض بنفس الاسم لنفس الدكتور.';
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
      if (type === 'Removable Denture') {
        this.removableDentureType = '';
      }
    } else {
      if (type === 'Empty') {
        this.selectedWorkTypes.clear();
        this.workTypeQuantities = {};
        this.selectedWorkTypes.add('Empty');
        this.workTypeQuantities['Empty'] = 1;
        this.nightGuardType = '';
        this.removableDentureType = '';
      } else {
        this.selectedWorkTypes.delete('Empty');
        delete this.workTypeQuantities['Empty'];
        this.selectedWorkTypes.add(type);
        this.workTypeQuantities[type] = 1;
        if (type === 'Night Guard') {
          this.nightGuardType = 'Soft';
        }
        if (type === 'Removable Denture') {
          this.removableDentureType = 'Acrylic';
        }
      }
    }
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
        if (this.nightGuardType) {
          displayName = `Night Guard ${this.nightGuardType}`;
        } else {
          displayName = 'Night Guard';
        }
      } else if (wt === 'Removable Denture') {
        if (this.removableDentureType) {
          displayName = `Removable Denture ${this.removableDentureType}`;
        } else {
          displayName = 'Removable Denture';
        }
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

  private reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    this.reloadCasesFromBackend();
    this.loadCustomWorkTypes();
    this.connectRealtimeUpdates();
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
        // Drop selections that no longer exist / already exited
        const alive = new Set(
          mapped.filter((c) => c.status !== 'exited').map((c) => c.id)
        );
        this.selectedExitIds.update((prev) => {
          const next = new Set<string>();
          for (const id of prev) {
            if (alive.has(id)) next.add(id);
          }
          return next;
        });
      },
      error: () => {
        this.casesLoading.set(false);
        if (!silent) this.flash('تعذر تحميل الحالات من الخادم');
      },
    });
  }

  setFilter(
    filter: 'all' | 'urgent' | 'pending' | 'design' | 'finishing' | 'finished' | 'exited'
  ): void {
    this.activeFilter.set(filter);
    this.clearExitSelection();
  }

  /** Non-exited cases in the current filtered list (eligible for bulk exit). */
  selectableCasesForExit(): any[] {
    return this.cases().filter((c) => c.status !== 'exited');
  }

  selectedExitCount(): number {
    return this.selectedExitIds().size;
  }

  isCaseSelectedForExit(id: string): boolean {
    return this.selectedExitIds().has(id);
  }

  isAllSelectableSelected(): boolean {
    const selectable = this.selectableCasesForExit();
    if (!selectable.length) return false;
    const selected = this.selectedExitIds();
    return selectable.every((c) => selected.has(c.id));
  }

  clearExitSelection(): void {
    this.selectedExitIds.set(new Set());
  }

  toggleCaseExitSelection(c: any, event?: Event): void {
    event?.stopPropagation();
    if (!c?.id || c.status === 'exited') return;
    this.selectedExitIds.update((prev) => {
      const next = new Set(prev);
      if (next.has(c.id)) next.delete(c.id);
      else next.add(c.id);
      return next;
    });
  }

  toggleSelectAllForExit(event?: Event): void {
    event?.stopPropagation();
    const selectable = this.selectableCasesForExit();
    if (!selectable.length) return;
    if (this.isAllSelectableSelected()) {
      this.clearExitSelection();
      return;
    }
    this.selectedExitIds.set(new Set(selectable.map((c) => c.id)));
  }

  exitSelectedCases(): void {
    const selected = this.selectedExitIds();
    const targets = this.selectableCasesForExit().filter((c) => selected.has(c.id));
    if (!targets.length) {
      this.flash('اختر حالة واحدة على الأقل للإخراج');
      return;
    }
    const ok = confirm(`هل تريد إخراج ${targets.length} حالة نهائيًا؟`);
    if (!ok) return;

    this.bulkExiting.set(true);
    forkJoin(
      targets.map((c) =>
        this.caseApi.exitCase(c.id).pipe(
          catchError(() => of({ __failed: true, caseNumber: c.caseNumber }))
        )
      )
    ).subscribe({
      next: (results) => {
        this.bulkExiting.set(false);
        const failed = results.filter((r: any) => r && r.__failed === true);
        const okCount = targets.length - failed.length;
        this.clearExitSelection();
        this.reloadCasesFromBackend();
        if (failed.length === 0) {
          this.flash(`تم إخراج ${okCount} حالة بنجاح`);
        } else if (okCount === 0) {
          this.flash('تعذر إخراج الحالات المحددة');
        } else {
          this.flash(`تم إخراج ${okCount} حالة — فشل ${failed.length}`);
        }
      },
      error: () => {
        this.bulkExiting.set(false);
        this.flash('تعذر إخراج الحالات المحددة');
      },
    });
  }

  goToOverdueCase(caseId: string): void {
    const target = this.sharedCases.cases().find((c) => c.id === caseId);
    if (!target) {
      this.flash('الحالة غير موجودة');
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
    this.createRequesterKind.set('doctor');
    this.editingId = null;
    this.formDraft = emptyDraft();
    this.selectedWorkTypes.clear();
    this.workTypeQuantities = {};
    this.workTypeError = '';
    this.nightGuardType = '';
    this.removableDentureType = '';
    this.patientWarning = '';
    this.newCustomWorkType = '';
    this.customWorkTypeError = '';
    this.loadCustomWorkTypes();
    this.existingPlyFileName = null;
    this.clearPlySelection();
    this.dialogOpen.set(true);
    this.menuOpenId.set(null);
  }

  openCreateLabDialog(): void {
    this.openCreateDialog();
    this.createRequesterKind.set('lab');
  }

  openEdit(c: any): void {
    this.proceedWithEdit(c);
  }

  proceedWithEdit(c: any): void {
    this.dialogMode.set('edit');
    this.editingId = c.id;
    this.existingPlyFileName = c.plyFileName || null;
    this.clearPlySelection();
    const delivery = String(c.deliveryDate || '');
    const dateMatch = delivery.match(/^(\d{4}-\d{2}-\d{2})(?:\s+(.+))?$/);
    const currentCaseType = this.getCaseTypeFromWorkType(c.workType);
    this.createRequesterKind.set(c.requesterType === 'lab' ? 'lab' : 'doctor');
    this.formDraft = {
      labName: c.labName || '',
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
    this.removableDentureType = '';
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
          } else if (wtName.startsWith('Removable Denture')) {
            this.selectedWorkTypes.add('Removable Denture');
            this.workTypeQuantities['Removable Denture'] = qty;
            if (wtName.includes('Flex')) {
              this.removableDentureType = 'Flex';
            } else {
              this.removableDentureType = 'Acrylic';
            }
          } else if (this.workTypeOptions.includes(wtName)) {
            this.selectedWorkTypes.add(wtName);
            this.workTypeQuantities[wtName] = qty;
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
    const isStudentCase = existing?.requesterType === 'student';
    const isLabCase =
      existing?.requesterType === 'lab' ||
      (this.dialogMode() === 'create' && this.createRequesterKind() === 'lab');

    if (isLabCase && !(d.labName || '').trim()) {
      this.flash('يرجى إدخال اسم المعمل');
      return;
    }
    if (!d.doctor.trim()) {
      this.flash('يرجى تعبئة اسم الطبيب');
      return;
    }
    if (!d.patient?.trim()) {
      this.flash('يرجى إدخال اسم المريض');
      return;
    }
    if (d.caseType !== 'Empty' && this.selectedWorkTypes.size === 0) {
      this.workTypeError = 'يرجى اختيار نوع عمل واحد على الأقل';
      this.flash('يرجى اختيار نوع العمل');
      return;
    }
    if (isStudentCase && (!Number.isFinite(Number(d.studentPrice)) || Number(d.studentPrice) <= 0)) {
      this.flash('يرجى إدخال سعر حالة الطالب بشكل صحيح');
      return;
    }

    let patientName = d.patient.trim();
    const docName = d.doctor.trim();
    
    const parts = patientName.split(/\s+/).filter((p: string) => p);
    const isSingleWord = parts.length === 1;
    
    if (isSingleWord) {
      const existingCases = this.sharedCases.cases().filter(c => 
        c.status !== 'exited' &&
        c.doctor?.trim().toLowerCase() === docName.toLowerCase() &&
        c.id !== this.editingId
      );
      
      const matchPattern = new RegExp(`^${this.escapeRegExp(patientName)}(?:\\s+(\\d+))?$`, 'i');
      
      let maxNumber = 1;
      let duplicateExists = false;
      
      for (const c of existingCases) {
        const pName = (c.patient || '').trim();
        const match = pName.match(matchPattern);
        if (match) {
          duplicateExists = true;
          if (match[1]) {
            const num = parseInt(match[1], 10);
            if (num > maxNumber) {
              maxNumber = num;
            }
          }
        }
      }
      
      if (duplicateExists) {
        patientName = `${patientName} ${maxNumber + 1}`;
        d.patient = patientName; // Update local form field
      }
    }

    const formPayload = {
      requesterType: isStudentCase
        ? ('student' as const)
        : isLabCase
          ? ('lab' as const)
          : ('doctor' as const),
      studentPrice: isStudentCase ? Number(d.studentPrice || 0) : 0,
      labName: isLabCase ? String(d.labName || '').trim() : '',
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

    if (this.dialogMode() === 'create') {
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
    if (this.dialogMode() === 'edit' && this.editingId) {
      return this.sharedCases.getCaseById(this.editingId)?.requesterType === 'student';
    }
    return false;
  }

  isLabDialog(): boolean {
    if (this.dialogMode() === 'edit' && this.editingId) {
      return this.sharedCases.getCaseById(this.editingId)?.requesterType === 'lab';
    }
    return this.createRequesterKind() === 'lab';
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
    this.proceedWithDelete(c);
  }

  proceedWithDelete(c: any): void {
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
    if (c.status === 'exited') {
      this.flash('هذه الحالة خارجة بالفعل');
      return;
    }
    const ok = confirm(`هل تريد إخراج الحالة ${c.caseNumber} نهائيًا؟`);
    if (!ok) return;

    this.caseApi.exitCase(c.id).subscribe({
      next: () => {
        this.selectedExitIds.update((prev) => {
          const next = new Set(prev);
          next.delete(c.id);
          return next;
        });
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
      labName?: string;
      workType: string;
      workDetail: string;
      color: string;
      size: string;
    },
    query: string
  ): number {
    const doctor = this.normalizeSearchText(caseItem.doctor).replace(/^د\s+/, '').replace(/^dr\s+/, '');
    const patient = this.normalizeSearchText(caseItem.patient);
    const labName = this.normalizeSearchText(caseItem.labName || '');
    const caseNumber = this.normalizeSearchText(caseItem.caseNumber);
    const queryTokens = query.split(' ').filter(Boolean);
    const patientHasAllTokens = queryTokens.every(token => patient.includes(token));
    const doctorHasAllTokens = queryTokens.every(token => doctor.includes(token));
    const labHasAllTokens =
      labName.length > 0 && queryTokens.every(token => labName.includes(token));

    // Priority 1: patient/doctor/lab starts with query
    if (patient.startsWith(query)) return 120;
    if (doctor.startsWith(query)) return 110;
    if (labName && labName.startsWith(query)) return 108;

    // Priority 1.5: all query words found in patient/doctor/lab
    if (patientHasAllTokens) return 105;
    if (doctorHasAllTokens) return 95;
    if (labHasAllTokens) return 93;

    // Priority 2: patient/doctor/lab contains query
    if (patient.includes(query)) return 100;
    if (doctor.includes(query)) return 90;
    if (labName && labName.includes(query)) return 88;

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

  printCaseCard(c: any): void {
    const now = new Date();
    const printDate = now.toLocaleDateString('en-GB') + '  ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    const receivedDate = c.receivedDate ? this.formatDateValue(c.receivedDate) : { date: '', time: '' };
    const deliveryDate = c.deliveryDate ? this.formatDateValue(c.deliveryDate) : null;

    const workTypeDisplay = this.formatWorkTypeForDisplay ? this.formatWorkTypeForDisplay(c.workType) : (c.workType || '');
    const isLab = c.requesterType === 'lab';
    const requesterLabel =
      c.requesterType === 'student' ? 'طالب' : isLab ? 'معمل' : 'دكتور';
    const labName = String(c.labName || '').trim();
    const doctorName = String(c.doctor || '').trim();
    const partySectionTitle = isLab ? 'بيانات المعمل والمريض' : 'بيانات الطبيب والمريض';
    const partyRows = isLab
      ? `<div class="row">
      <span class="label">المعمل</span>
      <span class="value">${labName || '—'}</span>
    </div>
    <div class="row">
      <span class="label">الطبيب</span>
      <span class="value">${doctorName || '—'}</span>
    </div>`
      : `<div class="row">
      <span class="label">الطبيب</span>
      <span class="value">${doctorName || '—'}</span>
    </div>`;

    const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8">
  <title>طباعة حالة — ${c.caseNumber}</title>
  <style>
    @page { margin: 15mm 20mm; size: A4; }
    * { box-sizing: border-box; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
    html { height: 100%; }
    body {
      margin: 0; padding: 0;
      background: #fff; color: #000;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      font-size: 19px;
    }
    .page-content { flex: 1; }
    .header { text-align: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 3px solid #000; }
    .header h1 { font-size: 34px; font-weight: bold; margin: 0 0 6px 0; letter-spacing: 2px; }
    .header p { font-size: 15px; color: #555; margin: 0; }
    .case-ref {
      display: flex; justify-content: space-between; align-items: center;
      background: #f5f5f5; border: 1px solid #ddd; border-radius: 6px;
      padding: 14px 20px; margin: 22px 0;
    }
    .case-ref .num { font-size: 26px; font-weight: bold; }
    .case-ref .badge { background: #222; color: #fff; border-radius: 4px; padding: 5px 16px; font-size: 16px; }
    .section { margin: 22px 0; }
    .section-title {
      font-size: 17px; font-weight: bold;
      border-right: 4px solid #000; padding-right: 12px;
      margin-bottom: 12px; color: #222;
    }
    .row {
      display: flex; justify-content: space-between;
      padding: 10px 0; border-bottom: 1px solid #eee;
      font-size: 18px;
    }
    .row:last-child { border-bottom: none; }
    .label { color: #666; }
    .value { font-weight: bold; text-align: left; }
    .footer {
      margin-top: 30px; padding-top: 14px;
      border-top: 2px solid #000;
      display: flex; justify-content: space-between;
      font-size: 15px; color: #555;
    }
    /* Teeth chart */
    .teeth-section { margin-top: 36px; }
    .teeth-title {
      font-size: 17px; font-weight: bold;
      border-right: 4px solid #000; padding-right: 12px;
      margin-bottom: 14px; color: #222;
    }
    .teeth-table {
      width: 100%; border-collapse: collapse;
      font-size: 17px;
    }
    .teeth-table th {
      background: #2980b9; color: #fff;
      text-align: center; padding: 8px 0;
      font-size: 18px; font-weight: bold;
      width: 50%;
    }
    .teeth-table td {
      text-align: center; padding: 10px 2px;
      font-size: 18px; font-weight: bold;
      width: 6.25%;
    }
    .teeth-table .divider td { border-top: 2px solid #333; padding: 0; height: 0; }
    .jaw-row td { border-bottom: none; }
    .center-line { border-right: 2px solid #333; }
  </style>
</head>
<body>
<div class="page-content">
  <div class="header">
    <h1>Elite Lab</h1>
    <p>Precision Dental Laboratories</p>
  </div>

  <div class="case-ref">
    <span class="num">${c.caseNumber || ''}</span>
    <span class="badge">${requesterLabel}</span>
  </div>

  <div class="section">
    <div class="section-title">${partySectionTitle}</div>
    ${partyRows}
    <div class="row">
      <span class="label">المريض</span>
      <span class="value">${c.patient || '—'}</span>
    </div>
  </div>

  <div class="section">
    <div class="section-title">تفاصيل العمل</div>
    <div class="row">
      <span class="label">نوع العمل</span>
      <span class="value">${workTypeDisplay || '—'}</span>
    </div>
    ${c.workDetail ? `<div class="row"><span class="label">ملاحظات العمل</span><span class="value">${c.workDetail}</span></div>` : ''}
    <div class="row">
      <span class="label">اللون</span>
      <span class="value">${c.color || '—'}</span>
    </div>
    <div class="row">
      <span class="label">الكمية</span>
      <span class="value">${c.quantity || '—'}</span>
    </div>
    ${c.size ? `<div class="row"><span class="label">الحجم</span><span class="value">${c.size}</span></div>` : ''}
  </div>

  <div class="section">
    <div class="section-title">التواريخ</div>
    <div class="row">
      <span class="label">تاريخ الاستلام</span>
      <span class="value">${receivedDate.date}${receivedDate.time ? ' — ' + receivedDate.time : ''}</span>
    </div>
    ${deliveryDate ? `<div class="row"><span class="label">تاريخ التسليم</span><span class="value">${deliveryDate.date}${deliveryDate.time ? ' — ' + deliveryDate.time : ''}</span></div>` : ''}
  </div>

  <div class="teeth-section">
    <div class="teeth-title">مخطط الأسنان</div>
    <table class="teeth-table" dir="ltr">
      <thead>
        <tr>
          <th colspan="8">R</th>
          <th colspan="8" style="border-right: none;">L</th>
        </tr>
      </thead>
      <tbody>
        <tr class="jaw-row">
          <td>8</td><td>7</td><td>6</td><td>5</td><td>4</td><td>3</td><td>2</td><td class="center-line">1</td>
          <td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td><td>7</td><td>8</td>
        </tr>
        <tr class="divider"><td colspan="16"></td></tr>
        <tr class="jaw-row">
          <td>8</td><td>7</td><td>6</td><td>5</td><td>4</td><td>3</td><td>2</td><td class="center-line">1</td>
          <td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td><td>7</td><td>8</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="footer">
    <span>تاريخ الطباعة: ${printDate}</span>
    <span>Elite Dental Lab</span>
  </div>
</div>
  <script>
    window.onload = function() {
      window.print();
      window.onafterprint = function() { window.close(); };
    };
  </script>
</body>
</html>`;

    const popup = window.open('', '_blank', 'width=380,height=600,toolbar=0,menubar=0,scrollbars=0');
    if (popup) {
      popup.document.write(html);
      popup.document.close();
    }
  }
}
