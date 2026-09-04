/**
 * Shared case pricing helpers — dynamic materials from DB + doctor overrides.
 */

const Material = require('../models/Material');
const DEFAULT_MATERIALS = require('../data/defaultMaterials');

const FALLBACK_PRICES = Object.fromEntries(
  DEFAULT_MATERIALS.map((m) => [m.key, Number(m.defaultPrice) || 0])
);

let materialsCache = null;
let materialsCacheAt = 0;
const CACHE_MS = 60_000;

function invalidateMaterialCache() {
  materialsCache = null;
  materialsCacheAt = 0;
}

async function loadActiveMaterials() {
  const now = Date.now();
  if (materialsCache && now - materialsCacheAt < CACHE_MS) {
    return materialsCache;
  }
  try {
    const mats = await Material.find({ active: true }).sort({ sortOrder: 1 }).lean();
    materialsCache = mats.length ? mats : DEFAULT_MATERIALS;
  } catch {
    materialsCache = DEFAULT_MATERIALS;
  }
  materialsCacheAt = now;
  return materialsCache;
}

function materialsToDefaultPrices(materials) {
  const prices = { ...FALLBACK_PRICES };
  for (const m of materials || []) {
    if (m?.key) prices[m.key] = Number(m.defaultPrice) || 0;
  }
  return prices;
}

/** Normalize doctor name for matching (titles stripped). */
function normalizeDoctorKey(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/^(د\.|د|dr\.|dr|doctor|أ\.|ا\.)\s*/i, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function doctorKeysMatch(a, b) {
  const ka = normalizeDoctorKey(a);
  const kb = normalizeDoctorKey(b);
  if (!ka || !kb) return false;
  return ka === kb || ka.includes(kb) || kb.includes(ka);
}

function isExcludedWorkCaseType(caseType) {
  const ct = String(caseType || '').toLowerCase();
  return (
    ct.includes('redo') ||
    ct.includes('remake') ||
    ct.includes('modification') ||
    ct.includes('تعديل') ||
    ct.includes('اعاده') ||
    ct.includes('إعادة') ||
    ct.includes('empty') ||
    ct.includes('غير معروف') ||
    ct.includes('unknown')
  );
}

/** True when case must not count in billing / materials (type or meta flags). */
function isNonBillableCase(caseType, metaOrNotes) {
  if (isExcludedWorkCaseType(caseType)) return true;
  const meta =
    metaOrNotes && typeof metaOrNotes === 'object' && !Array.isArray(metaOrNotes)
      ? metaOrNotes
      : parseNotesMeta(metaOrNotes || '');
  return !!(meta.isRedoCase || meta.isModificationCase);
}

function parseNotesMeta(notes) {
  const prefix = '__META__\n';
  if (!notes || typeof notes !== 'string' || !notes.startsWith(prefix)) return {};
  try {
    return JSON.parse(notes.slice(prefix.length));
  } catch {
    return {};
  }
}

function resolvePrices(custom, labDefaults) {
  const base = { ...(labDefaults || FALLBACK_PRICES) };
  if (custom && typeof custom === 'object') {
    for (const [k, v] of Object.entries(custom)) {
      if (v === undefined || v === null || v === '') continue;
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) base[k] = n;
    }
  }
  return base;
}

/** Keep pricing aligned with try-in phase labels (before / after). */
function normalizeMaterialPartForPricing(lowerPart) {
  let lower = String(lowerPart || '').toLowerCase();
  if (/try\s*in\s+before|tray\s*in\s+before/.test(lower)) {
    return 'try in';
  }
  return lower
    .replace(/\s+after\s+try\s*in/gi, '')
    .replace(/\s+after\s+tray\s*in/gi, '')
    .replace(/\s+after\s+tary\s*in/gi, '')
    .trim();
}

/**
 * Match a caseType part against material keywords (longest keyword first).
 */
