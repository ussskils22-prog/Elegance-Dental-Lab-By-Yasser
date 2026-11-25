const mongoose = require('mongoose');

/** One-time 6-digit code an admin creates so a new PC can join (expires after 15 minutes). */
const stationPairCodeSchema = new mongoose.Schema(
  {
    codeHash: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['print', 'scanner1', 'scanner2', 'scanner3'], required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true }
);
// Mongo removes old codes a day after they expire
stationPairCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model('StationPairCode', stationPairCodeSchema);
