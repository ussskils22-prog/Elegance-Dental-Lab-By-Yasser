const { parseCaps, canTakeKind, jobKindFilterForCaps } = require('../utils/printCaps');

describe('print caps — only a PC with the printer connected takes the job', () => {
  test('parse', () => {
    expect(parseCaps('Sheet, receipt')).toEqual(['sheet', 'receipt']);
    expect(parseCaps('')).toEqual([]);
  });

  test('a PC whose sheet printer is unplugged gets no sheets', () => {
    expect(canTakeKind(['none'], 'sheet')).toBe(false);
    expect(canTakeKind(['receipt'], 'sheet')).toBe(false);
    expect(jobKindFilterForCaps(['none'])).toEqual({ _id: { $exists: false } });
    expect(jobKindFilterForCaps(['receipt'])).toEqual({ 'printData.jobKind': 'receipt' });
  });

  test('a PC with the printer takes sheets, receipts only with a receipt printer', () => {
    expect(canTakeKind(['sheet'], 'sheet')).toBe(true);
    expect(canTakeKind(['sheet'], 'receipt')).toBe(false);
    expect(jobKindFilterForCaps(['sheet', 'receipt'])).toEqual({});
  });

  test('old agents (no caps sent) keep the old rule: sheets only', () => {
    expect(canTakeKind(null, 'sheet')).toBe(true);
    expect(canTakeKind(null, 'receipt')).toBe(false);
    expect(jobKindFilterForCaps(null)).toEqual({ 'printData.jobKind': { $ne: 'receipt' } });
  });
});
