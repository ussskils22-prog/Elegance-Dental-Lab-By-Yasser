/**
 * Operations report: what is late, what is due soon, what is stuck, what is ready
 * and waiting for pickup. Used by GET /cases/operations-report (screen + print)
 * and by the twice-daily WhatsApp summary.
 */
const { classifyCase, metaOf } = require('../utils/caseDeadlines');
const { cairoParts, cairoDayKey } = require('../utils/cairoTime');

const STAGE_AR = {
  waiting: 'انتظار',
  secretary: 'سكرتارية',
  design: 'ديزاين',
  khart: 'خرط',
  finishing: 'فينيش',
  completed: 'جاهزة',
};

function rowOf(doc, c) {
  const meta = metaOf(doc);
  return {
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

/** Pure: build the report from case documents. */
function buildOperationsReport(cases, now = new Date()) {
  const report = { generatedAt: now.toISOString(), overdue: [], dueSoon: [], stuck: [], readyWaiting: [] };
  for (const doc of cases || []) {
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
  section('🟡 تتسلم خلال 24 ساعة', report.dueSoon, (r) => `${r.caseNumber} — ${r.doctorName} — ${r.stageLabel} — ${fmtDue(r.dueAt)}`);
  section('⏸️ واقفة أكتر من يومين في نفس المرحلة', report.stuck, (r) => `${r.caseNumber} — ${r.doctorName} — ${r.stageLabel} — ${r.hoursInStage} ساعة`);
  section('✅ جاهزة ومستنية الاستلام', report.readyWaiting, (r) => `${r.caseNumber} — ${r.doctorName}`);
  return lines.join('\n');
}

async function loadOpenCases() {
  const DentalCase = require('../models/DentalCase');
  return DentalCase.find({ currentStage: { $ne: 'exited' }, status: { $ne: 'exited' } })
    .select('caseNumber patientName currentStage status dueDate notes referringDoctor priority createdAt updatedAt stageTimestamps')
    .lean();
}

async function generateOperationsReport(now = new Date()) {
  return buildOperationsReport(await loadOpenCases(), now);
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

module.exports = { buildOperationsReport, formatReportText, generateOperationsReport, scheduleOperationsReport };
