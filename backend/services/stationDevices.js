/**
 * Pairing lab PCs (print / scan stations) without passwords or shared secrets.
 *   admin: createPairCode(kind)      → "482913" (15 min, one use)
 *   PC:    pairDevice(code, name)    → device token (kept in the PC's config)
 *   PC:    verifyDeviceToken(token)  → the device (print agent auth)
 *   PC:    deviceSession(token)      → a normal login token for the scanner account
 */
const crypto = require('crypto');

const STATION_KINDS = ['print', 'scanner1', 'scanner2', 'scanner3'];
const PAIR_CODE_TTL_MS = 15 * 60 * 1000;
const KIND_LABEL = { print: 'جهاز الطباعة', scanner1: 'سكان 1', scanner2: 'سكان 2', scanner3: 'سكان 3' };
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function isStationKind(kind) {
  return STATION_KINDS.includes(String(kind || ''));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** 6 digits, never starting with 0 (easier to read out loud). */
function newPairCode() {
  return String(crypto.randomInt(100000, 1000000));
}

/** Accept "482 913", "482-913" and Arabic digits. */
function normalizePairCode(input) {
  let out = '';
  for (const ch of String(input || '')) {
    if (ch >= '0' && ch <= '9') out += ch;
    else if (ARABIC_DIGITS.includes(ch)) out += String(ARABIC_DIGITS.indexOf(ch));
  }
  return out;
}

function newDeviceToken() {
  return `occla_dev_${crypto.randomBytes(32).toString('hex')}`;
}

async function createPairCode(kind, adminId) {
  if (!isStationKind(kind)) {
    const err = new Error('نوع الجهاز غير معروف');
    err.status = 400;
    throw err;
  }
  const StationPairCode = require('../models/StationPairCode');
  for (let i = 0; i < 5; i++) {
    const code = newPairCode();
    try {
      const expiresAt = new Date(Date.now() + PAIR_CODE_TTL_MS);
      await StationPairCode.create({ codeHash: sha256(code), kind, createdBy: adminId || null, expiresAt });
      return { code, kind, expiresAt };
    } catch (err) {
      if (err && err.code === 11000) continue; // same code still stored — draw again
      throw err;
    }
  }
  throw new Error('تعذر إنشاء كود — جرّب تاني');
}

async function pairDevice(codeInput, name) {
  const StationPairCode = require('../models/StationPairCode');
  const StationDevice = require('../models/StationDevice');
  const code = normalizePairCode(codeInput);
  const fail = () => {
    const err = new Error('الكود غلط أو انتهى — اطلب كود جديد من الأدمن');
    err.status = 400;
    return err;
  };
  if (code.length !== 6) throw fail();
  // Atomic: a code works once
  const pair = await StationPairCode.findOneAndUpdate(
    { codeHash: sha256(code), usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { new: true }
  );
  if (!pair) throw fail();
  const token = newDeviceToken();
  const device = await StationDevice.create({
    name: String(name || '').trim().slice(0, 80) || KIND_LABEL[pair.kind],
    kind: pair.kind,
    tokenHash: sha256(token),
    pairedBy: pair.createdBy || null,
    lastSeenAt: new Date(),
  });
  return { token, kind: device.kind, deviceId: String(device._id), name: device.name };
}

// Small cache so every print-agent HTTP call does not hit the database
const cache = new Map();
const CACHE_MS = 60 * 1000;

async function verifyDeviceToken(token) {
  const t = String(token || '');
  if (!t.startsWith('occla_dev_')) return null;
  const hash = sha256(t);
  const hit = cache.get(hash);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.device;
  const StationDevice = require('../models/StationDevice');
  const device = await StationDevice.findOne({ tokenHash: hash, revokedAt: null }).lean();
  cache.set(hash, { device, at: Date.now() });
  if (device && (!device.lastSeenAt || Date.now() - new Date(device.lastSeenAt).getTime() > 5 * 60 * 1000)) {
    StationDevice.updateOne({ _id: device._id }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
  }
  return device;
}

function forgetDeviceCache() {
  cache.clear();
}

/** Scan stations: a normal login token for an active account with that scanner role. */
async function deviceSession(token) {
  const device = await verifyDeviceToken(token);
  if (!device || !String(device.kind).startsWith('scanner')) return null;
  const User = require('../models/User');
  const user = await User.findOne({ role: device.kind, isActive: true }).sort({ createdAt: 1 });
  if (!user) {
    const err = new Error(`مفيش حساب «${KIND_LABEL[device.kind]}» شغال — اعمله من الأدمن`);
    err.status = 409;
    throw err;
  }
  const { generateToken } = require('../config/jwt');
  return { token: generateToken(user._id, user.role), user: { fullName: user.fullName, role: user.role } };
}

module.exports = {
  STATION_KINDS,
  KIND_LABEL,
  isStationKind,
  sha256,
  newPairCode,
  normalizePairCode,
  newDeviceToken,
  createPairCode,
  pairDevice,
  verifyDeviceToken,
  forgetDeviceCache,
  deviceSession,
};
