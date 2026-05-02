import { Injectable } from '@angular/core';
import {
  HttpInterceptor,
  HttpRequest,
  HttpHandler,
  HttpEvent,
  HttpErrorResponse,
} from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

/**
 * Clears session on 401 and sends the user to login.
 * Skips unauthenticated endpoints so login and session bootstrap do not loop.
 */
@Injectable()
export class UnauthorizedInterceptor implements HttpInterceptor {
  constructor(
    private auth: AuthService,
    private router: Router
  ) {}

  intercept(req: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    return next.handle(req).pipe(
      catchError((err: HttpErrorResponse) => {
        if (err.status !== 401) {
          return throwError(() => err);
        }
        const url = req.url;
        if (url.includes('/auth/login')) {
          return throwError(() => err);
        }
        this.auth.forceLogoutLocal();
        if (!url.includes('/auth/me')) {
          const returnUrl = this.router.url?.startsWith('/login') ? undefined : this.router.url;
          void this.router.navigate(['/login'], {
            queryParams: returnUrl ? { returnUrl } : undefined,
          });
        }
        return throwError(() => err);
      })
    );
  }
}
