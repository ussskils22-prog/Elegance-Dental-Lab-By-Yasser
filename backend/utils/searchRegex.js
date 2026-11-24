/**
 * Build a safe, case-insensitive RegExp from user search text.
 * - Regex special characters are escaped (typing "(" no longer crashes the query).
 * - Common Arabic spelling variants match each other (ا/أ/إ/آ, ي/ى, ه/ة).
 */
const GROUPS = [
  ['ا', 'أ', 'إ', 'آ'],
  ['ي', 'ى'],
  ['ه', 'ة'],
];

function escapeChar(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function arabicLooseRegex(text) {
  const raw = String(text || '').trim().slice(0, 100);
  if (!raw) return null;
  let pattern = '';
  for (const ch of raw) {
    const group = GROUPS.find((g) => g.includes(ch));
    pattern += group ? `[${group.join('')}]` : escapeChar(ch);
  }
  return new RegExp(pattern, 'i');
}

module.exports = { arabicLooseRegex };
