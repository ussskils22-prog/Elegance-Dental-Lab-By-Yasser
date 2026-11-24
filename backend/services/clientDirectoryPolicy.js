/**
 * Who may add which clients, and when a case must use an existing one.
 *
 * Doctors and labs are few and stable: only the admin adds or removes them, and everyone
 * else picks from the list — so two secretaries can never create "شيماء" and "معمل شيماء".
 * Students arrive daily, so reception keeps adding them directly.
 */
const { isClientPortalRole } = require('../utils/clientRoles');
const { normalizeDoctorKey } = require('../utils/doctorName');

const LIST_ONLY_TYPES = new Set(['doctor', 'lab']);

function normType(t) {
  return t === 'lab' ? 'lab' : t === 'student' ? 'student' : 'doctor';
}

/** May this user create a new client account of this type? */
function canAddClient(userRole, clientType) {
  if (String(userRole) === 'admin') return true;
  return normType(clientType) === 'student';
}

/** Must a case of this requester type use an existing account (non-admin staff only)? */
function mustPickFromList(userRole, requesterType) {
  const role = String(userRole || '');
  if (role === 'admin' || isClientPortalRole(role)) return false;
  return LIST_ONLY_TYPES.has(normType(requesterType));
}

function notInListMessage(requesterType, name) {
  const kind = normType(requesterType) === 'lab' ? 'المعمل' : 'الدكتور';
  return `${kind} «${name}» مش موجود في القائمة. اختار الاسم من القائمة، ولو ${kind} جديد اطلب من الأدمن يضيفه.`;
}

/** Active account of that type whose name is the same doctor/lab (normalized). */
async function findClientAccount(name, requesterType) {
  const key = normalizeDoctorKey(name);
  if (!key) return null;
  const User = require('../models/User');
  const users = await User.find({ role: normType(requesterType), isActive: true }).select('fullName role').lean();
  return users.find((u) => normalizeDoctorKey(u.fullName) === key) || null;
}

module.exports = { canAddClient, mustPickFromList, notInListMessage, findClientAccount, LIST_ONLY_TYPES };