function resolvePartUnitPrice(lowerPart, prices, materials) {
  const mats = materials || DEFAULT_MATERIALS;
  const normalized = normalizeMaterialPartForPricing(lowerPart);
  let best = null;
  let bestLen = -1;
  for (const m of mats) {
    const keywords = (m.matchKeywords || []).map((k) => String(k).toLowerCase()).filter(Boolean);
    for (const kw of keywords) {
      if (normalized.includes(kw) && kw.length > bestLen) {
        bestLen = kw.length;
        best = m;
      }
    }
  }
  if (!best) return null;
  const unitPrice = prices[best.key] ?? (Number(best.defaultPrice) || 0);
  return { label: best.label, key: best.key, unitPrice };
}

function calculateCaseCostBreakdown(caseType, metaOrNotes, customPrices, materials, labDefaults) {
  if (isNonBillableCase(caseType, metaOrNotes)) {
    return { total: 0, quantity: 0, unitPrice: 0, lines: [] };
  }

  const meta =
    metaOrNotes && typeof metaOrNotes === 'object' && !Array.isArray(metaOrNotes)
      ? metaOrNotes
      : parseNotesMeta(metaOrNotes || '');

  const prices = resolvePrices(customPrices, labDefaults || materialsToDefaultPrices(materials));
  const parts = String(caseType || '')
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  const caseOverallQuantity = Number(meta.quantity ?? 1) || 1;

  let total = 0;
  let quantity = 0;
  const lines = [];

  for (const part of parts) {
    const lowerPart = part.toLowerCase();
    const match = part.match(/\((\d+)\)/);
    const qty = match ? parseInt(match[1], 10) : caseOverallQuantity;
    const resolved = resolvePartUnitPrice(lowerPart, prices, materials);
    if (!resolved) continue;

    const lineTotal = qty * resolved.unitPrice;
    total += lineTotal;
    quantity += qty;
    lines.push({
      label: resolved.label,
      key: resolved.key,
      quantity: qty,
      unitPrice: resolved.unitPrice,
      lineTotal,
    });
  }

  const unitPrice =
    lines.length === 1
      ? lines[0].unitPrice
      : quantity > 0
        ? Math.round((total / quantity) * 100) / 100
        : 0;

  return { total, quantity, unitPrice, lines };
}

function calculateCaseCost(caseType, metaOrNotes, customPrices, materials, labDefaults) {
  return calculateCaseCostBreakdown(caseType, metaOrNotes, customPrices, materials, labDefaults)
    .total;
}

/** Async wrapper that loads materials from DB. */
async function calculateCaseCostAsync(caseType, metaOrNotes, customPrices) {
  const materials = await loadActiveMaterials();
  const labDefaults = materialsToDefaultPrices(materials);
  return calculateCaseCost(caseType, metaOrNotes, customPrices, materials, labDefaults);
}

async function calculateCaseCostBreakdownAsync(caseType, metaOrNotes, customPrices) {
  const materials = await loadActiveMaterials();
  const labDefaults = materialsToDefaultPrices(materials);
  return calculateCaseCostBreakdown(caseType, metaOrNotes, customPrices, materials, labDefaults);
}

function findPricingForDoctor(pricings, doctorName) {
  if (!Array.isArray(pricings) || !doctorName) return null;
  const exact = pricings.find((p) => doctorKeysMatch(p.doctorName, doctorName));
  if (exact) return exact;
  const want = String(doctorName).trim().toLowerCase();
  return (
    pricings.find((p) => String(p.doctorName || '').trim().toLowerCase() === want) || null
  );
}

module.exports = {
  DEFAULT_PRICES: FALLBACK_PRICES,
  FALLBACK_PRICES,
  invalidateMaterialCache,
  loadActiveMaterials,
  materialsToDefaultPrices,
  normalizeDoctorKey,
  doctorKeysMatch,
  isExcludedWorkCaseType,
  isNonBillableCase,
  parseNotesMeta,
  resolvePrices,
  resolvePartUnitPrice,
  calculateCaseCostBreakdown,
  calculateCaseCost,
  calculateCaseCostAsync,
  calculateCaseCostBreakdownAsync,
  findPricingForDoctor,
};
