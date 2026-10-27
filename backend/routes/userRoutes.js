const express = require('express');
const { body } = require('express-validator');
const userController = require('../controllers/userController');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// Validation rules
const updateUserValidation = [
  body('fullName').optional().trim(),
  body('phone').optional().trim(),
  body('department').optional().trim(),
  body('role').optional().isIn([
    'admin',
    'secretary',
    'designer',
    'finisher',
    'requester',
    'doctor',
    'student',
    'lab',
    'scanner1',
    'scanner2',
    'scanner3',
  ]),
  body('password').optional().isLength({ min: 6 }),
  body('isActive').optional().isBoolean(),
];

const updateStatusValidation = [
  body('status').isIn(['online', 'offline', 'idle']),
];

// All routes require authentication
router.use(authenticate);

// Get all users
router.get('/', authorize('admin'), userController.getAllUsers);

// Get users by role
router.get('/role/:role', authorize('admin', 'secretary'), userController.getUsersByRole);

// Convert/create doctor/student/lab by name and retag their cases
router.post(
  '/ensure-client-account',
  authorize('admin', 'secretary'),
  body('fullName').trim().notEmpty(),
  body('role').isIn(['doctor', 'student', 'lab']),
  userController.ensureClientAccount
);

// Get user by ID
router.get('/:id', authorize('admin', 'secretary'), userController.getUserById);

// Reset doctor password (admin or secretary)
router.patch(
  '/:id/reset-doctor-password',
  authorize('admin', 'secretary'),
  body('password').isLength({ min: 6 }),
  userController.resetDoctorPassword
);

// Convert doctor/student/lab account and retag cases by name
router.patch(
  '/:id/convert-client-role',
  authorize('admin', 'secretary'),
  body('role').isIn(['doctor', 'student', 'lab']),
  userController.convertClientRole
);

// Update user (admin — staff management / role / password / active)
router.put('/:id', authorize('admin'), updateUserValidation, userController.updateUser);

// Update user status
router.put('/:id/status', updateStatusValidation, userController.updateUserStatus);

// Delete user (soft delete) - Admin only
router.delete('/:id', authorize('admin'), userController.deleteUser);

module.exports = router;
