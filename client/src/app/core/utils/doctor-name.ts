/**
 * Same doctor/lab name rule as the server (backend/utils/doctorName.js):
 * titles, spacing, punctuation and Arabic letter variants are ignored.
 */
const TITLE_RE = /^(?:د\s*[./]|د(?=\s)|dr\s*[./]|dr(?=\s)|doctor(?=\s)|دكتور[ةه]?(?=\s)|أ\s*\.|ا\s*\.)\s*/i;

export function normalizeDoctorKey(name: string | null | undefined): string {
  let s = String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  for (let i = 0; i < 3; i++) {
    const next = s.replace(TITLE_RE, '');
    if (next === s) break;
    s = next.trim();
  }
  s = s
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|\s)عبد\s+/g, '$1عبد');
  return s;
}

export function sameDoctorName(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = normalizeDoctorKey(a);
  return Boolean(ka) && ka === normalizeDoctorKey(b);
}

/** Normalized name with all spaces removed ("م حمد خالد" → "محمدخالد"). */
export function compactNameKey(name: string | null | undefined): string {
  return normalizeDoctorKey(name).replace(/\s+/g, '');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Suggestions for a name being typed: plain "contains" matches first, then names that
 * look like a typo of what was typed so far (spaces ignored, 1–2 letters off).
 */
export function rankNameSuggestions(input: string, names: string[], limit = 8): string[] {
  const key = normalizeDoctorKey(input);
  const compact = compactNameKey(input);
  if (!key) return [];
  const contains: string[] = [];
  const fuzzy: { name: string; d: number }[] = [];
  const maxEdits = compact.length >= 6 ? 2 : compact.length >= 4 ? 1 : 0;
  for (const name of names) {
    const k = normalizeDoctorKey(name);
    const c = k.replace(/\s+/g, '');
    if (!k) continue;
    if (k.includes(key) || c.includes(compact)) {
      contains.push(name);
      continue;
    }
    if (!maxEdits) continue;
    // compare against the start of the stored name, so half-typed names match too
    const d = Math.min(levenshtein(compact, c), levenshtein(compact, c.slice(0, compact.length)));
    if (d <= maxEdits) fuzzy.push({ name, d });
  }
  contains.sort((a, b) => {
    const pa = normalizeDoctorKey(a).startsWith(key) ? 0 : 1;
    const pb = normalizeDoctorKey(b).startsWith(key) ? 0 : 1;
    return pa - pb || a.localeCompare(b, 'ar');
  });
  fuzzy.sort((a, b) => a.d - b.d);
  return [...contains, ...fuzzy.map((f) => f.name)].slice(0, limit);
}

/**
 * Stored name with the same letters as the typed one, differing only by spaces/spelling
 * variants ("م حمد خالد", "عبد الرحمن" vs "عبدالرحمن"). Returns the stored spelling so the
 * case uses it; null when the typed text is already exactly a stored name or nothing matches.
 */
export function spacingOnlyMatch(input: string, names: string[]): string | null {
  const typed = String(input ?? '').trim();
  const compact = compactNameKey(typed);
  if (!compact) return null;
  if (names.some((n) => n.trim() === typed)) return null;
  return names.find((n) => compactNameKey(n) === compact) ?? null;
}
