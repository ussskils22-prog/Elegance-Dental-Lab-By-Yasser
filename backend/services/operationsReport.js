/**
 * Operations report: what is late, what is due soon, what is stuck, what is ready
 * and waiting for pickup. Used by GET /cases/operations-report (screen + print)
 * and by the twice-daily WhatsApp summary.
 */
const { classifyCase, metaOf, cairoTomorrowKey } = require('../utils/caseDeadlines');
const { cairoParts, cairoDayKey, cairoDateTimeToUtc } = require('../utils/cairoTime');

const REPORT_DAYS = 7;

/** The printed report covers the last 7 Cairo days (today + 6 before): [from, now]. */
function weekRange(now = new Date()) {
  const sixDaysAgo = new Date(now.getTime() - (REPORT_DAYS - 1) * 24 * 3600 * 1000);
  return { from: cairoDateTimeToUtc(cairoDayKey(sixDaysAgo), '00:00'), to: now };
}

// The lab works with 4 stages: جديدة → ديزاين → فينيش → جاهزة (milling counts as فينيش).
const STAGE_AR = {
  waiting: 'جديدة',
  secretary: 'جديدة',
  design: 'ديزاين',
  khart: 'فينيش',
  finishing: 'فينيش',
  completed: 'جاهزة',
};

/** "Zircon (3)" → "Zircon"; the count is its own column. */
function workTypeOf(meta, doc) {
  const raw = String((meta.originalEntry && meta.originalEntry.workType) || meta.workType || doc.caseType || '').trim();
  return raw.replace(/\s*\(\d+\)\s*$/, '');
}

function quantityOf(meta) {
  const q = Number(meta.quantity ?? (meta.originalEntry && meta.originalEntry.quantity));
  return Number.isFinite(q) && q > 0 ? q : null;
}

function rowOf(doc, c) {
  const meta = metaOf(doc);
  return {
    workType: workTypeOf(meta, doc),
    quantity: quantityOf(meta),
    id: String(doc._id || ''),
    caseNumber: String(doc.caseNumber || ''),
    doctorName: String(doc.referringDoctor || meta.doctor || meta.doctorName || ''),
    patientName: String(doc.patientName || ''),
    stage: String(doc.currentStage || ''),
    stageLabel: STAGE_AR[doc.currentStage] || String(doc.currentStage || ''),
    priority: String(doc.priority || 'normal'),
    dueAt: c.due ? c.due.toISOString() : null,
    hoursOverdue: c.hoursOverdue,
    hoursInStage: c.hoursInStage,
  };
}

/** "السبت 28/11" — the Cairo day the "due tomorrow" section is about. */
function tomorrowLabel(now = new Date()) {
  const [y, m, d] = cairoTomorrowKey(now).split('-').map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 10));
  const day = new Intl.DateTimeFormat('ar-EG', { timeZone: 'Africa/Cairo', weekday: 'long' }).format(noon);
  return `${day} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

/**
 * Pure: build the report from case documents.
 * opts.since (Date): only cases received on/after it (the weekly printed report).
 */
function buildOperationsReport(cases, now = new Date(), opts = {}) {
  const since = opts.since instanceof Date ? opts.since : null;
  const report = { generatedAt: now.toISOString(), tomorrow: tomorrowLabel(now), overdue: [], dueSoon: [], stuck: [], readyWaiting: [] };
  if (since) report.range = { from: since.toISOString(), to: now.toISOString() };
  for (const doc of cases || []) {
    if (since) {
      const created = doc.createdAt ? new Date(doc.createdAt) : null;
      if (!created || Number.isNaN(created.getTime()) || created < since) continue;
    }
    const c = classifyCase(doc, now);
    if (!c) continue;
    const row = rowOf(doc, c);
    if (c.overdue) report.overdue.push(row);
    else if (c.dueSoon) report.dueSoon.push(row);
    if (c.stuck) report.stuck.push(row);
    if (c.readyWaiting) report.readyWaiting.push(row);
  }
  report.overdue.sort((a, b) => b.hoursOverdue - a.hoursOverdue);
  report.dueSoon.sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  report.stuck.sort((a, b) => (b.hoursInStage || 0) - (a.hoursInStage || 0));
  report.counts = {
    overdue: report.overdue.length,
    dueSoon: report.dueSoon.length,
    stuck: report.stuck.length,
    readyWaiting: report.readyWaiting.length,
  };
  return report;
}

function fmtDue(iso) {
  if (!iso) return '—';
  const p = cairoParts(new Date(iso));
  const h12 = p.hour % 12 || 12;
  return `${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')} ${h12}:${String(p.minute).padStart(2, '0')} ${p.hour < 12 ? 'ص' : 'م'}`;
}

