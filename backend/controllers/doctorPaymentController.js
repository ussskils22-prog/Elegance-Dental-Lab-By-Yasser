const DoctorPayment = require('../models/DoctorPayment');
const CashEntry = require('../models/CashEntry');

async function ensureCashIncomeForPayment(payment, userId) {
  if (!payment?._id) return null;
  const existing = await CashEntry.findOne({ doctorPaymentId: payment._id });
  if (existing) return existing;

  const name = String(payment.doctorName || '').trim() || 'account';
  const notesExtra = String(payment.notes || '').trim();
  return CashEntry.create({
    type: 'income',
    amount: Number(payment.amount) || 0,
    date: payment.paymentDate || payment.createdAt || new Date(),
    category: 'doctor_payment',
    notes: notesExtra
      ? ('Payment from ' + name + ' — ' + notesExtra)
      : ('Payment from ' + name),
    createdBy: userId || null,
    doctorPaymentId: payment._id,
  });
}

/** Idempotent: mirror any doctor/lab payments missing from the cash ledger */
exports.syncDoctorPaymentsToCash = async function syncDoctorPaymentsToCash(userId) {
  const payments = await DoctorPayment.find({}).sort({ paymentDate: -1 });
  let created = 0;
  for (const payment of payments) {
    const before = await CashEntry.findOne({ doctorPaymentId: payment._id }).select('_id');
    if (before) continue;
    if (!Number(payment.amount) || Number(payment.amount) <= 0) continue;
    await ensureCashIncomeForPayment(payment, userId);
    created += 1;
  }
  return { scanned: payments.length, created };
};

exports.getAllPayments = async (req, res) => {
  try {
    const { doctor } = req.query;
    let filter = {};
    if (doctor) {
      const escaped = doctor.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.doctorName = { $regex: new RegExp('^' + escaped + '$', 'i') };
    }
    const payments = await DoctorPayment.find(filter).sort({ paymentDate: -1 });
    res.status(200).json({ success: true, data: payments });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.addPayment = async (req, res) => {
  try {
    const { doctorName, amount, paymentDate, notes, remainingBefore } = req.body;
    if (!doctorName || amount === undefined || amount === null) {
      return res.status(400).json({ success: false, message: 'doctorName and amount are required' });
    }

    const normalizedName = doctorName.trim();
    const num = Number(amount);
    if (!Number.isFinite(num) || num <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than zero' });
    }

    if (remainingBefore !== undefined && remainingBefore !== null && remainingBefore !== '') {
      const remaining = Number(remainingBefore);
      if (Number.isFinite(remaining)) {
        if (remaining <= 0) {
          return res.status(400).json({
            success: false,
            message: 'No remaining balance on this account invoice',
          });
        }
        if (num > remaining) {
          return res.status(400).json({
            success: false,
            message: 'Payment cannot exceed remaining invoice balance (' + remaining + ' EGP)',
          });
        }
      }
    }

    const when = paymentDate ? new Date(paymentDate) : new Date();
    const paymentNotes = notes || '';

    const payment = await DoctorPayment.create({
      doctorName: normalizedName,
      amount: num,
      paymentDate: when,
      notes: paymentNotes,
    });

    try {
      await ensureCashIncomeForPayment(payment, req.user?.id || req.user?._id || null);
    } catch (cashErr) {
      console.error('Failed to create cash income for doctor payment:', cashErr);
    }

    res.status(201).json({ success: true, data: payment });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.deletePayment = async (req, res) => {
  try {
    const { id } = req.params;
    const payment = await DoctorPayment.findByIdAndDelete(id);
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    try {
      await CashEntry.deleteMany({ doctorPaymentId: payment._id });
    } catch (cashErr) {
      console.error('Failed to delete linked cash income:', cashErr);
    }

    res.status(200).json({ success: true, message: 'Payment deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};