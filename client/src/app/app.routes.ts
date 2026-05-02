import { Routes } from '@angular/router';
import { AppRole } from './core/auth/auth.types';
import { authGuard, guestGuard } from './core/guards/auth.guard';
import { roleGuard } from './core/guards/role.guard';
import { Login } from './modules/login/login';
import { Secretary } from './modules/secretary/secretary';
import { Admin } from './modules/admin/admin';
import { CaseManagementComponent } from './modules/case-management/case-management';
import { SecretaryDashboardComponent } from './modules/secretary-dashboard/secretary-dashboard';
import { Finishing } from './modules/finishing/finishing';

/** Admin may open designer / secretary / finisher workspaces from the admin UI. */
const WITH_ADMIN: (r: AppRole) => AppRole[] = r => [r, 'admin'];

export const routes: Routes = [
  { path: 'login', component: Login, canActivate: [guestGuard] },

  {
    path: 'admin',
    canActivate: [authGuard, roleGuard(['admin'])],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      { path: 'dashboard', component: Admin },
      { path: 'case-management', component: CaseManagementComponent },
    ],
  },

  {
    path: 'secretary',
    canActivate: [authGuard, roleGuard(WITH_ADMIN('secretary'))],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      { path: 'dashboard', component: Secretary },
      { path: 'stats', component: SecretaryDashboardComponent },
    ],
  },

  {
    path: 'designer',
    canActivate: [authGuard, roleGuard(WITH_ADMIN('designer'))],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        loadChildren: () => import('./modules/design/design.routes').then(m => m.routes),
      },
    ],
  },

  {
    path: 'finisher',
    canActivate: [authGuard, roleGuard(WITH_ADMIN('finisher'))],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      { path: 'dashboard', component: Finishing },
    ],
  },

  /* Legacy URLs → canonical RBAC paths */
  { path: 'secretary-dashboard', pathMatch: 'full', redirectTo: '/secretary/stats' },
  { path: 'finishing', pathMatch: 'full', redirectTo: '/finisher/dashboard' },
  { path: 'design', pathMatch: 'full', redirectTo: '/designer/dashboard' },

  { path: '', pathMatch: 'full', redirectTo: 'login' },
  { path: '**', redirectTo: '/login' },
];
