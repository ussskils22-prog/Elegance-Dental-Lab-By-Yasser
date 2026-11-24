import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiBaseUrl } from '../api/api.config';

@Injectable({
  providedIn: 'root',
})
export class UserApiService {
  private get apiUrl(): string {
    return `${apiBaseUrl()}/users`;
  }

  constructor(private http: HttpClient) {}

  /** Admin list: set `includeInactive` to include deactivated users. */
  getAllUsers(role?: string, status?: string, includeInactive?: boolean): Observable<any> {
    let params = new HttpParams();
    if (role) params = params.set('role', role);
    if (status) params = params.set('status', status);
    if (includeInactive) params = params.set('includeInactive', 'true');
    return this.http.get(this.apiUrl, { params });
  }

  // Get users by role
  getUsersByRole(role: string): Observable<any> {
    return this.http.get(`${this.apiUrl}/role/${role}`);
  }

  // Get user by ID
  getUserById(id: string): Observable<any> {
    return this.http.get(`${this.apiUrl}/${id}`);
  }

  // Update user
  updateUser(id: string, data: any): Observable<any> {
    return this.http.put(`${this.apiUrl}/${id}`, data);
  }

  // Update user status
  updateUserStatus(id: string, status: 'online' | 'offline' | 'idle'): Observable<any> {
    return this.http.put(`${this.apiUrl}/${id}/status`, { status });
  }

  /** Admin: list (apply=false) or delete (apply=true) all stopped doctor / student / lab accounts. */
  purgeStoppedClients(apply: boolean): Observable<any> {
    return this.http.post(`${this.apiUrl}/clients/purge-stopped`, { apply });
  }

  // Delete user (soft delete)
  deleteUser(id: string): Observable<any> {
    return this.http.delete(`${this.apiUrl}/${id}`);
  }

  /** Admin or secretary: reset a doctor account password. */
  resetDoctorPassword(id: string, password: string): Observable<any> {
    return this.http.patch(`${this.apiUrl}/${id}/reset-doctor-password`, { password });
  }

  /** Admin or secretary: convert doctor/student/lab and retag cases by name. */
  convertClientRole(id: string, role: 'doctor' | 'student' | 'lab'): Observable<any> {
    return this.http.patch(`${this.apiUrl}/${id}/convert-client-role`, { role });
  }

  /** Admin or secretary: create or convert by name, then retag cases. */
  ensureClientAccount(fullName: string, role: 'doctor' | 'student' | 'lab'): Observable<any> {
    return this.http.post(`${this.apiUrl}/ensure-client-account`, { fullName, role });
  }
}
