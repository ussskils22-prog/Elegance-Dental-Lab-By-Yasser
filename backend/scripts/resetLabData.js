/**
 * Reset the lab's data to zero — keeps doctors, labs, staff logins, prices and materials.
 *
 * DRY RUN by default: prints what would be deleted and touches nothing.
 *   railway run node scripts/resetLabData.js
 *
 * For real (only after reading the dry run; the database name must match what the dry run printed):
 *   railway run node scripts/resetLabData.js --apply --db <database name> --confirm RESET
 *
 * Before deleting anything it writes a full JSON backup of every collection it touches to
 * backups/reset-<time>/ on the machine that runs it (so run it with `railway run` on your PC,
 * not inside the Railway container, whose disk is wiped on every deploy).
 *
 * DELETED: cases, doctor payments/charges, print jobs, notifications, month archives,
 *          exocad ingests, operating expenses, payroll employees + payments,
 *          material purchases + stock movements, and student accounts.
 * KEPT:    doctor / lab / staff accounts, doctor price lists, materials (prices),
 *          app settings, exocad doctor mapping, paired lab devices, audit log.
 * Options:
 *   --reset-stock    also set every material's stock quantity to 0
 *   --with-history   also delete the audit log (case history)
 */
require('dotenv').config();
// Some ISPs' DNS cannot answer mongodb+srv SRV lookups (querySrv EBADRESP): set DNS_SERVERS=8.8.8.8,1.1.1.1
if (process.env.DNS_SERVERS) require('dns').setServers(process.env.DNS_SERVERS.split(',').map((s) => s.trim()));
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '').trim() : '';
}
const has = (flag) => process.argv.includes(flag);

/** [label, model file, filter] — everything here is deleted. */
function wipePlan({ withHistory }) {
  const plan = [
    ['الحالات', 'DentalCase', {}],
    ['مدفوعات ومديونيات الدكاترة', 'DoctorPayment', {}],
    ['طوابير الطباعة', 'PrintJob', {}],
    ['الإشعارات', 'Notification', {}],
    ['أرشيف الشهور', 'MonthArchive', {}],
    ['ملفات Exocad الواردة', 'ExocadIngest', {}],
    ['المصاريف التشغيلية', 'OperatingExpense', {}],
    ['موظفين المرتبات', 'PayrollEmployee', {}],
    ['صرف المرتبات', 'PayrollPayment', {}],
    ['مشتريات الخامات', 'MaterialPurchase', {}],
    ['حركة المخزن', 'MaterialStockMovement', {}],
    ['حسابات الطلبة', 'User', { role: 'student' }],
  ];
  if (withHistory) plan.push(['سجل الحالات (audit log)', 'AuditLog', {}]);
  return plan;
}

async function main() {
  const apply = has('--apply');
  const resetStock = has('--reset-stock');
  const withHistory = has('--with-history');
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set. Run it as: railway run node scripts/resetLabData.js');
    process.exit(2);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const dbName = mongoose.connection.db.databaseName;
  if (apply && (arg('--db') !== dbName || arg('--confirm') !== 'RESET')) {
    console.error(`\nRefused: connected to "${dbName}". Pass --db ${dbName} --confirm RESET exactly (copy them from the dry run).`);
    await mongoose.disconnect();
    process.exit(3);
  }
  const plan = wipePlan({ withHistory }).map(([label, file, filter]) => ({
    label,
    file,
    filter,
    Model: require(path.join('..', 'models', file)),
  }));

  console.log(`\nDatabase: ${dbName}${apply ? '' : '   (DRY RUN — nothing is deleted)'}\n`);
  console.log('Will be DELETED:');
  for (const p of plan) {
    p.count = await p.Model.countDocuments(p.filter);
    console.log(`  - ${p.label}: ${p.count}`);
  }
  const User = require('../models/User');
  const kept = await User.aggregate([{ $match: { role: { $ne: 'student' } } }, { $group: { _id: '$role', n: { $sum: 1 } } }]);
  const DoctorPricing = require('../models/DoctorPricing');
  const Material = require('../models/Material');
  console.log('\nKept:');
  console.log(`  - accounts: ${kept.map((r) => `${r._id} ${r.n}`).join(', ') || 'none'}`);
  console.log(`  - doctor price lists: ${await DoctorPricing.countDocuments()}`);
  console.log(`  - materials: ${await Material.countDocuments()}${resetStock ? ' (stock → 0)' : ' (stock unchanged)'}`);
  if (!withHistory) console.log('  - audit log (add --with-history to delete it too)');

  if (!apply) {
    console.log(`\nTo delete for real:\n  railway run node scripts/resetLabData.js --apply --db ${dbName} --confirm RESET${resetStock ? ' --reset-stock' : ''}${withHistory ? ' --with-history' : ''}\n`);
    await mongoose.disconnect();
    return;
  }

  // 1) Backup everything that will change, before touching anything
  const dir = path.resolve('backups', `reset-${dbName}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const p of plan) {
    const docs = await p.Model.collection.find(p.filter).toArray();
    fs.writeFileSync(path.join(dir, `${p.file}${p.file === 'User' ? '-students' : ''}.json`), JSON.stringify(docs));
  }
  if (resetStock) fs.writeFileSync(path.join(dir, 'Material.json'), JSON.stringify(await Material.collection.find({}).toArray()));
  console.log(`\nBackup written to ${dir}`);

  // 2) Delete
  for (const p of plan) {
    const r = await p.Model.deleteMany(p.filter);
    console.log(`  deleted ${p.label}: ${r.deletedCount}`);
  }
  if (resetStock) {
    const r = await Material.updateMany({}, { $set: { stockQty: 0, lastLowStockAlertAt: null } });
    console.log(`  materials stock → 0: ${r.modifiedCount}`);
  }
  console.log('\nDone. Lab data is reset; doctors, labs, staff, prices and materials are kept.\n');
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error('Reset failed:', err?.message || err);
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(1);
  });
}

module.exports = { wipePlan };
