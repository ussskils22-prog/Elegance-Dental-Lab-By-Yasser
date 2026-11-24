/**
 * Doctor name identity helpers.
 *
 * Two names are the SAME doctor only when their normalized keys are equal.
 * The old rule also accepted "one name contains the other", which made
 * "محمد" equal to "أحمد محمد" and mixed prices, payments and debts between
 * different doctors. Typos are never auto-merged: use findSimilarDoctorNames
 * to ask the user "did you mean …?" instead.
 */

// Note: \b is ASCII-only in JS, so Arabic titles use a (?=\s) lookahead instead.
const TITLE_RE = /^(?:د\s*[./]|د(?=\s)|dr\s*[./]|dr(?=\s)|doctor(?=\s)|دكتور[ةه]?(?=\s)|أ\s*\.|ا\s*\.)\s*/i;

/** Unify Arabic letter variants that people type interchangeably. */
function unifyArabic(s) {
  return s
    .replace(/[ً-ْـ]/g, '') // harakat + tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

/** Normalize a doctor name to a comparison key (titles, spacing, punctuation, letter variants removed). */
function normalizeDoctorKey(name) {
  let s = String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  // strip leading titles (repeat: "د. د/ ...")
  for (let i = 0; i < 3; i++) {
    const next = s.replace(TITLE_RE, '');
    if (next === s) break;
    s = next.trim();
  }
  s = unifyArabic(s)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // "عبد الله" and "عبدالله" are the same name
  s = s.replace(/(^|\s)عبد\s+/g, '$1عبد');
  return s;
}

/** True only when both names normalize to the same non-empty key. */
function doctorKeysMatch(a, b) {
  const ka = normalizeDoctorKey(a);
  const kb = normalizeDoctorKey(b);
  return Boolean(ka) && ka === kb;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Names that look like a typo of `name` (but are not the same normalized name).
 * Allowed edits scale with length: up to 2 for typical full names, 1 for short ones.
 */
function findSimilarDoctorNames(name, candidates, { limit = 5 } = {}) {
  const want = normalizeDoctorKey(name);
  // Single-word names are too short to tell a typo from a different person (سامي/سامح).
  if (!want || !want.includes(' ')) return [];
  const maxEdits = want.replace(/\s/g, '').length >= 7 ? 2 : 1;
  const seen = new Set();
  const scored = [];
  for (const raw of candidates || []) {
    const key = normalizeDoctorKey(raw);
    if (!key || key === want || seen.has(key)) continue;
    seen.add(key);
    const d = levenshtein(want, key);
    if (d <= maxEdits) scored.push({ name: String(raw).trim(), d });
  }
  scored.sort((x, y) => x.d - y.d);
  return scored.slice(0, limit).map((x) => x.name);
}

module.exports = {
  normalizeDoctorKey,
  doctorKeysMatch,
  findSimilarDoctorNames,
  levenshtein,
};
