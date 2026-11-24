const { isIdle, IDLE_DAYS } = require('../services/clientActivity');

const now = new Date('2026-11-24T12:00:00Z');
const daysAgo = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

describe('isIdle — no case in the last 30 days', () => {
  test('uses 30 days', () => expect(IDLE_DAYS).toBe(30));
  test('a case 10 days ago → active', () => {
    expect(isIdle({ lastCaseAt: daysAgo(10), createdAt: daysAgo(400) }, now)).toBe(false);
  });
  test('last case 31 days ago → idle', () => {
    expect(isIdle({ lastCaseAt: daysAgo(31), createdAt: daysAgo(400) }, now)).toBe(true);
  });
  test('a doctor added this week with no case yet is not idle', () => {
    expect(isIdle({ lastCaseAt: null, createdAt: daysAgo(3) }, now)).toBe(false);
  });
  test('an old account that never sent a case is idle', () => {
    expect(isIdle({ lastCaseAt: null, createdAt: daysAgo(90) }, now)).toBe(true);
  });
  test('no dates at all → not idle (do not guess)', () => {
    expect(isIdle({}, now)).toBe(false);
  });
});
