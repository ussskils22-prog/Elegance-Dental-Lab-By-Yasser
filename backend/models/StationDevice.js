const mongoose = require('mongoose');

/**
 * A lab PC paired with the server (print station or scan station 1/2/3).
 * It signs in with its own token, so no shared secret or password lives on the PC,
 * and one PC can be switched off from the admin screen without touching the others.
 */
const stationDeviceSchema = new mongoose.Schema(
  {
    name: { type: String, default: '', trim: true },
    kind: { type: String, enum: ['print', 'scanner1', 'scanner2', 'scanner3'], required: true },
    /** sha256 of the device token (the token itself is only ever given to the PC) */
    tokenHash: { type: String, required: true, unique: true },
    pairedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lastSeenAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('StationDevice', stationDeviceSchema);
