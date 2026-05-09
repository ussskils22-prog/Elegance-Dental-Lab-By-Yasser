const User = require('../models/User');
const { validationResult } = require('express-validator');

// Get all users (admin). Pass includeInactive=true to list deactivated accounts too.
exports.getAllUsers = async (req, res) => {
  try {
    const { role, status, includeInactive } = req.query;

    const filter = {};
    if (includeInactive !== 'true') {
      filter.isActive = true;
    }
    if (role) filter.role = role;
    if (status) filter.status = status;

    const users = await User.find(filter).select('-password').sort({ fullName: 1 });

    res.status(200).json({
      success: true,
      data: users,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users',
      error: error.message,
    });
  }
};

// Get user by ID
exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({
      success: true,
      user,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user',
      error: error.message,
    });
  }
};

// Update user
exports.updateUser = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { fullName, phone, department, role, password, isActive } = req.body;

    const user = await User.findById(req.params.id).select('+password');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Only admin can change roles
    if (role && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admin can change user roles' });
    }

    if (fullName) user.fullName = fullName;
    if (phone !== undefined && phone !== null) user.phone = phone;
    if (department !== undefined) user.department = department;
    if (role && req.user.role === 'admin') user.role = role;

    if (password && typeof password === 'string' && password.length >= 6) {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Only admin can set passwords' });
      }
      user.password = password;
    }

    if (req.user.role === 'admin' && isActive !== undefined) {
      let normalizedIsActive = isActive;
      if (typeof normalizedIsActive === 'string') {
        const lowered = normalizedIsActive.toLowerCase();
        if (lowered === 'true') normalizedIsActive = true;
        if (lowered === 'false') normalizedIsActive = false;
      }

      if (typeof normalizedIsActive !== 'boolean') {
        return res.status(400).json({ message: 'isActive must be a boolean' });
      }

      user.isActive = normalizedIsActive;
      if (!normalizedIsActive) {
        user.status = 'offline';
        user.lastSeen = new Date();
      }
    }

    await user.save();

    res.status(200).json({
      success: true,
      message: 'User updated successfully',
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        department: user.department,
        isActive: user.isActive,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update user',
      error: error.message,
    });
  }
};

// Update user status
exports.updateUserStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!['online', 'offline', 'idle'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      {
        status,
        lastSeen: new Date(),
      },
      { new: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({
      success: true,
      message: 'User status updated',
      user,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update user status',
      error: error.message,
    });
  }
};

// Delete user (soft delete)
exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({
      success: true,
      message: 'User deleted successfully',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to delete user',
      error: error.message,
    });
  }
};

// Get users by role
exports.getUsersByRole = async (req, res) => {
  try {
    const { role } = req.params;

    const validRoles = ['admin', 'secretary', 'designer', 'finisher'];

    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: 'Invalid role' });
    }

    const users = await User.find({ role, isActive: true }).select('-password').sort({ fullName: 1 });

    res.status(200).json({
      success: true,
      data: users,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users',
      error: error.message,
    });
  }
};