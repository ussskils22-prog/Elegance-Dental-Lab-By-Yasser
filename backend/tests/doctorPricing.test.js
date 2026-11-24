const { mergePricesForDoctor, findPricingForDoctor } = require('../services/casePricingService');

const pricings = [
  { doctorName: 'محمد', prices: { zircon: 900 }, updatedAt: '2026-01-01' },
  { doctorName: 'أحمد محمد', prices: { zircon: 650 }, updatedAt: '2026-02-01' },
  { doctorName: 'د. علي عبدالله', prices: { emax: 1200 }, updatedAt: '2026-01-05' },
  { doctorName: 'علي عبد الله', prices: { zircon: 700 }, updatedAt: '2026-03-01' },
];

describe('doctor price lookup uses the exact doctor only', () => {
  test('"محمد" does not pick up "أحمد محمد" prices', () => {
    expect(mergePricesForDoctor(pricings, 'محمد')).toMatchObject({ zircon: 900 });
    expect(mergePricesForDoctor(pricings, 'د. محمد').zircon).toBe(900);
  });

  test('"أحمد محمد" keeps his own price', () => {
    expect(mergePricesForDoctor(pricings, 'احمد محمد').zircon).toBe(650);
  });

  test('spelling/title variants of the same doctor are merged', () => {
    const merged = mergePricesForDoctor(pricings, 'علي عبدالله');
    expect(merged.emax).toBe(1200);
    expect(merged.zircon).toBe(700);
  });

  test('a typo gets no doctor prices (falls back to lab defaults)', () => {
    expect(mergePricesForDoctor(pricings, 'غلي غبدالله')).toBeNull();
    expect(findPricingForDoctor(pricings, 'غلي غبدالله')).toBeNull();
  });
});
