/**
 * Who among doctors / students / labs is really working with the lab right now.
 *
 *  - "Idle" (خامل): no case in the last IDLE_DAYS days (a new account counts from the day it
 *    was added). Idle is only a label for the admin counters — the account still logs in and
 *    secretaries can still pick it; the next case makes it active again by itself.
 *  - "Stopped" (موقوف): isActive=false, set by the admin. purgeStoppedClients deletes those.
 */
const { normalizeDoctorKey } = require('../utils/doctorName');
const { CLIENT_PORTAL_ROLES } = require('../utils/clientRoles');

const IDLE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Pure: is this client idle? lastCaseAt / createdAt may be missing. */
function isIdle({ lastCaseAt, createdAt }, now = new Date()) {
  const times = [lastCaseAt, createdAt].map((d) => (d ? new Date(d).getTime() : NaN)).filter(Number.isFinite);
  if (!times.length) return false;
  return now.getTime() - Math.max(...times) > IDLE_DAYS * DAY_MS;
}

/** Map of user id → date of that client's newest case (linked by account id or by the same name). */
async function lastCaseDates(users) {
  const DentalCase = require('../models/DentalCase');
  const clients = users.filter((u) => CLIENT_PORTAL_ROLES.includes(String(u.role || '').toLowerCase()));
  const out = new Map();
  if (!clients.length) return out;
  const [byId, byName] = await Promise.all([
    DentalCase.aggregate([
      { $match: { referringDoctorId: { $in: clients.map((u) => u._id) } } },
      { $group: { _id: '$referringDoctorId', last: { $max: '$createdAt' } } },
    ]),
    DentalCase.aggregate([{ $group: { _id: '$referringDoctor', last: { $max: '$createdAt' } } }]),
  ]);
  const newestByKey = new Map();
  for (const r of byName) {
    const key = normalizeDoctorKey(r._id);
    if (!key || !r.last) continue;
    const prev = newestByKey.get(key);
    if (!prev || r.last > prev) newestByKey.set(key, r.last);
  }
  const idLast = new Map(byId.map((r) => [String(r._id), r.last]));
  for (const u of clients) {
    const dates = [idLast.get(String(u._id)), newestByKey.get(normalizeDoctorKey(u.fullName))].filter(Boolean);
    if (dates.length) out.set(String(u._id), new Date(Math.max(...dates.map((d) => new Date(d).getTime()))));
  }
  return out;
}

/**
 * Delete every stopped (isActive=false) doctor / student / lab account, even with history.
 * Cases and payments are kept and still carry the name; only the login account goes, and
 * cases that pointed at it by id are unlinked. Dry run unless apply=true.
 */
async function purgeStoppedClients({ apply = false } = {}) {
  const User = require('../models/User');
  const DentalCase = require('../models/DentalCase');
  const stopped = await User.find({ role: { $in: CLIENT_PORTAL_ROLES }, isActive: false }).select('fullName role');
  const ids = stopped.map((u) => u._id);
  const linked = ids.length
    ? await DentalCase.aggregate([
        { $match: { referringDoctorId: { $in: ids } } },
        { $group: { _id: '$referringDoctorId', n: { $sum: 1 } } },
      ])
    : [];
  const casesById = new Map(linked.map((r) => [String(r._id), r.n]));
  const accounts = stopped.map((u) => ({
    id: String(u._id),
    name: u.fullName,
    role: u.role,
    linkedCases: casesById.get(String(u._id)) || 0,
  }));
  if (apply && ids.length) {
    await DentalCase.updateMany({ referringDoctorId: { $in: ids } }, { $unset: { referringDoctorId: 1 } }, { timestamps: false });
    await User.deleteMany({ _id: { $in: ids }, isActive: false });
  }
  return { applied: Boolean(apply), count: accounts.length, accounts };
}

module.exports = { IDLE_DAYS, isIdle, lastCaseDates, purgeStoppedClients };
