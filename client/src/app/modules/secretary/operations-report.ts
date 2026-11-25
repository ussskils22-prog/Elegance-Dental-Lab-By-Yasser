/** Operations report as returned by GET /api/cases/operations-report. */
export interface OperationsReportRow {
  caseNumber: string;
  doctorName: string;
  patientName: string;
  stageLabel: string;
  dueAt: string | null;
  hoursOverdue: number;
  hoursInStage: number | null;
}

export interface OperationsReport {
  generatedAt: string;
  overdue: OperationsReportRow[];
  dueSoon: OperationsReportRow[];
  stuck: OperationsReportRow[];
  readyWaiting: OperationsReportRow[];
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Cairo time with English digits, e.g. "25/11 4:00 م". */
const cairo = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p: Record<string, string> = {};
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
  const h = Number(p['hour']);
  return `${p['day']}/${p['month']} ${h % 12 || 12}:${p['minute']} ${h < 12 ? 'ص' : 'م'}`;
};

function table(title: string, rows: OperationsReportRow[], extraHead: string, extra: (r: OperationsReportRow) => string): string {
  const body = rows.length
    ? rows
        .map(
          (r, i) =>
            `<tr><td>${i + 1}</td><td>${esc(r.caseNumber)}</td><td>${esc(r.doctorName)}</td><td>${esc(r.patientName)}</td><td>${esc(r.stageLabel)}</td><td>${extra(r)}</td></tr>`
        )
        .join('')
    : `<tr><td colspan="6" class="none">لا يوجد</td></tr>`;
  return `<h2>${esc(title)} <span>(${rows.length})</span></h2>
<table><thead><tr><th>#</th><th>رقم الحالة</th><th>الدكتور</th><th>المريض</th><th>المرحلة</th><th>${esc(extraHead)}</th></tr></thead><tbody>${body}</tbody></table>`;
}

/** Self-contained, print-friendly HTML page (A4, RTL). */
export function renderOperationsReportHtml(r: OperationsReport, labName = ''): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير التشغيل</title>
<style>
  body{font-family:'Cairo','Segoe UI',sans-serif;margin:16px;color:#111}
  h1{font-size:20px;margin:0 0 4px} .meta{color:#555;font-size:12px;margin-bottom:12px}
  h2{font-size:15px;margin:18px 0 6px;border-bottom:2px solid #111;padding-bottom:3px} h2 span{color:#555}
  table{width:100%;border-collapse:collapse;font-size:12px} th,td{border:1px solid #999;padding:4px 6px;text-align:right}
  th{background:#eee} td.none{text-align:center;color:#777}
  @page{size:A4;margin:12mm}
</style></head><body>
<h1>تقرير التشغيل${labName ? ' — ' + esc(labName) : ''}</h1>
<div class="meta">اتطبع: ${esc(cairo(r.generatedAt))}</div>
${table('🔴 متأخرة عن ميعاد التسليم', r.overdue, 'متأخرة', (x) => `${x.hoursOverdue} ساعة`)}
${table('🟡 تتسلم خلال 24 ساعة', r.dueSoon, 'ميعاد التسليم', (x) => esc(cairo(x.dueAt)))}
${table('⏸️ واقفة أكتر من يومين في نفس المرحلة', r.stuck, 'في المرحلة من', (x) => `${x.hoursInStage ?? '—'} ساعة`)}
${table('✅ جاهزة ومستنية الاستلام', r.readyWaiting, 'ميعاد التسليم', (x) => esc(cairo(x.dueAt)))}
</body></html>`;
}
