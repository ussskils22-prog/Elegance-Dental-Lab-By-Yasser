const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'dist', 'client', 'browser', 'ngsw-worker.js');
if (!fs.existsSync(file)) {
  console.error('ngsw-worker.js was not found at', file);
  process.exit(1);
}
fs.appendFileSync(file, `\n// masar-sw ${Date.now()}\n`);
console.log('stamped', file);
