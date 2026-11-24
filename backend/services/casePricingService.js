/**
 * Shared case pricing helpers — dynamic materials from DB + doctor overrides.
 */

const Material = require('../models/Material');
const DEFAULT_MATERIALS = require('../data/defaultMaterials');
const {
  normalizeCaseTypeParts,
  splitNormalizedCaseTypeParts,
  isExcludedWorkPart,
  isWholeCaseExcluded,
} = require('../utils/caseTypeParts');

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
    if (!m?.key) continue;
    const n = Number(m.defaultPrice) || 0;
    prices[m.key] = n;
    prices[String(m.key).toLowerCase()] = n;
  }
  // Ensure FALLBACK camelCase keys also have lowercase aliases
  for (const [k, v] of Object.entries(FALLBACK_PRICES)) {
    const lower = String(k).toLowerCase();
    if (prices[lower] === undefined) prices[lower] = v;
  }
  return prices;
}

function lookupPrice(prices, key, fallback = 0) {
  if (!prices || !key) return fallback;
  if (prices[key] !== undefined && prices[key] !== null && prices[key] !== '') {
    const n = Number(prices[key]);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const lower = String(key).toLowerCase();
  if (prices[lower] !== undefined && prices[lower] !== null && prices[lower] !== '') {
    const n = Number(prices[lower]);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  // Scan case-insensitive (covers germanZircon vs germanzircon)
  for (const [k, v] of Object.entries(prices)) {
    if (String(k).toLowerCase() !== lower) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}

function resolvePrices(custom, labDefaults) {
  const base = { ...(labDefaults || FALLBACK_PRICES) };
  if (custom && typeof custom === 'object') {
    for (const [k, v] of Object.entries(custom)) {
      if (v === undefined || v === null || v === '') continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) continue;
      base[k] = n;
      base[String(k).toLowerCase()] = n;
      // Also overwrite any existing key that only differs by case
      for (const existing of Object.keys(base)) {
        if (existing !== k && String(existing).toLowerCase() === String(k).toLowerCase()) {
          base[existing] = n;
        }
      }
    }
  }
  return base;
}

// Doctor identity: exact normalized match only (see utils/doctorName.js).
// The old "one name contains the other" rule merged different doctors.
const { normalizeDoctorKey, doctorKeysMatch } = require('../utils/doctorName');

/** True when every part is redo/mod/empty/unknown (mixed New+Redo is false). */
function isExcludedWorkCaseType(caseType) {
  return isWholeCaseExcluded(caseType);
}

/** True when case must not count in billing / materials (type or meta flags). */
function isNonBillableCase(caseType, metaOrNotes) {
  if (isExcludedWorkCaseType(caseType)) return true;
  const meta =
    metaOrNotes && typeof metaOrNotes === 'object' && !Array.isArray(metaOrNotes)
      ? metaOrNotes
      : parseNotesMeta(metaOrNotes || '');
  // Whole-case meta flags only when there is no mixed/new billable encoding.
  if (meta.isRedoCase || meta.isModificationCase) {
    const parts = splitNormalizedCaseTypeParts(caseType);
    const hasBillable = parts.some((p) => !isExcludedWorkPart(p));
    if (!hasBillable) return true;
  }
  return false;
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

/** Keep pricing aligned with try-in phase labels (before / after). Case-insensitive. */
function normalizeMaterialPartForPricing(lowerPart) {
  let lower = String(lowerPart || '').toLowerCase();
  if (/try\s*in\s+before|tray\s*in\s+before|tary\s*in\s+before/.test(lower)) {
    return 'try in';
  }
  return lower
    .replace(/\s+after\s+try\s*in/gi, '')
    .replace(/\s+after\s+tray\s*in/gi, '')
    .replace(/\s+after\s+tary\s*in/gi, '')
    .trim();
}

function isTryInPricingPart(lowerPart) {
  const s = String(lowerPart || '').toLowerCase();
  if (/\bafter\s+try\s*in\b|\bafter\s+tray\s*in\b|\bafter\s+tary\s*in\b/.test(s)) {
    return false;
  }
  return /try\s*in|tryin|tray\s*in|tary\s*in/.test(s);
}

/**
 * Match a caseType part against material keywords (longest keyword first).
 * Try-in / "try in before X" always bills at tryIn — never the embedded final material.
 */
function resolvePartUnitPrice(lowerPart, prices, materials) {
  const mats = materials || DEFAULT_MATERIALS;
  const raw = String(lowerPart || '').toLowerCase();

  if (isTryInPricingPart(raw)) {
    const tryIn =
      mats.find((m) => String(m.key).toLowerCase() === 'tryin') ||
      DEFAULT_MATERIALS.find((m) => String(m.key).toLowerCase() === 'tryin');
    if (tryIn) {
      const unitPrice = lookupPrice(prices, tryIn.key, Number(tryIn.defaultPrice) || 0);
      return { label: tryIn.label || 'Try in', key: tryIn.key, unitPrice };
    }
    return { label: 'Try in', key: 'tryIn', unitPrice: lookupPrice(prices, 'tryIn', 0) };
  }

  const normalized = normalizeMaterialPartForPricing(raw);
  let best = null;
  let bestLen = -1;
  for (const m of mats) {
    if (String(m.key).toLowerCase() === 'tryin') continue;
    const keywords = (m.matchKeywords || []).map((k) => String(k).toLowerCase()).filter(Boolean);
    for (const kw of keywords) {
      if (normalized.includes(kw) && kw.length > bestLen) {
        bestLen = kw.length;
        best = m;
      }
    }
  }
  if (!best) return null;
  const unitPrice = lookupPrice(prices, best.key, Number(best.defaultPrice) || 0);
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
  const parts = splitNormalizedCaseTypeParts(caseType);
  const caseOverallQuantity = Number(meta.quantity ?? 1) || 1;

  let total = 0;
  let quantity = 0;
  const lines = [];

  for (const part of parts) {
    if (isExcludedWorkPart(part)) continue;
    const lowerPart = part.toLowerCase();
    const match = part.match(/\((\d+)\)/);
    const qty = match ? parseInt(match[1], 10) : caseOverallQuantity;
    // Try-in / "try in before X" bills at tryIn price (not the final material price).
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
  const want = String(doctorName).trim().toLowerCase();
  const exact = pricings.find((p) => String(p.doctorName || '').trim().toLowerCase() === want);
  if (exact) return exact;
  const wantKey = normalizeDoctorKey(doctorName);
  if (wantKey) {
    const byKey = pricings.find((p) => normalizeDoctorKey(p.doctorName) === wantKey);
    if (byKey) return byKey;
  }
  return pricings.find((p) => doctorKeysMatch(p.doctorName, doctorName)) || null;
}

/**
 * Merge prices from EVERY DoctorPricing row that matches this doctor name.
 * Fixes empty exact row "فرزات" winning over "د. فرزات" that has germanZircon:75.
 */
function mergePricesForDoctor(pricings, doctorName) {
  if (!Array.isArray(pricings) || !doctorName) return null;
  const want = String(doctorName).trim().toLowerCase();
  const wantKey = normalizeDoctorKey(doctorName);
  const matches = pricings.filter((p) => {
    const name = String(p.doctorName || '').trim();
    if (!name) return false;
    if (name.toLowerCase() === want) return true;
    if (wantKey && normalizeDoctorKey(name) === wantKey) return true;
    return doctorKeysMatch(name, doctorName);
  });
  if (!matches.length) return null;

  const sorted = [...matches].sort((a, b) => {
    const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return ta - tb;
  });

  const merged = {};
  for (const row of sorted) {
    const prices = row.prices && typeof row.prices === 'object' ? row.prices : {};
    for (const [k, v] of Object.entries(prices)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) continue;
      merged[k] = n;
      merged[String(k).toLowerCase()] = n;
    }
  }
  return Object.keys(merged).length ? merged : null;
}

/**
 * Rewrite unpaid exited case bills for a doctor using current (or provided) prices.
 * Paid cases are left untouched. Returns how many cases were updated.
 */
async function repriceUnpaidExitedCasesForDoctor(doctorName, pricesOverride = null) {
  const DentalCase = require('../models/DentalCase');
  const DoctorPricing = require('../models/DoctorPricing');
  const name = String(doctorName || '').trim();
  if (!name) return { updated: 0 };

  const materials = await loadActiveMaterials();
  const labDefaults = materialsToDefaultPrices(materials);

  let prices = pricesOverride;
  if (!prices || typeof prices !== 'object') {
    const pricings = await DoctorPricing.find().lean();
    prices = mergePricesForDoctor(pricings, name);
  }

  const cases = await DentalCase.find({
    currentStage: 'exited',
    $or: [{ paymentStatus: { $exists: false } }, { paymentStatus: { $ne: 'paid' } }],
  }).select(
    'caseNumber caseType notes referringDoctor salaryAmount revenueAmount billSnapshot paymentStatus materialCost caseProfit'
  );

  let updated = 0;
  for (const dentalCase of cases) {
    const meta = parseNotesMeta(dentalCase.notes || '');
    const caseDoctor = String(
      dentalCase.referringDoctor || meta.doctor || meta.doctorName || ''
    ).trim();
    if (!doctorKeysMatch(caseDoctor, name)) continue;
    if (isNonBillableCase(dentalCase.caseType, meta)) continue;

    const breakdown = calculateCaseCostBreakdown(
      dentalCase.caseType,
      dentalCase.notes,
      prices,
      materials,
      labDefaults
    );
    const total = Math.round((Number(breakdown.total) || 0) * 100) / 100;
    dentalCase.salaryAmount = total;
    dentalCase.revenueAmount = total;
    dentalCase.billSnapshot = {
      doctorName: caseDoctor,
      pricedAt: new Date().toISOString(),
      quantity: breakdown.quantity || 0,
      unitPrice: breakdown.unitPrice || 0,
      total,
      lines: breakdown.lines || [],
      priceSource: prices ? 'doctor-pricing' : 'lab-default',
    };
    dentalCase.markModified('billSnapshot');

    const cogs = Math.max(0, Number(dentalCase.materialCost) || 0);
    dentalCase.caseProfit = Math.round((total - cogs) * 100) / 100;

    await dentalCase.save();
    updated += 1;
  }

  return { updated };
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
  normalizeCaseTypeParts,
  splitNormalizedCaseTypeParts,
  isExcludedWorkPart,
  isWholeCaseExcluded,
  parseNotesMeta,
  resolvePrices,
  resolvePartUnitPrice,
  calculateCaseCostBreakdown,
  calculateCaseCost,
  calculateCaseCostAsync,
  calculateCaseCostBreakdownAsync,
  findPricingForDoctor,
  mergePricesForDoctor,
  repriceUnpaidExitedCasesForDoctor,
};
