const { renameInNotes } = require('../services/doctorMerge');
const { normalizeDoctorKey } = require('../utils/doctorName');

describe('renameInNotes', () => {
  const notes = '__META__\n' + JSON.stringify({ doctor: 'محمد حالد', workType: 'Zircon' });

  test('renames the doctor inside case notes', () => {
    const out = JSON.parse(renameInNotes(notes, normalizeDoctorKey('محمد حالد'), 'محمد خالد').slice(9));
    expect(out).toEqual({ doctor: 'محمد خالد', workType: 'Zircon' });
  });

  test('leaves other doctors and plain notes alone', () => {
    expect(renameInNotes(notes, normalizeDoctorKey('سامي'), 'X')).toBe(notes);
    expect(renameInNotes('free text', normalizeDoctorKey('سامي'), 'X')).toBe('free text');
  });
});
