const fs = require('fs');
const s = fs.readFileSync(process.env.TEMP + '/elegance-main.js', 'utf8');
const idx = s.indexOf('dental_system_auth_session');
console.log('session key', idx);
console.log(s.slice(idx, idx + 2500));
