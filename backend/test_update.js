// Test script to verify updateCase API actually saves changes
const https = require('https');

const BASE = 'elegance-dental-lab-by-yasser-production.up.railway.app';
const CASE_ID = '6a5298f869d5286cd233db8c'; // محمد ياقوت - CASE-2026-00119

// Login first
const loginBody = JSON.stringify({ email: 'usskilssss@gmail.com', password: 'Y0509749239y' });

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const req = https.request({ hostname: BASE, path, method, headers }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  // Step 1: Login
  const login = await request('POST', '/api/auth/login', { email: 'usskilssss@gmail.com', password: 'Y0509749239y' });
  if (!login.token) { console.error('Login failed:', login); return; }
  const token = login.token;
  console.log('Login OK, token obtained');

  // Step 2: Read current case
  const before = await request('GET', '/api/cases/' + CASE_ID, null, token);
  const caseBefore = before.case || before;
  console.log('BEFORE exited:', caseBefore.stageTimestamps?.exited);
  const notesBefore = JSON.parse((caseBefore.notes || '').replace('__META__\n', '') || '{}');
  console.log('BEFORE receivedDate:', notesBefore.receivedDate);

  // Step 3: Update with new exitedAt (change to July 11)
  const newNotes = '__META__\n' + JSON.stringify({
    requesterType: 'doctor', studentPrice: 0, doctor: 'سلطان',
    workDetail: '', color: '', size: '', quantity: 8,
    deliveryDate: '', deliveryTime: '',
    receivedDate: '2026-07-08 22:26:00',  // Keep entry date same
    designImages: []
  });

  const updateResult = await request('PUT', '/api/cases/' + CASE_ID, {
    notes: newNotes,
    stageTimestamps: { exited: '2026-07-11T21:00:00.000Z' }  // Change exit date to July 11
  }, token);
  console.log('Update success:', updateResult.success);
  console.log('Update message:', updateResult.message);

  // Step 4: Read after update
  const after = await request('GET', '/api/cases/' + CASE_ID, null, token);
  const caseAfter = after.case || after;
  console.log('AFTER exited:', caseAfter.stageTimestamps?.exited);
  const notesAfter = JSON.parse((caseAfter.notes || '').replace('__META__\n', '') || '{}');
  console.log('AFTER receivedDate:', notesAfter.receivedDate);
}

main().catch(console.error);
