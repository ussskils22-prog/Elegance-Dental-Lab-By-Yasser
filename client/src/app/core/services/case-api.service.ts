import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { apiBaseUrl } from '../api/api.config';

@Injectable({
  providedIn: 'root',
})
export class CaseApiService {
  private get apiUrl(): string {
    return `${apiBaseUrl()}/cases`;
  }

  private get rootApiUrl(): string {
    return apiBaseUrl();
  }

  constructor(private http: HttpClient) {}

  // Get all cases with pagination and filtering
  getAllCases(page: number = 1, limit: number = 10, filters?: any): Observable<any> {
    let params = `?page=${page}&limit=${limit}`;
    if (filters?.stage) params += `&stage=${encodeURIComponent(filters.stage)}`;
    if (filters?.status) params += `&status=${encodeURIComponent(filters.status)}`;
    if (filters?.priority) params += `&priority=${encodeURIComponent(filters.priority)}`;
    if (filters?.search) params += `&search=${encodeURIComponent(filters.search)}`;
    if (filters?.scope) params += `&scope=${encodeURIComponent(filters.scope)}`;
    if (filters?.year) params += `&year=${encodeURIComponent(filters.year)}`;
    if (filters?.month) params += `&month=${encodeURIComponent(filters.month)}`;

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

  /** Admin dashboard material counters (optionally scoped by exit year/month) */
  getExitedMaterialStats(filters?: { year?: number; month?: number }): Observable<any> {
    const params: string[] = [];
    if (filters?.year) params.push(`year=${filters.year}`);
    if (filters?.month) params.push(`month=${filters.month}`);
    const query = params.length ? `?${params.join('&')}` : '';
    return this.http.get(`${this.apiUrl}/material-stats${query}`);
  }

  /** Active cases overdue / due within 24h */
  getDeliveryAlerts(): Observable<any> {
    return this.http.get(`${this.apiUrl}/delivery-alerts`);
  }

  /** Doctor portal: read-only حسابات summary for exited billable cases */
  getDoctorAccountSummary(filters?: {
    doctor?: string;
    year?: number;
    month?: number;
  }): Observable<any> {
    const params: string[] = [];
    if (filters?.doctor) params.push(`doctor=${encodeURIComponent(filters.doctor)}`);
    if (filters?.year) params.push(`year=${filters.year}`);
    if (filters?.month) params.push(`month=${filters.month}`);
    const query = params.length ? `?${params.join('&')}` : '';
    return this.http.get(`${this.apiUrl}/doctor-account-summary${query}`);
  }

  /** Doctor portal: live material exit counts for this doctor */
  getDoctorExitedMaterials(filters?: { doctor?: string }): Observable<any> {
    const params: string[] = [];
    if (filters?.doctor) params.push(`doctor=${encodeURIComponent(filters.doctor)}`);
    const query = params.length ? `?${params.join('&')}` : '';
    return this.http.get(`${this.apiUrl}/doctor-exited-materials${query}`);
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

  /** Secretary/admin: convert a name and retag all cases. */
  retagRequester(
    fullName: string,
    requesterType: 'doctor' | 'student' | 'lab',
    caseIds: string[] = []
  ): Observable<any> {
    return this.http.post(`${this.apiUrl}/retag-requester`, { fullName, requesterType, caseIds });
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

  /** Station barcode/QR scan. Station is optional — scanner accounts use their role on the server. */
  scanAtStation(
    caseNumber: string,
    station?: 'reception' | 'design' | 'finishing'
  ): Observable<any> {
    const body: Record<string, string> = { caseNumber };
    if (station) body['station'] = station;
    return this.http.post(`${this.apiUrl}/scan`, body);
  }

  // Upload a case image file (designer/finisher/admin)
  uploadCaseImage(id: string, file: File): Observable<any> {
    const form = new FormData();
    form.append('image', file);
    return this.http.post(`${this.apiUrl}/${id}/upload-image`, form);
  }

  /** رفع مسح ثلاثي الأبعاد أو أرشيف (.ply / .stl / .obj / .rar / .zip) */
  uploadCasePly(id: string, file: File): Observable<any> {
    const form = new FormData();
    form.append('ply', file);
    return this.http.post(`${this.apiUrl}/${id}/upload-ply`, form);
  }

  /** حفظ لينك سكان خارجي بدل رفع ملف */
  setCasePlyLink(id: string, url: string, fileName?: string): Observable<any> {
    return this.http.put(`${this.apiUrl}/${id}/ply-link`, {
      url: String(url || '').trim(),
      fileName: fileName || undefined,
    });
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

  getDoctorPricings(): Observable<any> {
    return this.http.get(`${this.rootApiUrl}/doctor-pricing`);
  }

  updateDoctorPricing(doctorName: string, prices: any): Observable<any> {
    return this.http.put(`${this.rootApiUrl}/doctor-pricing`, { doctorName, prices });
  }

  getDoctorPayments(doctorName?: string): Observable<any> {
    const url = doctorName 
      ? `${this.rootApiUrl}/doctor-payments?doctor=${encodeURIComponent(doctorName)}` 
      : `${this.rootApiUrl}/doctor-payments`;
    return this.http.get(url);
  }

  addDoctorPayment(
    doctorName: string,
    amount: number,
    notes: string = '',
    paymentDate?: string,
    entryType: 'payment' | 'charge' = 'payment'
  ): Observable<any> {
    return this.http.post(`${this.rootApiUrl}/doctor-payments`, {
      doctorName,
      amount,
      notes,
      paymentDate,
      entryType,
    });
  }

  deleteDoctorPayment(id: string): Observable<any> {
    return this.http.delete(`${this.rootApiUrl}/doctor-payments/${id}`);
  }

  /** Bill summary of one case (reception / admin). */
  getCaseBill(caseId: string): Observable<{ success: boolean; data: CaseBill }> {
    return this.http.get<{ success: boolean; data: CaseBill }>(`${this.apiUrl}/${caseId}/bill`);
  }

  /** Record a cash payment linked to a case (marks it paid when covered + prints receipt). */
  collectCasePayment(bill: CaseBill, amount: number, notes: string = ''): Observable<any> {
    return this.http.post(`${this.rootApiUrl}/doctor-payments`, {
      doctorName: bill.doctorName,
      amount,
      notes,
      entryType: 'payment',
      caseId: bill.caseId,
    });
  }
}

export interface CaseBill {
  caseId: string;
  caseNumber: string;
  patientName: string;
  doctorName: string;
  amount: number;
  amountSource: 'frozen' | 'manual' | 'live' | 'none';
  nonBillable: boolean;
  paymentStatus: 'paid' | 'unpaid';
  paidAt: string | null;
  paidTotal: number;
  currentStage: string;
  payments: { id: string; amount: number; entryType: string; paymentDate: string | null; notes: string }[];
}
