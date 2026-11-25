const mongoose = require('mongoose');

const DoctorPaymentSchema = new mongoose.Schema({
  doctorName: {
    type: String,
    required: true,
    trim: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  /** payment = credit against due; charge = add to doctor's invoice/due */
  entryType: {
    type: String,
    enum: ['payment', 'charge'],
    default: 'payment',
    index: true,
  },
  /**
   * Optional link to a case. Linked payments are audit/settlement for that case
   * and must NOT be double-counted with paymentStatus=paid on the same case.
   */
  caseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DentalCase',
    default: null,
    index: true,
  },
  paymentDate: {
    type: Date,
    default: Date.now
  },
  notes: {
    type: String,
    default: ''
  },
  /** cash | vodafone_cash | instapay — '' for older payments */
  paymentMethod: {
    type: String,
    enum: ['', 'cash', 'vodafone_cash', 'instapay'],
    default: ''
  }
}, { timestamps: true });

module.exports = mongoose.model('DoctorPayment', DoctorPaymentSchema);
