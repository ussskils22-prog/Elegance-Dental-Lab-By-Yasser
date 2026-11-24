/**
 * How much history hangs on a client account (doctor / student / lab):
 * cases linked by account id or by the same name, and payments under the same name.
 * Used to decide whether an account may be deleted or only deactivated.
 */
const { normalizeDoctorKey } = require('../utils/doctorName');

/** Pure: may this account be deleted? Accounts with any history must be deactivated instead. */
function deleteDecision(usage) {
  const cases = Number(usage?.cases) || 0;
  const payments = Number(usage?.payments) || 0;
  if (!cases && !payments) return { allowed: true, message: '' };
  const parts = [];
  if (cases) parts.push(`${cases} حالة`);
  if (payments) parts.push(`${payments} دفعة`);
  return {
    allowed: false,
    message: `الحساب ده عليه ${parts.join(' و')} — مينفعش يتحذف عشان التاريخ والحسابات ما تضيعش. أوقفه بدل ما تحذفه، أو ادمجه في الاسم الصح من «أسامي محتملة التكرار».`,
  };
}

async function clientUsage(user) {
  const DentalCase = require('../models/DentalCase');
  const DoctorPayment = require('../models/DoctorPayment');
  const key = normalizeDoctorKey(user?.fullName);
  const [byId, byName, payNames] = await Promise.all([
    DentalCase.countDocuments({ referringDoctorId: user._id }),
    DentalCase.aggregate([
      { $match: { $or: [{ referringDoctorId: null }, { referringDoctorId: { $exists: false } }, { referringDoctorId: { $ne: user._id } }] } },
      { $group: { _id: '$referringDoctor', n: { $sum: 1 } } },
    ]),
    DoctorPayment.aggregate([{ $group: { _id: '$doctorName', n: { $sum: 1 } } }]),
  ]);
  const sameName = (rows) => rows.filter((r) => key && normalizeDoctorKey(r._id) === key).reduce((s, r) => s + r.n, 0);
  return { cases: byId + sameName(byName), payments: sameName(payNames) };
}

module.exports = { deleteDecision, clientUsage };
