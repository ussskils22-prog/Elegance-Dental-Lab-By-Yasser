const { validationResult } = require('express-validator');
const { updateCaseValidation } = require('../routes/caseValidation');

async function errorsFor(body) {
  const req = { body };
  for (const rule of updateCaseValidation) await rule.run(req);
  return validationResult(req).array().map((e) => e.path);
}

describe('edit case validation', () => {
  test('blank phone and email from the edit form are accepted', async () => {
    expect(await errorsFor({ patientName: 'رغده ثابت', patientPhone: '', patientEmail: '', caseType: 'Zircon' })).toEqual([]);
  });

  test('a real bad email is still rejected', async () => {
    expect(await errorsFor({ patientEmail: 'not-an-email' })).toEqual(['patientEmail']);
  });
});
