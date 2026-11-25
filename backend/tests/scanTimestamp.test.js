const { scanTimestamp } = require('../utils/scanTimestamp');

const now = new Date('2026-11-25T12:00:00Z');
describe('scanTimestamp — offline scans keep their real time', () => {
  test('no time sent → now', () => expect(scanTimestamp(undefined, now)).toEqual(now));
  test('a scan queued 2 hours ago keeps its time', () => {
    expect(scanTimestamp('2026-11-25T10:00:00Z', now).toISOString()).toBe('2026-11-25T10:00:00.000Z');
  });
  test('garbage → now', () => expect(scanTimestamp('yesterday', now)).toEqual(now));
  test('older than 3 days → now', () => expect(scanTimestamp('2026-11-20T10:00:00Z', now)).toEqual(now));
  test('far in the future → now', () => expect(scanTimestamp('2026-11-26T10:00:00Z', now)).toEqual(now));
  test('a minute ahead (clock drift) → now', () => expect(scanTimestamp('2026-11-25T12:01:00Z', now)).toEqual(now));
});
