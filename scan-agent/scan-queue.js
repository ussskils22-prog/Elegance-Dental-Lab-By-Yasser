/**
 * Scans waiting to reach the server, saved on disk so nothing is lost when the internet
 * drops, the server is slow, or the PC restarts. Strict first-in-first-out (stage moves
 * must happen in the order the case was scanned).
 */
const fs = require('fs');
const path = require('path');

class ScanQueue {
  /** @param {string} file path of the JSON file */
  constructor(file) {
    this.file = file;
    this.items = [];
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(raw)) this.items = raw.filter((x) => x && typeof x.code === 'string');
    } catch (_) {
      this.items = [];
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.items), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (_) {}
  }

  push(code, scannedAt = new Date().toISOString()) {
    this.items.push({ code, scannedAt });
    this.save();
  }

  peek() {
    return this.items[0] || null;
  }

  shift() {
    const first = this.items.shift() || null;
    this.save();
    return first;
  }

  get size() {
    return this.items.length;
  }
}

module.exports = { ScanQueue };
