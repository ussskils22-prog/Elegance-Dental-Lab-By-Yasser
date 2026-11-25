const { buildOperationsReport, formatReportText } = require('../services/operationsReport');

const META = (o) => `__META__\n${JSON.stringify(o)}`;
const now = new Date('2026-11-24T10:00:00Z');

const cases = [
  { _id: '1', caseNumber: 'C-1', referringDoctor: 'علي عبدالله', currentStage: 'design', notes: META({ deliveryDate: '2026-11-22', deliveryTime: '12:00' }), stageTimestamps: { design: '2026-11-24T08:00:00Z' } },
  { _id: '2', caseNumber: 'C-2', referringDoctor: 'سامي', currentStage: 'finishing', notes: META({ deliveryDate: '2026-11-24', deliveryTime: '20:00' }), stageTimestamps: { finishing: '2026-11-24T09:00:00Z' } },
  { _id: '3', caseNumber: 'C-3', referringDoctor: 'هالة', currentStage: 'khart', notes: '', stageTimestamps: { khart: '2026-11-20T09:00:00Z' } },
  { _id: '4', caseNumber: 'C-4', referringDoctor: 'كريم', currentStage: 'completed', notes: META({ deliveryDate: '2026-11-20' }) },
  { _id: '5', caseNumber: 'C-5', referringDoctor: 'نادر', currentStage: 'exited', notes: META({ deliveryDate: '2026-11-01' }) },
];

describe('buildOperationsReport', () => {
  const r = buildOperationsReport(cases, now);

  test('sorts cases into the right sections', () => {
    expect(r.overdue.map((x) => x.caseNumber)).toEqual(['C-1']);
    expect(r.dueSoon.map((x) => x.caseNumber)).toEqual(['C-2']);
    expect(r.stuck.map((x) => x.caseNumber)).toEqual(['C-3']);
    expect(r.readyWaiting.map((x) => x.caseNumber)).toEqual(['C-4']);
  });

  test('ready and exited cases are never counted as late', () => {
    expect(r.counts).toEqual({ overdue: 1, dueSoon: 1, stuck: 1, readyWaiting: 1 });
  });

  test('the text summary names each section with its count', () => {
    const text = formatReportText(r, 'Elegance');
    expect(text).toContain('متأخرة عن ميعاد التسليم (1)');
    expect(text).toContain('C-1 — علي عبدالله — ديزاين');
    expect(text).toContain('واقفة أكتر من يومين في نفس المرحلة (1)');
  });
});

describe('stage names — the lab uses 4 stages', () => {
  const { STAGE_AR } = require('../services/operationsReport');
  test('new / design / finish / ready', () => {
    expect(STAGE_AR.waiting).toBe('جديدة');
    expect(STAGE_AR.secretary).toBe('جديدة');
    expect(STAGE_AR.design).toBe('ديزاين');
    expect(STAGE_AR.khart).toBe('فينيش');
    expect(STAGE_AR.finishing).toBe('فينيش');
    expect(STAGE_AR.completed).toBe('جاهزة');
    expect(new Set(Object.values(STAGE_AR)).size).toBe(4);
  });
});
