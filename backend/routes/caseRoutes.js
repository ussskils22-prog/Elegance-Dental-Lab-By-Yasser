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
  body('patientEmail').optional({ values: 'falsy' }).isEmail(),
  body('patientPhone').optional({ values: 'falsy' }).trim(),
  body('requesterType').optional().isIn(['doctor', 'student', 'lab']),
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
  body('requesterType').optional().isIn(['doctor', 'student', 'lab']),
  body('salaryAmount').optional().isFloat({ min: 0 }),
  body('notes').optional().isString(),
  body('caseType').optional().trim().notEmpty(),
  body('priority').optional().isIn(['low', 'normal', 'high', 'urgent']),
  body('dueDate').optional().isISO8601(),
  body('stageTimestamps').optional().isObject(),
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

// Get all cases — authentication required
router.get('/', authenticate, caseController.getAllCases);

// All other case routes require authentication
router.use(authenticate);

// Create case - Secretary, Admin, Requester, Doctor
router.post(
  '/',
  authorize('admin', 'secretary', 'requester', 'doctor', 'student', 'lab'),
  createCaseValidation,
  caseController.createCase
);

router.get('/financial-report', authorize('admin'), caseController.getFinancialReport);
router.get('/material-stats', authorize('admin'), caseController.getExitedMaterialStats);
router.get(
  '/delivery-alerts',
  authorize('admin', 'secretary'),
  caseController.getDeliveryAlerts
);
router.get(
  '/doctor-account-summary',
  authorize('doctor', 'student', 'lab', 'admin'),
  caseController.getDoctorAccountSummary
);
router.get(
  '/doctor-exited-materials',
  authorize('doctor', 'student', 'lab', 'admin'),
  caseController.getDoctorExitedMaterials
);

// Station barcode/QR scan (must be before /:id)
router.post(
  '/scan',
  authorize('admin', 'secretary', 'designer', 'finisher', 'scanner1', 'scanner2', 'scanner3'),
  caseController.scanAtStation
);

// Convert doctor/student/lab by name and retag all their cases (must be before /:id)
router.post(
  '/retag-requester',
  authorize('admin', 'secretary'),
  body('fullName').trim().notEmpty(),
  body('requesterType').isIn(['doctor', 'student', 'lab']),
  caseController.retagRequesterByName
);

// Case bill (doctor, due amount, paid status) — reception + admin
router.get('/:id/bill', authorize('admin', 'secretary'), caseController.getCaseBill);

// Get case by ID
router.get('/:id', authenticate, caseController.getCaseById);

// Update case (admin: any, secretary: own created, designer/finisher: assigned case)
router.put('/:id', authorize('admin', 'secretary', 'designer', 'finisher', 'doctor', 'student', 'lab'), updateCaseValidation, caseController.updateCase);
router.put('/:id/financials', authorize('admin'), updateFinancialsValidation, caseController.updateCaseFinancials);
router.delete('/:id', authorize('admin', 'secretary'), caseController.deleteCase);

// Claim case — lab staff only
router.put(
  '/:id/claim',
  authorize('admin', 'designer', 'finisher'),
  caseController.claimCase
);

// Assign case - Admin only
router.put(
  '/:id/assign',
  authorize('admin'),
  assignCaseValidation,
  caseController.assignCase
);

// Move stage — forward-only (enforced in controller)
router.put(
  '/:id/move-stage',
  authorize('admin', 'secretary', 'designer', 'finisher'),
  moveStageValidation,
  caseController.moveStage
);

// Upload case image (designer / finisher / admin)
router.post('/:id/upload-image', authorize('admin', 'designer', 'finisher'), uploadCaseImage.single('image'), caseController.uploadCaseImage);

// Upload 3D/scan archive (.ply / .stl / .obj / .rar / .zip) — saved into case notes meta
const plyUploadMiddleware = (req, res, next) => {
  uploadCasePly.single('ply')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          message: 'File exceeds maximum allowed size for scan uploads (100 MB).',
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
  authorize('admin', 'secretary', 'doctor', 'student', 'lab'),
  plyUploadMiddleware,
  caseController.uploadCasePly
);

router.put(
  '/:id/ply-link',
  authorize('admin', 'secretary', 'doctor', 'student', 'lab'),
  caseController.setCasePlyLink
);

// Complete case — finishing staff / admin / secretary
router.put(
  '/:id/complete',
  authorize('admin', 'secretary', 'finisher', 'scanner1'),
  caseController.completeCase
);
router.put('/:id/exit', authorize('admin', 'secretary'), caseController.exitCase);
router.put(
  '/:id/request-revision',
  authorize('admin', 'secretary'),
  caseController.requestRevision
);

// Release case - Admin only
router.put('/:id/release', authorize('admin'), caseController.releaseCase);

// Reopen case - Admin only
router.put('/:id/reopen', authorize('admin'), caseController.reopenCase);

module.exports = router;
