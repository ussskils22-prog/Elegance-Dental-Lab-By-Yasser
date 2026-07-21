const mongoose = require('mongoose');

const DoctorPricingSchema = new mongoose.Schema({
  doctorName: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  prices: {
    emax: { type: Number, default: 1000 },
    germanZircon: { type: Number, default: 850 },
    zircon: { type: Number, default: 700 },
    titanium: { type: Number, default: 2200 },
    peek: { type: Number, default: 1700 },
    pmma: { type: Number, default: 250 },
    nightGuard: { type: Number, default: 300 }
  }
}, { timestamps: true });

module.exports = mongoose.model('DoctorPricing', DoctorPricingSchema);
