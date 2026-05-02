import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
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
        provideHttpClient(),
        {
          provide: CaseApiService,
          useValue: {
            getAllCases: () => of({ success: true, data: [] }),
            createCase: () => of({ success: true }),
            updateCase: () => of({ success: true }),
            deleteCase: () => of({ success: true }),
          },
        },
        {
          provide: AuthService,
          useValue: { performLogout: () => {} },
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
