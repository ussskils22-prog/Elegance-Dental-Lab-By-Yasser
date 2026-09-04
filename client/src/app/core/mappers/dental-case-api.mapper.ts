import type { DentalCase } from '../services/shared-cases.service';
import { environment } from '../../../environments/environment';

const META_PREFIX = '__META__\n';
const MEDIA_BASE_URL = (environment.socketUrl || '').replace(/\/+$/, '');

export function normalizeCaseImageUrl(rawUrl: string): string {
  const clean = String(rawUrl || '').trim();
  if (!clean) return '';
  if (/^(https?:)?\/\//i.test(clean) || clean.startsWith('data:') || clean.startsWith('blob:')) {
    return clean;
  }
  const normalizedPath = clean.startsWith('/') ? clean : `/${clean}`;
  return `${MEDIA_BASE_URL}${normalizedPath}`;
}

/** مسار مخزّن على الخادم من رابط كامل أو نسبي (صور، PLY، …) */
export function toStoredCaseImagePath(rawUrl: string): string {
  const clean = String(rawUrl || '').trim();
  if (!clean || clean.startsWith('data:') || clean.startsWith('blob:')) return '';

  if (/^https?:\/\//i.test(clean)) {
    try {
      const parsed = new URL(clean);
      // Our own uploads host → store pathname only
      if (MEDIA_BASE_URL && clean.startsWith(MEDIA_BASE_URL)) {
        return parsed.pathname || '';
      }
      // External scan links (Drive / WeTransfer / lab cloud) → keep full URL
      return clean;
    } catch {
      return '';
    }
  }

  return clean.startsWith('/') ? clean : `/${clean}`;
}

export function isExternalScanUrl(rawUrl: string | undefined | null): boolean {
  const clean = String(rawUrl || '').trim();
  return /^https?:\/\//i.test(clean);
}

export function sanitizeCaseImageListForStorage(images: string[] | undefined): string[] {
  if (!Array.isArray(images) || images.length === 0) return [];
  const unique = new Set<string>();
  for (const image of images) {
    const storedPath = toStoredCaseImagePath(image);
    if (!storedPath) continue;
    unique.add(storedPath);
  }
  return Array.from(unique);
}

export type CaseMeta = {
  requesterType?: 'doctor' | 'student';
  studentPrice?: number;
  doctor?: string;
  branch?: string;
  workDetail?: string;
  color?: string;
  size?: string;
  quantity?: number;
  deliveryDate?: string;
  deliveryTime?: string;
  receivedDate?: string;
  instructions?: string;
  designNotes?: string;
  selectedFileName?: string;
  designImages?: string[];
  finishingNotes?: string;
  uiStatusOverride?: 'in-progress' | 'under-khart' | 'needs-revision';
  plyScanPath?: string;
  plyFileName?: string;
  /** طريقة استلام الشغل من العيادة */
  intakeType?: 'impression' | 'scan';
  /** مصدر تسجيل الحالة */
  entrySource?: 'secretary' | 'print' | 'doctor';
  /**
   * مخطط الأسنان (FDI): خامة لكل سن + groupId للجسور المتصلة.
   * مثال: [{ fdi:'16', material:'Zircon', groupId:'g1' }, ...]
   */
  teeth?: Array<{ fdi: string; material: string; groupId: string }>;
  /** Case number of the try-in this final was spawned from */
  sourceTryInCaseNumber?: string;
  sourceTryInCaseId?: string;
};

export type SecretaryCaseFormPayload = {
  requesterType?: 'doctor' | 'student';
  studentPrice?: number;
  doctor: string;
  patient: string;
  patientEmail?: string;
  patientPhone?: string;
  workType: string;
  workDetail: string;
  color: string;
  size: string;
  quantity: number;
  date: string;
  deliveryDate?: string;
  deliveryTime?: string;
  branch?: string;
  exitedAt?: string;
  intakeType?: 'impression' | 'scan';
  entrySource?: 'secretary' | 'print' | 'doctor';
  teeth?: Array<{ fdi: string; material: string; groupId: string }>;
  sourceTryInCaseNumber?: string;
  sourceTryInCaseId?: string;
};

