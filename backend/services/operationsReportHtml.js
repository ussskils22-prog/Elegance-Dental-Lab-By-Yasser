/**
 * Print-ready HTML of the operations report (A4, RTL). The server owns it so the screen,
 * the page count and the paper from the print PC all come from the same page.
 */
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Cairo time with English digits, e.g. "25/11 4:00 م". */
function cairo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d)) {
    p[part.type] = part.value;
  }
  const h = Number(p.hour);
  return `${p.day}/${p.month} ${h % 12 || 12}:${p.minute} ${h < 12 ? 'ص' : 'م'}`;
}

function table(title, rows) {
  const body = rows.length
    ? rows
        .map(
          (r, i) =>
            `<tr><td>${i + 1}</td><td>${esc(r.doctorName)}</td><td>${esc(r.patientName)}</td><td>${esc(r.workType || '—')}</td><td class="n">${r.quantity ?? '—'}</td><td>${esc(r.stageLabel)}</td></tr>`
        )
        .join('')
    : '<tr><td colspan="6" class="none">لا يوجد</td></tr>';
  return `<h2>${esc(title)} <span>(${rows.length})</span></h2>
<table><thead><tr><th class="n">#</th><th>الدكتور</th><th>المريض</th><th>النوع</th><th class="n">العدد</th><th>المرحلة</th></tr></thead><tbody>${body}</tbody></table>`;
}

/** Page margin used by the print PC and by the page counter on the screen. */
const PAGE_MARGIN_MM = 12;

function renderOperationsReportHtml(r, labName = '') {
  const range = r.range
    ? `الحالات المستلمة من ${esc(cairo(r.range.from).split(' ')[0])} إلى ${esc(cairo(r.range.to).split(' ')[0])} (آخر 7 أيام) — `
    : '';
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير التشغيل</title>
<style>
  html,body{margin:0;padding:0}
  body{font-family:'Cairo','Segoe UI',Tahoma,sans-serif;color:#111}
  h1{font-size:20px;margin:0 0 4px} .meta{color:#555;font-size:12px;margin-bottom:12px}
  h2{font-size:15px;margin:18px 0 6px;border-bottom:2px solid #111;padding-bottom:3px;break-after:avoid} h2 span{color:#555}
  table{width:100%;border-collapse:collapse;font-size:12px} th,td{border:1px solid #999;padding:4px 6px;text-align:right}
  tr{break-inside:avoid} thead{display:table-header-group}
  th{background:#eee} td.none{text-align:center;color:#777} .n{text-align:center;width:9%}
  @page{size:A4;margin:${PAGE_MARGIN_MM}mm}
</style></head><body>
<h1>تقرير التشغيل${labName ? ' — ' + esc(labName) : ''}</h1>
<div class="meta">${range}اتطبع: ${esc(cairo(r.generatedAt))}</div>
${table('🔴 متأخرة عن ميعاد التسليم', r.overdue)}
${table(`🟡 تسليمها بكرة${r.tomorrow ? ' — ' + r.tomorrow : ''}`, r.dueSoon)}
${table('⏸️ واقفة أكتر من يومين في نفس المرحلة', r.stuck)}
${table('✅ جاهزة ومستنية الاستلام', r.readyWaiting)}
</body></html>`;
}

module.exports = { renderOperationsReportHtml, PAGE_MARGIN_MM };
