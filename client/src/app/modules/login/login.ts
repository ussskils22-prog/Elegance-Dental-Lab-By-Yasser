import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class Login {
  email = '';
  password = '';
  showPassword = false;
  loginError = '';
  submitting = false;
  public themeService = inject(ThemeService);

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private auth: AuthService
  ) {}

  togglePassword(): void {
    this.showPassword = !this.showPassword;
  }

  login(): void {
    const email = this.email.trim();
    if (!email || !this.password) {
      this.loginError = 'يرجى إدخال البريد الإلكتروني وكلمة المرور';
      return;
    }
    this.loginError = '';
    this.submitting = true;
    this.auth.login(email, this.password).subscribe({
      next: () => {
        this.submitting = false;
        const returnUrl = this.safeReturnUrl(this.route.snapshot.queryParamMap.get('returnUrl'));
        if (returnUrl) {
          void this.router.navigateByUrl(returnUrl);
          return;
        }
        const session = this.auth.getSession();
        if (session) {
          void this.router.navigateByUrl(this.auth.homePathForRole(session.role));
        }
      },
      error: (err: unknown) => {
        this.submitting = false;
        this.loginError = this.formatLoginError(err);
      },
    });
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
        return 'البريد الإلكتروني أو كلمة المرور غير صحيحة';
      }
    }
    return 'تعذر تسجيل الدخول. حاول مرة أخرى.';
  }

  private safeReturnUrl(raw: string | null): string | null {
    if (!raw || !raw.startsWith('/') || raw.startsWith('//')) {
      return null;
    }
    return raw;
  }
}
