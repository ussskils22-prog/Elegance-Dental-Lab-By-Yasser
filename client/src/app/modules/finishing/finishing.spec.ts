import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';

import { Finishing } from './finishing';

describe('Finishing', () => {
  let component: Finishing;
  let fixture: ComponentFixture<Finishing>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Finishing],
      providers: [provideHttpClient()],
    })
    .compileComponents();

    fixture = TestBed.createComponent(Finishing);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
