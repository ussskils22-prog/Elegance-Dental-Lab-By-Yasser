// Pairing flow with in-memory stand-ins for the two collections.
const store = { codes: [], devices: [] };

jest.mock('../models/StationPairCode', () => ({
  create: async (doc) => {
    if (store.codes.some((c) => c.codeHash === doc.codeHash)) throw Object.assign(new Error('dup'), { code: 11000 });
    store.codes.push({ ...doc, usedAt: null });
    return doc;
  },
  findOneAndUpdate: async (q) => {
    const c = store.codes.find((x) => x.codeHash === q.codeHash && !x.usedAt && x.expiresAt > new Date());
    if (!c) return null;
    c.usedAt = new Date();
    return c;
  },
}));

jest.mock('../models/StationDevice', () => ({
  create: async (doc) => {
    const d = { ...doc, _id: `dev${store.devices.length + 1}`, revokedAt: null };
    store.devices.push(d);
    return d;
  },
  findOne: (q) => ({
    lean: async () => store.devices.find((d) => d.tokenHash === q.tokenHash && !d.revokedAt) || null,
  }),
  updateOne: async () => ({}),
}));

const svc = require('../services/stationDevices');

beforeEach(() => {
  store.codes = [];
  store.devices = [];
  svc.forgetDeviceCache();
});

test('admin code → PC pairs once → its token is accepted', async () => {
  const { code } = await svc.createPairCode('print', 'admin1');
  const paired = await svc.pairDevice(code, 'PRINT-PC');
  expect(paired.kind).toBe('print');
  expect(paired.name).toBe('PRINT-PC');
  const device = await svc.verifyDeviceToken(paired.token);
  expect(device && device.kind).toBe('print');
  // the token itself is never stored
  expect(JSON.stringify(store.devices)).not.toContain(paired.token);
});

test('a code works only once', async () => {
  const { code } = await svc.createPairCode('scanner2');
  await svc.pairDevice(code, 'SCAN-2');
  await expect(svc.pairDevice(code, 'OTHER')).rejects.toThrow('الكود غلط أو انتهى');
});

test('wrong / short codes are refused', async () => {
  await expect(svc.pairDevice('123', 'X')).rejects.toThrow('الكود غلط أو انتهى');
  await expect(svc.pairDevice('999999', 'X')).rejects.toThrow('الكود غلط أو انتهى');
});

test('a disconnected PC is refused', async () => {
  const { code } = await svc.createPairCode('print');
  const { token } = await svc.pairDevice(code, 'P');
  store.devices[0].revokedAt = new Date();
  svc.forgetDeviceCache();
  expect(await svc.verifyDeviceToken(token)).toBeNull();
});

test('unknown station kind cannot get a code', async () => {
  await expect(svc.createPairCode('admin')).rejects.toThrow('نوع الجهاز غير معروف');
});
