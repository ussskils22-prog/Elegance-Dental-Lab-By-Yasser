import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { BehaviorSubject, Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthService } from './auth.service';

@Injectable({
  providedIn: 'root',
})
export class SocketService {
  private socket: Socket | null = null;
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

  // User Events
  private userStatusChanged$ = new BehaviorSubject<any>(null);

  // Notification Events
  private notificationReceived$ = new BehaviorSubject<any>(null);

  constructor(private authService: AuthService) {}

  connect(): void {
    if (this.socket?.connected) return;

    const token = this.authService.getToken();

    if (!token) {
      console.warn('No token available for Socket.io connection');
      return;
    }

    this.socket = io(environment.socketUrl, {
      auth: {
        token,
      },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5,
    });

    // Connection events
    this.socket.on('connect', () => {
      console.log('Socket.io connected');
      this.isConnected$.next(true);
    });

    this.socket.on('disconnect', () => {
      console.log('Socket.io disconnected');
      this.isConnected$.next(false);
    });

    this.socket.on('error', (error: unknown) => {
      console.error('Socket.io error:', error);
    });

    // ════════════════════════════════════════════════
    // CASE EVENTS
    // ════════════════════════════════════════════════

    this.socket.on('case:created', (data: unknown) => {
      console.log('Case created:', data);
      this.caseCreated$.next(data);
    });

    this.socket.on('case:assigned', (data: unknown) => {
      console.log('Case assigned:', data);
      this.caseAssigned$.next(data);
    });

    this.socket.on('case:reassigned', (data: unknown) => {
      console.log('Case reassigned:', data);
      this.caseReassigned$.next(data);
    });

    this.socket.on('case:moved-stage', (data: unknown) => {
      console.log('Case moved to stage:', data);
      this.caseMovedStage$.next(data);
    });

    this.socket.on('case:completed', (data: unknown) => {
      console.log('Case completed:', data);
      this.caseCompleted$.next(data);
    });

    this.socket.on('case:released', (data: unknown) => {
      console.log('Case released:', data);
      this.caseReleased$.next(data);
    });

    this.socket.on('case:updated', (data: unknown) => {
      console.log('Case updated:', data);
      this.caseUpdated$.next(data);
    });

    this.socket.on('case:deleted', (data: unknown) => {
      console.log('Case deleted:', data);
      this.caseDeleted$.next(data);
    });

    // ════════════════════════════════════════════════
    // USER EVENTS
    // ════════════════════════════════════════════════

    this.socket.on('user:status-changed', (data: unknown) => {
      console.log('User status changed:', data);
      this.userStatusChanged$.next(data);
    });

    // ════════════════════════════════════════════════
    // NOTIFICATION EVENTS
    // ════════════════════════════════════════════════

    this.socket.on('notification:new', (data: unknown) => {
      console.log('New notification:', data);
      this.notificationReceived$.next(data);
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.isConnected$.next(false);
    }
  }

  // ════════════════════════════════════════════════
  // EMIT METHODS
  // ════════════════════════════════════════════════

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

  // ════════════════════════════════════════════════
  // OBSERVABLE METHODS
  // ════════════════════════════════════════════════

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

  onUserStatusChanged(): Observable<any> {
    return this.userStatusChanged$.asObservable();
  }

  onNotificationReceived(): Observable<any> {
    return this.notificationReceived$.asObservable();
  }
}
