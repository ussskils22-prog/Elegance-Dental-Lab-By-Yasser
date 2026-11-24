const {
  normalizeDoctorKey,
  doctorKeysMatch,
  findSimilarDoctorNames,
} = require('../utils/doctorName');

describe('doctorKeysMatch — same doctor only, never "part of the name"', () => {
  test('a shared first name is NOT the same doctor', () => {
    expect(doctorKeysMatch('د. محمد', 'أحمد محمد')).toBe(false);
    expect(doctorKeysMatch('محمد', 'محمد علي')).toBe(false);
    expect(doctorKeysMatch('علي', 'علي عبدالله')).toBe(false);
  });

  test('titles, spacing and punctuation are ignored', () => {
    expect(doctorKeysMatch('د. علي عبدالله', 'علي عبدالله')).toBe(true);
    expect(doctorKeysMatch('  علي   عبدالله ', 'د علي عبدالله')).toBe(true);
    expect(doctorKeysMatch('Dr. Sami', 'sami')).toBe(true);
  });

  test('common Arabic spelling variants are the same name', () => {
    expect(doctorKeysMatch('أحمد', 'احمد')).toBe(true);
    expect(doctorKeysMatch('إيمان', 'ايمان')).toBe(true);
    expect(doctorKeysMatch('علي', 'على')).toBe(true);
    expect(doctorKeysMatch('فاطمة', 'فاطمه')).toBe(true);
    expect(doctorKeysMatch('عبد الله', 'عبدالله')).toBe(true);
  });

  test('a typo is NOT silently treated as the same doctor', () => {
    expect(doctorKeysMatch('غلي غبدالله', 'علي عبدالله')).toBe(false);
  });

  test('empty names never match', () => {
    expect(doctorKeysMatch('', '')).toBe(false);
    expect(doctorKeysMatch('د.', 'د.')).toBe(false);
  });
});

describe('normalizeDoctorKey', () => {
  test('strips titles and unifies letters', () => {
    expect(normalizeDoctorKey('د. أحمد  عبد الله')).toBe(normalizeDoctorKey('احمد عبدالله'));
  });
});

describe('findSimilarDoctorNames — "did you mean" for typos', () => {
  const doctors = ['علي عبدالله', 'سامي فرزات', 'هالة محمود', 'محمد عادل'];

  test('finds the doctor behind a typo', () => {
    expect(findSimilarDoctorNames('غلي غبدالله', doctors)).toEqual(['علي عبدالله']);
  });

  test('an exact (normalized) match is not reported as merely similar', () => {
    expect(findSimilarDoctorNames('د. علي عبدالله', doctors)).toEqual([]);
  });

  test('single-word names are too short to judge (سامي/سامح are different people)', () => {
    expect(findSimilarDoctorNames('سامح', ['سامي', 'رامي'])).toEqual([]);
  });

  test('"DR/ Sami" strips the title', () => {
    expect(doctorKeysMatch('DR/ Sami', 'sami')).toBe(true);
  });

  test('a clearly different name returns nothing', () => {
    expect(findSimilarDoctorNames('كريم منصور', doctors)).toEqual([]);
  });
});
