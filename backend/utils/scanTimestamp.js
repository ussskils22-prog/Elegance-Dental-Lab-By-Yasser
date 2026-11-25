/**
 * When was the barcode really scanned? Scan stations queue scans while the internet is down
 * and send them later with `scannedAt`; the stage time should be the scan time, not the send
 * time. Only trust a time from the last 3 days that is not in the future.
 */
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const FUTURE_SLACK_MS = 2 * 60 * 1000;

function scanTimestamp(raw, now = new Date()) {
  if (raw === undefined || raw === null || raw === '') return now;
  const t = new Date(raw);
  if (isNaN(t.getTime())) return now;
  const diff = now.getTime() - t.getTime();
  if (diff < -FUTURE_SLACK_MS || diff > MAX_AGE_MS) return now;
  return diff < 0 ? now : t;
}

module.exports = { scanTimestamp };
