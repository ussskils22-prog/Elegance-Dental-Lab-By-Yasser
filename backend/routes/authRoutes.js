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
  body('role').optional().isIn(['admin', 'secretary', 'designer', 'finisher']),
  body('department').optional().trim(),
];

// Public routes
router.post('/login', loginValidation, authController.login);

// Protected routes
router.post(
  '/register',
  authenticate,
  authorize('admin'),
  registerValidation,
  authController.register
);
router.post('/logout', authenticate, authController.logout);
router.get('/me', authenticate, authController.getCurrentUser);

module.exports = router;
