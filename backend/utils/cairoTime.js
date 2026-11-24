/**
 * Lab-local (Africa/Cairo) date helpers. The server runs in UTC, so plain
 * getMonth()/getHours() put early-morning events in the wrong day or month.
 */
const TZ = 'Africa/Cairo';

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** {year, month(1-12), day, hour, minute, second} of an instant in Cairo. */
function cairoParts(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date ?? NaN);
  // Bad/missing dates: behave like getFullYear() on an invalid Date (NaN) instead of throwing.
  if (Number.isNaN(d.getTime())) {
    return { year: NaN, month: NaN, day: NaN, hour: NaN, minute: NaN, second: NaN };
  }
  const out = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour, minute: out.minute, second: out.second };
}

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM' in Cairo. */
function cairoMonthKey(date) {
  const p = cairoParts(date);
  return `${p.year}-${pad(p.month)}`;
}

/** 'YYYY-MM-DD' in Cairo. */
function cairoDayKey(date) {
  const p = cairoParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Cairo offset from UTC in minutes at a given instant (handles DST). */
function cairoOffsetMinutes(date) {
  const p = cairoParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - (date.getTime() - (date.getTime() % 1000))) / 60000);
}

/** Instant for a Cairo wall time ('YYYY-MM-DD', 'HH:mm'). Returns null when invalid. */
function cairoDateTimeToUtc(ymd, hm = '00:00') {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return null;
  const t = /^(\d{1,2}):(\d{2})/.exec(String(hm || '00:00')) || [null, '0', '0'];
  const guess = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]));
  if (Number.isNaN(guess.getTime())) return null;
  // shift by the Cairo offset at that moment (twice to settle across a DST edge)
  let utc = new Date(guess.getTime() - cairoOffsetMinutes(guess) * 60000);
  utc = new Date(guess.getTime() - cairoOffsetMinutes(utc) * 60000);
  return utc;
}

/**
 * Cairo calendar month as UTC instants: [start, endExclusive).
 * month is 1-12. Example: Dec 2026 starts 2026-11-30T22:00Z.
 */
function cairoMonthRange(year, month) {
  const y = Number(year);
  const m = Number(month);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const start = cairoDateTimeToUtc(`${y}-${pad(m)}-01`, '00:00');
  const endExclusive = cairoDateTimeToUtc(`${ny}-${pad(nm)}-01`, '00:00');
  return { start, endExclusive, endInclusive: new Date(endExclusive.getTime() - 1) };
}

module.exports = { TZ, cairoParts, cairoMonthKey, cairoDayKey, cairoDateTimeToUtc, cairoMonthRange };
