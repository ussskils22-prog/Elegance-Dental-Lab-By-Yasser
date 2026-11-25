const { newPairCode, normalizePairCode, newDeviceToken, isStationKind, sha256 } = require('../services/stationDevices');

describe('station pairing helpers', () => {
  test('pair codes are 6 digits', () => {
    for (let i = 0; i < 50; i++) expect(newPairCode()).toMatch(/^[1-9]\d{5}$/);
  });
  test('codes typed with spaces or Arabic digits still work', () => {
    expect(normalizePairCode(' 482 913 ')).toBe('482913');
    expect(normalizePairCode('٤٨٢٩١٣')).toBe('482913');
  });
  test('device tokens are long, random and recognisable', () => {
    const a = newDeviceToken();
    expect(a).toMatch(/^occla_dev_[0-9a-f]{64}$/);
    expect(a).not.toBe(newDeviceToken());
    expect(sha256(a)).toHaveLength(64);
  });
  test('only the 4 station kinds', () => {
    expect(isStationKind('print')).toBe(true);
    expect(isStationKind('scanner3')).toBe(true);
    expect(isStationKind('admin')).toBe(false);
  });
});