/** Plain-text summary (WhatsApp). Lists are capped so the message stays readable. */
function formatReportText(report, labName = '', cap = 15) {
  const lines = [];
  lines.push(`📋 تقرير التشغيل${labName ? ' — ' + labName : ''}`);
  lines.push(`🕒 ${cairoDayKey(new Date(report.generatedAt))} ${fmtDue(report.generatedAt).split(' ').slice(1).join(' ')}`);
  const section = (title, rows, line) => {
    lines.push('');
    lines.push(`${title} (${rows.length})`);
    if (!rows.length) lines.push('  لا يوجد');
    rows.slice(0, cap).forEach((r) => lines.push('  • ' + line(r)));
    if (rows.length > cap) lines.push(`  … و${rows.length - cap} كمان`);
  };
  section('🔴 متأخرة عن ميعاد التسليم', report.overdue, (r) => `${r.caseNumber} — ${r.doctorName} — ${r.stageLabel} — متأخرة ${r.hoursOverdue} ساعة`);
  section(`🟡 تسليمها بكرة (${report.tomorrow || ''})`, report.dueSoon, (r) => `${r.caseNumber} — ${r.doctorName} — ${r.stageLabel} — ${fmtDue(r.dueAt)}`);
  section('⏸️ واقفة أكتر من يومين في نفس المرحلة', report.stuck, (r) => `${r.caseNumber} — ${r.doctorName} — ${r.stageLabel} — ${r.hoursInStage} ساعة`);
  section('✅ جاهزة ومستنية الاستلام', report.readyWaiting, (r) => `${r.caseNumber} — ${r.doctorName}`);
  return lines.join('\n');
}

async function loadOpenCases(since = null) {
  const DentalCase = require('../models/DentalCase');
  const filter = { currentStage: { $ne: 'exited' }, status: { $ne: 'exited' } };
  if (since) filter.createdAt = { $gte: since };
  return DentalCase.find(filter)
    .select('caseNumber patientName currentStage status dueDate notes referringDoctor priority createdAt updatedAt stageTimestamps')
    .lean();
}

/** opts.weekly: only cases received in the last 7 days (the printed report). */
async function generateOperationsReport(now = new Date(), opts = {}) {
  const since = opts.weekly ? weekRange(now).from : null;
  return buildOperationsReport(await loadOpenCases(since), now, { since });
}

/**
 * Send the summary at the configured Cairo hours (default 08:00 and 20:00) to
 * OPS_REPORT_PHONES (comma-separated). Does nothing until phones are configured.
 */
function scheduleOperationsReport() {
  const hours = String(process.env.OPS_REPORT_HOURS || '8,20')
    .split(',')
    .map((h) => Number(h.trim()))
    .filter((h) => Number.isInteger(h) && h >= 0 && h < 24);
  const lastSent = new Set();
  const tick = async () => {
    try {
      const phones = String(process.env.OPS_REPORT_PHONES || '').split(',').map((p) => p.trim()).filter(Boolean);
      if (!phones.length) return;
      const p = cairoParts(new Date());
      if (!hours.includes(p.hour) || p.minute >= 10) return;
      const key = `${cairoDayKey(new Date())}-${p.hour}`;
      if (lastSent.has(key)) return;
      const wa = require('./whatsappService');
      await wa.reloadWhatsAppConfig();
      if (!wa.providerConfigured()) return; // retried next minute while still inside the window
      const text = formatReportText(await generateOperationsReport(), process.env.LAB_NAME || '');
      for (const phone of phones) await wa.sendWhatsAppText(phone, text);
      lastSent.add(key); // only after a successful send
      console.log(`[ops-report] sent ${key} to ${phones.length} phone(s)`);
    } catch (err) {
      console.warn('[ops-report] failed:', err?.message || err);
    }
  };
  setInterval(tick, 60 * 1000);
}

module.exports = { STAGE_AR, weekRange, buildOperationsReport, formatReportText, generateOperationsReport, scheduleOperationsReport };
