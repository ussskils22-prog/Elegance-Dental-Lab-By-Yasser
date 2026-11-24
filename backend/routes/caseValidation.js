const { body } = require('express-validator');

// Edit form sends empty strings for blank optional fields (no phone, no email):
// treat empty as "not provided" instead of failing with "Invalid value".
const updateCaseValidation = [
  body('patientName').optional({ values: 'falsy' }).trim().notEmpty(),
  body('patientEmail').optional({ values: 'falsy' }).isEmail(),
  body('patientPhone').optional({ values: 'falsy' }).trim(),
  body('requesterType').optional({ values: 'falsy' }).isIn(['doctor', 'student', 'lab']),
  body('salaryAmount').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('notes').optional().isString(),
  body('caseType').optional({ values: 'falsy' }).trim().notEmpty(),
  body('priority').optional({ values: 'falsy' }).isIn(['low', 'normal', 'high', 'urgent']),
  body('dueDate').optional({ values: 'falsy' }).isISO8601(),
  body('stageTimestamps').optional().isObject(),
];

module.exports = { updateCaseValidation };
