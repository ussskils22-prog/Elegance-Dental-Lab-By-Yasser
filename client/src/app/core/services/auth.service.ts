import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { BehaviorSubject, Observable, catchError, finalize, map, of, tap, throwError } from 'rxjs';
import { AppRole, AuthSession } from '../auth/auth.types';
import { apiBaseUrl } from '../api/api.config';

const AUTH_SESSION_KEY = 'dental_system_auth_session';
const AUTH_TOKEN_KEY = 'dental_system_auth_token';
const AUTH_LAST_URL_KEY = 'dental_system_last_url';

interface AuthUserDto {
  id: string;
  fullName: string;
  email: string;
  role: string;
}

/** Body for `POST /api/auth/register` (admin creates staff). */
export interface RegisterStaffPayload {
  fullName: string;
  email: string;
  phone: string;
  password: string;
  role: AppRole;
  department?: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly apiUrl = `${apiBaseUrl()}/auth`;

  private readonly isAuthenticated$ = new BehaviorSubject<boolean>(false);
  private readonly currentUser$ = new BehaviorSubject<AuthSession | null>(null);

  /** True after `bootstrapSession()` finishes (success or failure). Used to avoid flashing `/login` before `/me`. */
  readonly bootstrapComplete = signal(false);

  // In-memory storage for token and session
  private storedToken: string | null = null;
  private storedSession: AuthSession | null = null;

  constructor(private http: HttpClient) {
    this.hydrateFromStorage();
    if (!this.getToken()) {
      this.clearSession();
    }
  }

  // ════════════════════════════════════════════════
  // SESSION BOOTSTRAP (APP_INITIALIZER)
  // ════════════════════════════════════════════════

  /**
   * Validates stored JWT via `GET /auth/me` and rebuilds session; clears storage on failure.
   */
  bootstrapSession(): Observable<void> {
    const token = this.getToken();
    if (!token) {
      this.isAuthenticated$.next(false);
      this.currentUser$.next(null);
      return of(undefined).pipe(
        map(() => void 0),
        finalize(() => this.bootstrapComplete.set(true))
      );
    }

    return this.http.get<{ success?: boolean; user?: AuthUserDto }>(`${this.apiUrl}/me`).pipe(
      tap((res) => {
        if (res?.success && res.user) {
          const session = this.userToSession(res.user);
          this.setSession(session);
          this.isAuthenticated$.next(true);
          this.currentUser$.next(session);
        } else {
          this.forceLogoutLocal();
        }
      }),
      catchError(() => {
        this.forceLogoutLocal();
        return of(undefined);
      }),
      map(() => void 0),
      finalize(() => this.bootstrapComplete.set(true))
    );
  }

  // ════════════════════════════════════════════════
  // LOGIN & LOGOUT
  // ════════════════════════════════════════════════

  login(email: string, password: string): Observable<void> {
    return this.http
      .post<{ success?: boolean; token?: string; user?: AuthUserDto }>(`${this.apiUrl}/login`, {
        email,
        password,
      })
      .pipe(
        tap((response) => {
          if (response?.success && response.token && response.user) {
            this.setToken(response.token);
            const session = this.userToSession(response.user);
            this.setSession(session);
            this.isAuthenticated$.next(true);
            this.currentUser$.next(session);
            return;
          }
          throw new Error('Invalid response from server');
        }),
        map(() => void 0),
        catchError((error) => {
          console.error('Login error:', error);
          return throwError(() => error);
        })
      );
  }

  logout(): Observable<void> {
    const token = this.getToken();
    if (!token) {
      this.forceLogoutLocal();
      return of(undefined);
    }
    return this.http.post<{ success?: boolean }>(`${this.apiUrl}/logout`, {}).pipe(
      catchError(() => of(null)),
      tap(() => this.forceLogoutLocal()),
      map(() => void 0)
    );
  }

  /** Calls the logout API (or clears locally), then navigates to `/login`. */
  performLogout(router: Router): void {
    this.logout().subscribe({
      complete: () => void router.navigateByUrl('/login'),
    });
  }

  /** POST /auth/register — admin only; persists user in MongoDB. */
  registerStaff(payload: RegisterStaffPayload): Observable<void> {
    return this.http
      .post<{ success?: boolean; message?: string }>(`${this.apiUrl}/register`, payload)
      .pipe(
        tap((res) => {
          if (res && res.success === false) {
            throw new Error(res.message || 'Registration failed');
          }
        }),
        map(() => void 0),
        catchError((err) => throwError(() => err))
      );
  }

