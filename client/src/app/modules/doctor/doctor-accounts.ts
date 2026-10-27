import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { CaseApiService } from '../../core/services/case-api.service';
import { ThemeService } from '../../core/services/theme.service';
import { LanguageService } from '../../core/i18n/language.service';
import { TPipe } from '../../core/i18n/t.pipe';
import { AppOverflowMenuComponent } from '../../shared/app-overflow-menu/app-overflow-menu';
import { BrandLockupComponent } from '../../shared/brand-lockup/brand-lockup';

export type DoctorAccountCaseRow = {
  id: string;
  caseNumber: string;
  patientName: string;
  caseType: string;
  amount: number;
  quantity?: number;
  unitPrice?: number;
  lines?: Array<{
    label: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }>;
  paymentStatus: 'paid' | 'unpaid';
  plyScanUrl?: string | null;
  plyFileName?: string | null;
};

export type DoctorLedgerRow = {
  id: string;
  amount: number;
  entryType: 'payment' | 'charge';
  paymentDate: string | null;
  notes: string;
  linkedToCase: boolean;
};

export type DoctorAccountSummary = {
  doctorName: string;
  totalDue: number;
  totalPaid: number;
  remaining: number;
  caseCount: number;
  cases: DoctorAccountCaseRow[];
  ledger?: DoctorLedgerRow[];
};

@Component({
  selector: 'app-doctor-accounts',
  standalone: true,
  imports: [CommonModule, AppOverflowMenuComponent, BrandLockupComponent, TPipe],
  templateUrl: './doctor-accounts.html',
  styleUrls: ['./doctor-accounts.css'],
})
export class DoctorAccountsComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly caseApi = inject(CaseApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  readonly themeService = inject(ThemeService);
  readonly lang = inject(LanguageService);

  readonly viewingAsDoctor = signal<string | null>(null);
  readonly isAdminView = computed(() => {
    const role = this.auth.getSession()?.role;
    return role === 'admin' && !!this.viewingAsDoctor();
  });
  readonly doctorName = computed(() => {
    const as = this.viewingAsDoctor()?.trim();
    if (as && this.auth.getSession()?.role === 'admin') return as;
    return this.auth.getSession()?.name?.trim() || '—';
  });

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly summary = signal<DoctorAccountSummary | null>(null);

  pageTitle(): string {
    return this.lang.t('doctorPages.accounts.title').replace('{name}', this.doctorName());
  }

  billableMeta(n: number): string {
    return this.lang.t('doctorPages.accounts.billableMeta').replace('{n}', String(n));
  }

  ngOnInit(): void {
    const as = (this.route.snapshot.queryParamMap.get('as') || '').trim();
    const role = this.auth.getSession()?.role;
    this.viewingAsDoctor.set(role === 'admin' && as ? as : null);
    this.loadSummary();
  }

  backToDashboard(): void {
    const as = this.viewingAsDoctor()?.trim();
    this.router.navigate(['/doctor/dashboard'], {
      queryParams: as && this.auth.getSession()?.role === 'admin' ? { as } : {},
    });
  }

  formatMoney(value: number | null | undefined): string {
    const n = Number(value);
    const safe = Number.isFinite(n) ? n : 0;
    return `${safe.toLocaleString('en-EG')} EGP`;
  }

  private loadSummary(): void {
    this.loading.set(true);
    this.error.set(null);
    const filters: { doctor?: string } = {};
    if (this.isAdminView()) {
      const as = this.viewingAsDoctor()?.trim();
      if (as) filters.doctor = as;
    }
    this.caseApi.getDoctorAccountSummary(filters).subscribe({
      next: (res) => {
        this.summary.set((res?.data as DoctorAccountSummary) ?? null);
        this.loading.set(false);
      },
      error: (err) => {
        this.summary.set(null);
        this.loading.set(false);
        this.error.set(err?.error?.message || this.lang.t('doctorPages.accounts.loadError'));
      },
    });
  }
}
