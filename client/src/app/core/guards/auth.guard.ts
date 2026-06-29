import { inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { CanActivateFn, Router } from '@angular/router';
import { filter, map, take } from 'rxjs';
import { AuthService } from '../services/auth.service';

/** Blocks unauthenticated users; sends them to `/login` with optional return URL. Waits for auth bootstrap first. */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return toObservable(auth.bootstrapComplete).pipe(
    filter(Boolean),
    take(1),
    map(() => {
      if (auth.isAuthenticatedValue()) {
        // Save current URL in sessionStorage so refresh restores it
        auth.saveLastUrl(state.url);
        return true;
      }
      return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
    })
  );
};

/** On `/login`, if already signed in, go to that user's home dashboard. */
export const guestGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return toObservable(auth.bootstrapComplete).pipe(
    filter(Boolean),
    take(1),
    map(() => {
      if (!auth.isAuthenticatedValue()) {
        return true;
      }
      const session = auth.getSession();
      if (!session) {
        return true;
      }
      return router.createUrlTree([auth.homePathForRole(session.role)]);
    })
  );
};
