import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { DentalCase, AuditLog, CaseStage, User } from '../models/case.model';
import { RealtimeService } from './realtime.service';
import { DataPersistenceService, Patient } from './data-persistence.service';

@Injectable({
  providedIn: 'root'
})
export class CaseManagementService {
  private readonly CASES_KEY = 'dental_system_cases';

  private allCases = new BehaviorSubject<DentalCase[]>([]);
  public allCases$ = this.allCases.asObservable();

  private auditLogs = new BehaviorSubject<AuditLog[]>([]);
  public auditLogs$ = this.auditLogs.asObservable();

  private assignedCases = new Map<string, DentalCase>(); // caseId -> User mapping
  private auditTrail: AuditLog[] = [];

  constructor(
    private realtimeService: RealtimeService,
    private dataPersistence: DataPersistenceService
  ) {
    this.loadCasesFromStorage();
  }

  // ════════════════════════════════════════════════
  // CASE CLAIMING (Atomic Operation)
  // ════════════════════════════════════════════════

  /**
   * Claim/Start a case - ATOMIC OPERATION
   * Ensures only one user can claim at a time
   */
  claimCase(caseId: string, userId: string, userName: string): { success: boolean; message: string } {
    const cases = this.allCases.value;
    const caseItem = cases.find(c => c.id === caseId);

    if (!caseItem) {
      return { success: false, message: 'Case not found' };
    }

    // Atomic check: is it already assigned?
    if (caseItem.assignedTo && caseItem.assignedTo !== userId) {
      return {
        success: false,
        message: `Case already assigned to ${caseItem.assignedTo}. Cannot claim.`
      };
    }

    // Assign the case
    caseItem.assignedTo = userId;
    caseItem.assignedAt = new Date();
    caseItem.status = 'in_progress';
    caseItem.currentStage = this.getNextStage(caseItem.currentStage);

    // Update in store
    this.updateCases(cases);

    // Log the action
    const caseNumber = caseItem.caseNumber;
    this.addAuditLog({
      caseId,
      caseNumber,
      action: 'assigned',
      performedBy: userId,
      performedByName: userName,
      details: { newValue: userId }
    });

    // Emit real-time notification
    this.realtimeService.emitCaseClaimed(caseId, userId, userName);
    this.realtimeService.emitCaseUpdate(caseItem);

    return { success: true, message: `Case claimed by ${userName}` };
  }

  // ════════════════════════════════════════════════
  // ADMIN CONTROLS
  // ════════════════════════════════════════════════

  /**
   * Force assign a case (Admin only)
   */
  adminAssignCase(
    caseId: string,
    userId: string,
    userName: string,
    adminId: string,
    adminName: string
  ): boolean {
    const cases = this.allCases.value;
    const caseItem = cases.find(c => c.id === caseId);

    if (!caseItem) return false;

    const oldAssignee = caseItem.assignedTo;
    caseItem.assignedTo = userId;
    caseItem.assignedAt = new Date();

    this.updateCases(cases);

    this.addAuditLog({
      caseId,
      caseNumber: caseItem.caseNumber,
      action: oldAssignee ? 'reassigned' : 'assigned',
      performedBy: adminId,
      performedByName: adminName,
      details: { oldValue: oldAssignee, newValue: userId }
    });

    this.realtimeService.emitCaseUpdate(caseItem);
    this.realtimeService.emitNotification({
      id: this.generateId(),
      type: 'case_reassigned',
      title: `Case Reassigned by Admin`,
      message: `Case #${caseItem.caseNumber} reassigned to ${userName}`,
      caseId,
      caseNumber: caseItem.caseNumber,
      timestamp: new Date(),
      read: false,
      targetAudience: 'all'
    });

    return true;
  }

