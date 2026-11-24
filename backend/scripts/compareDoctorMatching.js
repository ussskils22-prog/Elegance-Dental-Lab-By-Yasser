/**
 * PRE-DEPLOY CHECK for the exact doctor-name matching change.
 *
 * The old code treated two names as the same doctor when one CONTAINED the other
 * ("فرزات" = "سامي فرزات"). The new code needs the same name (after removing titles,
 * spaces and Arabic letter variants). This script shows, on real data, what that changes:
 *   1. payments that leave a doctor's ledger (saved under a shorter/longer name variant)
 *   2. doctors who lose a price list they used to borrow from a similar name
 *   3. exited cases with NO frozen bill whose live price changes (history would move)
 *
 * Read-only by default:
 *   node scripts/compareDoctorMatching.js
 * Freeze group 3 at the OLD price so history cannot move (writes billSnapshot only):
 *   node scripts/compareDoctorMatching.js --freeze --apply --by admin@lab.com
 */
require('dotenv').config();
// Some ISPs' DNS cannot answer the SRV lookups that mongodb+srv:// needs (querySrv EBADRESP).
// Set DNS_SERVERS=8.8.8.8,1.1.1.1 to resolve through public DNS instead.
if (process.env.DNS_SERVERS) require('dns').setServers(process.env.DNS_SERVERS.split(',').map((s) => s.trim()));
const mongoose = require('mongoose');
const DentalCase = require('../models/DentalCase');
const DoctorPayment = require('../models/DoctorPayment');
const DoctorPricing = require('../models/DoctorPricing');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { normalizeDoctorKey, doctorKeysMatch } = require('../utils/doctorName');
const pricing = require('../services/casePricingService');

/** The OLD rule, kept here only to measure the difference. */
function legacyMatch(a, b) {
  const ka = normalizeDoctorKey(a);
  const kb = normalizeDoctorKey(b);
  if (!ka || !kb) return false;
  return ka === kb || ka.includes(kb) || kb.includes(ka);
}

function legacyMergePrices(pricings, doctorName) {
  const rows = pricings
    .filter((p) => legacyMatch(p.doctorName, doctorName))
    .sort((a, b) => new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0));
  if (!rows.length) return null;
  const merged = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.prices || {})) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) {
        merged[k] = n;
        merged[String(k).toLowerCase()] = n;
      }
    }
  }
  return Object.keys(merged).length ? merged : null;
}

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
};

async function main() {
  const freeze = process.argv.includes('--freeze');
  const apply = process.argv.includes('--apply');
  if (freeze && apply && !arg('--by')) {
    console.error('--freeze --apply needs --by <admin email> for the audit log.');
    process.exit(2);
  }
  await mongoose.connect(process.env.MONGODB_URI);

  const cases = await DentalCase.find({})
    .select('caseNumber caseType notes referringDoctor currentStage billSnapshot revenueAmount salaryAmount')
    .lean();
  const payments = await DoctorPayment.find({}).lean();
  const pricings = await DoctorPricing.find({}).lean();
  const caseDoctor = (c) => {
    const m = pricing.parseNotesMeta(c.notes || '');
    return String(c.referringDoctor || m.doctor || m.doctorName || '').trim();
  };
  const doctors = [...new Set(cases.map(caseDoctor).filter(Boolean))];

  // 1. payments leaving a ledger
  console.log('\n== 1. Payments that will no longer count for a doctor ==');
  let lost = 0;
  for (const d of doctors) {
    const moved = payments.filter((p) => legacyMatch(p.doctorName, d) && !doctorKeysMatch(p.doctorName, d));
    if (!moved.length) continue;
    lost += moved.length;
    const sum = moved.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    console.log(`  ${d}: ${moved.length} entries (${sum}) saved as ${[...new Set(moved.map((p) => p.doctorName))].join(' / ')}`);
  }
  if (!lost) console.log('  none');

  // 2. price lists no longer borrowed
  console.log('\n== 2. Doctors who lose a borrowed price list ==');
  let borrowed = 0;
  for (const d of doctors) {
    const before = pricings.filter((p) => legacyMatch(p.doctorName, d)).map((p) => p.doctorName);
    const after = pricings.filter((p) => doctorKeysMatch(p.doctorName, d)).map((p) => p.doctorName);
    const gone = before.filter((n) => !after.includes(n));
    if (!gone.length) continue;
    borrowed++;
    console.log(`  ${d}: no longer uses prices of ${gone.join(' / ')}`);
  }
  if (!borrowed) console.log('  none');

  // 3. unfrozen exited bills that change
  console.log('\n== 3. Exited cases without a frozen bill whose price changes ==');
  const materials = await pricing.loadActiveMaterials();
  const labDefaults = pricing.materialsToDefaultPrices(materials);
  const unfrozen = cases.filter((c) => {
    if (c.currentStage !== 'exited') return false;
    const snap = c.billSnapshot;
    if (snap && snap.total != null && snap.total !== '' && Number.isFinite(Number(snap.total))) return false;
    return !(Number(c.revenueAmount) > 0) && !(Number(c.salaryAmount) > 0);
  });
  const changed = [];
  for (const c of unfrozen) {
    const d = caseDoctor(c);
    const meta = pricing.parseNotesMeta(c.notes || '');
    if (pricing.isNonBillableCase(c.caseType, meta)) continue;
    const oldB = pricing.calculateCaseCostBreakdown(c.caseType, c.notes, legacyMergePrices(pricings, d), materials, labDefaults);
    const newB = pricing.calculateCaseCostBreakdown(c.caseType, c.notes, pricing.mergePricesForDoctor(pricings, d), materials, labDefaults);
    const o = Math.round((Number(oldB.total) || 0) * 100) / 100;
    const n = Math.round((Number(newB.total) || 0) * 100) / 100;
    if (o !== n) changed.push({ c, d, o, n, oldB });
  }
  changed.forEach((x) => console.log(`  ${x.c.caseNumber} (${x.d}): ${x.o} → ${x.n}`));
  console.log(`  ${changed.length} of ${unfrozen.length} unfrozen exited cases change`);

  if (freeze) {
    if (!apply) {
      console.log('\n--freeze without --apply: nothing written.');
    } else {
      const admin = await User.findOne({ email: arg('--by').toLowerCase(), role: 'admin' });
      if (!admin) throw new Error(`No admin account with email ${arg('--by')}`);
      for (const x of changed) {
        const snapshot = {
          doctorName: x.d,
          pricedAt: new Date().toISOString(),
          quantity: x.oldB.quantity || 0,
          unitPrice: x.oldB.unitPrice || 0,
          total: x.o,
          lines: x.oldB.lines || [],
          priceSource: 'frozen-before-exact-doctor-matching',
        };
        await DentalCase.updateOne({ _id: x.c._id }, { $set: { billSnapshot: snapshot } }, { timestamps: false });
        await AuditLog.create({
          caseId: x.c._id,
          caseNumber: x.c.caseNumber,
          action: 'financial_updated',
          performedBy: admin._id,
          performedByName: admin.fullName,
          details: { oldValue: null, newValue: x.o, notes: 'compareDoctorMatching --freeze (keep pre-change price)' },
        });
      }
      console.log(`\nFroze ${changed.length} exited bills at their pre-change amount.`);
    }
  }
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
