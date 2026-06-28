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
import { ThemeService } from '../../core/services/theme.service';

function emptyDraft(): CaseDraft {
  const today = new Date();
  const months = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const day = today.getDate();
  const month = months[today.getMonth()];
  const year = today.getFullYear();

  // الوقت الحالي بصيغة HH:MM م/ص
  const rawHours = today.getHours();
  const ampm = rawHours >= 12 ? 'م' : 'ص';
  const hours12 = rawHours % 12 || 12;
  const hours = String(hours12).padStart(2, '0');
  const minutes = String(today.getMinutes()).padStart(2, '0');
  const currentTime = `${hours}:${minutes} ${ampm}`;

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
    quantity: '1' as any,
    date: dateWithTime,
    deliveryDate: '',
    deliveryTime: '',
    caseType: 'New',
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
    const dateMatch = val.match(/^(\d{4}-\d{2}-\d{2})(?:\s+(.+))?$/);
    if (dateMatch) {
      const datePart = dateMatch[1];
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
    'all' | 'pending' | 'in-progress' | 'under-khart' | 'finished' | 'exited'
  >('all');
  readonly casesLoading = signal(false);
  readonly saveInProgress = signal(false);

  // عرض الحالات من SharedCasesService مباشرة لتحديث فوري
  readonly cases = computed(() => {
    const allCases = this.sharedCases.cases();
    const selectedFilter = this.activeFilter();
    const q = this.normalizeSearchText(this.searchQuery());

    let baseCases =
      selectedFilter === 'all'
        ? allCases.filter(c => c.status !== 'exited')
        : allCases.filter(c => c.status === selectedFilter);

    if (selectedFilter === 'exited') {
      baseCases = [...baseCases].sort((a, b) => {
        const timeA = a.exitedAtRaw ? new Date(a.exitedAtRaw).getTime() : 0;
        const timeB = b.exitedAtRaw ? new Date(b.exitedAtRaw).getTime() : 0;
        return timeB - timeA;
      });
    }

    if (!q) return baseCases;

    const scored = baseCases
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
    const finished = activeCases.filter(c => c.status === 'finished').length;
    const exited = allCases.filter(c => c.status === 'exited').length;

    return [
      { label: 'إجمالي الحالات', value: total, color: 'purple' as const, hint: total > 0 ? '+12%' : undefined },
      { label: 'الحالات الجديدة', value: pending, color: 'amber' as const },
      { label: 'الحالات المنتهية', value: finished, color: 'emerald' as const },
      { label: 'الحالات الخارجة', value: exited, color: 'rose' as const },
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
  readonly dialogMode = signal<'create' | 'edit'>('create');
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
  /** ملف مسح .ply اختياري عند الإنشاء/التعديل */
  selectedPlyFile: File | null = null;
  /** اسم ملف PLY المحفوظ مسبقاً (وضع التعديل) */
  existingPlyFileName: string | null = null;

  /** Work Type chip options */
  readonly workTypeOptions = [
    'Zircon', 'German Zircon', 'Emax', 'Pmma Cad',
    'Peek', 'Titanium', 'Try in', 'Mokup',
    'Night Guard'
  ];
  readonly caseTypeOptions = [
    { value: 'New', label: 'جديد' },
    { value: 'Modification', label: 'تعديل' },
    { value: 'Redo', label: 'اعادة' },
    { value: 'Empty', label: 'غير معروف' }
  ];

  getCaseTypeFromWorkType(wt: string): 'New' | 'Modification' | 'Redo' | 'Empty' {
    if (!wt) return 'New';
    const normalized = wt.trim();
    if (normalized === 'Modification') return 'Modification';
    if (normalized === 'Redo' || normalized === 'Remake') return 'Redo';
    if (normalized === 'Empty') return 'Empty';
    return 'New';
  }

  onCaseTypeChange(): void {
    if (this.formDraft.caseType !== 'New') {
      this.selectedWorkTypes.clear();
      this.workTypeQuantities = {};
      this.nightGuardType = '';
      this.formDraft.workType = this.formDraft.caseType;
    } else {
      this.updateWorkTypeString();
    }
  }

  selectedWorkTypes = new Set<string>();
  workTypeQuantities: Record<string, number> = {};
  workTypeError = '';
  nightGuardType: 'Soft' | 'Hard' | '' = '';
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
        if (type === 'Night Guard') {
          this.nightGuardType = 'Soft';
        }
      }
    }
    this.updateWorkTypeString();
  }

  onWorkTypeQtyChange(): void {
    this.updateWorkTypeString();
  }

  updateWorkTypeString(): void {
    if (this.formDraft.caseType !== 'New') {
      this.formDraft.workType = this.formDraft.caseType;
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
      }
      
      if (this.selectedWorkTypes.size > 1 || q > 1) {
        parts.push(`${displayName} (${q})`);
      } else {
        parts.push(displayName);
      }
    }
    this.formDraft.quantity = total || 1;
    this.formDraft.workType = parts.join(' + ');
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
    this.caseApi.getAllCases(1, 3000).subscribe({
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
    filter: 'all' | 'pending' | 'in-progress' | 'under-khart' | 'finished' | 'exited'
  ): void {
    this.activeFilter.set(filter);
  }

  openCreateDialog(): void {
    this.dialogMode.set('create');
    this.editingId = null;
    this.formDraft = emptyDraft();
    this.selectedWorkTypes.clear();
    this.workTypeQuantities = {};
    this.workTypeError = '';
    this.nightGuardType = '';
    this.patientWarning = '';
    this.existingPlyFileName = null;
    this.clearPlySelection();
    this.dialogOpen.set(true);
    this.menuOpenId.set(null);
  }

  openEdit(c: any): void {
    if (c.status === 'exited') {
      this.openPasswordProtection('edit', c);
      return;
    }
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
      caseType: currentCaseType,
    };
    // Restore selectedWorkTypes from saved string
    this.selectedWorkTypes = new Set<string>();
    this.workTypeQuantities = {};
    this.workTypeError = '';
    this.nightGuardType = '';
    this.patientWarning = '';
    if (currentCaseType === 'New' && c.workType) {
      const parts = c.workType.split('+').map((s: string) => s.trim()).filter((s: string) => s);
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

    if (!d.doctor.trim()) {
      this.flash('يرجى تعبئة اسم الطبيب');
      return;
    }
    if (!d.patient?.trim()) {
      this.flash('يرجى إدخال اسم المريض');
      return;
    }
    if (d.caseType === 'New' && this.selectedWorkTypes.size === 0) {
      this.workTypeError = 'يرجى اختيار نوع عمل واحد على الأقل';
      this.flash('يرجى اختيار نوع العمل');
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
      quantity: d.quantity !== '' && d.quantity !== null && !isNaN(Number(d.quantity)) ? Number(d.quantity) : 1,
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
    if (c.status === 'exited') {
      this.openPasswordProtection('delete', c);
      return;
    }
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
}