  /**
   * Release a case (set assignedTo = null)
   */
  releaseCase(caseId: string, adminId: string, adminName: string): boolean {
    const cases = this.allCases.value;
    const caseItem = cases.find(c => c.id === caseId);

    if (!caseItem) return false;

    const oldAssignee = caseItem.assignedTo;
    caseItem.assignedTo = null;
    caseItem.assignedAt = null;
    caseItem.status = 'waiting';

    this.updateCases(cases);

    this.addAuditLog({
      caseId,
      caseNumber: caseItem.caseNumber,
      action: 'released',
      performedBy: adminId,
      performedByName: adminName,
      details: { oldValue: oldAssignee, newValue: null }
    });

    this.realtimeService.emitCaseUpdate(caseItem);

    return true;
  }

  /**
   * Move case to any stage (Admin only)
   */
  adminMoveStage(
    caseId: string,
    newStage: CaseStage,
    adminId: string,
    adminName: string
  ): boolean {
    const cases = this.allCases.value;
    const caseItem = cases.find(c => c.id === caseId);

    if (!caseItem) return false;

    const oldStage = caseItem.currentStage;
    caseItem.currentStage = newStage;
    if (newStage !== 'waiting') {
      caseItem.stageTimestamps[newStage as 'secretary' | 'design' | 'finishing' | 'completed'] = new Date();
    }

    if (newStage === 'completed') {
      caseItem.status = 'completed';
    }

    this.updateCases(cases);

    this.addAuditLog({
      caseId,
      caseNumber: caseItem.caseNumber,
      action: 'moved_stage',
      performedBy: adminId,
      performedByName: adminName,
      details: { oldValue: oldStage, newValue: newStage }
    });

    this.realtimeService.emitCaseStageChanged(caseId, oldStage, newStage);
    this.realtimeService.emitCaseUpdate(caseItem);

    return true;
  }

  /**
   * Complete a case
   */
  completeCase(caseId: string, userId: string, userName: string): boolean {
    const cases = this.allCases.value;
    const caseItem = cases.find(c => c.id === caseId);

    if (!caseItem) return false;

    caseItem.currentStage = 'completed';
    caseItem.status = 'completed';
    caseItem.stageTimestamps.completed = new Date();

    this.updateCases(cases);

    this.addAuditLog({
      caseId,
      caseNumber: caseItem.caseNumber,
      action: 'completed',
      performedBy: userId,
      performedByName: userName,
      details: { newValue: 'completed' }
    });

    this.realtimeService.emitCaseCompleted(caseId, userId);
    this.realtimeService.emitCaseUpdate(caseItem);
    this.realtimeService.emitNotification({
      id: this.generateId(),
      type: 'case_completed',
      title: 'Case Completed',
      message: `Case #${caseItem.caseNumber} completed by ${userName}`,
      caseId,
      caseNumber: caseItem.caseNumber,
      timestamp: new Date(),
      read: false,
      targetAudience: 'admin'
    });

    return true;
  }

  /**
   * Reopen a case
   */
  reopenCase(caseId: string, adminId: string, adminName: string): boolean {
    const cases = this.allCases.value;
    const caseItem = cases.find(c => c.id === caseId);

    if (!caseItem) return false;

    caseItem.currentStage = 'finishing';
    caseItem.status = 'in_progress';

    this.updateCases(cases);

    this.addAuditLog({
      caseId,
      caseNumber: caseItem.caseNumber,
      action: 'reopened',
      performedBy: adminId,
      performedByName: adminName,
      details: {}
    });

    this.realtimeService.emitCaseUpdate(caseItem);

    return true;
  }

  // ════════════════════════════════════════════════
  // CASE CREATION
  // ════════════════════════════════════════════════

