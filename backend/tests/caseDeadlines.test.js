const { cairoParts, cairoDateTimeToUtc, cairoMonthKey, cairoMonthRange } = require('../utils/cairoTime');
const { caseDueAt, classifyCase } = require('../utils/caseDeadlines');

const META = (o) => `__META__\n${JSON.stringify(o)}`;

describe('cairoTime', () => {
  test('a case exited at 01:30 Cairo on 1 Dec belongs to December, not November', () => {
    const utc = new Date('2026-11-30T23:30:00Z'); // 01:30 on 1 Dec in Cairo (UTC+2)
    expect(cairoMonthKey(utc)).toBe('2026-12');
    expect(cairoParts(utc)).toMatchObject({ year: 2026, month: 12, day: 1, hour: 1 });
  });

  test('Cairo month range covers midnight-to-midnight Cairo time', () => {
    const r = cairoMonthRange(2026, 12);
    expect(r.start.toISOString()).toBe('2026-11-30T22:00:00.000Z');
    expect(r.endExclusive.toISOString()).toBe('2026-12-31T22:00:00.000Z');
    expect(cairoMonthRange(2026, 1).start.toISOString()).toBe('2025-12-31T22:00:00.000Z');
  });

  test('a missing or bad date gives NaN parts instead of throwing', () => {
    expect(Number.isNaN(cairoParts(null).year)).toBe(true);
    expect(Number.isNaN(cairoParts('not a date').month)).toBe(true);
  });

  test('converts a Cairo wall time to the right instant', () => {
    expect(cairoDateTimeToUtc('2026-11-24', '18:00').toISOString()).toBe('2026-11-24T16:00:00.000Z');
  });
});

describe('caseDueAt — one rule for the delivery deadline', () => {
  test('uses delivery date + time from the case form (Cairo time)', () => {
    const doc = { notes: META({ deliveryDate: '2026-11-24', deliveryTime: '14:00' }) };
    expect(caseDueAt(doc).toISOString()).toBe('2026-11-24T12:00:00.000Z');
  });

  test('delivery date without a time is due at the end of that Cairo day', () => {
    const doc = { notes: META({ deliveryDate: '2026-11-24' }) };
    expect(caseDueAt(doc).toISOString()).toBe('2026-11-24T21:59:00.000Z');
  });

  test('ignores the dueDate field (it is a synthetic now+7d default, not a real promise)', () => {
    expect(caseDueAt({ dueDate: '2026-11-25T10:00:00Z', notes: '' })).toBeNull();
  });

  test('no deadline at all → null', () => {
    expect(caseDueAt({ notes: '' })).toBeNull();
  });
});

describe('classifyCase', () => {
  const now = new Date('2026-11-24T10:00:00Z');
  const base = (extra) => ({ currentStage: 'design', notes: META({ deliveryDate: '2026-11-23', deliveryTime: '12:00' }), ...extra });

  test('past deadline and still in the lab → overdue', () => {
    expect(classifyCase(base(), now).overdue).toBe(true);
  });

  test('ready (completed) and waiting for pickup is NOT overdue', () => {
    const c = classifyCase(base({ currentStage: 'completed' }), now);
    expect(c.overdue).toBe(false);
    expect(c.readyWaiting).toBe(true);
  });

  test('exited cases are never in the report', () => {
    expect(classifyCase(base({ currentStage: 'exited' }), now)).toBeNull();
  });

  test('due tomorrow (Cairo date) → dueSoon, any hour', () => {
    const late = { currentStage: 'finishing', notes: META({ deliveryDate: '2026-11-25', deliveryTime: '22:00' }) };
    const early = { currentStage: 'finishing', notes: META({ deliveryDate: '2026-11-25', deliveryTime: '09:00' }) };
    expect(classifyCase(late, now).dueSoon).toBe(true);
    expect(classifyCase(early, now).dueSoon).toBe(true);
  });

  test('due later today or after tomorrow → not in "tomorrow"', () => {
    const today = { currentStage: 'finishing', notes: META({ deliveryDate: '2026-11-24', deliveryTime: '20:00' }) };
    const later = { currentStage: 'finishing', notes: META({ deliveryDate: '2026-11-26' }) };
    expect(classifyCase(today, now).dueSoon).toBe(false);
    expect(classifyCase(later, now).dueSoon).toBe(false);
  });

  test('Friday 11pm Cairo → tomorrow is Saturday', () => {
    const { cairoTomorrowKey } = require('../utils/caseDeadlines');
    expect(cairoTomorrowKey(new Date('2026-11-27T21:00:00Z'))).toBe('2026-11-28');
    expect(cairoTomorrowKey(new Date('2026-11-27T22:30:00Z'))).toBe('2026-11-29'); // already Saturday 00:30
  });

  test('no stage movement for more than 48 hours → stuck', () => {
    const doc = { currentStage: 'design', notes: '', stageTimestamps: { design: '2026-11-21T09:00:00Z' }, createdAt: '2026-11-20T09:00:00Z' };
    const c = classifyCase(doc, now);
    expect(c.stuck).toBe(true);
    expect(c.hoursInStage).toBe(73);
  });

  test('recent stage movement is not stuck', () => {
    const doc = { currentStage: 'design', notes: '', stageTimestamps: { design: '2026-11-24T08:00:00Z' } };
    expect(classifyCase(doc, now).stuck).toBe(false);
  });
});
