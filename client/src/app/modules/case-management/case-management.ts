import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CaseApiService } from '../../core/services/case-api.service';
import { AuditApiService } from '../../core/services/audit-api.service';
import { SocketService } from '../../core/services/socket.service';
import { UserApiService } from '../../core/services/user-api.service';
import { AuthService } from '../../core/services/auth.service';
import { DentalCase, CaseStage, AuditLog } from '../../core/models/case.model';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

@Component({
  selector: 'app-case-management',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './case-management.html',
  styleUrl: './case-management.css'
})
export class CaseManagementComponent implements OnInit, OnDestroy {
  viewMode: 'kanban' | 'table' | 'audit' = 'kanban';

  // Case data by stage
  waitingCases: DentalCase[] = [];
  secretaryCases: DentalCase[] = [];
  designCases: DentalCase[] = [];
  khartCases: DentalCase[] = [];
  finishingCases: DentalCase[] = [];
  completedCases: DentalCase[] = [];

  allCases: DentalCase[] = [];
  auditLogs: AuditLog[] = [];

  // UI state
  selectedCase: DentalCase | null = null;
  showCaseModal = false;
  showAuditModal = false;
  globalSearch = '';

  // Admin controls
  adminUserList: Array<{ id: string; name: string; role: string }> = [];
  currentUser = { id: 'admin', name: 'Admin User', role: 'admin' };

  private destroy$ = new Subject<void>();

  constructor(
    private caseApi: CaseApiService,
    private auditApi: AuditApiService,
    private socketService: SocketService,
    private userApi: UserApiService,
    private auth: AuthService
  ) {}

