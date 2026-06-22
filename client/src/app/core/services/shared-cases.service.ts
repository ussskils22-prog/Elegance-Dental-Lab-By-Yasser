import { Injectable, signal } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface DentalCase {
  id: string;
  caseNumber: string;
  priority: 'emergency' | 'normal' | 'low';
  patient: string;
  doctor: string;
  clinic: string;
  receivedDate: string;
  deliveryDate: string;
  enteredBy: string;
  requesterType?: 'doctor' | 'student';
  instructions: string;
  status:
    | 'pending'
    | 'in-progress'
    | 'needs-revision'
    | 'under-khart'
    | 'finished'
    | 'exited';
  designNotes: string;
  selectedFileName: string;
  designImages: string[]; // صور التصميم المرفوعة
  // تفاصيل العمل من السكرتيرية
  workType: string;
  workDetail: string;
  color: string;
  size: string;
  quantity: number;
  /** من الـ API (حفظ المريض) */
  patientEmail?: string;
  patientPhone?: string;
  salaryAmount?: number;
  finishingNotes?: string;
  /** مسار ملف المسح .ply (رابط كامل للعرض/التحميل) */
  plyScanUrl?: string;
  /** اسم الملف الأصلي للمسح */
  plyFileName?: string;
  exitedAt?: string;
}

@Injectable({
  providedIn: 'root',
})
export class SharedCasesService {
  private caseCounter = 8846;
  private readonly _cases = signal<DentalCase[]>([]);
  private readonly casesSubject = new BehaviorSubject<DentalCase[]>(this._cases());
  public readonly cases$ = this.casesSubject.asObservable();

  constructor() {}

  readonly cases = this._cases.asReadonly();

  /** استبدال القائمة بالكامل (مزامنة من الـ API). */
  setCasesFromServer(cases: DentalCase[]): void {
    this._cases.set(cases);
    this.emitCases();
  }

  // إضافة حالة جديدة من السكرتيرية
  addCaseFromSecretary(data: {
    doctor: string;
    patient: string;
    workType: string;
    workDetail: string;
    color: string;
    size: string;
    quantity: number;
    date: string;
    deliveryDate?: string;
    deliveryTime?: string;
    enteredBy: string;
  }): void {
    const formatTimeTo12Hour = (timeStr: string): string => {
      if (!timeStr) return '';
      const parts = timeStr.trim().split(':');
      if (parts.length < 2) return timeStr;
      let hour = parseInt(parts[0], 10);
      const minute = parts[1];
      if (isNaN(hour)) return timeStr;
      const ampm = hour >= 12 ? 'م' : 'ص';
      hour = hour % 12;
      hour = hour ? hour : 12;
      return `${hour}:${minute} ${ampm}`;
    };
    const deliveryInfo = data.deliveryDate ? `${data.deliveryDate}${data.deliveryTime ? ' ' + formatTimeTo12Hour(data.deliveryTime) : ''}` : '';
    const caseNumber = `LF-${this.caseCounter++}`;
    const newCase: DentalCase = {
      id: Math.random().toString(36).substr(2, 9),
      caseNumber,
      priority: 'normal',
      patient: data.patient,
      doctor: data.doctor,
      clinic: '', // يمكن تحديثها لاحقاً
      receivedDate: data.date,
      deliveryDate: deliveryInfo,
      enteredBy: data.enteredBy,
      instructions: `نوع العمل: ${data.workType} - ${data.workDetail}\nاللون: ${data.color}\nالحجم: ${data.size}\nالعدد: ${data.quantity}`,
      status: 'pending',
      designNotes: '',
      selectedFileName: '',
      designImages: [],
      // حفظ تفاصيل العمل
      workType: data.workType,
      workDetail: data.workDetail,
      color: data.color,
      size: data.size,
      quantity: data.quantity,
    };
    this._cases.update((cases) => [newCase, ...cases]);
    this.emitCases();
  }

  // تحديث حالة
  updateCase(id: string, updatedCase: DentalCase): void {
    this._cases.update((cases) => cases.map((c) => (c.id === id ? updatedCase : c)));
    this.emitCases();
  }

  // حذف حالة
  deleteCase(id: string): void {
    this._cases.update((cases) => cases.filter((c) => c.id !== id));
    this.emitCases();
  }

  // الحصول على حالة بواسطة ID
  getCaseById(id: string): DentalCase | undefined {
    return this._cases().find((c) => c.id === id);
  }

  // تحديث البيانات في الحالة الموجودة
  syncCase(updatedCase: DentalCase): void {
    this.updateCase(updatedCase.id, updatedCase);
    this.emitCases();
  }

  private emitCases(): void {
    this.casesSubject.next(this._cases());
  }
}
