import { Injectable } from '@angular/core';
import { Subject, BehaviorSubject, Observable } from 'rxjs';
import { DentalCase, AuditLog, SystemNotification, User } from '../models/case.model';

interface WebSocketMessage {
  type: string;
  data: any;
  timestamp: Date;
}

@Injectable({
  providedIn: 'root'
})
export class RealtimeService {
  private wsConnected = new BehaviorSubject<boolean>(false);
  public connected$ = this.wsConnected.asObservable();

  // Case updates
  private caseUpdated = new Subject<DentalCase>();
  public caseUpdated$ = this.caseUpdated.asObservable();

  // Case claimed
  private caseClaimed = new Subject<{ caseId: string; userId: string; userName: string }>();
  public caseClaimed$ = this.caseClaimed.asObservable();

  // Case stage changed
  private caseStageChanged = new Subject<{ caseId: string; oldStage: string; newStage: string }>();
  public caseStageChanged$ = this.caseStageChanged.asObservable();

  // Case created
  private caseCreated = new Subject<DentalCase>();
  public caseCreated$ = this.caseCreated.asObservable();

  // Case completed
  private caseCompleted = new Subject<{ caseId: string; completedBy: string }>();
  public caseCompleted$ = this.caseCompleted.asObservable();

  // Audit log entry
  private auditLogEntry = new Subject<AuditLog>();
  public auditLogEntry$ = this.auditLogEntry.asObservable();

  // System notification
  private systemNotification = new Subject<SystemNotification>();
  public systemNotification$ = this.systemNotification.asObservable();

  // User status changed
  private userStatusChanged = new Subject<User>();
  public userStatusChanged$ = this.userStatusChanged.asObservable();

  constructor() {
    this.initializeWebSocket();
  }

  private initializeWebSocket() {
    // Simulate WebSocket connection
    // In production, replace with actual WebSocket/Socket.io implementation
    setTimeout(() => {
      this.wsConnected.next(true);
      console.log('WebSocket connected');
    }, 1000);
  }

  // Emit case update
  emitCaseUpdate(dentalCase: DentalCase) {
    this.caseUpdated.next(dentalCase);
  }

  // Emit case claimed
  emitCaseClaimed(caseId: string, userId: string, userName: string) {
    this.caseClaimed.next({ caseId, userId, userName });
  }

  // Emit stage change
  emitCaseStageChanged(caseId: string, oldStage: string, newStage: string) {
    this.caseStageChanged.next({ caseId, oldStage, newStage });
  }

  // Emit case created
  emitCaseCreated(dentalCase: DentalCase) {
    this.caseCreated.next(dentalCase);
  }

  // Emit case completed
  emitCaseCompleted(caseId: string, completedBy: string) {
    this.caseCompleted.next({ caseId, completedBy });
  }

  // Emit audit log
  emitAuditLog(log: AuditLog) {
    this.auditLogEntry.next(log);
  }

  // Emit notification
  emitNotification(notification: SystemNotification) {
    this.systemNotification.next(notification);
  }

  // Emit user status change
  emitUserStatusChanged(user: User) {
    this.userStatusChanged.next(user);
  }

  // Connect to real WebSocket (to be implemented in production)
  connect(userId: string): Observable<any> {
    return new Observable(observer => {
      // In production: connect to actual WebSocket server
      observer.next({ status: 'connected', userId });
    });
  }

  disconnect() {
    this.wsConnected.next(false);
  }

  isConnected(): boolean {
    return this.wsConnected.value;
  }
}
