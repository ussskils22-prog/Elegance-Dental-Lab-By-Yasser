import { ComponentFixture, TestBed } from '@angular/core/testing';
import { commonTestProviders } from '../../testing/test-providers';

import { Finishing } from './finishing';

describe('Finishing', () => {
  let component: Finishing;
  let fixture: ComponentFixture<Finishing>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Finishing],
      providers: [...commonTestProviders()],
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
