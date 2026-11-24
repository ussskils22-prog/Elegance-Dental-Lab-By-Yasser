const { arabicLooseRegex } = require('../utils/searchRegex');

describe('arabicLooseRegex — safe, spelling-tolerant search', () => {
  test('special characters are searched literally, never crash', () => {
    const re = arabicLooseRegex('(a+');
    expect(re.test('x(a+y')).toBe(true);
    expect(re.test('aaa')).toBe(false);
  });

  test('ي/ى, ه/ة and alef forms find each other', () => {
    expect(arabicLooseRegex('على').test('د. علي عبدالله')).toBe(true);
    expect(arabicLooseRegex('فاطمه').test('فاطمة')).toBe(true);
    expect(arabicLooseRegex('احمد').test('أحمد سامي')).toBe(true);
    expect(arabicLooseRegex('إيمان').test('ايمان')).toBe(true);
  });

  test('is case-insensitive for latin text', () => {
    expect(arabicLooseRegex('case-2026').test('CASE-2026-02380')).toBe(true);
  });

  test('empty search returns null', () => {
    expect(arabicLooseRegex('   ')).toBeNull();
  });
});
