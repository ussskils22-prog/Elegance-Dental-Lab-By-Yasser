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
  body('role').optional().isIn(['admin', 'secretary', 'designer', 'finisher']),
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
router.get('/role/:role', userController.getUsersByRole);

// Get user by ID
router.get('/:id', userController.getUserById);

// Update user (admin — staff management / role / password / active)
router.put('/:id', authorize('admin'), updateUserValidation, userController.updateUser);

// Update user status
router.put('/:id/status', updateStatusValidation, userController.updateUserStatus);

// Delete user (soft delete) - Admin only
router.delete('/:id', authorize('admin'), userController.deleteUser);

module.exports = router;
