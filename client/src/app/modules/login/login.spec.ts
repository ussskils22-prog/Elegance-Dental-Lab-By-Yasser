import { ComponentFixture, TestBed } from '@angular/core/testing';
import { commonTestProviders } from '../../testing/test-providers';
import { signal } from '@angular/core';
import { of } from 'rxjs';

import { Login } from './login';
import { AuthService } from '../../core/services/auth.service';

describe('Login', () => {
  let component: Login;
  let fixture: ComponentFixture<Login>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Login],
      providers: [
        ...commonTestProviders(),
        {
          provide: AuthService,
          useValue: {
            login: () => of(undefined),
            getSession: () => ({ id: '1', name: 'Test', email: 'a@b.com', role: 'admin', loginAt: '' }),
            homePathForRole: () => '/admin/dashboard',
            bootstrapComplete: signal(true),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Login);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
