const svc = require('../services/stationDevices');

const send = (res, err, fallback) =>
  res.status(err.status || 500).json({ success: false, message: err.status ? err.message : fallback });

// POST /api/stations/pair-codes (admin) { kind }
exports.createPairCode = async (req, res) => {
  try {
    const r = await svc.createPairCode(req.body?.kind, req.user?.id || req.user?._id);
    res.status(201).json({ success: true, data: r });
  } catch (err) {
    send(res, err, 'تعذر إنشاء الكود');
  }
};

// POST /api/stations/pair (the PC, no login) { code, name }
exports.pair = async (req, res) => {
  try {
    const r = await svc.pairDevice(req.body?.code, req.body?.name);
    res.status(201).json({ success: true, data: r });
  } catch (err) {
    send(res, err, 'تعذر ربط الجهاز');
  }
};

// POST /api/stations/session (scan PC, header x-device-token) → login token for the scanner account
exports.session = async (req, res) => {
  try {
    const r = await svc.deviceSession(req.headers['x-device-token']);
    if (!r) return res.status(401).json({ success: false, message: 'الجهاز ده مش مربوط أو اتوقف' });
    res.status(200).json({ success: true, token: r.token, user: r.user });
  } catch (err) {
    send(res, err, 'تعذر تسجيل دخول الجهاز');
  }
};

// GET /api/stations (admin)
exports.list = async (req, res) => {
  try {
    const StationDevice = require('../models/StationDevice');
    const rows = await StationDevice.find({}).select('-tokenHash').sort({ createdAt: -1 }).lean();
    res.status(200).json({ success: true, data: rows });
  } catch (err) {
    send(res, err, 'تعذر تحميل الأجهزة');
  }
};

// POST /api/stations/:id/revoke (admin) — that PC can no longer print or scan
exports.revoke = async (req, res) => {
  try {
    const StationDevice = require('../models/StationDevice');
    const r = await StationDevice.updateOne({ _id: req.params.id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    svc.forgetDeviceCache();
    res.status(200).json({ success: true, revoked: r.modifiedCount === 1 });
  } catch (err) {
    send(res, err, 'تعذر إيقاف الجهاز');
  }
};
