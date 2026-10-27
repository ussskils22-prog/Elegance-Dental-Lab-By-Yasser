import { Component, DestroyRef, Input, OnInit, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LabConfigService } from '../../core/services/lab-config.service';

@Component({
  selector: 'app-brand-lockup',
  standalone: true,
  templateUrl: './brand-lockup.html',
  styleUrl: './brand-lockup.css',
})
export class BrandLockupComponent implements OnInit {
  /** bar = navbar. hero = login and marketing pages. */
  @Input() layout: 'bar' | 'hero' = 'bar';
  /** Hide the lab name when the mark stands alone, such as on the login poster. */
  @Input() showLab = true;
  /** Force a light mark on a dark photo. */
  @Input() tone: 'auto' | 'light' = 'auto';

  labName = 'Elegance Dental Lab';

  private readonly labConfig = inject(LabConfigService);
  private readonly destroyRef = inject(DestroyRef);

  ngOnInit(): void {
    this.labName = this.labConfig.branding.labName || this.labName;
    this.labConfig
      .brandingChanges()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((branding) => {
        if (branding?.labName) this.labName = branding.labName;
      });
    this.labConfig.loadPublicBranding().subscribe((branding) => {
      if (branding?.labName) this.labName = branding.labName;
    });
  }
}
