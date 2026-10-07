/**
 * Seed a DEMO Mongo database with fake lab data + Admin Demo account.
 *
 * SAFETY: refuses to run unless DEMO_MODE=true.
 * Never point MONGODB_URI at production when running this.
 *
 * Usage:
 *   DEMO_MODE=true MONGODB_URI="mongodb://..." node scripts/seedDemo.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const User = require('../models/User');
const DentalCase = require('../models/DentalCase');
const Material = require('../models/Material');
const DoctorPayment = require('../models/DoctorPayment');
const DoctorPricing = require('../models/DoctorPricing');

const DEMO_ADMIN = {
  fullName: 'Admin Demo',
  email: 'demo-admin@unishop.local',
  password: 'Demo@UniShop2026',
  phone: '01000000000',
  role: 'admin',
  department: 'Management',
};

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

async function wipeDemoCollections() {
  await Promise.all([
    User.deleteMany({}),
    DentalCase.deleteMany({}),
    Material.deleteMany({}),
    DoctorPayment.deleteMany({}),
    DoctorPricing.deleteMany({}),
  ]);
}

async function createUser(data) {
  // Use Model.create so password pre-save hook hashes once
  return User.create({
    fullName: data.fullName,
    email: data.email,
    phone: data.phone,
    password: data.password,
    role: data.role,
    department: data.department || '',
    isActive: true,
    status: 'offline',
    ...(data.pin
      ? { pinHash: await bcrypt.hash(String(data.pin), 10), loginPasswordVisible: data.password }
      : {}),
  });
}

async function seed() {
  if (String(process.env.DEMO_MODE || '').toLowerCase() !== 'true') {
    console.error('REFUSED: Set DEMO_MODE=true to run seedDemo.js (protects production DBs).');
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('REFUSED: MONGODB_URI is required.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected:', mongoose.connection.host, '/', mongoose.connection.name);
  console.log('Wiping demo collections...');
  await wipeDemoCollections();

  const admin = await createUser(DEMO_ADMIN);
  const secretary = await createUser({
    fullName: 'سكرتارية ديمو',
    email: 'demo-secretary@unishop.local',
    password: 'Demo@123456',
    phone: '01000000002',
    role: 'secretary',
    department: 'Reception',
  });
  const designer = await createUser({
    fullName: 'ديزاينر ديمو',
    email: 'demo-designer@unishop.local',
    password: 'Demo@123456',
    phone: '01000000003',
    role: 'designer',
    department: 'Design',
  });
  const finisher = await createUser({
    fullName: 'فينيشر ديمو',
    email: 'demo-finisher@unishop.local',
    password: 'Demo@123456',
    phone: '01000000004',
    role: 'finisher',
    department: 'Finishing',
  });

  const doctors = [];
  const doctorDefs = [
    { fullName: 'د. أحمد التجريبي', email: 'demo-doctor1@unishop.local', pin: '1234' },
    { fullName: 'د. سارة النموذج', email: 'demo-doctor2@unishop.local', pin: '1234' },
    { fullName: 'د. كريم العرض', email: 'demo-doctor3@unishop.local', pin: '5678' },
  ];
  for (const d of doctorDefs) {
    doctors.push(
      await createUser({
        ...d,
        password: 'Demo@123456',
        phone: '01011112222',
        role: 'doctor',
        department: 'دكتور',
      })
    );
  }

  await createUser({
    fullName: 'طالب ديمو',
    email: 'demo-student@unishop.local',
    password: 'Demo@123456',
    phone: '01033334444',
    role: 'student',
    department: 'طالب',
  });

  const materials = [
    {
      key: 'zircon',
      label: 'Zircon',
      labelAr: 'زيركون',
      matchKeywords: ['zircon', 'زيركون'],
      defaultPrice: 800,
      stockQty: 120,
      avgUnitCost: 350,
      sortOrder: 10,
    },
    {
      key: 'emax',
      label: 'Emax',
      labelAr: 'إيماكس',
      matchKeywords: ['emax', 'ايماكس', 'إيماكس'],
      defaultPrice: 900,
      stockQty: 80,
      avgUnitCost: 400,
      sortOrder: 20,
    },
    {
      key: 'peek',
      label: 'Peek',
      labelAr: 'بيك',
      matchKeywords: ['peek', 'بيك'],
      defaultPrice: 700,
      stockQty: 40,
      avgUnitCost: 300,
      sortOrder: 30,
    },
  ];
  await Material.insertMany(materials);

  for (const doc of doctors) {
    await DoctorPricing.create({
      doctorName: doc.fullName,
      prices: { zircon: 750, emax: 850, peek: 650 },
    });
  }

  const caseSpecs = [
    {
      patientName: 'مريض تجريبي ١',
      doctor: doctors[0],
      stage: 'secretary',
      caseType: 'Zircon (2)',
      daysAgoCreated: 1,
    },
    {
      patientName: 'مريض تجريبي ٢',
      doctor: doctors[0],
      stage: 'design',
      caseType: 'Emax (1)',
      daysAgoCreated: 2,
    },
    {
      patientName: 'مريض تجريبي ٣',
      doctor: doctors[1],
      stage: 'finishing',
      caseType: 'Zircon (3)',
      daysAgoCreated: 3,
    },
    {
      patientName: 'مريض تجريبي ٤',
      doctor: doctors[1],
      stage: 'completed',
      caseType: 'Peek (1)',
      daysAgoCreated: 5,
    },
    {
      patientName: 'مريض تجريبي ٥',
      doctor: doctors[2],
      stage: 'exited',
      caseType: 'Zircon (2)',
      daysAgoCreated: 8,
      revenue: 1600,
      paid: true,
    },
    {
      patientName: 'مريض تجريبي ٦',
      doctor: doctors[2],
      stage: 'exited',
      caseType: 'Emax (2)',
      daysAgoCreated: 10,
      revenue: 1800,
      paid: false,
    },
    {
      patientName: 'مريض تجريبي ٧',
      doctor: doctors[0],
      stage: 'waiting',
      caseType: 'Zircon (1)',
      daysAgoCreated: 0,
    },
    {
      patientName: 'مريض تجريبي ٨',
      doctor: doctors[1],
      stage: 'khart',
      caseType: 'Emax (2)',
      daysAgoCreated: 4,
    },
  ];

  const stageStatus = {
    waiting: 'waiting',
    secretary: 'in_progress',
    design: 'in_progress',
    khart: 'in_progress',
    finishing: 'in_progress',
    completed: 'completed',
    exited: 'exited',
  };

  for (const spec of caseSpecs) {
    const createdAt = daysAgo(spec.daysAgoCreated);
    const stamps = {};
    const order = ['secretary', 'design', 'khart', 'finishing', 'completed', 'exited'];
    let t = new Date(createdAt);
    for (const s of order) {
      stamps[s] = new Date(t);
      if (s === spec.stage) break;
      t = new Date(t.getTime() + 12 * 3600 * 1000);
    }

    const c = new DentalCase({
      patientName: spec.patientName,
      patientEmail: 'patient.demo@unishop.local',
      patientPhone: '01099998888',
      requesterType: 'doctor',
      referringDoctor: spec.doctor.fullName,
      notes: `meta:doctor=${spec.doctor.fullName}; demo case`,
      currentStage: spec.stage,
      status: stageStatus[spec.stage] || 'waiting',
      createdBy: secretary._id,
      caseType: spec.caseType,
      priority: 'normal',
      dueDate: daysFromNow(3),
      stageTimestamps: stamps,
      revenueAmount: spec.revenue || 0,
      salaryAmount: spec.revenue || 0,
      paymentStatus: spec.paid ? 'paid' : 'unpaid',
      paidAt: spec.paid ? daysAgo(1) : null,
      createdAt,
      updatedAt: createdAt,
    });
    // Bypass default timestamps overwrite by setting after construct
    await c.save();
    if (spec.daysAgoCreated) {
      await DentalCase.updateOne(
        { _id: c._id },
        { $set: { createdAt, updatedAt: createdAt } }
      );
    }
  }

  await DoctorPayment.create({
    doctorName: doctors[2].fullName,
    amount: 500,
    entryType: 'payment',
    notes: 'دفعة تجريبية للديمو',
    paymentDate: daysAgo(2),
  });
  await DoctorPayment.create({
    doctorName: doctors[0].fullName,
    amount: 200,
    entryType: 'charge',
    notes: 'خدمة إضافية تجريبية',
    paymentDate: daysAgo(1),
  });

  console.log('\n✅ Demo seed completed.');
  console.log('------------------------------');
  console.log('Admin Demo:');
  console.log(`  ${DEMO_ADMIN.email}`);
  console.log(`  ${DEMO_ADMIN.password}`);
  console.log('Staff (password Demo@123456):');
  console.log('  demo-secretary@unishop.local');
  console.log('  demo-designer@unishop.local');
  console.log('  demo-finisher@unishop.local');
  console.log('Doctors (password Demo@123456, PIN 1234/5678):');
  for (const d of doctorDefs) console.log(`  ${d.email}  pin=${d.pin}`);
  console.log(`Users: admin=${admin.email}, secretary=${secretary.email}, designer=${designer.email}, finisher=${finisher.email}`);

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch(async (err) => {
  console.error('seedDemo failed:', err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
