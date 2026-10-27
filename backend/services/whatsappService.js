/**
 * WhatsApp notifications via UltraMsg, Meta Cloud API, or WhatsApp Web (Baileys).
 * Config from: Admin UI (Mongo AppSettings) OR env vars.
 */
const User = require('../models/User');
const DentalCase = require('../models/DentalCase');

const DEFAULT_MSG_COMPLETED =
  '{lab}\nحالة ({patient})\n{workType} — {quantity} قطعة\nجاهزة للاستلام تواصل مع المعمل لاستلام الحالة';
const DEFAULT_MSG_EXITED =
  '{lab}\nحالة ({patient})\n{workType} — {quantity} قطعة\nتم التسليم / خرجت من المعمل';
const DEFAULT_MSG_DAILY =
  '{lab} — ملخص يومي\nعندك {count} حالات جاهزة للاستلام.\n{list}';
const OLD_MSG_COMPLETED =
  '{lab}\nالحالة {caseNumber} للمريض {patient} أصبحت منتهية وجاهزة.';
const OLD_MSG_EXITED =
  '{lab}\nالحالة {caseNumber} للمريض {patient} تم تسليمها/خرجت من المعمل.';

function normalizeMsgTemplate(saved, oldDefault, nextDefault) {
  const text = String(saved || '').trim();
  if (!text || text === oldDefault) return nextDefault;
  return text;
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

function caseMessageVars(dentalCase) {
  const meta = parseNotesMeta(dentalCase?.notes || '');
  const workType =
    String(meta.workType || dentalCase?.caseType || '').trim() || '—';
  const qtyRaw = meta.quantity ?? meta.qty;
  const quantity =
    qtyRaw !== undefined && qtyRaw !== null && qtyRaw !== '' && !Number.isNaN(Number(qtyRaw))
      ? String(Number(qtyRaw))
      : '1';
  return {
    lab: labLabel(),
    caseNumber: dentalCase?.caseNumber || '',
    patient: dentalCase?.patientName || '—',
    workType,
    quantity,
  };
}

/** @type {null | { enabled: boolean, provider: string, token: string, instanceId: string, phoneNumberId: string, dailyHour: number, labName: string, msgCompleted: string, msgExited: string, msgDaily: string }} */
let cachedConfig = null;

function configFromEnv() {
  const provider = String(process.env.WHATSAPP_PROVIDER || '').toLowerCase();
  return {
    enabled: !!provider,
    provider,
    token: String(process.env.WHATSAPP_TOKEN || ''),
    instanceId: String(process.env.WHATSAPP_INSTANCE_ID || ''),
    phoneNumberId: String(process.env.WHATSAPP_PHONE_NUMBER_ID || ''),
    dailyHour: Number(process.env.WHATSAPP_DAILY_HOUR || 18),
    labName: String(process.env.WHATSAPP_LAB_NAME || 'Elegance Dental Lab'),
    msgCompleted: DEFAULT_MSG_COMPLETED,
    msgExited: DEFAULT_MSG_EXITED,
    msgDaily: DEFAULT_MSG_DAILY,
    alertPhones: String(process.env.WHATSAPP_ALERT_PHONES || ''),
  };
}

function applyTemplate(template, vars) {
  let out = String(template || '');
  for (const [key, value] of Object.entries(vars || {})) {
    out = out.split(`{${key}}`).join(String(value ?? ''));
  }
  return out;
}

async function reloadWhatsAppConfig() {
  try {
    const AppSettings = require('../models/AppSettings');
    const doc = await AppSettings.findOne({ key: 'app' }).lean();
    if (
      doc?.whatsapp &&
      (doc.whatsapp.enabled ||
        doc.whatsapp.token ||
        String(doc.whatsapp.provider || '').toLowerCase() === 'waweb')
    ) {
      cachedConfig = {
        enabled: !!doc.whatsapp.enabled,
        provider: String(doc.whatsapp.provider || 'ultramsg').toLowerCase(),
        token: String(doc.whatsapp.token || ''),
        instanceId: String(doc.whatsapp.instanceId || ''),
        phoneNumberId: String(doc.whatsapp.phoneNumberId || ''),
        dailyHour: Number(doc.whatsapp.dailyHour ?? 18),
        labName: String(doc.whatsapp.labName || 'Elegance Dental Lab'),
        msgCompleted: normalizeMsgTemplate(
          doc.whatsapp.msgCompleted,
          OLD_MSG_COMPLETED,
          DEFAULT_MSG_COMPLETED
        ),
        msgExited: normalizeMsgTemplate(
          doc.whatsapp.msgExited,
          OLD_MSG_EXITED,
          DEFAULT_MSG_EXITED
        ),
        msgDaily: String(doc.whatsapp.msgDaily || DEFAULT_MSG_DAILY),
        alertPhones: String(doc.whatsapp.alertPhones || ''),
      };
      return cachedConfig;
    }
  } catch (err) {
    console.warn('[whatsapp] reload from DB failed:', err.message);
  }
  cachedConfig = configFromEnv();
  return cachedConfig;
}

function getConfig() {
  if (cachedConfig) return cachedConfig;
  cachedConfig = configFromEnv();
  return cachedConfig;
}

/**
 * Normalize to E.164 digits without +.
 * Egyptian mobiles: 01xxxxxxxxx / 1xxxxxxxxx / 201xxxxxxxxx → 201xxxxxxxxx
 */
function normalizePhone(raw) {
  let p = String(raw || '').replace(/\D/g, '');
  if (!p) return '';
  if (p.startsWith('00')) p = p.slice(2);
  // Local EG: 01xxxxxxxxx (11 digits)
  if (p.startsWith('0') && p.length === 11) p = `20${p.slice(1)}`;
  // Local EG without leading 0: 1xxxxxxxxx (10 digits, mobile)
  else if (p.length === 10 && p.startsWith('1')) p = `20${p}`;
  // Typed as 0201... (13 digits)
  else if (p.startsWith('020') && p.length === 13) p = p.slice(1);
  return p;
}

function providerConfigured() {
  const c = getConfig();
  if (c.provider === 'waweb') {
    if (!c.enabled) return false;
    try {
      const { isWhatsAppWebConnected } = require('./waWebService');
      return isWhatsAppWebConnected();
    } catch {
      return false;
    }
  }
  // Env-only configs may have enabled inferred from provider string
  const on = c.enabled || !!(c.token && (c.instanceId || c.phoneNumberId));
  if (!on) return false;
  if (c.provider === 'meta') return !!(c.token && c.phoneNumberId);
  if (c.provider === 'ultramsg') return !!(c.token && c.instanceId);
  return false;
}

async function sendWhatsAppText(phone, body) {
  if (!cachedConfig) await reloadWhatsAppConfig();
  if (!providerConfigured()) {
    console.log('[whatsapp] skipped (not configured):', String(body).slice(0, 80));
    return {
      ok: false,
      skipped: true,
      error: 'واتساب مش مضبوط أو مش متصل حالياً',
    };
  }
  const to = normalizePhone(phone);
  if (!to) return { ok: false, error: 'رقم الموبايل غير صالح' };

  const c = getConfig();
  const text = String(body);

  try {
    if (c.provider === 'waweb') {
      const { sendWhatsAppWebText } = require('./waWebService');
      // Always await — surface skipped/errors; pass raw phone (waWeb normalizes too)
      const result = await sendWhatsAppWebText(phone, text);
      if (!result?.ok) {
        console.warn(
          '[whatsapp] waweb send not ok:',
          result?.error || result?.skipped || 'failed',
          'phone=',
          phone,
          'normalized=',
          to
        );
      }
      return result;
    }

    if (c.provider === 'meta') {
      const res = await fetch(`https://graph.facebook.com/v19.0/${c.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${c.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: text },
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.warn('[whatsapp] meta error:', res.status, errText);
        return { ok: false, error: errText };
      }
      return { ok: true, to };
    }

    if (c.provider === 'ultramsg') {
      const instance = c.instanceId.replace(/^instance/i, '');
      const instancePath = c.instanceId.startsWith('instance')
        ? c.instanceId
        : `instance${instance}`;
      const params = new URLSearchParams({
        token: c.token,
        to: `${to}@c.us`,
        body: text,
      });
      const res = await fetch(`https://api.ultramsg.com/${instancePath}/messages/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.warn('[whatsapp] ultramsg error:', res.status, errText);
        return { ok: false, error: errText };
      }
      return { ok: true, to };
    }
  } catch (err) {
    console.warn('[whatsapp] send failed:', err.message);
    return { ok: false, error: err.message };
  }
  return {
    ok: false,
    skipped: true,
    error: `مزود واتساب غير معروف (${c.provider || 'none'})`,
  };
}

function normalizeDoctorKey(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    // strip common titles so "د. أحمد" matches "أحمد"
    .replace(/^(د\.|د|dr\.|dr|doctor|أ\.|ا\.)\s*/i, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function findDoctorUserByCase(dentalCase) {
  const doctorName = String(dentalCase?.referringDoctor || '').trim();
  if (!doctorName) return null;
  const users = await User.find({ role: 'doctor', isActive: true }).select('fullName phone email');
  const key = normalizeDoctorKey(doctorName);
  if (!key) return null;

  const exact = users.find((u) => normalizeDoctorKey(u.fullName) === key);
  if (exact) return exact;

  // No fuzzy/partial name match — prevents messaging the wrong doctor
  console.warn('[whatsapp] no exact doctor user match for:', doctorName);
  return null;
}

function labLabel() {
  return getConfig().labName || 'Elegance Dental Lab';
}

async function notifyDoctorCaseStatus(dentalCase, kind) {
  try {
    // Always reload — admin may have just enabled / switched provider
    await reloadWhatsAppConfig();
    const c = getConfig();
    if (!c.enabled) {
      console.log('[whatsapp] skip (disabled):', dentalCase?.caseNumber, kind);
      return;
    }
    // WhatsApp Web: only notify when case is completed (lower ban risk)
    if (c.provider === 'waweb' && kind !== 'exited') {
      console.log('[whatsapp] waweb skip non-completed:', kind, dentalCase?.caseNumber);
      return;
    }
    const doctor = await findDoctorUserByCase(dentalCase);
    if (!doctor?.phone) {
      console.log(
        '[whatsapp] no doctor phone match for',
        dentalCase?.caseNumber,
        'referringDoctor=',
        dentalCase?.referringDoctor || ''
      );
      return;
    }
    const vars = { ...caseMessageVars(dentalCase), count: '', list: '' };
    let msg = '';
    if (kind === 'completed') {
      msg = applyTemplate(c.msgCompleted || DEFAULT_MSG_COMPLETED, vars);
    } else if (kind === 'exited') {
      msg = applyTemplate(c.msgExited || DEFAULT_MSG_EXITED, vars);
    } else {
      msg = applyTemplate('{lab}\nتحديث على الحالة ({patient}).', vars);
    }
    const result = await sendWhatsAppText(doctor.phone, msg);
    console.log(
      '[whatsapp] notify',
      dentalCase?.caseNumber,
      kind,
      'to',
      doctor.fullName,
      result?.ok ? 'OK' : result?.error || result?.skipped || 'failed'
    );
  } catch (err) {
    console.warn('[whatsapp] notifyDoctorCaseStatus:', err.message);
  }
}

/** Send alert to lab admin phones (AppSettings.whatsapp.alertPhones + admin users). */
async function notifyLabAlert(text) {
  await reloadWhatsAppConfig();
  const c = getConfig();
  if (!c.enabled) return { skipped: true, reason: 'disabled' };

  const phones = new Set();
  const raw = String(c.alertPhones || '');
  for (const part of raw.split(/[,;\s]+/)) {
    const p = String(part || '').trim();
    if (p) phones.add(p);
  }
  const admins = await User.find({ role: 'admin', isActive: true }).select('phone').lean();
  for (const a of admins) {
    if (a?.phone) phones.add(String(a.phone).trim());
  }
  if (!phones.size) return { skipped: true, reason: 'no-phones' };

  const body = `${labLabel()}\n${text}`;
  const results = [];
  for (const phone of phones) {
    results.push(await sendWhatsAppText(phone, body));
  }
  return { ok: true, results };
}

/** Reminder to a doctor about unpaid balance. */
async function sendDoctorDebtReminder({ doctorName, phone, unpaidAmount, unpaidCases, labName }) {
  await reloadWhatsAppConfig();
  const c = getConfig();
  if (!c.enabled) return { ok: false, error: 'واتساب غير مفعّل' };

  let to = phone;
  if (!to) {
    const fakeCase = { referringDoctor: doctorName };
    const doctor = await findDoctorUserByCase(fakeCase);
    to = doctor?.phone;
  }
  if (!to) return { ok: false, error: 'لا يوجد رقم واتساب للطبيب' };

  const msg =
    `${labName || labLabel()}\n` +
    `تذكير ودي بالحساب\n` +
    `دكتور: ${doctorName}\n` +
    `المبلغ المستحق: ${Number(unpaidAmount || 0).toLocaleString('en-EG')} EGP\n` +
    `عدد الحالات غير المدفوعة: ${Number(unpaidCases || 0)}\n` +
    `برجاء التواصل مع المعمل للتسوية.`;

  const result = await sendWhatsAppText(to, msg);
  return result?.ok
    ? { ok: true, result }
    : { ok: false, error: result?.error || result?.skipped || 'فشل الإرسال' };
}

async function sendDailyReadySummaries() {
  if (!cachedConfig) await reloadWhatsAppConfig();
  if (getConfig().provider === 'waweb') {
    console.log('[whatsapp] daily summary skipped for waweb (completed-only mode)');
    return;
  }
  if (!providerConfigured()) {
    console.log('[whatsapp] daily summary skipped (not configured)');
    return;
  }
  try {
    const ready = await DentalCase.find({
      currentStage: 'completed',
      status: { $ne: 'exited' },
    })
      .select('referringDoctor caseNumber patientName')
      .lean();

    const byDoctor = new Map();
    for (const c of ready) {
      const key = normalizeDoctorKey(c.referringDoctor);
      if (!key) continue;
      if (!byDoctor.has(key)) byDoctor.set(key, []);
      byDoctor.get(key).push(c);
    }

    const doctors = await User.find({ role: 'doctor', isActive: true }).select('fullName phone');
    for (const doc of doctors) {
      const list = byDoctor.get(normalizeDoctorKey(doc.fullName)) || [];
      if (!list.length || !doc.phone) continue;
      const listText =
        list
          .slice(0, 8)
          .map((c) => `• ${c.caseNumber} — ${c.patientName}`)
          .join('\n') + (list.length > 8 ? `\n… و${list.length - 8} أخرى` : '');
      const msg = applyTemplate(getConfig().msgDaily || DEFAULT_MSG_DAILY, {
        lab: labLabel(),
        caseNumber: '',
        patient: '',
        count: String(list.length),
        list: listText,
      });
      await sendWhatsAppText(doc.phone, msg);
    }
  } catch (err) {
    console.warn('[whatsapp] daily summary failed:', err.message);
  }
}

function scheduleDailyWhatsAppSummary() {
  reloadWhatsAppConfig()
    .then(() => {
      console.log(
        providerConfigured()
          ? `[whatsapp] ready (daily ~${getConfig().dailyHour}:00)`
          : '[whatsapp] idle — configure from Admin → واتساب'
      );
    })
    .catch(() => {});

  const tick = async () => {
    await reloadWhatsAppConfig();
    if (!providerConfigured()) return;
    const hour = getConfig().dailyHour ?? 18;
    const now = new Date();
    if (now.getHours() === hour && now.getMinutes() < 5) {
      const key = now.toISOString().slice(0, 10);
      if (scheduleDailyWhatsAppSummary._lastRun === key) return;
      scheduleDailyWhatsAppSummary._lastRun = key;
      await sendDailyReadySummaries();
    }
  };
  setInterval(tick, 60 * 1000);
}

module.exports = {
  sendWhatsAppText,
  notifyDoctorCaseStatus,
  notifyLabAlert,
  sendDoctorDebtReminder,
  sendDailyReadySummaries,
  scheduleDailyWhatsAppSummary,
  providerConfigured,
  reloadWhatsAppConfig,
  normalizePhone,
  findDoctorUserByCase,
};
