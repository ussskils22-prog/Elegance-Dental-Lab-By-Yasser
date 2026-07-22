const DoctorPayment = require('../models/DoctorPayment');

exports.getAllPayments = async (req, res) => {
  try {
    const { doctor } = req.query;
    let filter = {};
    if (doctor) {
      // Normalize and find case-insensitive matching if needed, or exact matching
      filter.doctorName = { $regex: new RegExp('^' + doctor.trim().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '$', 'i') };
    }
    const payments = await DoctorPayment.find(filter).sort({ paymentDate: -1 });
    res.status(200).json({ success: true, data: payments });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.addPayment = async (req, res) => {
  try {
    const { doctorName, amount, paymentDate, notes } = req.body;
    if (!doctorName || amount === undefined || amount === null) {
      return res.status(400).json({ success: false, message: 'doctorName and amount are required' });
    }

    const normalizedName = doctorName.trim();
    if (amount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than zero' });
    }

    const payment = await DoctorPayment.create({
      doctorName: normalizedName,
      amount: Number(amount),
      paymentDate: paymentDate || new Date(),
      notes: notes || ''
    });

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
    res.status(200).json({ success: true, message: 'Payment deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
