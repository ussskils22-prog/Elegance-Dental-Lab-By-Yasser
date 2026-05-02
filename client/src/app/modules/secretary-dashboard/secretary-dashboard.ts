import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CaseManagementService } from '../../core/services/case-management.service';
import { DataPersistenceService, Patient } from '../../core/services/data-persistence.service';
import { DentalCase } from '../../core/models/case.model';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

@Component({
  selector: 'app-secretary-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './secretary-dashboard.html',
  styleUrl: './secretary-dashboard.css'
})
export class SecretaryDashboardComponent implements OnInit, OnDestroy {
  // Data
  patients: Patient[] = [];
  cases: DentalCase[] = [];
  waitingCases: DentalCase[] = [];

  // UI State
  selectedPatient: Patient | null = null;
  showNewCaseForm = false;
  showAddPatientForm = false;
  globalSearch = '';

  // Form data
  newCaseForm = {
    patientId: '',
    caseType: '',
    priority: 'normal' as 'low' | 'normal' | 'high' | 'urgent',
    notes: ''
  };

  newPatientForm = {
    name: '',
    email: '',
    phone: '',
    dateOfBirth: '',
    address: ''
  };

  caseTypes = ['Implant', 'Crown', 'Bridge', 'Veneer', 'Cleaning', 'Root Canal'];
  priorities = ['low', 'normal', 'high', 'urgent'];

  currentUser = { id: 'sec-1', name: 'Secretary Assistant', role: 'secretary' };

  private destroy$ = new Subject<void>();

  constructor(
    private caseService: CaseManagementService,
    private dataPersistence: DataPersistenceService
  ) {}

  ngOnInit() {
    // Load patients
    this.loadPatients();

    // Subscribe to cases
    this.caseService.allCases$.pipe(takeUntil(this.destroy$)).subscribe(cases => {
      this.cases = cases;
      this.updateWaitingCases();
    });

    // Subscribe to patient updates
    this.dataPersistence.patients$.pipe(takeUntil(this.destroy$)).subscribe(patients => {
      this.patients = patients;
    });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ════════════════════════════════════════════════
  // PATIENT MANAGEMENT
  // ════════════════════════════════════════════════

  loadPatients() {
    this.patients = this.dataPersistence.getPatients();
  }

  getFilteredPatients(): Patient[] {
    if (!this.globalSearch.trim()) return this.patients;
    const searchLower = this.globalSearch.toLowerCase();
    return this.patients.filter(p =>
      p.name.toLowerCase().includes(searchLower) ||
      p.email.toLowerCase().includes(searchLower) ||
      p.phone.includes(searchLower)
    );
  }

  selectPatient(patient: Patient) {
    this.selectedPatient = patient;
    this.newCaseForm.patientId = patient.id;
  }

  openAddPatientForm() {
    this.showAddPatientForm = true;
  }

  closeAddPatientForm() {
    this.showAddPatientForm = false;
    this.newPatientForm = {
      name: '',
      email: '',
      phone: '',
      dateOfBirth: '',
      address: ''
    };
  }

  addNewPatient() {
    if (!this.newPatientForm.name || !this.newPatientForm.email || !this.newPatientForm.phone) {
      alert('Please fill in all required fields');
      return;
    }

    const patient = this.dataPersistence.addPatient({
      name: this.newPatientForm.name,
      email: this.newPatientForm.email,
      phone: this.newPatientForm.phone,
      dateOfBirth: this.newPatientForm.dateOfBirth,
      address: this.newPatientForm.address
    });

    alert(`Patient "${patient.name}" added successfully!`);
    this.closeAddPatientForm();
    this.loadPatients();
  }

  // ════════════════════════════════════════════════
  // CASE MANAGEMENT
  // ════════════════════════════════════════════════

  openNewCaseForm() {
    if (!this.selectedPatient) {
      alert('Please select a patient first');
      return;
    }
    this.showNewCaseForm = true;
  }

  closeNewCaseForm() {
    this.showNewCaseForm = false;
    this.newCaseForm = {
      patientId: '',
      caseType: '',
      priority: 'normal',
      notes: ''
    };
    this.selectedPatient = null;
  }

  createCase() {
    if (!this.newCaseForm.patientId || !this.newCaseForm.caseType) {
      alert('Please select patient and case type');
      return;
    }

    const patient = this.dataPersistence.getPatientById(this.newCaseForm.patientId);
    if (!patient) {
      alert('Patient not found');
      return;
    }

    const newCase = this.caseService.createCase(
      patient.name,
      patient.email,
      patient.phone,
      this.newCaseForm.caseType,
      this.newCaseForm.priority,
      this.newCaseForm.notes,
      this.currentUser.id,
      this.currentUser.name
    );

    alert(`Case #${newCase.caseNumber} created successfully for ${patient.name}!`);
    this.closeNewCaseForm();
  }

  private updateWaitingCases() {
    this.waitingCases = this.cases.filter(c => c.currentStage === 'waiting');
  }

  getCaseCount(): number {
    return this.waitingCases.length;
  }

  getCasesForPatient(patientId: string): DentalCase[] {
    return this.cases.filter(c => c.patientName === this.selectedPatient?.name);
  }
}
