const { parseCaps, canTakeKind, jobKindFilterForCaps, effectiveCaps } = require('../utils/printCaps');

describe('old agents are shut out while a new one with the sheet printer is online', () => {
  test('old agent gets nothing when a new sheet agent is online', () => {
    const caps = effectiveCaps(null, true);
    expect(canTakeKind(caps, 'sheet')).toBe(false);
    expect(canTakeKind(caps, 'receipt')).toBe(false);
    expect(jobKindFilterForCaps(caps)).toEqual({ _id: { $exists: false } });
  });

  test('old agent keeps working when no new agent is online', () => {
    expect(effectiveCaps(null, false)).toBeNull();
    expect(canTakeKind(effectiveCaps(undefined, false), 'sheet')).toBe(true);
  });

  test('new agents are untouched', () => {
    expect(effectiveCaps(['sheet'], true)).toEqual(['sheet']);
    expect(effectiveCaps(['receipt'], true)).toEqual(['receipt']);
  });
});

describe('print caps — only a PC with the printer connected takes the job', () => {
  test('parse', () => {
    expect(parseCaps('Sheet, receipt')).toEqual(['sheet', 'receipt']);
    expect(parseCaps('')).toEqual([]);
  });

  test('a PC whose sheet printer is unplugged gets no sheets', () => {
    expect(canTakeKind(['none'], 'sheet')).toBe(false);
    expect(canTakeKind(['receipt'], 'sheet')).toBe(false);
    expect(jobKindFilterForCaps(['none'])).toEqual({ _id: { $exists: false } });
    expect(jobKindFilterForCaps(['receipt'])).toEqual({ 'printData.jobKind': { $in: ['receipt'] } });
  });

  test('a PC with the printer takes sheets, receipts only with a receipt printer', () => {
    expect(canTakeKind(['sheet'], 'sheet')).toBe(true);
    expect(canTakeKind(['sheet'], 'receipt')).toBe(false);
    expect(jobKindFilterForCaps(['sheet', 'receipt', 'report'])).toEqual({});
    expect(jobKindFilterForCaps(['sheet', 'receipt'])).toEqual({ 'printData.jobKind': { $nin: ['report'] } });
  });

  test('old agents (no caps sent) keep the old rule: sheets only', () => {
    expect(canTakeKind(null, 'sheet')).toBe(true);
    expect(canTakeKind(null, 'receipt')).toBe(false);
    expect(jobKindFilterForCaps(null)).toEqual({ 'printData.jobKind': { $nin: ['receipt', 'report'] } });
  });

  test('the A4 report goes only to a new agent with the sheet printer connected', () => {
    expect(canTakeKind(['sheet', 'report'], 'report')).toBe(true);
    expect(canTakeKind(['sheet'], 'report')).toBe(false); // agent too old to know reports
    expect(canTakeKind(['receipt', 'report'], 'report')).toBe(false); // sheet printer unplugged
    expect(canTakeKind(null, 'report')).toBe(false);
    expect(jobKindFilterForCaps(['receipt', 'report'])).toEqual({ 'printData.jobKind': { $in: ['receipt'] } });
  });
});
