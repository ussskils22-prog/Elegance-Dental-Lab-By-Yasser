import { ChangeDetectorRef, Component, HostListener, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { SharedCasesService, DentalCase } from '../../core/services/shared-cases.service';
import { CaseApiService } from '../../core/services/case-api.service';
import {
  buildDesignerNotesMeta,
  mapApiCaseToDentalCase,
  normalizeCaseImageUrl,
  sanitizeCaseImageListForStorage,
  toStoredCaseImagePath,
} from '../../core/mappers/dental-case-api.mapper';
import { SocketService } from '../../core/services/socket.service';

export type CasePriority = 'emergency' | 'normal' | 'low';
export type CaseStatus =
  | 'pending'
  | 'in-progress'
  | 'needs-revision'
  | 'ready-for-finishing'
  | 'under-khart'
  | 'finished'
  | 'exited';

export interface WorkStage {
  id: CaseStatus;
  label: string;
  icon: 'check' | 'warning' | 'clock' | 'flag';
}

@Component({
  selector: 'app-case-details',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './design.html',
  styleUrls: ['./design.css']
})
export class CaseDetailsComponent implements OnInit, OnDestroy {

  private sharedCasesService = inject(SharedCasesService);
  private caseApi = inject(CaseApiService);
  private socketService = inject(SocketService);
  private cdr = inject(ChangeDetectorRef);
  private socketSubs: Subscription[] = [];
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private isAutosaving = false;

  /* ── View state ── */
  view: 'list' | 'detail' = 'list';
  selectedCase: DentalCase | null = null;
  sidebarOpen       = false;
  isSaving          = false;
  saveSuccess       = false;
  isFinishing       = false;
  showFinishConfirm = false;
  toastMsg          = '';
  toastVisible      = false;
  activeFilter: CaseStatus | 'all' = 'all';
  searchTerm        = '';

  /* ── Notifications ── */
  readonly notificationsOpen = signal(false);

  /** معاينة مسح PLY (Three.js) */
  plyViewerOpen = false;
  plyViewerLoading = false;
  plyViewerError = '';
  private plyCleanup: (() => void) | null = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private auth: AuthService
  ) {}

  logout(): void {
    this.flushDesignerChanges(() => this.auth.performLogout(this.router));
  }

  toggleNotifications(ev: Event): void {
    ev.stopPropagation();
    this.notificationsOpen.update((v) => !v);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(ev: MouseEvent): void {
    const el = ev.target as HTMLElement;
    if (el.closest('.notifications-anchor')) {
      return;
    }
    this.notificationsOpen.set(false);
  }

  handleNavAction(): void {
    if (this.view === 'detail') {
      this.goBack();
    }
  }

  /* ── Work stages shown inside detail view ── */
  workStages: WorkStage[] = [
    { id: 'in-progress',    label: 'تحت الديزاين',    icon: 'clock'   },

    { id: 'ready-for-finishing', label: 'جاهزة للفينيش', icon: 'check' },
  ];

  /* ── Cases list - مأخوذة من service مشترك ── */
  get cases(): DentalCase[] {
    return this.sharedCasesService.cases();
  }

  set cases(value: DentalCase[]) {
    // تحديث البيانات في الـ service عند التغيير
    value.forEach((c) => {
      const existing = this.sharedCasesService.getCaseById(c.id);
      if (existing) {
        this.sharedCasesService.syncCase(c);
      }
    });
  }

  ngOnInit(): void {
    this.reloadCasesFromBackend();
    this.connectRealtimeUpdates();

    this.route.params.subscribe(params => {
      const id = params['id'];
      if (id) {
        const caseItem = this.cases.find(c => c.id === id);
        if (caseItem) {
          this.openCase(caseItem);
        } else {
          this.router.navigate(['/designer/dashboard']);
        }
      } else {
        this.view = 'list';
        this.selectedCase = null;
      }
    });
  }

  ngOnDestroy(): void {
    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    this.socketSubs.forEach((s) => s.unsubscribe());
    this.disposePlyInternals();
  }

  private connectRealtimeUpdates(): void {
    this.socketService.connect();
    this.socketSubs.push(
      this.socketService.onCaseCreated().subscribe((evt) => {
        if (evt) this.reloadCasesFromBackend(false);
      }),
      this.socketService.onCaseMovedStage().subscribe((evt) => {
        if (evt) this.reloadCasesFromBackend(false);
      }),
      this.socketService.onCaseAssigned().subscribe((evt) => {
        if (evt) this.reloadCasesFromBackend(false);
      }),
      this.socketService.onCaseReassigned().subscribe((evt) => {
        if (evt) this.reloadCasesFromBackend(false);
      }),
      this.socketService.onCaseCompleted().subscribe((evt) => {
        if (evt) this.reloadCasesFromBackend(false);
      }),
      this.socketService.onCaseReleased().subscribe((evt) => {
        if (evt) this.reloadCasesFromBackend(false);
      }),
      this.socketService.onCaseUpdated().subscribe((evt) => {
        if (evt) this.reloadCasesFromBackend(false);
      }),
      this.socketService.onCaseDeleted().subscribe((evt) => {
        if (evt) this.reloadCasesFromBackend(false);
      })
    );
  }

  private reloadCasesFromBackend(showErrorToast: boolean = true): void {
    this.caseApi.getAllCases(1, 500).subscribe({
      next: res => {
        const rows = (res?.data ?? []) as Record<string, unknown>[];
        const mapped = Array.isArray(rows) ? rows.map(r => mapApiCaseToDentalCase(r)) : [];
        this.sharedCasesService.setCasesFromServer(mapped);
        if (this.view === 'detail' && this.selectedCase) {
          const stillThere = mapped.some((c) => c.id === this.selectedCase!.id);
          if (!stillThere) {
            this.view = 'list';
            this.selectedCase = null;
            this.showFinishConfirm = false;
            this.router.navigate(['/designer/dashboard']);
          }
        }
      },
      error: () => {
        if (showErrorToast) {
          this.showToast('تعذر تحميل الحالات من الخادم');
        }
      },
    });
  }

  /* ════════ COMPUTED ════════ */

  get filteredCases(): DentalCase[] {
    let filtered = this.cases;

    // Apply status filter
    if (this.activeFilter !== 'all') {
      filtered = filtered.filter(c => c.status === this.activeFilter);
    }

    // Apply search filter
    if (this.searchTerm.trim()) {
      const searchLower = this.searchTerm.toLowerCase();
      filtered = filtered.filter(c =>
        c.patient.toLowerCase().includes(searchLower) ||
        c.caseNumber.toLowerCase().includes(searchLower) ||
        c.doctor.toLowerCase().includes(searchLower)
      );
    }

    return filtered;
  }

  get counts() {
    return {
      all:            this.cases.length,
      pending:        this.cases.filter(c => c.status === 'pending').length,
      'in-progress':  this.cases.filter(c => c.status === 'in-progress').length,
      'needs-revision': this.cases.filter(c => c.status === 'needs-revision').length,
      'ready-for-finishing': this.cases.filter(c => c.status === 'ready-for-finishing').length,
      'under-khart': this.cases.filter(c => c.status === 'under-khart').length,
      finished:       this.cases.filter(c => c.status === 'finished').length,
    };
  }

  priorityLabel(p: CasePriority): string {
    return { emergency: 'طارئ', normal: 'عادي', low: 'منخفض' }[p];
  }

  statusLabel(s: CaseStatus): string {
    return {
      pending:          'قيد الانتظار',
      'in-progress':    'تحت الديزاين',
      'needs-revision': 'محتاجة تعديل',
      'ready-for-finishing': 'جاهزة للفينيش',
      'under-khart':    'تحت الخرط',
      finished:         'منتهية',
      exited:           'خروج',
    }[s];
  }

  get currentStage(): WorkStage | undefined {
    if (!this.selectedCase) return undefined;
    return this.workStages.find(s => s.id === this.selectedCase!.status);
  }

  /* ════════ NAVIGATION ════════ */

  openCase(c: DentalCase): void {
    this.closePlyViewer();
    this.selectedCase = { ...c };
    this.view = 'detail';
    this.sidebarOpen = false;
    this.showFinishConfirm = false;

    // Auto-set to in-progress when opening a pending case
    if (this.selectedCase.status === 'pending') {
      this.selectedCase.status = 'in-progress';
      this.moveStageByStatus('in-progress');
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
    this.router.navigate(['/designer/dashboard', c.id]);
  }

  goBack(): void {
    this.closePlyViewer();
    this.flushDesignerChanges(() => {
      this.view = 'list';
      this.selectedCase = null;
      this.showFinishConfirm = false;
      this.router.navigate(['/designer/dashboard']);
    });
  }

  // مزامنة جميع التعديلات من selectedCase إلى service
  private syncChangesToList(): void {
    if (!this.selectedCase) return;
    this.sharedCasesService.syncCase({ ...this.selectedCase });
  }

  setStage(id: CaseStatus): void {
    if (!this.selectedCase) return;
    this.selectedCase.status = id;
    this.moveStageByStatus(id);
  }

  /* ════════ FINISH ════════ */

  requestFinish(): void {
    this.showFinishConfirm = true;
  }

  cancelFinish(): void {
    this.showFinishConfirm = false;
  }

  async confirmFinish(): Promise<void> {
    if (!this.selectedCase) return;

    // أولاً: حفظ جميع التعديلات المعلقة
    this.sharedCasesService.syncCase({ ...this.selectedCase });

    this.isFinishing = true;
    this.showFinishConfirm = false;
    await new Promise(r => setTimeout(r, 1600));

    // ثم: تحويلها إلى جاهزة للفينيش ليستلمها قسم الـ Finishing
    this.selectedCase.status = 'ready-for-finishing';
    this.moveStageByStatus('ready-for-finishing');

    this.isFinishing = false;
    this.showToast('تم إرسال الحالة إلى قسم الفينيش ✅');
    setTimeout(() => this.goBack(), 1800);
  }

  /* ════════ SAVE ════════ */

  async saveCase(): Promise<void> {
    if (!this.selectedCase) return;
    this.isSaving = true;
    const payload = this.buildUpdatePayload(this.selectedCase);
    this.caseApi.updateCase(this.selectedCase.id, payload).subscribe({
      next: () => {
        this.isSaving = false;
        this.saveSuccess = true;
        this.reloadCasesFromBackend(false);
        this.showToast('تم حفظ بيانات الحالة');
        setTimeout(() => (this.saveSuccess = false), 3000);
      },
      error: (err) => {
        this.isSaving = false;
        const msg = String(err?.error?.message || '');
        if (msg.includes('assigned to you')) {
          this.showToast('لا يمكنك حفظ هذه الحالة لأنها مسندة لمستخدم آخر');
          return;
        }
        this.showToast('فشل حفظ البيانات على الخادم');
      },
    });
  }

  /* ═══════ FILE/IMAGES ═══════ */

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files?.[0] && this.selectedCase) {
      this.selectedCase.selectedFileName = input.files[0].name;
      this.sharedCasesService.syncCase({ ...this.selectedCase });
      this.scheduleAutosave();
    }
  }

  triggerFileInput(): void {
    (document.getElementById('imageInput') as HTMLInputElement)?.click();
  }

  onImageSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (!files || !this.selectedCase) return;

    const maxSize = 10 * 1024 * 1024; // 10MB
    const validTypes = ['image/jpeg', 'image/jpg', 'image/png'];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      if (!validTypes.includes(file.type)) {
        this.showToast('نوع الملف غير مدعوم. يرجى اختيار صور JPEG أو PNG فقط.');
        continue;
      }

      if (file.size > maxSize) {
        this.showToast('حجم الملف كبير جداً. الحد الأقصى 10MB لكل صورة.');
        continue;
      }

      this.caseApi.uploadCaseImage(this.selectedCase.id, file).subscribe({
        next: (res) => {
          const rawUrl = String(res?.imageUrl ?? '');
          const imageUrl = normalizeCaseImageUrl(rawUrl);
          if (!this.selectedCase) return;
          if (!imageUrl) return;
          if (!this.selectedCase.designImages) {
            this.selectedCase.designImages = [];
          }
          this.selectedCase.designImages.push(imageUrl);
          this.sharedCasesService.syncCase({ ...this.selectedCase });
          this.scheduleAutosave();
        },
        error: () => {
          this.showToast('فشل رفع الصورة إلى الخادم');
        },
      });
    }

    // Clear the input
    input.value = '';
  }

  triggerImageInput(): void {
    (document.getElementById('imageInput') as HTMLInputElement)?.click();
  }

  removeImage(index: number): void {
    if (!this.selectedCase || !this.selectedCase.designImages) return;

    this.selectedCase.designImages.splice(index, 1);
    this.sharedCasesService.syncCase({ ...this.selectedCase });
    this.scheduleAutosave();
  }

  onImageError(event: Event): void {
    const img = event.target as HTMLImageElement;
    console.error('Failed to load image:', img.src);
    // Retry once after 1 second
    if (!img.dataset['retried']) {
      img.dataset['retried'] = 'true';
      setTimeout(() => {
        img.src = img.src + '?t=' + Date.now();
      }, 1000);
    }
  }

  imageModalVisible = false;
  selectedImage = '';

  openImageModal(imageUrl: string): void {
    this.selectedImage = imageUrl;
    this.imageModalVisible = true;
  }

  closeImageModal(): void {
    this.imageModalVisible = false;
    this.selectedImage = '';
  }

  openPlyViewer(): void {
    if (!this.selectedCase?.plyScanUrl) return;
    this.plyViewerError = '';
    this.plyViewerLoading = true;
    this.plyViewerOpen = true;
    this.disposePlyInternals();
    this.cdr.markForCheck();
    setTimeout(() => void this.bootstrapPlyViewer(), 80);
  }

  closePlyViewer(): void {
    this.plyViewerOpen = false;
    this.plyViewerLoading = false;
    this.plyViewerError = '';
    this.disposePlyInternals();
    this.cdr.markForCheck();
  }

  private disposePlyInternals(): void {
    if (this.plyCleanup) {
      this.plyCleanup();
      this.plyCleanup = null;
    }
    const host = document.getElementById('designer-ply-view-host');
    if (host) host.innerHTML = '';
  }

  private async bootstrapPlyViewer(): Promise<void> {
    const url = this.selectedCase?.plyScanUrl;
    const host = document.getElementById('designer-ply-view-host');
    if (!url || !host) {
      this.plyViewerLoading = false;
      this.cdr.markForCheck();
      return;
    }

    host.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    host.appendChild(canvas);

    const height = () => Math.min(Math.round(window.innerHeight * 0.52), 520);
    const width = () => Math.max(host.clientWidth || 640, 320);

    try {
      const THREE = await import('three');
      const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
      const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');

      const w = width();
      const h = height();
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x1e293b);

      const camera = new THREE.PerspectiveCamera(45, w / Math.max(h, 200), 0.01, 5000);
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;

      scene.add(new THREE.AmbientLight(0xffffff, 0.62));
      const key = new THREE.DirectionalLight(0xffffff, 0.95);
      key.position.set(4, 6, 5);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xa5c4ff, 0.35);
      rim.position.set(-3, 2, -4);
      scene.add(rim);

      const loader = new PLYLoader();
      await new Promise<void>((resolve, reject) => {
        loader.load(
          url,
          (geometry: import('three').BufferGeometry) => {
            geometry.computeVertexNormals();
            const material = new THREE.MeshStandardMaterial({
              color: 0x94a3b8,
              metalness: 0.08,
              roughness: 0.62,
              flatShading: false,
              side: THREE.DoubleSide,
            });
            const mesh = new THREE.Mesh(geometry, material);
            scene.add(mesh);

            const box = new THREE.Box3().setFromObject(mesh);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            mesh.position.sub(center);
            const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
            const dist = maxDim * 2.4;
            camera.position.set(dist * 0.85, dist * 0.55, dist * 0.85);
            camera.lookAt(0, 0, 0);
            controls.target.set(0, 0, 0);
            controls.update();
            resolve();
          },
          undefined,
          (err: unknown) => reject(err)
        );
      });

      let rafId = 0;
      const animate = () => {
        rafId = requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
      };
      rafId = requestAnimationFrame(animate);

      const onResize = () => {
        const nw = width();
        const nh = height();
        camera.aspect = nw / Math.max(nh, 200);
        camera.updateProjectionMatrix();
        renderer.setSize(nw, nh);
      };
      window.addEventListener('resize', onResize);

      this.plyCleanup = () => {
        window.removeEventListener('resize', onResize);
        cancelAnimationFrame(rafId);
        controls.dispose();
        renderer.dispose();
        scene.traverse((obj: import('three').Object3D) => {
          const o = obj as import('three').Mesh;
          if (o.isMesh) {
            o.geometry?.dispose();
            const mat = o.material;
            if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
            else mat?.dispose?.();
          }
        });
      };

      this.plyViewerLoading = false;
      this.cdr.markForCheck();
    } catch (e) {
      console.error(e);
      this.plyViewerError = 'تعذر تحميل أو عرض ملف PLY';
      this.plyViewerLoading = false;
      this.cdr.markForCheck();
    }
  }

  /* ════════ TOAST ════════ */

  showToast(msg: string): void {
    this.toastMsg = msg;
    this.toastVisible = true;
    setTimeout(() => (this.toastVisible = false), 3000);
  }

  // حفظ تلقائي للملاحظات عند مغادرة textarea
  saveNotesOnBlur(): void {
    if (!this.selectedCase) return;
    this.sharedCasesService.syncCase({ ...this.selectedCase });
    this.flushDesignerChanges();
  }

  // حفظ الملاحظات أثناء الكتابة (عند كل تغيير)
  onNotesChange(): void {
    if (!this.selectedCase) return;
    this.sharedCasesService.syncCase({ ...this.selectedCase });
    this.scheduleAutosave();
  }

  private moveStageByStatus(status: CaseStatus): void {
    if (!this.selectedCase) return;
    const apiStage =
      status === 'ready-for-finishing' ? 'finishing' :
      status === 'finished' ? 'completed' :
      status === 'exited' ? 'exited' :
      status === 'under-khart' ? 'khart' :
      status === 'in-progress' ? 'design' : 'secretary';

    const payload = this.buildUpdatePayload(this.selectedCase);
    this.caseApi.updateCase(this.selectedCase.id, payload).subscribe({
      next: () => {
        this.caseApi.moveStage(this.selectedCase!.id, apiStage).subscribe({
          next: () => {
            this.reloadCasesFromBackend(false);
          },
          error: () => {
            this.sharedCasesService.syncCase({ ...this.selectedCase! });
          },
        });
      },
      error: (err) => {
        const msg = String(err?.error?.message || '');
        if (msg.includes('assigned to you')) {
          this.showToast('لا يمكنك حفظ هذه الحالة لأنها مسندة لمستخدم آخر');
        }
        this.sharedCasesService.syncCase({ ...this.selectedCase! });
      },
    });
  }

  private buildUpdatePayload(dentalCase: DentalCase): Record<string, unknown> {
    const dueDateIso =
      /^\d{4}-\d{2}-\d{2}/.test(dentalCase.deliveryDate || '')
        ? new Date((dentalCase.deliveryDate || '').replace(' ', 'T')).toISOString()
        : new Date().toISOString();

    const plyStored = dentalCase.plyScanUrl
      ? toStoredCaseImagePath(dentalCase.plyScanUrl)
      : '';
    const notesMeta = buildDesignerNotesMeta({
      requesterType: dentalCase.requesterType === 'student' ? 'student' : 'doctor',
      doctor: dentalCase.doctor,
      workDetail: dentalCase.workDetail,
      color: dentalCase.color,
      size: dentalCase.size,
      quantity: dentalCase.quantity,
      deliveryDate: (dentalCase.deliveryDate || '').split(' ')[0] || '',
      deliveryTime: (dentalCase.deliveryDate || '').split(' ')[1] || '',
      receivedDate: dentalCase.receivedDate,
      instructions: dentalCase.instructions || '',
      designNotes: dentalCase.designNotes || '',
      selectedFileName: dentalCase.selectedFileName || '',
      designImages: sanitizeCaseImageListForStorage(dentalCase.designImages),
      uiStatusOverride:
        dentalCase.status === 'under-khart'
          ? 'under-khart'
          : dentalCase.status === 'ready-for-finishing'
            ? 'ready-for-finishing'
            : 'in-progress',
      ...(plyStored
        ? {
            plyScanPath: plyStored,
            plyFileName: dentalCase.plyFileName || '',
          }
        : {}),
    });

    return {
      patientName: dentalCase.patient,
      patientEmail: dentalCase.patientEmail || `case+${Date.now()}@mylab.com`,
      patientPhone: dentalCase.patientPhone || '0000000000',
      requesterType: dentalCase.requesterType === 'student' ? 'student' : 'doctor',
      caseType: dentalCase.workType || 'General',
      priority: dentalCase.priority === 'emergency' ? 'urgent' : dentalCase.priority,
      dueDate: dueDateIso,
      notes: notesMeta,
    };
  }

  private persistDesignerData(showSuccessToast: boolean): void {
    if (!this.selectedCase) return;
    if (this.isAutosaving) return;
    this.isAutosaving = true;
    const payload = this.buildUpdatePayload(this.selectedCase);
    this.caseApi.updateCase(this.selectedCase.id, payload).subscribe({
      next: () => {
        this.isAutosaving = false;
        if (showSuccessToast) {
          this.showToast('تم حفظ بيانات الحالة');
        }
      },
      error: (err) => {
        this.isAutosaving = false;
        const msg = String(err?.error?.message || '');
        if (msg.includes('assigned to you')) {
          this.showToast('لا يمكنك حفظ هذه الحالة لأنها مسندة لمستخدم آخر');
          return;
        }
        this.showToast('فشل حفظ البيانات على الخادم');
      },
    });
  }

  private scheduleAutosave(): void {
    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer);
    }
    this.autosaveTimer = setTimeout(() => {
      this.persistDesignerData(false);
      this.autosaveTimer = null;
    }, 700);
  }

  private flushDesignerChanges(onDone?: () => void): void {
    if (!this.selectedCase) {
      onDone?.();
      return;
    }
    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    const payload = this.buildUpdatePayload(this.selectedCase);
    this.caseApi.updateCase(this.selectedCase.id, payload).subscribe({
      next: () => onDone?.(),
      error: (err) => {
        const msg = String(err?.error?.message || '');
        if (msg.includes('assigned to you')) {
          this.showToast('لا يمكنك حفظ هذه الحالة لأنها مسندة لمستخدم آخر');
          onDone?.();
          return;
        }
        this.showToast('فشل حفظ البيانات على الخادم');
        onDone?.();
      },
    });
  }

  toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen;
  }

  setFilter(f: CaseStatus | 'all'): void {
    this.activeFilter = f;
  }

  clearSearch(): void {
    this.searchTerm = '';
  }
}