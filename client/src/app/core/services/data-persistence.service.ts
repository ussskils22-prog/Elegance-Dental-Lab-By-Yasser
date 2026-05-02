import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { RealtimeService } from './realtime.service';
import { SystemNotification } from '../models/case.model';

export interface Patient {
  id: string;
  name: string;
  email: string;
  phone: string;
  dateOfBirth?: string;
  address?: string;
  createdAt: Date;
}

export interface Secretary {
  id: string;
  name: string;
  email: string;
  phone: string;
  department: string;
  status: 'active' | 'inactive';
  joinDate: Date;
}

@Injectable({
  providedIn: 'root'
})
export class DataPersistenceService {
  private readonly PATIENTS_KEY = 'dental_system_patients';
  private readonly SECRETARIES_KEY = 'dental_system_secretaries';

  private patients = new BehaviorSubject<Patient[]>(this.loadPatients());
  public patients$ = this.patients.asObservable();

  private secretaries = new BehaviorSubject<Secretary[]>(this.loadSecretaries());
  public secretaries$ = this.secretaries.asObservable();

  constructor(private realtimeService: RealtimeService) {
    this.initializeSampleData();
  }

  // ════════════════════════════════════════════════
  // PATIENT MANAGEMENT
  // ════════════════════════════════════════════════

  getPatients(): Patient[] {
    return this.patients.value;
  }

  getPatientById(id: string): Patient | undefined {
    return this.patients.value.find(p => p.id === id);
  }

  addPatient(patient: Omit<Patient, 'id' | 'createdAt'>): Patient {
    const newPatient: Patient = {
      id: this.generateId(),
      ...patient,
      createdAt: new Date()
    };
    const current = this.patients.value;
    current.push(newPatient);
    this.savePatients(current);
    this.emitPatientNotification(
      'New Patient Added',
      `New patient ${newPatient.name} added by the secretary.`
    );
    return newPatient;
  }

  updatePatient(id: string, updates: Partial<Omit<Patient, 'id' | 'createdAt'>>): Patient | null {
    const current = this.patients.value;
    const index = current.findIndex(p => p.id === id);
    if (index === -1) return null;

    current[index] = { ...current[index], ...updates };
    this.savePatients(current);    this.emitPatientNotification(
      'Patient Updated',
      `Patient ${current[index].name} information was updated.`
    );    return current[index];
  }

  deletePatient(id: string): boolean {
    const current = this.patients.value;
    const filtered = current.filter(p => p.id !== id);
    if (filtered.length === current.length) return false;

    const deletedPatient = current.find(p => p.id === id);
    this.savePatients(filtered);
    if (deletedPatient) {
      this.emitPatientNotification(
        'Patient Removed',
        `Patient ${deletedPatient.name} was removed from the system.`
      );
    }
    return true;
  }

  // ════════════════════════════════════════════════
  // SECRETARY MANAGEMENT
  // ════════════════════════════════════════════════

  getSecretaries(): Secretary[] {
    return this.secretaries.value;
  }

  getSecretaryById(id: string): Secretary | undefined {
    return this.secretaries.value.find(s => s.id === id);
  }

  addSecretary(secretary: Omit<Secretary, 'id' | 'joinDate'>): Secretary {
    const newSecretary: Secretary = {
      id: this.generateId(),
      ...secretary,
      joinDate: new Date()
    };
    const current = this.secretaries.value;
    current.push(newSecretary);
    this.saveSecretaries(current);
    return newSecretary;
  }

  updateSecretary(id: string, updates: Partial<Omit<Secretary, 'id' | 'joinDate'>>): Secretary | null {
    const current = this.secretaries.value;
    const index = current.findIndex(s => s.id === id);
    if (index === -1) return null;

    current[index] = { ...current[index], ...updates };
    this.saveSecretaries(current);
    return current[index];
  }

  deleteSecretary(id: string): boolean {
    const current = this.secretaries.value;
    const filtered = current.filter(s => s.id !== id);
    if (filtered.length === current.length) return false;

    this.saveSecretaries(filtered);
    return true;
  }

  // ════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ════════════════════════════════════════════════

  private loadPatients(): Patient[] {
    return [];
  }

  private savePatients(patients: Patient[]) {
    this.patients.next(patients);
  }

  private loadSecretaries(): Secretary[] {
    return [];
  }

  private saveSecretaries(secretaries: Secretary[]) {
    this.secretaries.next(secretaries);
  }

  private initializeSampleData() {
    // Only initialize if no data exists
    if (this.patients.value.length === 0) {
      const samplePatients: Patient[] = [
        {
          id: 'pat-1',
          name: 'أحمد محمود',
          email: 'ahmad@example.com',
          phone: '+966501234567',
          dateOfBirth: '1985-03-15',
          address: 'الرياض، شارع الملك فهد',
          createdAt: new Date('2026-03-01')
        },
        {
          id: 'pat-2',
          name: 'فاطمة علي',
          email: 'fatima@example.com',
          phone: '+966502345678',
          dateOfBirth: '1990-07-22',
          address: 'جدة، شارع المعبدة',
          createdAt: new Date('2026-02-15')
        },
        {
          id: 'pat-3',
          name: 'محمد سالم',
          email: 'salem@example.com',
          phone: '+966503456789',
          dateOfBirth: '1988-11-08',
          address: 'الدمام، شارع الأمير سعود',
          createdAt: new Date('2026-01-20')
        }
      ];
      this.savePatients(samplePatients);
    }

    if (this.secretaries.value.length === 0) {
      const sampleSecretaries: Secretary[] = [
        {
          id: 'sec-1',
          name: 'نور الهاشمي',
          email: 'noor@dentalsystem.com',
          phone: '+966501111111',
          department: 'إدارة المرضى',
          status: 'active',
          joinDate: new Date('2025-01-10')
        },
        {
          id: 'sec-2',
          name: 'ليلى محمد',
          email: 'layla@dentalsystem.com',
          phone: '+966502222222',
          department: 'الاستقبال',
          status: 'active',
          joinDate: new Date('2025-06-15')
        }
      ];
      this.saveSecretaries(sampleSecretaries);
    }
  }

  private generateId(): string {
    return `id-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private emitPatientNotification(title: string, message: string) {
    const notification: SystemNotification = {
      id: this.generateId(),
      type: 'patient_update',
      title,
      message,
      timestamp: new Date(),
      read: false,
      targetAudience: 'admin'
    };
    this.realtimeService.emitNotification(notification);
  }

  // Clear all data (for testing)
  clearAllData() {
    this.patients.next([]);
    this.secretaries.next([]);
  }
}