function parseMeta(notes: string | undefined): Record<string, unknown> {
  if (!notes || !notes.startsWith(META_PREFIX)) {
    return {};
  }
  try {
    return JSON.parse(notes.slice(META_PREFIX.length)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stringifyMeta(meta: CaseMeta): string {
  return META_PREFIX + JSON.stringify(meta);
}

export function buildSecretaryNotes(
  form: SecretaryCaseFormPayload,
  plyPreserve?: { plyScanPath: string; plyFileName?: string }
): string {
  const meta: CaseMeta = {
    requesterType: form.requesterType === 'student' ? 'student' : 'doctor',
    studentPrice: Number(form.studentPrice || 0),
    doctor: form.doctor,
    branch: (form.branch || '').trim(),
    workDetail: form.workDetail,
    color: form.color,
    size: form.size,
    quantity: form.quantity,
    deliveryDate: form.deliveryDate || '',
    deliveryTime: form.deliveryTime || '',
    receivedDate: form.date,
  };
  if (form.intakeType === 'impression' || form.intakeType === 'scan') {
    meta.intakeType = form.intakeType;
  }
  if (form.entrySource === 'secretary' || form.entrySource === 'print' || form.entrySource === 'doctor') {
    meta.entrySource = form.entrySource;
  }
  if (Array.isArray(form.teeth) && form.teeth.length) {
    meta.teeth = form.teeth
      .filter((t) => t && t.fdi && t.material && t.groupId)
      .map((t) => ({
        fdi: String(t.fdi),
        material: String(t.material),
        groupId: String(t.groupId),
      }));
  }
  if (form.sourceTryInCaseNumber?.trim()) {
    meta.sourceTryInCaseNumber = form.sourceTryInCaseNumber.trim();
  }
  if (form.sourceTryInCaseId?.trim()) {
    meta.sourceTryInCaseId = form.sourceTryInCaseId.trim();
  }
  const path = plyPreserve?.plyScanPath?.trim();
  if (path) {
    meta.plyScanPath = path;
    meta.plyFileName = ((plyPreserve?.plyFileName ?? '') || '').trim().slice(0, 280) || '';
  }
  return stringifyMeta(meta);
}

export function buildDesignerNotesMeta(meta: CaseMeta): string {
  return stringifyMeta(meta);
}

export function buildDueIso(form: SecretaryCaseFormPayload): string {
  if (form.deliveryDate && /^\d{4}-\d{2}-\d{2}$/.test(form.deliveryDate)) {
    const raw = (form.deliveryTime && form.deliveryTime.trim()) || '18:00';
    const tm = raw.length === 5 ? `${raw}:00` : raw;
    return new Date(`${form.deliveryDate}T${tm}`).toISOString();
  }
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d.toISOString();
}

export function buildCreateCasePayload(
  form: SecretaryCaseFormPayload,
  plyPreserve?: { plyScanPath: string; plyFileName?: string }
): Record<string, unknown> {
  const email = (form.patientEmail || '').trim() || `case+${Date.now()}@mylab.com`;
  const phone = (form.patientPhone || '').trim() || '0000000000';
  const payload: Record<string, unknown> = {
    patientName: (form.patient || '').trim() || 'غير محدد',
    patientEmail: email,
    patientPhone: phone,
    requesterType: form.requesterType === 'student' ? 'student' : 'doctor',
    salaryAmount: Number(form.studentPrice || 0),
    caseType: (form.workType || '').trim(),
    priority: 'normal',
    dueDate: buildDueIso(form),
    notes: buildSecretaryNotes(form, plyPreserve),
  };

  if (form.exitedAt) {
    payload['stageTimestamps'] = {
      exited: new Date(form.exitedAt).toISOString()
    };
  }

  return payload;
}

export function formatTimeTo12Hour(timeStr: string): string {
  if (!timeStr) return '';
  const parts = timeStr.trim().split(':');
  if (parts.length < 2) return timeStr;
  let hour = parseInt(parts[0], 10);
  const minute = parts[1];
  if (isNaN(hour)) return timeStr;
  const ampm = hour >= 12 ? 'م' : 'ص';
  hour = hour % 12;
  hour = hour ? hour : 12; // 0 becomes 12
  return `${hour}:${minute} ${ampm}`;
}

export function mapApiCaseToDentalCase(doc: Record<string, unknown>): DentalCase {
  const id = String(doc['_id'] ?? doc['id'] ?? '');
  const meta = parseMeta(String(doc['notes'] ?? ''));
  const doctor = String(meta['doctor'] ?? '');
  const workDetail = String(meta['workDetail'] ?? '');
  const color = String(meta['color'] ?? '');
  const size = String(meta['size'] ?? '');
  const quantityRaw = meta['quantity'];
  const quantity =
    typeof quantityRaw === 'number' && !Number.isNaN(quantityRaw)
      ? quantityRaw
      : quantityRaw !== undefined && quantityRaw !== null && quantityRaw !== '' && !Number.isNaN(Number(quantityRaw))
        ? Number(quantityRaw)
        : 1;
  const deliveryDate = String(meta['deliveryDate'] ?? '');
  const deliveryTime = String(meta['deliveryTime'] ?? '');
  const receivedDateMeta = String(meta['receivedDate'] ?? '');
  const createdAt = doc['createdAt'];
  let receivedDisplay = receivedDateMeta;
  if (!receivedDisplay && createdAt) {
    try {
      receivedDisplay = new Date(String(createdAt)).toLocaleDateString('ar-EG', {
        day: 'numeric',
        month: 'numeric',
        year: 'numeric',
      });
    } catch {
      receivedDisplay = '';
    }
  }
  let deliveryDisplay = '';
  if (deliveryDate) {
    deliveryDisplay = deliveryTime ? `${deliveryDate} ${formatTimeTo12Hour(deliveryTime)}` : deliveryDate;
  }
  const caseNumber = String(doc['caseNumber'] ?? '');
  const patientName = String(doc['patientName'] ?? '');
  const caseType = String(doc['caseType'] ?? '');
  const createdBy = doc['createdBy'] as Record<string, unknown> | undefined;
  const enteredBy =
    createdBy && typeof createdBy['fullName'] === 'string'
      ? String(createdBy['fullName'])
      : 'السكرتارية';
  const createdByRole =
    createdBy && typeof createdBy['role'] === 'string' ? String(createdBy['role']) : '';

  const instructionsLines = [
    doctor && `الطبيب: ${doctor}`,
    `نوع العمل: ${caseType}${workDetail ? ' — ' + workDetail : ''}`,
    color && `اللون: ${color}`,
    size && `الحجم: ${size}`,
    `العدد: ${quantity}`,
  ].filter(Boolean);
  const designImagesRaw = meta['designImages'];
  const designImages = Array.isArray(designImagesRaw)
    ? designImagesRaw
        .filter((v): v is string => typeof v === 'string')
        .map((v) => normalizeCaseImageUrl(v))
        .filter(Boolean)
    : [];
  const instructionsFromMeta = String(meta['instructions'] ?? '');
  const designNotes = String(meta['designNotes'] ?? '');
  const finishingNotes = String(meta['finishingNotes'] ?? '');
  const selectedFileName = String(meta['selectedFileName'] ?? '');
  const uiStatusOverride = String(meta['uiStatusOverride'] ?? '');
  const plyPathRaw = doc['plyScanPath'] || meta['plyScanPath'];
  const plyScanPath = typeof plyPathRaw === 'string' ? plyPathRaw.trim() : '';
  const plyFileName = String(doc['plyFileName'] ?? meta['plyFileName'] ?? '').trim();
  const plyScanUrl = plyScanPath ? normalizeCaseImageUrl(plyScanPath) : '';
  const intakeRaw = String(meta['intakeType'] ?? '').toLowerCase();
  const intakeType: 'impression' | 'scan' | undefined =
    intakeRaw === 'scan' ? 'scan' : intakeRaw === 'impression' ? 'impression' : undefined;
  const entryRaw = String(meta['entrySource'] ?? '').toLowerCase();
  let entrySource: 'secretary' | 'print' | 'doctor' | undefined =
    entryRaw === 'secretary' || entryRaw === 'print' || entryRaw === 'doctor'
      ? (entryRaw as 'secretary' | 'print' | 'doctor')
      : undefined;
  if (!entrySource) {
    if (createdByRole === 'doctor') entrySource = 'doctor';
    else if (createdByRole === 'secretary') entrySource = 'secretary';
    else if (createdByRole === 'requester') entrySource = 'print';
  }
  const requesterTypeRaw = String(meta['requesterType'] ?? doc['requesterType'] ?? 'doctor');
  const requesterType: 'doctor' | 'student' =
    requesterTypeRaw === 'student' ? 'student' : 'doctor';
  const teethRaw = meta['teeth'];
  const teeth = Array.isArray(teethRaw)
    ? teethRaw
        .map((t) => {
          if (!t || typeof t !== 'object') return null;
          const row = t as Record<string, unknown>;
          const fdi = String(row['fdi'] ?? '').trim();
          const material = String(row['material'] ?? '').trim();
          const groupId = String(row['groupId'] ?? '').trim();
          if (!fdi || !material || !groupId) return null;
          return { fdi, material, groupId };
        })
        .filter((t): t is { fdi: string; material: string; groupId: string } => !!t)
    : undefined;
  const salaryAmountRaw = doc['salaryAmount'];
  const salaryAmount =
    typeof salaryAmountRaw === 'number' && !Number.isNaN(salaryAmountRaw)
      ? salaryAmountRaw
      : Number(salaryAmountRaw) || Number(meta['studentPrice'] || 0);

  const stageTimestamps = doc['stageTimestamps'] as Record<string, string> | undefined;
  const exitedAtRaw = stageTimestamps?.['exited'] || doc['updatedAt'];
  let exitedDisplay = '';
  if (exitedAtRaw && mapUiStatus(doc, uiStatusOverride) === 'exited') {
    try {
      const d = new Date(String(exitedAtRaw));
      const datePart = d.toLocaleDateString('ar-EG-u-nu-latn', { day: 'numeric', month: 'numeric', year: 'numeric' });
      const timePart = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
      exitedDisplay = `${datePart} ${timePart.replace('AM', 'ص').replace('PM', 'م')}`;
    } catch {
      exitedDisplay = '';
    }
  }

  return {
    id,
    caseNumber,
    priority: mapPriorityFromApi(String(doc['priority'] ?? 'normal')),
    patient: patientName,
    doctor,
    clinic: String(meta['branch'] ?? ''),
    branch: String(meta['branch'] ?? ''),
    receivedDate: receivedDisplay || caseNumber,
    receivedDateRaw: receivedDateMeta || undefined,
    createdAt: createdAt ? String(createdAt) : undefined,
    deliveryDate: deliveryDisplay,
    enteredBy,
    requesterType,
    instructions: instructionsFromMeta || instructionsLines.join('\n'),
    status: mapUiStatus(doc, uiStatusOverride),
    currentStage: String(doc['currentStage'] ?? ''),
    designNotes,
    selectedFileName,
    designImages,
    workType: caseType,
    workDetail,
    color,
    size,
    quantity,
    patientEmail: String(doc['patientEmail'] ?? ''),
    patientPhone: String(doc['patientPhone'] ?? ''),
    salaryAmount,
    finishingNotes,
    plyScanUrl: plyScanUrl || undefined,
    plyFileName: plyFileName || undefined,
    intakeType,
    entrySource,
    teeth,
    exitedAt: exitedDisplay || undefined,
    exitedAtRaw: exitedAtRaw ? String(exitedAtRaw) : undefined,
    sourceTryInCaseNumber: String(meta['sourceTryInCaseNumber'] ?? '').trim() || undefined,
    sourceTryInCaseId: String(meta['sourceTryInCaseId'] ?? '').trim() || undefined,
  };
}

function mapPriorityFromApi(p: string): DentalCase['priority'] {
  if (p === 'urgent' || p === 'high') return 'emergency';
  if (p === 'low') return 'low';
  return 'normal';
}

function mapUiStatus(doc: Record<string, unknown>, uiStatusOverride: string): DentalCase['status'] {
  const s = String(doc['status'] ?? '');
  const stage = String(doc['currentStage'] ?? '');
  if (s === 'exited' || stage === 'exited') return 'exited';
  if (uiStatusOverride === 'needs-revision') return 'needs-revision';
  // Prefer currentStage — status can lag after station scans
  if (stage === 'completed') return 'finished';
  if (stage === 'finishing') return 'ready-for-finishing';
  if (stage === 'khart') return 'under-khart';
  if (stage === 'design' && uiStatusOverride === 'under-khart') return 'under-khart';
  if (stage === 'design') return 'in-progress';
  if (stage === 'waiting' || stage === 'secretary') return 'pending';
  if (s === 'completed') return 'finished';
  return 'pending';
}
