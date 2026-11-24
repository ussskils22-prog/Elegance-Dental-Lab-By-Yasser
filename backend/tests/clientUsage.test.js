const { deleteDecision } = require('../services/clientUsage');

describe('deleteDecision — delete only accounts with no history', () => {
  test('an empty duplicate account can be deleted', () => {
    expect(deleteDecision({ cases: 0, payments: 0 }).allowed).toBe(true);
  });

  test('an account with cases must be deactivated, with a clear reason', () => {
    const d = deleteDecision({ cases: 12, payments: 0 });
    expect(d.allowed).toBe(false);
    expect(d.message).toContain('12 حالة');
    expect(d.message).toContain('أوقفه');
  });

  test('payments alone also block deleting', () => {
    expect(deleteDecision({ cases: 0, payments: 2 }).message).toContain('2 دفعة');
  });
});
