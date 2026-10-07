import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { apiBaseUrl, isDemoFrontendHost } from '../api/api.config';

@Injectable({ providedIn: 'root' })
export class DemoModeService {
  private readonly http = inject(HttpClient);

  /** True when backend reports DEMO_MODE (or demo frontend host as fallback). */
  readonly demoMode = signal(isDemoFrontendHost());

  constructor() {
    this.refresh();
  }

  refresh(): void {
    const url = `${apiBaseUrl().replace(/\/+$/, '')}/health`;
    this.http.get<{ demoMode?: boolean }>(url).subscribe({
      next: (res) => {
        if (typeof res?.demoMode === 'boolean') {
          this.demoMode.set(res.demoMode);
        } else if (isDemoFrontendHost()) {
          this.demoMode.set(true);
        }
      },
      error: () => {
        if (isDemoFrontendHost()) this.demoMode.set(true);
      },
    });
  }
}
