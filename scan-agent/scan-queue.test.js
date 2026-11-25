// node --test scan-queue.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ScanQueue } = require('./scan-queue');

test('scans survive a restart and stay in order', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-')), 'q.json');
  const a = new ScanQueue(file);
  a.push('CASE-1', '2026-11-25T10:00:00Z');
  a.push('CASE-2');
  a.push('CASE-3');
  const b = new ScanQueue(file); // "PC restarted"
  assert.strictEqual(b.size, 3);
  assert.strictEqual(b.shift().code, 'CASE-1');
  assert.strictEqual(new ScanQueue(file).peek().code, 'CASE-2');
});

test('a broken file starts an empty queue instead of crashing', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-')), 'q.json');
  fs.writeFileSync(file, '{not json');
  assert.strictEqual(new ScanQueue(file).size, 0);
});
