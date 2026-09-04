/** Materials that support Final vs Prova (try-in before final). */
const PHASE_MATERIALS = new Set([
  'Zircon',
  'German Zircon',
  'Emax',
  'Pmma Cad',
  'Peek',
  'Titanium',
]);

const TRY_IN_BEFORE_RE = /^try\s*in\s+before\s+(.+)$/i;
const TRAY_IN_BEFORE_RE = /^tray\s*in\s+before\s+(.+)$/i;
const AFTER_TRY_IN_RE = /^(.+?)\s+after\s+try\s*in$/i;
const AFTER_TRAY_IN_RE = /^(.+?)\s+after\s+tary\s*in$/i;
const AFTER_TRAY_IN_ALT_RE = /^(.+?)\s+after\s+tray\s*in$/i;

export type WorkPhase = 'final' | 'prova';

export function supportsTryInPhase(material: string): boolean {
  return PHASE_MATERIALS.has(String(material || '').trim());
}

export function buildTryInBeforeLabel(material: string): string {
  return `try in before ${String(material || '').trim()}`;
}

export function buildAfterTryInLabel(material: string): string {
  return `${String(material || '').trim()} after try in`;
}

/** Strip qty suffix: "try in before emax (20)" → base + qty */
export function splitWorkPart(part: string): { base: string; qty: number | null } {
  const raw = String(part || '').trim();
  const match = raw.match(/^(.*?)(?:\s*\((\d+)\))\s*$/);
  if (!match) return { base: raw, qty: null };
  return { base: match[1].trim(), qty: match[2] ? parseInt(match[2], 10) : null };
}

export function parseTryInBeforeMaterial(workType: string): string | null {
  const { base } = splitWorkPart(String(workType || '').trim());
  // Drop Modification/Redo prefixes for detection
  let cleaned = base;
  if (cleaned.startsWith('Modification - ')) cleaned = cleaned.slice('Modification - '.length);
  if (cleaned.startsWith('Redo - ')) cleaned = cleaned.slice('Redo - '.length);
  if (cleaned.startsWith('Remake - ')) cleaned = cleaned.slice('Remake - '.length);

  // Single-part only for spawn flow
  const first = cleaned.split('+')[0]?.trim() || '';
  const { base: partBase } = splitWorkPart(first);
  const m =
    partBase.match(TRY_IN_BEFORE_RE) ||
    partBase.match(TRAY_IN_BEFORE_RE);
  if (!m?.[1]) return null;
  const material = m[1].trim();
  return material || null;
}

export function isTryInBeforeWorkType(workType: string): boolean {
  return !!parseTryInBeforeMaterial(workType);
}

export function parseAfterTryInMaterial(workType: string): string | null {
  const { base } = splitWorkPart(String(workType || '').trim());
  let cleaned = base;
  if (cleaned.startsWith('Modification - ')) cleaned = cleaned.slice('Modification - '.length);
  if (cleaned.startsWith('Redo - ')) cleaned = cleaned.slice('Redo - '.length);
  const first = cleaned.split('+')[0]?.trim() || '';
  const { base: partBase } = splitWorkPart(first);
  const m =
    partBase.match(AFTER_TRY_IN_RE) ||
    partBase.match(AFTER_TRAY_IN_ALT_RE) ||
    partBase.match(AFTER_TRAY_IN_RE);
  if (!m?.[1]) return null;
  return m[1].trim() || null;
}

/** Apply phase to a material display name (without qty). */
export function applyWorkPhaseToName(materialDisplayName: string, phase: WorkPhase | ''): string {
  const name = String(materialDisplayName || '').trim();
  if (!name || !phase) return name;
  if (phase === 'prova') return buildTryInBeforeLabel(name);
  return name;
}

/**
 * When editing, recover base chip material + phase from saved work type part.
 */
export function parseMaterialAndPhaseFromPart(
  partName: string
): { material: string; phase: WorkPhase | '' } {
  const raw = String(partName || '').trim();
  const before =
    raw.match(TRY_IN_BEFORE_RE) || raw.match(TRAY_IN_BEFORE_RE);
  if (before?.[1]) {
    return { material: before[1].trim(), phase: 'prova' };
  }
  const after =
    raw.match(AFTER_TRY_IN_RE) ||
    raw.match(AFTER_TRAY_IN_ALT_RE) ||
    raw.match(AFTER_TRAY_IN_RE);
  if (after?.[1]) {
    return { material: after[1].trim(), phase: 'final' };
  }
  return { material: raw, phase: '' };
}

export function formatWorkPartWithQty(displayName: string, qty: number, forceQty: boolean): string {
  if (forceQty || qty > 1) return `${displayName} (${qty})`;
  return displayName;
}
