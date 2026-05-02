import { Routes } from '@angular/router';
import { CaseDetailsComponent } from './design';

export const routes: Routes = [
  { path: '', component: CaseDetailsComponent },
  { path: ':id', component: CaseDetailsComponent }
];
