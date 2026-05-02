const express = require('express');
const multer = require('multer');
const { body } = require('express-validator');
const caseController = require('../controllers/caseController');
const { authenticate, authorize } = require('../middleware/auth');
const { uploadCaseImage, uploadCasePly } = require('../middleware/upload');

const router = express.Router();

// Validation rules
const createCaseValidation = [
  body('patientName').trim().notEmpty(),
  body('patientEmail').isEmail(),
  body('patientPhone').trim().notEmpty(),
  body('requesterType').optional().isIn(['doctor', 'student']),
  body('salaryAmount').optional().isFloat({ min: 0 }),
  body('caseType').trim().notEmpty(),
  body('priority').isIn(['low', 'normal', 'high', 'urgent']),
  body('dueDate').isISO8601(),
  body('notes').optional().isString(),
];

const updateCaseValidation = [
  body('patientName').optional().trim().notEmpty(),
  body('patientEmail').optional().isEmail(),
  body('patientPhone').optional().trim().notEmpty(),
  body('requesterType').optional().isIn(['doctor', 'student']),
  body('salaryAmount').optional().isFloat({ min: 0 }),
  body('notes').optional().isString(),
  body('caseType').optional().trim().notEmpty(),
  body('priority').optional().isIn(['low', 'normal', 'high', 'urgent']),
  body('dueDate').optional().isISO8601(),
];

const moveStageValidation = [
  body('stage').isIn(['waiting', 'secretary', 'design', 'khart', 'finishing', 'completed', 'exited']),
];

const assignCaseValidation = [
  body('userId').notEmpty(),
];

const updateFinancialsValidation = [
  body('salaryAmount').optional().isFloat({ min: 0 }),
  body('paymentStatus').optional().isIn(['paid', 'unpaid']),
];

// All case routes require authentication
router.use(authenticate);

// Create case - Secretary and Admin
router.post(
  '/',
  authorize('admin', 'secretary'),
  createCaseValidation,
  caseController.createCase
);

// Get all cases
router.get('/', caseController.getAllCases);
router.get('/financial-report', authorize('admin'), caseController.getFinancialReport);

// Get case by ID
router.get('/:id', caseController.getCaseById);

// Update case (admin: any, secretary: own created, designer/finisher: assigned case)
router.put('/:id', authorize('admin', 'secretary', 'designer', 'finisher'), updateCaseValidation, caseController.updateCase);
router.put('/:id/financials', authorize('admin'), updateFinancialsValidation, caseController.updateCaseFinancials);
router.delete('/:id', authorize('admin', 'secretary'), caseController.deleteCase);

// Claim case (any authenticated user)
router.put('/:id/claim', caseController.claimCase);

// Assign case - Admin only
router.put(
  '/:id/assign',
  authorize('admin'),
  assignCaseValidation,
  caseController.assignCase
);

// Move stage - Admin and role specific
router.put('/:id/move-stage', moveStageValidation, caseController.moveStage);

// Upload case image (designer / finisher / admin)
router.post('/:id/upload-image', authorize('admin', 'designer', 'finisher'), uploadCaseImage.single('image'), caseController.uploadCaseImage);

// Upload secretary 3D scan (.ply) — saved into case notes meta
const plyUploadMiddleware = (req, res, next) => {
  uploadCasePly.single('ply')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          message: 'File exceeds maximum allowed size for PLY uploads (100 MB).',
        });
      }
      return res.status(400).json({
        message: err.message || 'Upload failed.',
      });
    }
    const msg =
      typeof err?.message === 'string' ? err.message : String(err?.message ?? 'Upload rejected');
    return res.status(400).json({ message: msg });
  });
};

router.post(
  '/:id/upload-ply',
  authorize('admin', 'secretary'),
  plyUploadMiddleware,
  caseController.uploadCasePly
);

// Complete case
router.put('/:id/complete', caseController.completeCase);
router.put('/:id/exit', authorize('admin', 'secretary'), caseController.exitCase);

// Release case - Admin only
router.put('/:id/release', authorize('admin'), caseController.releaseCase);

// Reopen case - Admin only
router.put('/:id/reopen', authorize('admin'), caseController.reopenCase);

module.exports = router;
