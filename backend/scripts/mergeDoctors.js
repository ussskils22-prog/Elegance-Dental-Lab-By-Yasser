/**
 * Merge a duplicate doctor (usually a typo) into the real one.
 *
 * DRY RUN by default — prints what would change and touches nothing.
 *   node scripts/mergeDoctors.js --from "غلي غبدالله" --into "علي عبدالله"
 * Apply for real (point MONGODB_URI at the right database first):
 *   node scripts/mergeDoctors.js --from "غلي غبدالله" --into "علي عبدالله" --apply --by admin@lab.com
 *
 * What it changes:
 *   - Cases: referringDoctor, notes meta doctor name, referringDoctorId → the real doctor.
 *     Money on exited cases (billSnapshot amounts, revenueAmount, prices) is NOT changed.
 *   - Doctor payments / charges: doctorName → the real doctor.
 *   - Doctor price list: the real doctor's prices win; keys only the duplicate had are copied over;
 *     the duplicate's price row is removed.
 *   - The duplicate's login account is deactivated (not deleted).
 * Every change is written to the audit log as "doctor_merged".
 */
require('dotenv').config();
// Some ISPs' DNS cannot answer mongodb+srv SRV lookups (querySrv EBADRESP): set DNS_SERVERS=8.8.8.8,1.1.1.1
if (process.env.DNS_SERVERS) require('dns').setServers(process.env.DNS_SERVERS.split(',').map((s) => s.trim()));
const mongoose = require('mongoose');
const User = require('../models/User');
const { normalizeDoctorKey } = require('../utils/doctorName');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '').trim() : '';
}

async function main() {
  const from = arg('--from');
  const into = arg('--into');
  const apply = process.argv.includes('--apply');
  const byEmail = arg('--by');
  if (!from || !into) {
    console.error('Usage: node scripts/mergeDoctors.js --from "<duplicate name>" --into "<real name>" [--apply]');
    process.exit(2);
  }
  const fromKey = normalizeDoctorKey(from);
  const intoKey = normalizeDoctorKey(into);
  if (!fromKey || !intoKey || fromKey === intoKey) {
    console.error('Names are empty or already the same doctor — nothing to merge.');
    process.exit(2);
  }

  if (apply && !byEmail) {
    console.error('--apply needs --by <admin email> so the audit log shows who merged.');
    process.exit(2);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const admin = apply ? await User.findOne({ email: byEmail.toLowerCase(), role: 'admin' }) : null;
  if (apply && !admin) {
    console.error(`No admin account with email ${byEmail}.`);
    await mongoose.disconnect();
    process.exit(2);
  }
  console.log(apply ? '*** APPLYING CHANGES ***' : 'Dry run — nothing will be written. Add --apply to merge.');
  const { mergeClientNames } = require('../services/doctorMerge');
  const r = await mergeClientNames({ from, into, apply, admin, source: 'scripts/mergeDoctors.js' });
  console.log(`Merge "${from}" → "${into}"`);
  console.log(`  cases to relink:        ${r.cases} (${r.exitedCases} exited — bill amounts untouched)`);
  console.log(`  payments to rename:     ${r.payments}`);
  console.log(`  price rows to fold in:  ${r.priceRows}`);
  console.log(`  accounts to deactivate: ${r.accountsDeactivated.join(', ') || 'none'}`);
  console.log(`  real account:           ${r.realAccount || 'none found — cases keep their current account link'}`);
  r.caseNumbers.forEach((n) => console.log(`    - ${n}`));
  if (r.pricesFoldedIntoExisting) {
    console.log("  NOTE: price keys only the duplicate had will be added to the real one's list;");
    console.log('        unfrozen exited bills are priced live and may change.');
  }
  console.log(r.applied ? 'Done.' : '');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
