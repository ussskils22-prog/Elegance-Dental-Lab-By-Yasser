import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

@Injectable({
  providedIn: 'root',
})
export class AuditApiService {
  private apiUrl = `${environment.apiUrl}/audit-logs`;

  constructor(private http: HttpClient) {}

  // Get all audit logs with pagination and filtering
  getAllAuditLogs(page: number = 1, limit: number = 20, filters?: any): Observable<any> {
    let params = `?page=${page}&limit=${limit}`;
    if (filters?.caseId) params += `&caseId=${filters.caseId}`;
    if (filters?.action) params += `&action=${filters.action}`;
    if (filters?.userId) params += `&userId=${filters.userId}`;

    return this.http.get(`${this.apiUrl}${params}`);
  }

  // Get audit logs for a specific case
  getCaseAuditLogs(caseId: string, page: number = 1, limit: number = 50): Observable<any> {
    return this.http.get(`${this.apiUrl}/case/${caseId}?page=${page}&limit=${limit}`);
  }
}
