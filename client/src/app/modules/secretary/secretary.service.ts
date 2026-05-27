import { Injectable, computed, signal, inject } from '@angular/core';
import { SharedCasesService } from '../../core/services/shared-cases.service';

export interface LabCase {
  id: string;
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
}

export type CaseDraft = Omit<LabCase, 'id'> & {
  patientPhone?: string;
  studentPrice?: number;
};

@Injectable({
  providedIn: 'root',
})
export class SecretaryService {
  private readonly sharedCases = inject(SharedCasesService);

  private readonly _cases = signal<LabCase[]>([]);
  private nextSeq = 4593;

  readonly cases = this._cases.asReadonly();

  readonly searchQuery = signal('');

  readonly filteredCases = computed(() => {
    let list = this._cases();
    const q = this.searchQuery().trim().toLowerCase();
    if (q) {
      list = list.filter(
        (c) =>
          c.id.toLowerCase().includes(q) ||
          c.doctor.toLowerCase().includes(q) ||
          c.patient.toLowerCase().includes(q) ||
          c.workType.toLowerCase().includes(q) ||
          c.workDetail.toLowerCase().includes(q) ||
          c.color.toLowerCase().includes(q) ||
          c.size.toLowerCase().includes(q) ||
          c.quantity.toString().includes(q) ||
          c.date.toLowerCase().includes(q),
      );
    }
    return list;
  });

  readonly stats = computed(() => {
    const list = this._cases();
    const total = list.length;

    return [
      { label: 'إجمالي الحالات', value: total, color: 'blue' as const, hint: total > 0 ? '+12%' : undefined },
      { label: 'حالات جديدة', value: total, color: 'green' as const },
      { label: 'قيد التنفيذ', value: 0, color: 'blue' as const },
      { label: 'جاهزة للتسليم', value: 0, color: 'green' as const },
    ];
  });

  create(draft: CaseDraft): LabCase {
    const id = `#LB-${this.nextSeq++}`;
    const row: LabCase = { ...draft, id };
    this._cases.update((rows) => [...rows, row]);
    return row;
  }

  update(id: string, draft: CaseDraft): void {
    this._cases.update((rows) =>
      rows.map((c) => (c.id === id ? { ...draft, id: c.id } : c)),
    );
  }

  delete(id: string): void {
    this._cases.update((rows) => rows.filter((c) => c.id !== id));
  }

  setSearch(q: string): void {
    this.searchQuery.set(q);
  }

  // Get the current status/phase of a case by its ID
  getCasePhase(caseId: string): { label: string; status: string; color: string } {
    const dentalCase = this.sharedCases.getCaseById(caseId);
    if (!dentalCase) {
      return { label: 'الجديدة', status: 'pending', color: 'pending' };
    }

    const phaseMap: Record<string, { label: string; color: string }> = {
      pending: { label: 'الجديدة', color: 'pending' },
      'in-progress': { label: 'ديزاين', color: 'design' },
      'under-khart': { label: 'خرط', color: 'khart' },
      'needs-revision': { label: 'محتاجة تعديل', color: 'revision' },
      'ready-for-finishing': { label: 'جاهزة', color: 'finishing' },
      finished: { label: 'منتهية', color: 'finished' },
      exited: { label: 'خارجة', color: 'exited' },
    };

    const phase = phaseMap[dentalCase.status] || { label: 'الجديدة', color: 'pending' };
    return { label: phase.label, status: dentalCase.status, color: phase.color };
  }

}
