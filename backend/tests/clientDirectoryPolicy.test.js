const { canAddClient, mustPickFromList, notInListMessage } = require('../services/clientDirectoryPolicy');

describe('who may add doctors, labs and students', () => {
  test('only admin adds doctors and labs', () => {
    expect(canAddClient('admin', 'doctor')).toBe(true);
    expect(canAddClient('admin', 'lab')).toBe(true);
    expect(canAddClient('secretary', 'doctor')).toBe(false);
    expect(canAddClient('secretary', 'lab')).toBe(false);
    expect(canAddClient('requester', 'doctor')).toBe(false);
  });

  test('reception adds students freely (new students every day)', () => {
    expect(canAddClient('secretary', 'student')).toBe(true);
    expect(canAddClient('admin', 'student')).toBe(true);
  });
});

describe('when a case must use a doctor/lab from the list', () => {
  test('non-admin staff creating a doctor or lab case', () => {
    expect(mustPickFromList('secretary', 'doctor')).toBe(true);
    expect(mustPickFromList('secretary', 'lab')).toBe(true);
    expect(mustPickFromList('requester', 'doctor')).toBe(true);
  });

  test('admin, students and the doctor portal are not restricted', () => {
    expect(mustPickFromList('admin', 'doctor')).toBe(false);
    expect(mustPickFromList('secretary', 'student')).toBe(false);
    expect(mustPickFromList('doctor', 'doctor')).toBe(false); // portal: own name is forced
  });

  test('the message tells the secretary what to do', () => {
    expect(notInListMessage('lab', 'معمل نور')).toContain('الأدمن');
    expect(notInListMessage('doctor', 'علي')).toContain('«علي»');
  });
});
