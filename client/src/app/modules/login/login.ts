import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';
import { LanguageService } from '../../core/i18n/language.service';
import { TPipe } from '../../core/i18n/t.pipe';
import { PwaInstallService } from '../../core/services/pwa-install.service';
import { LabConfigService, LabBranding } from '../../core/services/lab-config.service';
import { AppOverflowMenuComponent } from '../../shared/app-overflow-menu/app-overflow-menu';
import { BrandLockupComponent } from '../../shared/brand-lockup/brand-lockup';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, AppOverflowMenuComponent, BrandLockupComponent, TPipe],
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class Login implements OnInit {
  email = '';
  password = '';
  pin = '';
  showPassword = false;
  rememberEmail = true;
  /** When true and email has PIN, show PIN field instead of password */
  usePinLogin = false;
  emailHasPin = false;
  loginError = '';
  submitting = false;
  public themeService = inject(ThemeService);
  public readonly lang = inject(LanguageService);
  public readonly pwa = inject(PwaInstallService);
  private readonly labConfig = inject(LabConfigService);
  branding: LabBranding = {
    labName: 'Elegance Dental Lab',
    logoUrl: '',
    primaryColor: '#2563eb',
  };

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private auth: AuthService
  ) {}

  ngOnInit(): void {
    this.labConfig.loadPublicBranding().subscribe((b) => {
      this.branding = b;
    });
    const remembered = this.pwa.getRememberedEmail();
    if (remembered) {
      this.email = remembered;
      this.rememberEmail = true;
      this.refreshPinStatus();
    }
  }

  onEmailBlur(): void {
    this.refreshPinStatus();
  }

  refreshPinStatus(): void {
    const email = this.email.trim();
    if (!email.includes('@')) {
      this.emailHasPin = false;
      this.usePinLogin = false;
      return;
    }
    this.auth.checkPinStatus(email).subscribe((hasPin) => {
      this.emailHasPin = hasPin;
      this.usePinLogin = hasPin;
    });
  }

  switchToPassword(): void {
    this.usePinLogin = false;
    this.pin = '';
    this.loginError = '';
  }

  switchToPin(): void {
    if (!this.emailHasPin) return;
    this.usePinLogin = true;
    this.password = '';
    this.loginError = '';
  }

  togglePassword(): void {
    this.showPassword = !this.showPassword;
  }

  login(): void {
    const email = this.email.trim();
    if (!email) {
      this.loginError = this.lang.t('login.err.email');
      return;
    }

    if (this.usePinLogin) {
      const pin = this.pin.trim();
      if (!/^\d{4,6}$/.test(pin)) {
        this.loginError = this.lang.t('login.err.pin');
        return;
      }
      this.loginError = '';
      this.submitting = true;
      this.auth.loginWithPin(email, pin).subscribe({
        next: () => this.afterLoginSuccess(email),
        error: (err: unknown) => {
          this.submitting = false;
          this.loginError = this.formatLoginError(err);
        },
      });
      return;
    }

    if (!this.password) {
      this.loginError = this.lang.t('login.err.emailPassword');
      return;
    }
    this.loginError = '';
    this.submitting = true;
    this.auth.login(email, this.password).subscribe({
      next: () => this.afterLoginSuccess(email),
      error: (err: unknown) => {
        this.submitting = false;
        this.loginError = this.formatLoginError(err);
      },
    });
  }

  private afterLoginSuccess(email: string): void {
    this.submitting = false;
    if (this.rememberEmail) this.pwa.setRememberedEmail(email);
    else this.pwa.setRememberedEmail(null);

    const returnUrl = this.safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'));
    if (returnUrl) {
      void this.router.navigateByUrl(returnUrl);
      return;
    }
    const session = this.auth.getSession();
    if (session) {
      void this.router.navigateByUrl(this.auth.homePathForRole(session.role));
    }
  }

  async installApp(): Promise<void> {
    await this.pwa.installApp();
  }

  private formatLoginError(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      if (err.error?.message && typeof err.error.message === 'string') {
        return err.error.message;
      }
      if (Array.isArray(err.error?.errors) && err.error.errors[0]?.msg) {
        return err.error.errors[0].msg;
      }
      if (err.status === 401) {
        return this.usePinLogin
          ? this.lang.t('login.err.badPin')
          : this.lang.t('login.err.badCreds');
      }
    }
    return this.lang.t('login.err.generic');
  }

  private safeReturnUrl(raw: string | null): string | null {
    if (!raw || !raw.startsWith('/') || raw.startsWith('//')) {
      return null;
    }
    return raw;
  }
}
