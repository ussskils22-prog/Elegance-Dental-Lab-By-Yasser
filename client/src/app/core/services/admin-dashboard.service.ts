import { Injectable } from '@angular/core';

export interface AdminDashboardMetrics {
  totalPatients: number;
  pendingCases: number;
  totalRevenue: number;
  staffEfficiency: number;
}

interface DashboardCaseInput {
  currentStage: string;
  salary: number;
}

interface DashboardStaffInput {
  status: 'active' | 'inactive';
}

@Injectable({
  providedIn: 'root'
})
export class AdminDashboardService {
  calculateMetrics(totalPatients: number, cases: DashboardCaseInput[], staffMembers: DashboardStaffInput[]): AdminDashboardMetrics {
    const safePatients = Number.isFinite(totalPatients) ? Math.max(0, totalPatients) : 0;
    const safeCases = Array.isArray(cases) ? cases : [];
    const safeStaff = Array.isArray(staffMembers) ? staffMembers : [];

    const pendingCases = safeCases.filter(c => c.currentStage !== 'completed').length;
    const totalRevenue = safeCases
      .filter(c => c.currentStage === 'completed')
      .reduce((sum, c) => sum + (Number.isFinite(c.salary) ? c.salary : 0), 0);

    const activeStaffCount = safeStaff.filter(staff => staff.status === 'active').length;
    const staffEfficiency = activeStaffCount > 0
      ? Math.min(100, Number(((safeCases.length / activeStaffCount) * 10).toFixed(1)))
      : 0;

    return {
      totalPatients: safePatients,
      pendingCases,
      totalRevenue,
      staffEfficiency
    };
  }
}
