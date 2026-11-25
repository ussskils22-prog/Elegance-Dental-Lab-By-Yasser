/** How a doctor paid: cash, Vodafone Cash or InstaPay. Empty = not recorded (older payments). */
const PAYMENT_METHODS = { cash: 'كاش', vodafone_cash: 'فودافون كاش', instapay: 'إنستا باي' };

function normalizePaymentMethod(value) {
  const v = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PAYMENT_METHODS, v) ? v : '';
}

function paymentMethodLabel(value) {
  return PAYMENT_METHODS[normalizePaymentMethod(value)] || '';
}

/** Cairo time, all English (prints cleanly on the receipt): "25/11/2026 10:30 AM". */
function receiptDateText(date) {
  const d = date ? new Date(date) : new Date();
  if (isNaN(d.getTime())) return '';
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d)) p[part.type] = part.value;
  const h = Number(p.hour);
  return `${p.day}/${p.month}/${p.year} ${h % 12 || 12}:${p.minute} ${h < 12 ? 'AM' : 'PM'}`;
}

module.exports = { PAYMENT_METHODS, normalizePaymentMethod, paymentMethodLabel, receiptDateText };
