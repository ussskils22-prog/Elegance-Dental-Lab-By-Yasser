const mongoose = require('mongoose');

const DoctorChargeSchema = new mongoose.Schema({
  doctorName: {
    type: String,
    required: true,
    trim: true,
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  chargeDate: {
    type: Date,
    default: Date.now,
  },
  notes: {
    type: String,
    default: '',
  },
}, { timestamps: true });

module.exports = mongoose.model('DoctorCharge', DoctorChargeSchema);
