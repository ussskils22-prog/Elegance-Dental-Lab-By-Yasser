import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { DentalCase, SharedCasesService } from '../../core/services/shared-cases.service';
import { CaseApiService } from '../../core/services/case-api.service';
import { buildDesignerNotesMeta, mapApiCaseToDentalCase, sanitizeCaseImageListForStorage } from '../../core/mappers/dental-case-api.mapper';
import { SocketService } from '../../core/services/socket.service';

@Component({
  selector: 'app-finishing',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './finishing.html',
  styleUrl: './finishing.css',
})
export class Finishing implements OnInit, OnDestroy {
  private readonly sharedCasesService = inject(SharedCasesService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly caseApi = inject(CaseApiService);
  private readonly socketService = inject(SocketService);
  private socketSubs: Subscription[] = [];

  selectedCase: DentalCase | null = null;
  notes = '';
  isCompleting = false;
  searchTerm = '';

  ngOnInit(): void {
    this.reloadCasesFromBackend();
    this.connectRealtimeUpdates();
  }

  ngOnDestroy(): void {
    this.socketSubs.forEach((s) => s.unsubscribe());
  }

  private get readyForFinishingCases(): DentalCase[] {
    return this.sharedCasesService.cases().filter(c => c.status === 'ready-for-finishing');
  }

  get queueCases(): DentalCase[] {
    const search = this.searchTerm.trim().toLowerCase();
    const queue = this.readyForFinishingCases;

    if (!search) return queue;

    return queue.filter(c =>
      c.caseNumber.toLowerCase().includes(search) ||
      c.patient.toLowerCase().includes(search) ||
      c.doctor.toLowerCase().includes(search)
    );
  }

  get counts() {
    return {
      all: this.readyForFinishingCases.length
    };
  }

  takeCase(caseItem: DentalCase): void {
    this.selectedCase = { ...caseItem };
    this.notes = caseItem.finishingNotes || '';
  }

  closeCase(): void {
    this.selectedCase = null;
    this.notes = '';
  }

  logout(): void {
    this.auth.performLogout(this.router);
  }

  async markAsCompleted(): Promise<void> {
    if (!this.selectedCase || this.selectedCase.status !== 'ready-for-finishing') return;

    this.isCompleting = true;
    const payload = this.buildFinisherUpdatePayload(this.selectedCase, this.notes);
    this.caseApi.updateCase(this.selectedCase.id, payload).subscribe({
      next: () => {
        this.caseApi.completeCase(this.selectedCase!.id).subscribe({
          next: () => {
            this.isCompleting = false;
            this.reloadCasesFromBackend();
            this.closeCase();
          },
          error: () => {
            this.isCompleting = false;
          },
        });
      },
      error: () => {
        this.isCompleting = false;
      },
    });
  }

  private buildFinisherUpdatePayload(dentalCase: DentalCase, finishingNotes: string): Record<string, unknown> {
    const [deliveryDateRaw = '', deliveryTimeRaw = ''] = (dentalCase.deliveryDate || '').split(' ');
    const dueDateIso =
      /^\d{4}-\d{2}-\d{2}/.test(deliveryDateRaw)
        ? new Date(`${deliveryDateRaw}T${(deliveryTimeRaw || '18:00').slice(0, 5)}:00`).toISOString()
        : new Date().toISOString();

    const notesMeta = buildDesignerNotesMeta({
      requesterType: dentalCase.requesterType === 'student' ? 'student' : 'doctor',
      doctor: dentalCase.doctor,
      workDetail: dentalCase.workDetail,
      color: dentalCase.color,
      size: dentalCase.size,
      quantity: dentalCase.quantity,
      deliveryDate: deliveryDateRaw,
      deliveryTime: deliveryTimeRaw,
      receivedDate: dentalCase.receivedDate,
      instructions: dentalCase.instructions || '',
      designNotes: dentalCase.designNotes || '',
      finishingNotes: finishingNotes || '',
      selectedFileName: dentalCase.selectedFileName || '',
      designImages: sanitizeCaseImageListForStorage(dentalCase.designImages),
      uiStatusOverride:
        dentalCase.status === 'under-khart'
          ? 'under-khart'
          : dentalCase.status === 'ready-for-finishing'
            ? 'ready-for-finishing'
            : 'in-progress',
    });

    return {
      patientName: dentalCase.patient,
      patientEmail: dentalCase.patientEmail || `case+${Date.now()}@mylab.com`,
      patientPhone: dentalCase.patientPhone || '0000000000',
      requesterType: dentalCase.requesterType === 'student' ? 'student' : 'doctor',
      caseType: dentalCase.workType || 'General',
      priority: dentalCase.priority === 'emergency' ? 'urgent' : dentalCase.priority,
      dueDate: dueDateIso,
      notes: notesMeta,
    };
  }

  private reloadCasesFromBackend(): void {
    this.caseApi.getAllCases(1, 500).subscribe({
      next: (res) => {
        const rows = (res?.data ?? []) as Record<string, unknown>[];
        const mapped = Array.isArray(rows) ? rows.map((r) => mapApiCaseToDentalCase(r)) : [];
        this.sharedCasesService.setCasesFromServer(mapped);
      },
      error: () => {},
    });
  }

  private connectRealtimeUpdates(): void {
    this.socketService.connect();
    this.socketSubs.push(
      this.socketService.onCaseCreated().subscribe((evt) => {
        if (evt) this.reloadCasesFromBackend();
      }),
      this.socketService.onCaseMovedStage().subscribe((evt) => {
        if (evt) this.reloadCasesFromBackend();
      }),
      this.socketService.onCaseAssigned().subscribe((evt) => {
        if (evt) this.reloadCasesFromBackend();
      }),
      this.socketService.onCaseReassigned().subscribe((evt) => {
        if (evt) this.reloadCasesFromBackend();
      }),
      this.socketService.onCaseReleased().subscribe((evt) => {
        if (evt) this.reloadCasesFromBackend();
      }),
      this.socketService.onCaseCompleted().subscribe((evt) => {
        if (evt) this.reloadCasesFromBackend();
      }),
      this.socketService.onCaseUpdated().subscribe((evt) => {
        if (evt) this.reloadCasesFromBackend();
      }),
      this.socketService.onCaseDeleted().subscribe((evt) => {
        if (evt) this.reloadCasesFromBackend();
      })
    );
  }
}