  createCase(
    patientName: string,
    patientEmail: string,
    patientPhone: string,
    caseType: string,
    priority: string,
    notes: string,
    createdBy: string,
    createdByName: string
  ): DentalCase {
    const newCase: DentalCase = {
      id: this.generateId(),
      caseNumber: `#DC-${Math.floor(Math.random() * 10000)}`,
      patientName,
      patientEmail,
      patientPhone,
      notes,
      currentStage: 'waiting',
      status: 'waiting',
      assignedTo: null,
      assignedAt: null,
      createdBy,
      createdAt: new Date(),
      caseType,
      priority: priority as any,
      dueDate: this.addDays(new Date(), 7),
      stageTimestamps: {}
    };

    const cases = this.allCases.value;
    cases.push(newCase);
    this.updateCases(cases);

    this.addAuditLog({
      caseId: newCase.id,
      caseNumber: newCase.caseNumber,
      action: 'created',
      performedBy: createdBy,
      performedByName: createdByName,
      details: { newValue: newCase }
    });

    this.realtimeService.emitCaseCreated(newCase);
    this.realtimeService.emitNotification({
      id: this.generateId(),
      type: 'case_created',
      title: 'New Case Created',
      message: `Case #${newCase.caseNumber} created by ${createdByName}`,
      caseId: newCase.id,
      caseNumber: newCase.caseNumber,
      timestamp: new Date(),
      read: false,
      targetAudience: 'admin'
    });

    return newCase;
  }

  // ════════════════════════════════════════════════
  // RETRIEVAL
  // ════════════════════════════════════════════════

  getCaseById(caseId: string): DentalCase | undefined {
    return this.allCases.value.find(c => c.id === caseId);
  }

  getCasesByStage(stage: CaseStage): DentalCase[] {
    return this.allCases.value.filter(c => c.currentStage === stage);
  }

  getCasesByUser(userId: string): DentalCase[] {
    return this.allCases.value.filter(c => c.assignedTo === userId);
  }

  getUnassignedCases(): DentalCase[] {
    return this.allCases.value.filter(c => !c.assignedTo && c.status !== 'completed');
  }

  getAuditLogsForCase(caseId: string): AuditLog[] {
    return this.auditTrail.filter(log => log.caseId === caseId);
  }

  getAllAuditLogs(): AuditLog[] {
    return this.auditTrail;
  }

  // ════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ════════════════════════════════════════════════

  private addAuditLog(log: Omit<AuditLog, 'id' | 'timestamp'>) {
    const auditLog: AuditLog = {
      id: this.generateId(),
      timestamp: new Date(),
      ...log
    };

    this.auditTrail.push(auditLog);
    this.auditLogs.next(this.auditTrail);
    this.realtimeService.emitAuditLog(auditLog);
  }

  private getNextStage(currentStage: CaseStage): CaseStage {
    const stages: CaseStage[] = ['waiting', 'secretary', 'design', 'khart', 'finishing', 'completed'];
    const currentIndex = stages.indexOf(currentStage);
    return stages[Math.min(currentIndex + 1, stages.length - 1)];
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }

  // ════════════════════════════════════════════════
  // PERSISTENCE (LocalStorage)
  // ════════════════════════════════════════════════

  private loadCasesFromStorage() {
    this.initializeSampleData();
  }

  private saveCasesToStorage() {
    // localStorage removed
  }

  private updateCases(cases: DentalCase[]) {
    this.allCases.next(cases);
    this.saveCasesToStorage();
  }

  initializeSampleData() {
    // Get real patients from storage
    const realPatients = this.dataPersistence.getPatients();

    // Create cases using real patient data
    const sampleCases: DentalCase[] = realPatients.map((patient, index) => ({
      id: `case-${patient.id}`,
      caseNumber: `#DC-${String(index + 1).padStart(3, '0')}`,
      patientName: patient.name,
      patientEmail: patient.email,
      patientPhone: patient.phone,
      notes: `Patient case - Created from real data`,
      currentStage: index === 0 ? 'waiting' : index === 1 ? 'design' : 'finishing',
      status: index === 0 ? 'waiting' : 'in_progress',
      assignedTo: index === 0 ? null : `des-${index}`,
      assignedAt: index === 0 ? null : new Date(),
      createdBy: 'sec-1',
      createdAt: new Date(patient.createdAt),
      caseType: ['Implant', 'Crown', 'Bridge', 'Veneer'][index % 4],
      priority: ['high', 'normal', 'normal', 'low'][index % 4] as 'high' | 'normal' | 'low' | 'urgent',
      dueDate: this.addDays(new Date(), 5 - index),
      stageTimestamps: index === 0 ? {} : { design: new Date() }
    }));

    this.updateCases(sampleCases);
  }
}
