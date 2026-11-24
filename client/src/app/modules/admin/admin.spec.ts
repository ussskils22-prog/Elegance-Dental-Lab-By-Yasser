import { ComponentFixture, TestBed } from '@angular/core/testing';
import { commonTestProviders, lenientMock } from '../../testing/test-providers';
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
        ...commonTestProviders(),
        {
          provide: AuthService,
          useValue: lenientMock({
            performLogout: () => {},
            logout: () => of(undefined),
            registerStaff: () => of(undefined),
          }),
        },
        {
          provide: UserApiService,
          useValue: lenientMock({
            getAllUsers: () => of({ success: true, data: [] }),
            updateUser: () => of({ success: true }),
          }),
        },
        {
          provide: CaseApiService,
          useValue: lenientMock({
            getAllCases: () => of({ data: [] }),
            getFinancialReport: () => of({ data: [] }),
          }),
        },
        {
          provide: AdminDashboardService,
          useValue: lenientMock({
            calculateMetrics: () => ({
              totalRevenue: 0,
              staffEfficiency: 0,
            }),
          }),
        },
        {
          provide: SocketService,
          useValue: lenientMock({
            connect: () => {},
            onCaseCreated: () => NEVER,
            onCaseAssigned: () => NEVER,
            onCaseReassigned: () => NEVER,
            onCaseMovedStage: () => NEVER,
            onCaseCompleted: () => NEVER,
            onCaseReleased: () => NEVER,
            onCaseUpdated: () => NEVER,
            onCaseDeleted: () => NEVER,
          }),
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
