import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

@Injectable({
  providedIn: 'root',
})
export class CaseApiService {
  private apiUrl = `${environment.apiUrl}/cases`;

  constructor(private http: HttpClient) {}

  // Get all cases with pagination and filtering
  getAllCases(page: number = 1, limit: number = 10, filters?: any): Observable<any> {
    let params = `?page=${page}&limit=${limit}`;
    if (filters?.stage) params += `&stage=${filters.stage}`;
    if (filters?.status) params += `&status=${filters.status}`;
    if (filters?.priority) params += `&priority=${filters.priority}`;
    if (filters?.search) params += `&search=${filters.search}`;

    return this.http.get(`${this.apiUrl}${params}`);
  }

  getFinancialReport(filters?: {
    year?: number;
    month?: number;
    doctor?: string;
    paymentStatus?: 'paid' | 'unpaid';
  }): Observable<any> {
    const params: string[] = [];
    if (filters?.year) params.push(`year=${filters.year}`);
    if (filters?.month) params.push(`month=${filters.month}`);
    if (filters?.doctor) params.push(`doctor=${encodeURIComponent(filters.doctor)}`);
    if (filters?.paymentStatus) params.push(`paymentStatus=${filters.paymentStatus}`);
    const query = params.length ? `?${params.join('&')}` : '';
    return this.http.get(`${this.apiUrl}/financial-report${query}`);
  }

  // Get case by ID
  getCaseById(id: string): Observable<any> {
    return this.http.get(`${this.apiUrl}/${id}`);
  }

  // Create new case
  createCase(data: any): Observable<any> {
    return this.http.post(this.apiUrl, data);
  }

  updateCase(id: string, data: unknown): Observable<any> {
    return this.http.put(`${this.apiUrl}/${id}`, data);
  }

  updateCaseFinancials(
    id: string,
    data: { salaryAmount?: number; paymentStatus?: 'paid' | 'unpaid' }
  ): Observable<any> {
    return this.http.put(`${this.apiUrl}/${id}/financials`, data);
  }

  deleteCase(id: string): Observable<any> {
    return this.http.delete(`${this.apiUrl}/${id}`);
  }

  // Claim case (Atomic operation)
  claimCase(id: string): Observable<any> {
    return this.http.put(`${this.apiUrl}/${id}/claim`, {});
  }

  // Assign case (Admin only)
  assignCase(id: string, userId: string): Observable<any> {
    return this.http.put(`${this.apiUrl}/${id}/assign`, { userId });
  }

  // Move case to next stage
  moveStage(id: string, stage: string): Observable<any> {
    return this.http.put(`${this.apiUrl}/${id}/move-stage`, { stage });
  }

  // Upload a case image file (designer/finisher/admin)
  uploadCaseImage(id: string, file: File): Observable<any> {
    const form = new FormData();
    form.append('image', file);
    return this.http.post(`${this.apiUrl}/${id}/upload-image`, form);
  }

  /** رفع مسح ثلاثي الأبعاد .ply (سكرتير / أدمن) */
  uploadCasePly(id: string, file: File): Observable<any> {
    const form = new FormData();
    form.append('ply', file);
    return this.http.post(`${this.apiUrl}/${id}/upload-ply`, form);
  }

  // Complete case
  completeCase(id: string): Observable<any> {
    return this.http.put(`${this.apiUrl}/${id}/complete`, {});
  }

  // Exit completed case (Secretary/Admin)
  exitCase(id: string): Observable<any> {
    return this.http.put(`${this.apiUrl}/${id}/exit`, {});
  }

  /** إرجاع حالة منتهية لعمود «محتاجة تعديل» (سكرتير / أدمن) */
  requestRevision(id: string): Observable<any> {
    return this.http.put(`${this.apiUrl}/${id}/request-revision`, {});
  }

  // Release case (Admin only)
  releaseCase(id: string): Observable<any> {
    return this.http.put(`${this.apiUrl}/${id}/release`, {});
  }

  // Reopen case (Admin only)
  reopenCase(id: string): Observable<any> {
    return this.http.put(`${this.apiUrl}/${id}/reopen`, {});
  }
}
