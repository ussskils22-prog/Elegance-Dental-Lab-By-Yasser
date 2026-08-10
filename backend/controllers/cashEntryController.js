const CashEntry = require('../models/CashEntry');
const DoctorPayment = require('../models/DoctorPayment');
const { syncDoctorPaymentsToCash } = require('./doctorPaymentController');

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

exports.getEntries = async (req, res) => {
  try {
    // Ensure doctor/lab account payments appear in finance income
    try {
      await syncDoctorPaymentsToCash(req.user?.id || req.user?._id || null);
    } catch (syncErr) {
      console.error('cash sync from doctor payments failed:', syncErr);
    }

    const { from, to, type } = req.query;
    const filter = {};

    if (type === 'income' || type === 'expense') {
      filter.type = type;
    }

    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = startOfDay(from);
      if (to) filter.date.$lte = endOfDay(to);
    }

    const entries = await CashEntry.find(filter).sort({ date: -1, createdAt: -1 });
    res.status(200).json({ success: true, data: entries });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.addEntry = async (req, res) => {
  try {
    const { type, amount, date, category, notes } = req.body;

    if (type !== 'income' && type !== 'expense') {
      return res.status(400).json({ success: false, message: 'type must be income or expense' });
    }

    const num = Number(amount);
    if (!Number.isFinite(num) || num <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than zero' });
    }

    const entry = await CashEntry.create({
      type,
      amount: num,
      date: date ? new Date(date) : new Date(),
      category: (category || '').trim(),
      notes: (notes || '').trim(),
      createdBy: req.user?.id || req.user?._id || null,
    });

    res.status(201).json({ success: true, data: entry });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteEntry = async (req, res) => {
  try {
    const { id } = req.params;
    const entry = await CashEntry.findById(id);
    if (!entry) {
      return res.status(404).json({ success: false, message: 'Entry not found' });
    }

    // Doctor/lab report payments are mirrored into cash. Delete the source
    // payment too, otherwise syncDoctorPaymentsToCash recreates this row.
    if (entry.doctorPaymentId) {
      await DoctorPayment.findByIdAndDelete(entry.doctorPaymentId);
      await CashEntry.deleteMany({ doctorPaymentId: entry.doctorPaymentId });
    } else {
      await CashEntry.findByIdAndDelete(id);
    }

    res.status(200).json({ success: true, message: 'Entry deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
