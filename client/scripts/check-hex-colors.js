#!/usr/bin/env node
/**
 * Fails when a CSS file uses a raw hex color instead of a design token.
 * Allowed: anything inside an `@media print { ... }` block, and lines that
 * carry a `hex-ok: <reason>` comment.
 *
 * Usage (from client/): node scripts/check-hex-colors.js <file.css...>
 */
const fs = require('fs');

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node scripts/check-hex-colors.js <file.css...>');
  process.exit(2);
}

let hits = 0;
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let inComment = false;
  let depth = 0;
  let printDepth = -1; // brace depth at which the current @media print block opened

  lines.forEach((raw, i) => {
    // Strip block comments, tracking ones that span lines.
    let line = '';
    let rest = raw;
    while (rest.length) {
      if (inComment) {
        const end = rest.indexOf('*/');
        if (end === -1) { rest = ''; break; }
        rest = rest.slice(end + 2);
        inComment = false;
      } else {
        const start = rest.indexOf('/*');
        if (start === -1) { line += rest; rest = ''; break; }
        line += rest.slice(0, start);
        rest = rest.slice(start + 2);
        inComment = true;
      }
    }

    if (printDepth === -1 && /@media[^{]*\bprint\b/.test(line)) printDepth = depth;
    const insidePrint = printDepth !== -1;

    if (!insidePrint && !/hex-ok:/.test(raw)) {
      for (const m of line.matchAll(HEX)) {
        console.log(`${file}:${i + 1}: ${m[0]}`);
        hits++;
      }
    }

    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (printDepth !== -1 && depth === printDepth) printDepth = -1;
      }
    }
  });
}

console.log(hits === 0 ? `OK (${files.length} files)` : `FAIL (${hits} hits)`);
process.exit(hits === 0 ? 0 : 1);
