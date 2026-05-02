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
      return parsed.pathname || '';
    } catch {
      return '';
    }
  }

  return clean.startsWith('/') ? clean : `/${clean}`;
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
  uiStatusOverride?: 'in-progress' | 'under-khart' | 'ready-for-finishing';
  plyScanPath?: string;
  plyFileName?: string;
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
    workDetail: form.workDetail,
    color: form.color,
    size: form.size,
    quantity: form.quantity,
    deliveryDate: form.deliveryDate || '',
    deliveryTime: form.deliveryTime || '',
    receivedDate: form.date,
  };
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
  return {
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
      : Number(quantityRaw) || 1;
  const deliveryDate = String(meta['deliveryDate'] ?? '');
  const deliveryTime = String(meta['deliveryTime'] ?? '');
  const receivedDateMeta = String(meta['receivedDate'] ?? '');
  const createdAt = doc['createdAt'];
  let receivedDisplay = receivedDateMeta;
  if (!receivedDisplay && createdAt) {
    try {
      receivedDisplay = new Date(String(createdAt)).toLocaleDateString('ar-EG', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      receivedDisplay = '';
    }
  }
  let deliveryDisplay = '';
  if (deliveryDate) {
    deliveryDisplay = deliveryTime ? `${deliveryDate} ${deliveryTime}` : deliveryDate;
  }
  const caseNumber = String(doc['caseNumber'] ?? '');
  const patientName = String(doc['patientName'] ?? '');
  const caseType = String(doc['caseType'] ?? '');
  const createdBy = doc['createdBy'] as Record<string, unknown> | undefined;
  const enteredBy =
    createdBy && typeof createdBy['fullName'] === 'string'
      ? String(createdBy['fullName'])
      : 'السكرتارية';

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
  const plyPathRaw = meta['plyScanPath'];
  const plyScanPath = typeof plyPathRaw === 'string' ? plyPathRaw : '';
  const plyFileName = String(meta['plyFileName'] ?? '');
  const plyScanUrl = plyScanPath ? normalizeCaseImageUrl(plyScanPath) : '';
  const requesterTypeRaw = String(meta['requesterType'] ?? doc['requesterType'] ?? 'doctor');
  const requesterType: 'doctor' | 'student' =
    requesterTypeRaw === 'student' ? 'student' : 'doctor';
  const salaryAmountRaw = doc['salaryAmount'];
  const salaryAmount =
    typeof salaryAmountRaw === 'number' && !Number.isNaN(salaryAmountRaw)
      ? salaryAmountRaw
      : Number(salaryAmountRaw) || Number(meta['studentPrice'] || 0);

  return {
    id,
    caseNumber,
    priority: mapPriorityFromApi(String(doc['priority'] ?? 'normal')),
    patient: patientName,
    doctor,
    clinic: '',
    receivedDate: receivedDisplay || caseNumber,
    deliveryDate: deliveryDisplay,
    enteredBy,
    requesterType,
    instructions: instructionsFromMeta || instructionsLines.join('\n'),
    status: mapUiStatus(doc, uiStatusOverride),
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
  if (s === 'exited') return 'exited';
  if (s === 'completed' || stage === 'completed') return 'finished';
  if (stage === 'khart') return 'under-khart';
  if (stage === 'finishing') return 'ready-for-finishing';
  // Legacy: under-khart was only in notes meta before `khart` existed on currentStage
  if (stage === 'design' && uiStatusOverride === 'under-khart') return 'under-khart';
  if (stage === 'design') return 'in-progress';
  return 'pending';
}
