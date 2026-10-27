/**
 * Seed ONLY the elegance-demo database on the same cluster as backend/.env.
 * Never connects to the database name already in .env.
 */
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { spawn } = require('child_process');

try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (_) {}

const envPath = path.join(__dirname, '..', '.env');
const text = fs.readFileSync(envPath, 'utf8');
const line = text.split(/\r?\n/).find((l) => l.startsWith('MONGODB_URI='));
if (!line) {
  console.error('REFUSED: MONGODB_URI missing');
  process.exit(1);
}
let uri = line.slice('MONGODB_URI='.length).trim();
if (
  (uri.startsWith('"') && uri.endsWith('"')) ||
  (uri.startsWith("'") && uri.endsWith("'"))
) {
  uri = uri.slice(1, -1);
}
const match = uri.match(/^(mongodb(?:\+srv)?:\/\/(?:[^@/]+@)?[^/?]+)\/([^?]*)(\?.*)?$/i);
if (!match) {
  console.error('REFUSED: MONGODB_URI shape not recognized');
  process.exit(1);
}
console.log('currentDb=' + decodeURIComponent(match[2] || ''));
const demoUri = `${match[1]}/elegance-demo${match[3] || ''}`;
if (!/\/elegance-demo(\?|$)/.test(demoUri)) {
  console.error('REFUSED: rewrite did not target elegance-demo');
  process.exit(1);
}
console.log('targetDb=elegance-demo');

const child = spawn(process.execPath, [path.join(__dirname, 'seedDemo.js')], {
  cwd: path.join(__dirname, '..'),
  env: { ...process.env, DEMO_MODE: 'true', MONGODB_URI: demoUri, MONGO_USE_PUBLIC_DNS: '1' },
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code == null ? 1 : code));
