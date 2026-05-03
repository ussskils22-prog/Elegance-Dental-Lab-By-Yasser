require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const MONGODB_URI = process.env.MONGODB_URI;

const userSchema = new mongoose.Schema({
  fullName: String,
  email: { type: String, unique: true },
  password: String,
  phone: String,
  role: String,
  status: { type: String, default: 'offline' },
  department: String,
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

const users = [
  { fullName: 'Admin User', email: 'admin@dental.com', password: 'Admin@123', phone: '01000000001', role: 'admin', department: 'Management' },
  { fullName: 'Secretary User', email: 'secretary@dental.com', password: 'Secretary@123', phone: '01000000002', role: 'secretary', department: 'Reception' },
  { fullName: 'Designer User', email: 'designer@dental.com', password: 'Designer@123', phone: '01000000003', role: 'designer', department: 'Design' },
  { fullName: 'Finisher User', email: 'finisher@dental.com', password: 'Finisher@123', phone: '01000000004', role: 'finisher', department: 'Finishing' },
];

const seed = async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    for (const u of users) {
      const exists = await User.findOne({ email: u.email });
      if (exists) {
        console.log(`User ${u.email} already exists, skipping...`);
        continue;
      }
      const hashed = await bcrypt.hash(u.password, 10);
      await User.create({ ...u, password: hashed });
      console.log(`Created user: ${u.email} | password: ${u.password} | role: ${u.role}`);
    }

    console.log('\n✅ Seed completed!');
    console.log('-------------------');
    console.log('Admin:     admin@dental.com     / Admin@123');
    console.log('Secretary: secretary@dental.com / Secretary@123');
    console.log('Designer:  designer@dental.com  / Designer@123');
    console.log('Finisher:  finisher@dental.com  / Finisher@123');
    process.exit(0);
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  }
};

seed();
