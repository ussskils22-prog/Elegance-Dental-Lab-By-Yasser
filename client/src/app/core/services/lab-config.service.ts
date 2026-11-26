import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, of } from 'rxjs';
import { catchError, map, shareReplay, tap } from 'rxjs/operators';
import { environment } from '../../../environments/environment';

export interface LabBranding {
  labName: string;
  logoUrl: string;
  primaryColor: string;
}

export interface LabMaterial {
  _id?: string;
  key: string;
  label: string;
  labelAr?: string;
  matchKeywords: string[];
  defaultPrice: number;
  stockQty?: number;
  avgUnitCost?: number;
  lowStockAlert?: number;
  active: boolean;
  sortOrder: number;
  showInWorkTypes?: boolean;
  showInCounters?: boolean;
  color?: string;
}

export interface LabWorkflow {
  enabledStages: string[];
  allowSkipSecretary: boolean;
  allowSkipKhart: boolean;
  allStages?: string[];
}

const DEFAULT_BRANDING: LabBranding = {
  labName: 'OCCLA Dental Lab',
  logoUrl: '',
  primaryColor: '#2563eb',
};

@Injectable({ providedIn: 'root' })
export class LabConfigService {
  private readonly http = inject(HttpClient);
  private readonly branding$ = new BehaviorSubject<LabBranding>(DEFAULT_BRANDING);
  private publicLoaded = false;
  private materialsCache$: Observable<LabMaterial[]> | null = null;

  get branding(): LabBranding {
    return this.branding$.value;
  }

  brandingChanges(): Observable<LabBranding> {
    return this.branding$.asObservable();
  }

  /** Public endpoint — safe for login page. */
  loadPublicBranding(): Observable<LabBranding> {
    if (this.publicLoaded) return of(this.branding$.value);
    return this.http
      .get<{ success?: boolean; branding?: LabBranding }>(`${environment.apiUrl}/settings/public`)
      .pipe(
        map((res) => ({
          labName: res?.branding?.labName || DEFAULT_BRANDING.labName,
          logoUrl: res?.branding?.logoUrl || '',
          primaryColor: res?.branding?.primaryColor || DEFAULT_BRANDING.primaryColor,
        })),
        tap((b) => {
          this.branding$.next(b);
          this.publicLoaded = true;
        }),
        catchError(() => {
          this.branding$.next(DEFAULT_BRANDING);
          return of(DEFAULT_BRANDING);
        })
      );
  }

  getLabSettings(): Observable<{
    branding: LabBranding;
    workflow: LabWorkflow;
    materials: LabMaterial[];
    defaultPrices: Record<string, number>;
  }> {
    return this.http
      .get<{
        success?: boolean;
        branding?: LabBranding;
        workflow?: LabWorkflow;
        materials?: LabMaterial[];
        defaultPrices?: Record<string, number>;
      }>(`${environment.apiUrl}/settings/lab`)
      .pipe(
        map((res) => {
          const branding = {
            labName: res?.branding?.labName || DEFAULT_BRANDING.labName,
            logoUrl: res?.branding?.logoUrl || '',
            primaryColor: res?.branding?.primaryColor || DEFAULT_BRANDING.primaryColor,
          };
          this.branding$.next(branding);
          return {
            branding,
            workflow: {
              enabledStages: res?.workflow?.enabledStages || [],
              allowSkipSecretary: res?.workflow?.allowSkipSecretary !== false,
              allowSkipKhart: res?.workflow?.allowSkipKhart !== false,
              allStages: res?.workflow?.allStages || [],
            },
            materials: res?.materials || [],
            defaultPrices: res?.defaultPrices || {},
          };
        })
      );
  }

  updateLabSettings(body: {
    branding?: Partial<LabBranding>;
    workflow?: Partial<LabWorkflow>;
  }): Observable<any> {
    return this.http.put(`${environment.apiUrl}/settings/lab`, body).pipe(
      tap((res: any) => {
        if (res?.branding) {
          this.branding$.next({
            labName: res.branding.labName || this.branding.labName,
            logoUrl: res.branding.logoUrl || '',
            primaryColor: res.branding.primaryColor || this.branding.primaryColor,
          });
        }
      })
    );
  }

  listMaterials(activeOnly = false): Observable<LabMaterial[]> {
    const q = activeOnly ? '?active=1' : '';
    return this.http
      .get<{ success?: boolean; materials?: LabMaterial[] }>(`${environment.apiUrl}/materials${q}`)
      .pipe(map((res) => res?.materials || []));
  }

  /** Cached active materials for work-type chips. */
  activeMaterials(): Observable<LabMaterial[]> {
    if (!this.materialsCache$) {
      this.materialsCache$ = this.listMaterials(true).pipe(
        map((list) => list.filter((m) => m.showInWorkTypes !== false)),
        shareReplay(1),
        catchError(() => of([]))
      );
    }
    return this.materialsCache$;
  }

  invalidateMaterialsCache(): void {
    this.materialsCache$ = null;
  }

  createMaterial(body: Partial<LabMaterial>): Observable<any> {
    return this.http.post(`${environment.apiUrl}/materials`, body).pipe(
      tap(() => this.invalidateMaterialsCache())
    );
  }

  updateMaterial(id: string, body: Partial<LabMaterial>): Observable<any> {
    return this.http.put(`${environment.apiUrl}/materials/${id}`, body).pipe(
      tap(() => this.invalidateMaterialsCache())
    );
  }

  deleteMaterial(id: string): Observable<any> {
    return this.http.delete(`${environment.apiUrl}/materials/${id}`).pipe(
      tap(() => this.invalidateMaterialsCache())
    );
  }

  workTypeLabels(): Observable<string[]> {
    return this.activeMaterials().pipe(map((mats) => mats.map((m) => m.label)));
  }
}