  /** Clears token and session without calling the API (e.g. after 401). */
  forceLogoutLocal(): void {
    this.clearSession();
    this.clearToken();
    this.isAuthenticated$.next(false);
    this.currentUser$.next(null);
  }

  // ════════════════════════════════════════════════
  // TOKEN MANAGEMENT
  // ════════════════════════════════════════════════

  getToken(): string | null {
    return this.storedToken;
  }

  private setToken(token: string): void {
    this.storedToken = token;
    try {
      localStorage.setItem(AUTH_TOKEN_KEY, token);
    } catch (error) {
      console.warn('Failed to persist auth token:', error);
    }
  }

  private clearToken(): void {
    this.storedToken = null;
    try {
      localStorage.removeItem(AUTH_TOKEN_KEY);
    } catch (error) {
      console.warn('Failed to clear auth token:', error);
    }
  }

  // ════════════════════════════════════════════════
  // SESSION MANAGEMENT
  // ════════════════════════════════════════════════

  getSession(): AuthSession | null {
    return this.storedSession;
  }

  setSession(session: AuthSession): void {
    this.storedSession = session;
    try {
      // Use sessionStorage so each browser tab has its own independent session
      sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
    } catch (error) {
      console.warn('Failed to persist auth session:', error);
    }
  }

  /** Save the current URL so we can restore it after a page refresh. */
  saveLastUrl(url: string): void {
    try {
      if (url && url !== '/login' && url !== '/') {
        sessionStorage.setItem(AUTH_LAST_URL_KEY, url);
      }
    } catch { /* ignore */ }
  }

  /** Pop the last saved URL (returns null if none). */
  popLastUrl(): string | null {
    try {
      const url = sessionStorage.getItem(AUTH_LAST_URL_KEY);
      return url || null;
    } catch { return null; }
  }

  clearSession(): void {
    this.storedSession = null;
    try {
      sessionStorage.removeItem(AUTH_SESSION_KEY);
      sessionStorage.removeItem(AUTH_LAST_URL_KEY);
    } catch (error) {
      console.warn('Failed to clear auth session:', error);
    }
  }

  // ════════════════════════════════════════════════
  // AUTHENTICATION STATE
  // ════════════════════════════════════════════════

  isAuthenticated(): Observable<boolean> {
    return this.isAuthenticated$.asObservable();
  }

  isAuthenticatedValue(): boolean {
    return this.isAuthenticated$.value;
  }

  getCurrentUser(): Observable<AuthSession | null> {
    return this.currentUser$.asObservable();
  }

  getRole(): AppRole | null {
    return this.getSession()?.role ?? null;
  }

  homePathForRole(role: AppRole): string {
    switch (role) {
      case 'designer':
        return '/designer/dashboard';
      case 'finisher':
        return '/finisher/dashboard';
      case 'secretary':
        return '/secretary/dashboard';
      default:
        return '/admin/dashboard';
    }
  }

  private userToSession(user: AuthUserDto): AuthSession {
    return {
      id: String(user.id),
      name: user.fullName,
      email: user.email,
      role: this.normalizeRole(user.role),
      loginAt: new Date().toISOString(),
    };
  }

  private normalizeRole(value: string | undefined): AppRole {
    const v = (value || '').trim().toLowerCase();
    if (v === 'finishing') return 'finisher';
    if (v === 'admin' || v === 'secretary' || v === 'designer' || v === 'finisher') {
      return v;
    }
    return 'admin';
  }

  private hydrateFromStorage(): void {
    try {
      const token = localStorage.getItem(AUTH_TOKEN_KEY);
      this.storedToken = token && token.trim() ? token : null;
    } catch (error) {
      this.storedToken = null;
      console.warn('Failed to read auth token from storage:', error);
    }

    try {
      // Read session from sessionStorage (per-tab) so each tab is independent
      const rawSession = sessionStorage.getItem(AUTH_SESSION_KEY);
      if (!rawSession) {
        this.storedSession = null;
        return;
      }
      this.storedSession = JSON.parse(rawSession) as AuthSession;
    } catch (error) {
      this.storedSession = null;
      console.warn('Failed to read auth session from storage:', error);
      try {
        sessionStorage.removeItem(AUTH_SESSION_KEY);
      } catch {
        // Ignore storage cleanup failures
      }
    }
  }
}
