import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { BehaviorSubject, Observable, filter } from 'rxjs';
import { AuthService } from './auth.service';
import { socketBaseUrl } from '../api/api.config';

@Injectable({
  providedIn: 'root',
})
export class SocketService {
  private socket: Socket | null = null;
  private listenersBound = false;
  private isConnected$ = new BehaviorSubject<boolean>(false);

  // Case Events
  private caseCreated$ = new BehaviorSubject<any>(null);
  private caseAssigned$ = new BehaviorSubject<any>(null);
  private caseReassigned$ = new BehaviorSubject<any>(null);
  private caseMovedStage$ = new BehaviorSubject<any>(null);
  private caseCompleted$ = new BehaviorSubject<any>(null);
  private caseReleased$ = new BehaviorSubject<any>(null);
  private caseUpdated$ = new BehaviorSubject<any>(null);
  private caseDeleted$ = new BehaviorSubject<any>(null);
  private caseExited$ = new BehaviorSubject<any>(null);

  // User Events
  private userStatusChanged$ = new BehaviorSubject<any>(null);

  // Notification Events
  private notificationReceived$ = new BehaviorSubject<any>(null);

  // Print Agent online/offline (lab Windows service)
  private printAgentStatus$ = new BehaviorSubject<{
    online: boolean;
    agentCount?: number;
    connectedAt?: string | null;
  } | null>(null);

  // Print jobs (entry screen)
  private printJobCreated$ = new BehaviorSubject<any>(null);
  private printJobStatusUpdated$ = new BehaviorSubject<any>(null);
  private printJobDeleted$ = new BehaviorSubject<any>(null);
  private printAllJobsCleared$ = new BehaviorSubject<any>(null);

  constructor(private authService: AuthService) {}

  connect(): void {
    const token = this.authService.getToken();
    if (!token) {
      console.warn('No token available for Socket.io connection');
      return;
    }

    // Reuse existing socket — never orphan listeners by creating a second io()
    if (this.socket) {
      if (!this.socket.connected) {
        this.socket.auth = { token };
        this.socket.connect();
      }
      return;
    }

    this.socket = io(socketBaseUrl(), {
      auth: {
        token,
      },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
    });

    this.bindSocketListeners(this.socket);
  }

  private bindSocketListeners(socket: Socket): void {
    if (this.listenersBound) return;
    this.listenersBound = true;

    socket.on('connect', () => {
      console.log('Socket.io connected');
      this.isConnected$.next(true);
    });

    socket.on('disconnect', () => {
      console.log('Socket.io disconnected');
      this.isConnected$.next(false);
    });

    socket.on('error', (error: unknown) => {
      console.error('Socket.io error:', error);
    });

    socket.on('case:created', (data: unknown) => {
      this.caseCreated$.next(data);
    });

    socket.on('case:assigned', (data: unknown) => {
      this.caseAssigned$.next(data);
    });

    socket.on('case:reassigned', (data: unknown) => {
      this.caseReassigned$.next(data);
    });

    socket.on('case:moved-stage', (data: unknown) => {
      this.caseMovedStage$.next(data);
    });

    socket.on('case:completed', (data: unknown) => {
      this.caseCompleted$.next(data);
    });

    socket.on('case:released', (data: unknown) => {
      this.caseReleased$.next(data);
    });

    socket.on('case:updated', (data: unknown) => {
      this.caseUpdated$.next(data);
    });

    socket.on('case:deleted', (data: unknown) => {
      this.caseDeleted$.next(data);
    });

    socket.on('case:exited', (data: unknown) => {
      this.caseExited$.next(data);
    });

    socket.on('user:status-changed', (data: unknown) => {
      this.userStatusChanged$.next(data);
    });

    socket.on('notification:new', (data: unknown) => {
      this.notificationReceived$.next(data);
    });

    socket.on('print:agent-status', (data: unknown) => {
      const row = data as { online?: boolean; agentCount?: number; connectedAt?: string | null };
      this.printAgentStatus$.next({
        online: Boolean(row?.online),
        agentCount: Number(row?.agentCount) || 0,
        connectedAt: row?.connectedAt ?? null,
      });
    });

    socket.on('print:job-created', (data: unknown) => {
      this.printJobCreated$.next(data);
    });

    socket.on('print:job-status-updated', (data: unknown) => {
      this.printJobStatusUpdated$.next(data);
    });

    socket.on('print:job-deleted', (data: unknown) => {
      this.printJobDeleted$.next(data);
    });

    socket.on('print:all-jobs-cleared', (data: unknown) => {
      this.printAllJobsCleared$.next(data ?? true);
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.listenersBound = false;
      this.isConnected$.next(false);
    }
  }

  emitCaseCreated(data: any): void {
    this.socket?.emit('case:created', data);
  }

  emitCaseAssigned(data: any): void {
    this.socket?.emit('case:assigned', data);
  }

  emitCaseMovedStage(data: any): void {
    this.socket?.emit('case:moved-stage', data);
  }

  emitCaseCompleted(data: any): void {
    this.socket?.emit('case:completed', data);
  }

  emitUserStatusChange(status: 'online' | 'offline' | 'idle'): void {
    this.socket?.emit('user:status-change', { status });
  }

  isConnected(): Observable<boolean> {
    return this.isConnected$.asObservable();
  }

  onCaseCreated(): Observable<any> {
    return this.caseCreated$.asObservable();
  }

  onCaseAssigned(): Observable<any> {
    return this.caseAssigned$.asObservable();
  }

  onCaseReassigned(): Observable<any> {
    return this.caseReassigned$.asObservable();
  }

  onCaseMovedStage(): Observable<any> {
    return this.caseMovedStage$.asObservable();
  }

  onCaseCompleted(): Observable<any> {
    return this.caseCompleted$.asObservable();
  }

  onCaseReleased(): Observable<any> {
    return this.caseReleased$.asObservable();
  }

  onCaseUpdated(): Observable<any> {
    return this.caseUpdated$.asObservable();
  }

  onCaseDeleted(): Observable<any> {
    return this.caseDeleted$.asObservable();
  }

  onCaseExited(): Observable<any> {
    return this.caseExited$.asObservable();
  }

  onUserStatusChanged(): Observable<any> {
    return this.userStatusChanged$.asObservable();
  }

  onNotificationReceived(): Observable<any> {
    return this.notificationReceived$.asObservable();
  }

  onPrintAgentStatus(): Observable<{
    online: boolean;
    agentCount?: number;
    connectedAt?: string | null;
  } | null> {
    return this.printAgentStatus$.asObservable();
  }

  onPrintJobCreated(): Observable<any> {
    return this.printJobCreated$.pipe(filter((v) => v != null));
  }

  onPrintJobStatusUpdated(): Observable<any> {
    return this.printJobStatusUpdated$.pipe(filter((v) => v != null));
  }

  onPrintJobDeleted(): Observable<any> {
    return this.printJobDeleted$.pipe(filter((v) => v != null));
  }

  onPrintAllJobsCleared(): Observable<any> {
    return this.printAllJobsCleared$.pipe(filter((v) => v != null));
  }
}
