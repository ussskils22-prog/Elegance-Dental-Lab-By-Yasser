const express = require('express');
const { body } = require('express-validator');
const authController = require('../controllers/authController');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// Validation rules
const loginValidation = [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
];

const registerValidation = [
  body('fullName').trim().notEmpty(),
  body('email').isEmail().normalizeEmail(),
  body('phone').trim().notEmpty(),
  body('password').isLength({ min: 6 }),
  body('role').optional().isIn([
    'admin',
    'secretary',
    'designer',
    'finisher',
    'requester',
    'doctor',
    'scanner1',
    'scanner2',
    'scanner3',
  ]),
  body('department').optional().trim(),
];

const registerDoctorValidation = [
  body('fullName').trim().notEmpty(),
  body('email').isEmail().normalizeEmail(),
  body('phone').optional({ nullable: true }).trim(),
  body('password').isLength({ min: 6 }),
];

// Public routes
router.post('/login', loginValidation, authController.login);
router.post(
  '/login-pin',
  body('email').isEmail().normalizeEmail(),
  body('pin').isLength({ min: 4, max: 6 }),
  authController.loginWithPin
);
router.get('/pin-status', authController.pinStatus);

// Protected routes
router.post(
  '/register',
  authenticate,
  authorize('admin'),
  registerValidation,
  authController.register
);
router.post(
  '/register-doctor',
  authenticate,
  authorize('admin', 'secretary'),
  registerDoctorValidation,
  authController.registerDoctor
);
router.post('/logout', authenticate, authController.logout);
router.get('/me', authenticate, authController.getCurrentUser);
router.post(
  '/set-pin',
  authenticate,
  body('pin').isLength({ min: 4, max: 6 }),
  authController.setPin
);
router.post(
  '/change-password',
  authenticate,
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 }),
  authController.changePassword
);

module.exports = router;
