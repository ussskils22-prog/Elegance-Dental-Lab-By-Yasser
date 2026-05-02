import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { SystemNotification } from '../models/case.model';

@Injectable({
  providedIn: 'root'
})
export class NotificationService {
  private notifications = new BehaviorSubject<SystemNotification[]>([]);
  public notifications$ = this.notifications.asObservable();

  private unreadCount = new BehaviorSubject<number>(0);
  public unreadCount$ = this.unreadCount.asObservable();

  constructor() {}

  addNotification(notification: SystemNotification) {
    const current = this.notifications.value;
    current.unshift(notification);

    // Keep only last 50 notifications
    if (current.length > 50) {
      current.pop();
    }

    this.notifications.next(current);
    this.updateUnreadCount();

    // Auto-dismiss after 5 seconds
    setTimeout(() => {
      this.markAsRead(notification.id);
    }, 5000);
  }

  markAsRead(notificationId: string) {
    const current = this.notifications.value;
    const notification = current.find(n => n.id === notificationId);
    if (notification) {
      notification.read = true;
      this.notifications.next([...current]);
      this.updateUnreadCount();
    }
  }

  markAllAsRead() {
    const current = this.notifications.value;
    current.forEach(n => (n.read = true));
    this.notifications.next([...current]);
    this.updateUnreadCount();
  }

  clearNotifications() {
    this.notifications.next([]);
    this.unreadCount.next(0);
  }

  private updateUnreadCount() {
    const unread = this.notifications.value.filter(n => !n.read).length;
    this.unreadCount.next(unread);
  }
}
