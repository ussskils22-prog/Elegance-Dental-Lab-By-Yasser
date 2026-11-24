import { ComponentFixture, TestBed } from '@angular/core/testing';
import { commonTestProviders, lenientMock } from '../../testing/test-providers';
import { of } from 'rxjs';

import { Secretary } from './secretary';
import { CaseApiService } from '../../core/services/case-api.service';
import { AuthService } from '../../core/services/auth.service';

describe('Secretary', () => {
  let component: Secretary;
  let fixture: ComponentFixture<Secretary>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Secretary],
      providers: [
        ...commonTestProviders(),
        {
          provide: CaseApiService,
          useValue: lenientMock({
            getAllCases: () => of({ success: true, data: [] }),
            createCase: () => of({ success: true }),
            updateCase: () => of({ success: true }),
            deleteCase: () => of({ success: true }),
            getDeliveryAlerts: () => of({ success: true, data: { overdue: [] } }),
            getOperationsReport: () => of({ success: true, data: null }),
            checkDoctorName: () => of({ action: 'ok', similar: [] }),
          }),
        },
        {
          provide: AuthService,
          useValue: lenientMock({ performLogout: () => {}, getToken: () => null }),
        },
      ],
    })
    .compileComponents();

    fixture = TestBed.createComponent(Secretary);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
