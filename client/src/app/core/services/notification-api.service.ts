import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject } from 'rxjs';
import { environment } from '../../../environments/environment';
import { SocketService } from './socket.service';
import { tap } from 'rxjs/operators';

@Injectable({
  providedIn: 'root',
})
export class NotificationApiService {
  private apiUrl = `${environment.apiUrl}/notifications`;
  private unreadCount$ = new BehaviorSubject<number>(0);
  private notifications$ = new BehaviorSubject<any[]>([]);

  constructor(
    private http: HttpClient,
    private socketService: SocketService
  ) {
    this.initializeSocketListener();
  }

  private initializeSocketListener(): void {
    this.socketService.onNotificationReceived().subscribe((notification) => {
      if (notification) {
        this.notifications$.next([notification, ...this.notifications$.value]);
        this.updateUnreadCount();
      }
    });
  }

  // Get user notifications with pagination
  getNotifications(page: number = 1, limit: number = 20, read?: boolean): Observable<any> {
    let params = `?page=${page}&limit=${limit}`;
    if (read !== undefined) params += `&read=${read}`;

    return this.http.get(`${this.apiUrl}${params}`).pipe(
      tap((response: any) => {
        this.notifications$.next(response.data);
        this.unreadCount$.next(response.unreadCount);
      })
    );
  }

  // Get unread count
  getUnreadCount(): Observable<any> {
    return this.http.get(`${this.apiUrl}/unread/count`).pipe(
      tap((response: any) => {
        this.unreadCount$.next(response.unreadCount);
      })
    );
  }

  // Mark notification as read
  markAsRead(notificationId: string): Observable<any> {
    return this.http.put(`${this.apiUrl}/${notificationId}/read`, {}).pipe(
      tap(() => {
        this.updateUnreadCount();
      })
    );
  }

  // Mark all notifications as read
  markAllAsRead(): Observable<any> {
    return this.http.put(`${this.apiUrl}/read/all`, {}).pipe(
      tap(() => {
        this.unreadCount$.next(0);
      })
    );
  }

  // Delete notification
  deleteNotification(notificationId: string): Observable<any> {
    return this.http.delete(`${this.apiUrl}/${notificationId}`);
  }

  // Observables
  getUnreadCount$(): Observable<number> {
    return this.unreadCount$.asObservable();
  }

  getNotifications$(): Observable<any[]> {
    return this.notifications$.asObservable();
  }

  private updateUnreadCount(): void {
    this.getUnreadCount().subscribe();
  }
}
