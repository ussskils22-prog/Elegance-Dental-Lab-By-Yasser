/**
 * One definition of "when is this case due" and "is it late / stuck", shared by
 * the alerts endpoint, the operations report and the scheduled summary.
 */
const { cairoDateTimeToUtc } = require('./cairoTime');

const META = '__META__\n';
const STUCK_HOURS = 48;
const SOON_HOURS = 24;

function metaOf(doc) {
  const notes = String(doc?.notes || '');
  if (!notes.startsWith(META)) return {};
  try {
    return JSON.parse(notes.slice(META.length)) || {};
  } catch {
    return {};
  }
}

/**
 * Delivery deadline: the form's delivery date (+ time) in Cairo time.
 * A date with no time is due at 23:59 Cairo that day.
 */
function caseDueAt(doc) {
  const meta = metaOf(doc);
  if (meta.deliveryDate) {
    const at = cairoDateTimeToUtc(meta.deliveryDate, meta.deliveryTime || '23:59');
    if (at) return at;
  }
  // dueDate is NOT used: the client and print flow fill it with now+7d when no delivery
  // date was chosen (and re-slide it on every edit), so it is not a real promise to a doctor.
  return null;
}

/** When the case entered its current stage (falls back to creation time). */
function stageEnteredAt(doc) {
  const ts = doc?.stageTimestamps || {};
  const raw = ts[doc?.currentStage] || doc?.updatedAt || doc?.createdAt;
  const d = raw ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/**
 * Classify a case for alerts/reports. Exited cases return null.
 * Ready (completed) cases are "readyWaiting", never "overdue": the lab finished them.
 */
function classifyCase(doc, now = new Date()) {
  const stage = String(doc?.currentStage || '');
  if (stage === 'exited' || doc?.status === 'exited') return null;
  const due = caseDueAt(doc);
  const ready = stage === 'completed';
  const entered = stageEnteredAt(doc);
  const hoursInStage = entered ? Math.floor((now.getTime() - entered.getTime()) / 3600000) : null;
  const msLeft = due ? due.getTime() - now.getTime() : null;
  return {
    due,
    readyWaiting: ready,
    overdue: !ready && msLeft !== null && msLeft < 0,
    dueSoon: !ready && msLeft !== null && msLeft >= 0 && msLeft <= SOON_HOURS * 3600000,
    stuck: !ready && hoursInStage !== null && hoursInStage > STUCK_HOURS,
    hoursOverdue: msLeft !== null && msLeft < 0 ? Math.floor(-msLeft / 3600000) : 0,
    hoursInStage,
  };
}

module.exports = { caseDueAt, classifyCase, metaOf, STUCK_HOURS, SOON_HOURS };