  ngOnInit() {
    const session = this.auth.getSession();
    if (session) {
      this.currentUser = { id: session.id, name: session.name, role: session.role };
    }
    this.reloadCases();
    this.reloadAuditLogs();
    this.reloadUsers();
    this.connectRealtime();
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private connectRealtime(): void {
    this.socketService.connect();
    this.socketService.onCaseCreated().pipe(takeUntil(this.destroy$)).subscribe((evt) => {
      if (evt) this.reloadCases();
    });
    this.socketService.onCaseAssigned().pipe(takeUntil(this.destroy$)).subscribe((evt) => {
      if (evt) this.reloadCases();
    });
    this.socketService.onCaseReassigned().pipe(takeUntil(this.destroy$)).subscribe((evt) => {
      if (evt) this.reloadCases();
    });
    this.socketService.onCaseMovedStage().pipe(takeUntil(this.destroy$)).subscribe((evt) => {
      if (evt) this.reloadCases();
    });
    this.socketService.onCaseCompleted().pipe(takeUntil(this.destroy$)).subscribe((evt) => {
      if (evt) {
        this.reloadCases();
        this.reloadAuditLogs();
      }
    });
    this.socketService.onCaseReleased().pipe(takeUntil(this.destroy$)).subscribe((evt) => {
      if (evt) this.reloadCases();
    });
    this.socketService.onCaseUpdated().pipe(takeUntil(this.destroy$)).subscribe((evt) => {
      if (evt) this.reloadCases();
    });
    this.socketService.onCaseDeleted().pipe(takeUntil(this.destroy$)).subscribe((evt) => {
      if (evt) this.reloadCases();
    });
  }

  private reloadCases(): void {
    this.caseApi.getAllCases(1, 500).subscribe({
      next: (res) => {
        const rows = (res?.data ?? []) as Record<string, unknown>[];
        const mapped = rows.map((r) => this.mapApiCaseToModel(r));
        this.updateCasesByStage(mapped);
      },
      error: (err) => console.error('Failed to load cases', err),
    });
  }

  private reloadAuditLogs(): void {
    this.auditApi.getAllAuditLogs(1, 200).subscribe({
      next: (res) => {
        const rows = (res?.data ?? []) as Record<string, unknown>[];
        this.auditLogs = rows.map((r) => this.mapApiAuditToModel(r));
      },
      error: (err) => console.error('Failed to load audit logs', err),
    });
  }

  private reloadUsers(): void {
    this.userApi.getAllUsers(undefined, undefined, true).subscribe({
      next: (res) => {
        const rows = (res?.data ?? []) as Record<string, unknown>[];
        this.adminUserList = rows.map((u) => ({
          id: String(u['_id'] ?? ''),
          name: String(u['fullName'] ?? ''),
          role: String(u['role'] ?? ''),
        }));
      },
      error: (err) => console.error('Failed to load users', err),
    });
  }

  // ════════════════════════════════════════════════
  // VIEW MANAGEMENT
  // ════════════════════════════════════════════════

  setViewMode(mode: 'kanban' | 'table' | 'audit') {
    this.viewMode = mode;
  }

  private updateCasesByStage(cases: DentalCase[]) {
    this.waitingCases = cases.filter(c => c.currentStage === 'waiting');
    this.secretaryCases = cases.filter(c => c.currentStage === 'secretary');
    this.designCases = cases.filter(c => c.currentStage === 'design');
    this.khartCases = cases.filter(c => c.currentStage === 'khart');
    this.finishingCases = cases.filter(c => c.currentStage === 'finishing');
    this.completedCases = cases.filter(c => c.currentStage === 'completed');
    this.allCases = cases;
  }

  // ════════════════════════════════════════════════
  // ADMIN CONTROLS
  // ════════════════════════════════════════════════

  assignCase(caseItem: DentalCase) {
    const userId = prompt('Enter user ID to assign (Mongo user id):');
    if (userId) {
      const user = this.adminUserList.find(u => u.id === userId);
      if (user) {
        this.caseApi.assignCase(caseItem.id, userId).subscribe({
          next: () => this.reloadCases(),
          error: (err) => console.error('Assign failed', err),
        });
      }
    }
  }

  releaseCase(caseItem: DentalCase) {
    if (confirm(`Release case #${caseItem.caseNumber}?`)) {
      this.caseApi.releaseCase(caseItem.id).subscribe({
        next: () => this.reloadCases(),
        error: (err) => console.error('Release failed', err),
      });
    }
  }

  moveStageManually(caseItem: DentalCase) {
    const stages: CaseStage[] = ['waiting', 'secretary', 'design', 'khart', 'finishing', 'completed'];
    const currentIndex = stages.indexOf(caseItem.currentStage);
    const nextStage = stages[Math.min(currentIndex + 1, stages.length - 1)];

    this.caseApi.moveStage(caseItem.id, nextStage).subscribe({
      next: () => this.reloadCases(),
      error: (err) => console.error('Move stage failed', err),
    });
  }

  completeCase(caseItem: DentalCase) {
    if (confirm(`Complete case #${caseItem.caseNumber}?`)) {
      this.caseApi.completeCase(caseItem.id).subscribe({
        next: () => {
          this.reloadCases();
          this.reloadAuditLogs();
        },
        error: (err) => console.error('Complete failed', err),
      });
    }
  }

  reassignCase(caseItem: DentalCase) {
    const userId = prompt('Enter user ID to reassign to (Mongo user id):');
    if (userId) {
      const user = this.adminUserList.find(u => u.id === userId);
      if (user) {
        this.caseApi.assignCase(caseItem.id, userId).subscribe({
          next: () => this.reloadCases(),
          error: (err) => console.error('Reassign failed', err),
        });
      }
    }
  }

  reopenCase(caseItem: DentalCase) {
    if (confirm(`Reopen case #${caseItem.caseNumber}?`)) {
      this.caseApi.reopenCase(caseItem.id).subscribe({
        next: () => this.reloadCases(),
        error: (err) => console.error('Reopen failed', err),
      });
    }
  }

  // ════════════════════════════════════════════════
  // MODAL MANAGEMENT
  // ════════════════════════════════════════════════

  openCaseDetails(caseItem: DentalCase) {
    this.selectedCase = caseItem;
    this.showCaseModal = true;
  }

  openAuditLog(caseItem: DentalCase) {
    this.selectedCase = caseItem;
    this.showAuditModal = true;
  }

  closeModals() {
    this.showCaseModal = false;
    this.showAuditModal = false;
    this.selectedCase = null;
  }

  getCaseAuditLogs(): AuditLog[] {
    if (!this.selectedCase) return [];
    return this.auditLogs.filter((log) => log.caseId === this.selectedCase!.id);
  }

  // ════════════════════════════════════════════════
  // FILTERING & SEARCH
  // ════════════════════════════════════════════════

  getFilteredCases(cases: DentalCase[]): DentalCase[] {
    if (!this.globalSearch.trim()) return cases;
    const searchLower = this.globalSearch.toLowerCase();
    return cases.filter(c =>
      c.caseNumber.toLowerCase().includes(searchLower) ||
      c.patientName.toLowerCase().includes(searchLower) ||
      c.caseType.toLowerCase().includes(searchLower)
    );
  }

  private mapApiCaseToModel(doc: Record<string, unknown>): DentalCase {
    const parseDate = (v: unknown): Date => {
      const d = new Date(String(v ?? ''));
      return Number.isFinite(d.getTime()) ? d : new Date();
    };
    const assigned = doc['assignedTo'] as Record<string, unknown> | string | null;
    const assignedTo =
      assigned && typeof assigned === 'object' ? String(assigned['_id'] ?? '') : String(assigned ?? '');

    return {
      id: String(doc['_id'] ?? ''),
      caseNumber: String(doc['caseNumber'] ?? ''),
      patientName: String(doc['patientName'] ?? ''),
      patientEmail: String(doc['patientEmail'] ?? ''),
      patientPhone: String(doc['patientPhone'] ?? ''),
      requesterType: String(doc['requesterType'] ?? 'doctor') === 'student' ? 'student' : 'doctor',
      notes: String(doc['notes'] ?? ''),
      currentStage: (String(doc['currentStage'] ?? 'waiting') as CaseStage),
      status: (String(doc['status'] ?? 'waiting') as any),
      assignedTo: assignedTo || null,
      assignedAt: doc['assignedAt'] ? parseDate(doc['assignedAt']) : null,
      createdBy: String((doc['createdBy'] as Record<string, unknown>)?.['_id'] ?? doc['createdBy'] ?? ''),
      createdAt: parseDate(doc['createdAt']),
      caseType: String(doc['caseType'] ?? ''),
      priority: (String(doc['priority'] ?? 'normal') as any),
      dueDate: parseDate(doc['dueDate']),
      stageTimestamps: (doc['stageTimestamps'] as any) || {},
    };
  }

  private mapApiAuditToModel(doc: Record<string, unknown>): AuditLog {
    return {
      id: String(doc['_id'] ?? ''),
      caseId: String(doc['caseId'] ?? ''),
      caseNumber: String(doc['caseNumber'] ?? ''),
      action: String(doc['action'] ?? 'created') as any,
      performedBy: String(doc['performedBy'] ?? ''),
      performedByName: String(doc['performedByName'] ?? ''),
      timestamp: new Date(String(doc['timestamp'] ?? doc['createdAt'] ?? new Date().toISOString())),
      details: (doc['details'] as any) || {},
    };
  }

}
