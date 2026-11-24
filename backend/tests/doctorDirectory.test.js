const { decideDoctorName } = require('../services/doctorDirectory');

const known = ['علي عبدالله', 'سامي فرزات', 'هالة محمود'];

describe('decideDoctorName — stop typos from creating a new doctor', () => {
  test('a known doctor (any spelling variant) is accepted', () => {
    expect(decideDoctorName('د. على عبد الله', known, false)).toEqual({ action: 'ok', existing: 'علي عبدالله', similar: [] });
  });

  test('a typo of a known doctor is held with suggestions', () => {
    expect(decideDoctorName('غلي غبدالله', known, false)).toEqual({
      action: 'similar',
      existing: null,
      similar: ['علي عبدالله'],
    });
  });

  test('the user can confirm it really is a new doctor', () => {
    expect(decideDoctorName('غلي غبدالله', known, true).action).toBe('ok');
  });

  test('a brand-new, clearly different name is accepted', () => {
    expect(decideDoctorName('كريم منصور', known, false)).toEqual({ action: 'ok', existing: null, similar: [] });
  });

  test('a shorter or longer version of a known name is flagged (two secretaries, two spellings)', () => {
    const lab = ['معمل شيماء', 'الجندي مهندسين', 'الجندي حاتم'];
    expect(decideDoctorName('شيماء', lab, false)).toMatchObject({ action: 'similar', similar: ['معمل شيماء'] });
    expect(decideDoctorName('د. شيماء', ['شيماء'], false).action).toBe('ok'); // same name
    expect(decideDoctorName('الجندي', lab, false).similar).toEqual(['الجندي مهندسين', 'الجندي حاتم']);
  });

  test('an empty name is not checked', () => {
    expect(decideDoctorName('', known, false).action).toBe('ok');
  });
});
