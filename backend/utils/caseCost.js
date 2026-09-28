/**
 * Estimate billable case cost from caseType + doctor/lab custom prices.
 * Used only to backfill paid cases that were marked paid with salaryAmount = 0.
 * Does NOT overwrite cases that already have a positive salaryAmount.
 */

const DEFAULT_PRICES = {
  emax: 1000,
  germanZircon: 850,
  zircon: 700,
  titanium: 2200,
  peek: 1700,
  pmma: 250,
  nightGuard: 300,
  nightGuardSoft: 300,
  nightGuardHard: 300,
  mockup: 250,
  wax: 0,
  ring: 0,
  tryIn: 0,
  removableDenture: 0,
  removableDentureFlex: 0,
  removableDentureAcrylic: 0,
};

const SUBTYPE_PARENT = {
  nightGuardSoft: 'nightGuard',
  nightGuardHard: 'nightGuard',
  removableDentureFlex: 'removableDenture',
  removableDentureAcrylic: 'removableDenture',
};

function parseNotesMeta(notes) {
  const prefix = '__META__\n';
  if (!notes || typeof notes !== 'string' || !notes.startsWith(prefix)) return {};
  try {
    return JSON.parse(notes.slice(prefix.length));
  } catch {
    return {};
  }
}

function normalizeAccountKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isExcludedFromBilling(caseType) {
  const ct = String(caseType || '').toLowerCase();
  return (
    ct.includes('redo') ||
    ct.includes('remake') ||
    ct.includes('modification') ||
    ct.includes('تعديل') ||
    ct.includes('اعاده') ||
    ct.includes('إعادة') ||
    ct.includes('غير معروف') ||
    ct.includes('unknown') ||
    ct.includes('empty') ||
    ct.includes('try in') ||
    ct.includes('tryin')
  );
}

function priceForKey(custom, priceKey) {
  const raw = custom?.[priceKey];
  if (raw !== undefined && raw !== null && Number.isFinite(Number(raw))) {
    return Number(raw);
  }
  const parent = SUBTYPE_PARENT[priceKey];
  if (parent) {
    const parentRaw = custom?.[parent];
    if (parentRaw !== undefined && parentRaw !== null && Number.isFinite(Number(parentRaw))) {
      return Number(parentRaw);
    }
    return DEFAULT_PRICES[priceKey] ?? DEFAULT_PRICES[parent] ?? 0;
  }
  return DEFAULT_PRICES[priceKey] ?? 0;
}

function priceKeyFromPart(lowerPart) {
  if (lowerPart.includes('night guard') || lowerPart.includes('nightguard')) {
    if (lowerPart.includes('soft')) return 'nightGuardSoft';
    if (lowerPart.includes('hard')) return 'nightGuardHard';
    return 'nightGuard';
  }
  if (lowerPart.includes('removable denture')) {
    if (lowerPart.includes('flex')) return 'removableDentureFlex';
    if (lowerPart.includes('acrylic')) return 'removableDentureAcrylic';
    return 'removableDenture';
  }
  if (lowerPart.includes('emax')) return 'emax';
  if (lowerPart.includes('german zircon') || lowerPart.includes('german')) return 'germanZircon';
  if (lowerPart.includes('zircon')) return 'zircon';
  if (lowerPart.includes('titanium')) return 'titanium';
  if (lowerPart.includes('peek')) return 'peek';
  if (lowerPart.includes('pmma')) return 'pmma';
  if (lowerPart.includes('mokup') || lowerPart.includes('mockup')) return 'mockup';
  if (lowerPart.includes('wax')) return 'wax';
  if (lowerPart.includes('ring')) return 'ring';
  if (lowerPart.includes('try in') || lowerPart.includes('tryin')) return 'tryIn';
  return '';
}

function resolveAccountName(doc) {
  const notesMeta = parseNotesMeta(doc.notes || '');
  const doctorName =
    String(
      notesMeta.doctor ||
        notesMeta.doctorName ||
        doc.referringDoctor ||
        (doc.assignedTo && doc.assignedTo.fullName) ||
        ''
    ).trim() || 'غير محدد';
  const labName = String(notesMeta.labName || '').trim();
  const requesterRaw = String(notesMeta.requesterType || doc.requesterType || 'doctor').toLowerCase();
  const isLab = requesterRaw === 'lab' || !!labName;
  return isLab ? labName || doctorName : doctorName;
}

function calculateCaseCost(doc, pricesByDoctorKey) {
  const caseType = String(doc.caseType || '');
  if (isExcludedFromBilling(caseType)) return 0;

  const account = resolveAccountName(doc);
  const custom = pricesByDoctorKey.get(normalizeAccountKey(account)) || {};
  const notesMeta = parseNotesMeta(doc.notes || '');
  const overallQty = Number(doc.quantity ?? notesMeta.quantity ?? 1) || 1;

  let total = 0;
  const parts = caseType.split('+').map((p) => p.trim()).filter(Boolean);
  for (const part of parts.length ? parts : [caseType]) {
    const lower = part.toLowerCase();
    const m = part.match(/\((\d+)\)/);
    const qty = m ? parseInt(m[1], 10) : overallQty;
    const key = priceKeyFromPart(lower);
    if (key) total += qty * priceForKey(custom, key);
  }
  return total;
}

/**
 * Backfill salaryAmount for paid cases stuck at 0.
 * Safe: only touches paymentStatus=paid AND salaryAmount<=0.
 * Returns { scanned, repaired, ids }.
 */
async function repairPaidZeroSalaries({ DentalCase, DoctorPricing, CashEntry, userId }) {
  const broken = await DentalCase.find({
    paymentStatus: 'paid',
    $or: [{ salaryAmount: { $exists: false } }, { salaryAmount: null }, { salaryAmount: 0 }],
  });

  if (!broken.length) {
    return { scanned: 0, repaired: 0, ids: [] };
  }

  const pricings = await DoctorPricing.find({}).lean();
  const pricesByDoctorKey = new Map();
  for (const p of pricings) {
    pricesByDoctorKey.set(normalizeAccountKey(p.doctorName), p.prices || {});
  }

  const ids = [];
  for (const dentalCase of broken) {
    const amount = calculateCaseCost(dentalCase, pricesByDoctorKey);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    dentalCase.salaryAmount = amount;
    if (!dentalCase.paidAt) dentalCase.paidAt = new Date();
    await dentalCase.save();
    ids.push(String(dentalCase._id));

    if (CashEntry) {
      try {
        const existing = await CashEntry.findOne({ caseId: dentalCase._id, type: 'income' });
        const account = resolveAccountName(dentalCase);
        const note = 'Case ' + dentalCase.caseNumber + ' — ' + account;
        if (existing) {
          existing.amount = amount;
          existing.date = dentalCase.paidAt || new Date();
          existing.notes = note;
          existing.category = 'case_payment';
          await existing.save();
        } else {
          await CashEntry.create({
            type: 'income',
            amount,
            date: dentalCase.paidAt || new Date(),
            category: 'case_payment',
            notes: note,
            createdBy: userId || null,
            caseId: dentalCase._id,
          });
        }
      } catch (cashErr) {
        console.error('repairPaidZeroSalaries cash sync failed:', cashErr);
      }
    }
  }

  return { scanned: broken.length, repaired: ids.length, ids };
}

module.exports = {
  calculateCaseCost,
  repairPaidZeroSalaries,
  normalizeAccountKey,
  resolveAccountName,
};
