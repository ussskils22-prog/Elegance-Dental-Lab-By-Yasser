import { inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { CanActivateFn, Router } from '@angular/router';
import { filter, map, take } from 'rxjs';
import { AppRole } from '../auth/auth.types';
import { AuthService } from '../services/auth.service';

/**
 * Restricts a route to users whose session role is in `allowedRoles`.
 * If the user is signed in but not allowed → redirect to their own home (not login).
 */
export function roleGuard(allowedRoles: AppRole[]): CanActivateFn {
  return () => {
    const auth = inject(AuthService);
    const router = inject(Router);
    return toObservable(auth.bootstrapComplete).pipe(
      filter(Boolean),
      take(1),
      map(() => {
        const session = auth.getSession();
        if (!session) {
          return router.createUrlTree(['/login']);
        }
        if (allowedRoles.includes(session.role)) {
          return true;
        }
        return router.createUrlTree([auth.homePathForRole(session.role)]);
      })
    );
  };
}
