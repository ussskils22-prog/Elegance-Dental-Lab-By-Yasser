const { normalizePaymentMethod, paymentMethodLabel, receiptDateText } = require('../utils/paymentMethod');

describe('payment method', () => {
  test('known methods are kept', () => {
    expect(normalizePaymentMethod('cash')).toBe('cash');
    expect(normalizePaymentMethod('Vodafone_Cash')).toBe('vodafone_cash');
    expect(normalizePaymentMethod('instapay')).toBe('instapay');
  });
  test('anything else becomes empty', () => {
    expect(normalizePaymentMethod('visa')).toBe('');
    expect(normalizePaymentMethod(undefined)).toBe('');
  });
  test('Arabic labels for the receipt', () => {
    expect(paymentMethodLabel('vodafone_cash')).toBe('فودافون كاش');
    expect(paymentMethodLabel('')).toBe('');
  });
});

describe('receipt date — Cairo time, all English', () => {
  test('morning', () => expect(receiptDateText('2026-11-25T08:30:00Z')).toBe('25/11/2026 10:30 AM'));
  test('evening', () => expect(receiptDateText('2026-11-25T16:05:00Z')).toBe('25/11/2026 6:05 PM'));
});
