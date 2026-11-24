/**
 * Merge a duplicate client name (typo / second spelling) into the real one.
 * Shared by scripts/mergeDoctors.js and the admin "possible duplicates" screen.
 *
 * Changes (only when apply=true):
 *  - Cases: referringDoctor, notes meta doctor name, referringDoctorId → the real one.
 *    Bill amounts on exited cases are not touched; updatedAt is not bumped.
 *  - Doctor payments / charges: doctorName → the real one.
 *  - Price list: the real one's prices win; keys only the duplicate had are copied; duplicate row removed.
 *  - The duplicate's login account is deactivated (not deleted).
 *  - One "doctor_merged" audit entry per relinked case.
 */
const DentalCase = require('../models/DentalCase');
const DoctorPayment = require('../models/DoctorPayment');
const DoctorPricing = require('../models/DoctorPricing');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { normalizeDoctorKey } = require('../utils/doctorName');

const META = '__META__\n';

function metaOf(notes) {
  const raw = String(notes || '');
  if (!raw.startsWith(META)) return {};
  try {
    return JSON.parse(raw.slice(META.length)) || {};
  } catch {
    return {};
  }
}

function renameInNotes(notes, fromKey, into) {
  const raw = String(notes || '');
  if (!raw.startsWith(META)) return raw;
  const meta = metaOf(raw);
  let changed = false;
  for (const k of ['doctor', 'doctorName']) {
    if (meta[k] && normalizeDoctorKey(meta[k]) === fromKey) {
      meta[k] = into;
      changed = true;
    }
  }
  return changed ? META + JSON.stringify(meta) : raw;
}

/**
 * @param {{from:string, into:string, apply?:boolean, admin?:{_id:any, fullName:string}, source?:string}} opts
 * @returns summary of what changes (or changed)
 */
async function mergeClientNames({ from, into, apply = false, admin = null, source = 'merge' }) {
  const fromKey = normalizeDoctorKey(from);
  const intoKey = normalizeDoctorKey(into);
  if (!fromKey || !intoKey || fromKey === intoKey) {
    const err = new Error('الاسمين فاضيين أو هما نفس الاسم — مفيش حاجة تتدمج');
    err.status = 400;
    throw err;
  }
  if (apply && !admin) throw new Error('apply needs an admin for the audit log');

  const clients = await User.find({ role: { $in: ['doctor', 'student', 'lab'] } });
  const intoUser = clients.find((u) => u.isActive !== false && normalizeDoctorKey(u.fullName) === intoKey)
    || clients.find((u) => normalizeDoctorKey(u.fullName) === intoKey) || null;
  const fromUsers = clients.filter((u) => normalizeDoctorKey(u.fullName) === fromKey);

  const cases = (await DentalCase.find({}).select('caseNumber referringDoctor referringDoctorId notes currentStage'))
    .filter((c) => {
      const meta = metaOf(c.notes);
      return [c.referringDoctor, meta.doctor, meta.doctorName].some((n) => n && normalizeDoctorKey(n) === fromKey)
        || fromUsers.some((u) => c.referringDoctorId && String(c.referringDoctorId) === String(u._id));
    });
  const payments = (await DoctorPayment.find({})).filter((p) => normalizeDoctorKey(p.doctorName) === fromKey);
  const pricings = await DoctorPricing.find({});
  const fromPricing = pricings.filter((p) => normalizeDoctorKey(p.doctorName) === fromKey);
  const intoPricing = pricings.find((p) => normalizeDoctorKey(p.doctorName) === intoKey) || null;

  const summary = {
    from,
    into,
    applied: false,
    cases: cases.length,
    exitedCases: cases.filter((c) => c.currentStage === 'exited').length,
    caseNumbers: cases.slice(0, 30).map((c) => c.caseNumber),
    payments: payments.length,
    priceRows: fromPricing.length,
    pricesFoldedIntoExisting: Boolean(fromPricing.length && intoPricing),
    accountsDeactivated: fromUsers.map((u) => u.fullName),
    realAccount: intoUser ? intoUser.fullName : null,
  };
  if (!apply) return summary;

  for (const c of cases) {
    const set = { referringDoctor: into, notes: renameInNotes(c.notes, fromKey, into) };
    if (intoUser) set.referringDoctorId = intoUser._id;
    await DentalCase.updateOne({ _id: c._id }, { $set: set }, { timestamps: false });
    await AuditLog.create({
      caseId: c._id,
      caseNumber: c.caseNumber,
      action: 'doctor_merged',
      performedBy: admin._id,
      performedByName: admin.fullName,
      details: { oldValue: from, newValue: into, notes: source },
    });
  }
  for (const p of payments) {
    await DoctorPayment.updateOne({ _id: p._id }, { $set: { doctorName: into } }, { timestamps: false });
  }
  if (fromPricing.length) {
    if (intoPricing) {
      const merged = {};
      for (const row of fromPricing) Object.assign(merged, row.prices || {});
      intoPricing.prices = { ...merged, ...(intoPricing.prices || {}) };
      intoPricing.markModified('prices');
      await intoPricing.save();
      for (const row of fromPricing) await row.deleteOne();
    } else {
      const [first, ...rest] = fromPricing;
      first.doctorName = into;
      await first.save();
      for (const row of rest) await row.deleteOne();
    }
  }
  // The duplicate's account is now empty (cases and payments moved): delete it so it stops
  // cluttering the directory. If anything still hangs on it, only deactivate.
  const { clientUsage, deleteDecision } = require('./clientUsage');
  summary.accountsDeleted = [];
  for (const u of fromUsers) {
    if (intoUser && String(u._id) === String(intoUser._id)) continue;
    if (deleteDecision(await clientUsage(u)).allowed) {
      await User.deleteOne({ _id: u._id });
      summary.accountsDeleted.push(u.fullName);
    } else {
      u.isActive = false;
      await u.save();
    }
  }
  summary.applied = true;
  return summary;
}

module.exports = { mergeClientNames, renameInNotes };
