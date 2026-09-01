const User = require('../models/User');
const bcrypt = require('bcryptjs');
const { generateToken } = require('../config/jwt');
const { validationResult } = require('express-validator');

// Login
exports.login = async (req, res) => {
  try {
    // Validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    // Find only active user
    const user = await User.findOne({ email: email.toLowerCase(), isActive: true }).select('+password +pinHash');

    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // Compare password
    const isPasswordMatch = await user.comparePassword(password);

    if (!isPasswordMatch) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // Generate token
    const token = generateToken(user._id, user.role);

    // Update last seen
    await User.findByIdAndUpdate(user._id, { lastSeen: new Date(), status: 'online' });

    res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        department: user.department,
        hasPin: !!user.pinHash,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Login failed',
      error: error.message,
    });
  }
};

async function createStaffUser({ fullName, email, phone, password, role, department }) {
  let user = await User.findOne({ email: email.toLowerCase() });
  if (user) {
    const err = new Error('User already exists');
    err.statusCode = 400;
    throw err;
  }

  user = new User({
    fullName,
    email: email.toLowerCase(),
    phone,
    password,
    role: role || 'secretary',
    department,
    isActive: true,
  });
  if (role === 'doctor') {
    user.loginPasswordVisible = password;
  }

  await user.save();
  return user;
}

// Register (Admin only)
exports.register = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { fullName, email, phone, password, role, department } = req.body;
    const user = await createStaffUser({
      fullName,
      email,
      phone,
      password,
      role: role || 'secretary',
      department,
    });

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    res.status(status).json({
      success: false,
      message: status === 400 ? error.message : 'Registration failed',
      error: error.message,
    });
  }
};

// Register doctor account (Admin or Secretary)
exports.registerDoctor = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { fullName, email, phone, password } = req.body;
    const user = await createStaffUser({
      fullName,
      email,
      phone,
      password,
      role: 'doctor',
      department: 'دكتور',
    });

    res.status(201).json({
      success: true,
      message: 'تم إنشاء حساب الدكتور',
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    res.status(status).json({
      success: false,
      message: status === 400 ? 'البريد مستخدم بالفعل' : 'فشل إنشاء الحساب',
      error: error.message,
    });
  }
};

// Logout
exports.logout = async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user.id, {
      status: 'offline',
      lastSeen: new Date(),
    });

    res.status(200).json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Logout failed',
      error: error.message,
    });
  }
};

// Get Current User
exports.getCurrentUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('+pinHash');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({
      success: true,
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        status: user.status,
        department: user.department,
        lastSeen: user.lastSeen,
        hasPin: !!user.pinHash,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user',
      error: error.message,
    });
  }
};

// Doctor/admin: set or change 4–6 digit PIN for faster mobile login
exports.setPin = async (req, res) => {
  try {
    const pin = String(req.body?.pin || '').trim();
    if (!/^\d{4,6}$/.test(pin)) {
      return res.status(400).json({
        success: false,
        message: 'الرقم السري يجب أن يكون من 4 إلى 6 أرقام',
      });
    }

    const user = await User.findById(req.user.id).select('+pinHash');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (!['doctor', 'admin'].includes(user.role)) {
      return res.status(403).json({ success: false, message: 'PIN متاح لحسابات الدكاترة' });
    }

    const salt = await bcrypt.genSalt(10);
    user.pinHash = await bcrypt.hash(pin, salt);
    await user.save();

    return res.json({ success: true, message: 'تم حفظ الرقم السري' });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to set PIN',
      error: error.message,
    });
  }
};

// Public: login with email + PIN (doctors)
exports.loginWithPin = async (req, res) => {
  try {
    const email = String(req.body?.email || '').toLowerCase().trim();
    const pin = String(req.body?.pin || '').trim();
    if (!email || !/^\d{4,6}$/.test(pin)) {
      return res.status(400).json({
        success: false,
        message: 'أدخل البريد والرقم السري (4–6 أرقام)',
      });
    }

    const user = await User.findOne({ email, isActive: true }).select('+pinHash');
    if (!user || !user.pinHash) {
      return res.status(401).json({ message: 'الرقم السري غير صحيح أو غير مفعّل' });
    }
    if (!['doctor', 'admin'].includes(user.role)) {
      return res.status(403).json({ message: 'الدخول بالرقم السري متاح للدكاترة فقط' });
    }

    const ok = await user.comparePin(pin);
    if (!ok) {
      return res.status(401).json({ message: 'الرقم السري غير صحيح' });
    }

    const token = generateToken(user._id, user.role);
    await User.findByIdAndUpdate(user._id, { lastSeen: new Date(), status: 'online' });

    return res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        role: user.role,
        department: user.department,
        hasPin: true,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Login with PIN failed',
      error: error.message,
    });
  }
};

// Check if email has a PIN (for login UI) — no sensitive data
exports.pinStatus = async (req, res) => {
  try {
    const email = String(req.query?.email || '').toLowerCase().trim();
    if (!email) {
      return res.json({ success: true, hasPin: false });
    }
    const user = await User.findOne({ email, isActive: true }).select('+pinHash role');
    return res.json({
      success: true,
      hasPin: !!(user?.pinHash && ['doctor', 'admin'].includes(user.role)),
    });
  } catch (error) {
    return res.json({ success: true, hasPin: false });
  }
};

// Change own password (any authenticated user)
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || String(newPassword).length < 6) {
      return res.status(400).json({
        success: false,
        message: 'كلمة المرور الجديدة يجب ألا تقل عن 6 أحرف',
      });
    }

    const user = await User.findById(req.user.id).select('+password +loginPasswordVisible');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const ok = await user.comparePassword(String(currentPassword));
    if (!ok) {
      return res.status(400).json({ success: false, message: 'كلمة المرور الحالية غير صحيحة' });
    }

    user.password = String(newPassword);
    if (user.role === 'doctor') {
      user.loginPasswordVisible = String(newPassword);
    }
    await user.save();

    return res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح' });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to change password',
      error: error.message,
    });
  }
};
