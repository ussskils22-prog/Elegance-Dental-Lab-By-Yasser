import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { NEVER, of } from 'rxjs';

import { Admin } from './admin';
import { AuthService } from '../../core/services/auth.service';
import { UserApiService } from '../../core/services/user-api.service';
import { CaseApiService } from '../../core/services/case-api.service';
import { AdminDashboardService } from '../../core/services/admin-dashboard.service';
import { SocketService } from '../../core/services/socket.service';

describe('Admin', () => {
  let component: Admin;
  let fixture: ComponentFixture<Admin>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Admin],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        {
          provide: AuthService,
          useValue: {
            performLogout: () => {},
            logout: () => of(undefined),
            registerStaff: () => of(undefined),
          },
        },
        {
          provide: UserApiService,
          useValue: {
            getAllUsers: () => of({ success: true, data: [] }),
            updateUser: () => of({ success: true }),
          },
        },
        {
          provide: CaseApiService,
          useValue: {
            getAllCases: () => of({ data: [] }),
            getFinancialReport: () => of({ data: [] }),
          },
        },
        {
          provide: AdminDashboardService,
          useValue: {
            calculateMetrics: () => ({
              totalRevenue: 0,
              staffEfficiency: 0,
            }),
          },
        },
        {
          provide: SocketService,
          useValue: {
            connect: () => {},
            onCaseCreated: () => NEVER,
            onCaseAssigned: () => NEVER,
            onCaseReassigned: () => NEVER,
            onCaseMovedStage: () => NEVER,
            onCaseCompleted: () => NEVER,
            onCaseReleased: () => NEVER,
            onCaseUpdated: () => NEVER,
            onCaseDeleted: () => NEVER,
          },
        },
      ],
    })
    .compileComponents();

    fixture = TestBed.createComponent(Admin);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
