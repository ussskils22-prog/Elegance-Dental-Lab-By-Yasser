export type CaseStage = 'waiting' | 'secretary' | 'design' | 'khart' | 'finishing' | 'completed';
export type CaseStatus = 'waiting' | 'in_progress' | 'completed' | 'exited';

export interface DentalCase {
  id: string;
  caseNumber: string;
  patientName: string;
  patientEmail: string;
  patientPhone: string;
  requesterType?: 'doctor' | 'student';
  notes: string;

  // Workflow
  currentStage: CaseStage;
  status: CaseStatus;

  // Assignment
  assignedTo: string | null;
  assignedAt: Date | null;
  createdBy: string;
  createdAt: Date;

  // Additional info
  caseType: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  dueDate: Date;

  // Timestamps for each stage
  stageTimestamps: {
    secretary?: Date;
    design?: Date;
    khart?: Date;
    finishing?: Date;
    completed?: Date;
  };
}

export interface User {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  role: 'admin' | 'secretary' | 'designer' | 'finisher';
  status: 'online' | 'offline' | 'idle';
  lastSeen: Date;
  department: string;
}

export interface AuditLog {
  id: string;
  caseId: string;
  caseNumber: string;
  action:
    | 'created'
    | 'assigned'
    | 'reassigned'
    | 'moved_stage'
    | 'completed'
    | 'reopened'
    | 'released'
    | 'exited';
  performedBy: string;
  performedByName: string;
  timestamp: Date;
  details: {
    oldValue?: any;
    newValue?: any;
    notes?: string;
  };
}

export interface SystemNotification {
  id: string;
  type:
    | 'case_created'
    | 'case_assigned'
    | 'case_reassigned'
    | 'case_moved'
    | 'case_completed'
    | 'case_released'
    | 'case_exited'
    | 'patient_update'
    | 'patient_removed';
  title: string;
  message: string;
  caseId?: string;
  caseNumber?: string;
  relatedUser?: string;
  timestamp: Date;
  read: boolean;
  targetAudience: 'admin' | 'all' | string[]; // admin, specific role, or specific users
}

