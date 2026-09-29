const DoctorCharge = require('../models/DoctorCharge');

exports.getAllCharges = async (req, res) => {
  try {
    const { doctor } = req.query;
    let filter = {};
    if (doctor) {
      const escaped = doctor.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.doctorName = { $regex: new RegExp('^' + escaped + '$', 'i') };
    }
    const charges = await DoctorCharge.find(filter).sort({ chargeDate: -1 });
    res.status(200).json({ success: true, data: charges });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.addCharge = async (req, res) => {
  try {
    const { doctorName, amount, chargeDate, notes } = req.body;
    if (!doctorName || amount === undefined || amount === null) {
      return res.status(400).json({ success: false, message: 'doctorName and amount are required' });
    }

    const normalizedName = doctorName.trim();
    const num = Number(amount);
    if (!Number.isFinite(num) || num <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than zero' });
    }

    const when = chargeDate ? new Date(chargeDate) : new Date();
    const charge = await DoctorCharge.create({
      doctorName: normalizedName,
      amount: num,
      chargeDate: when,
      notes: notes || '',
    });

    res.status(201).json({ success: true, data: charge });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteCharge = async (req, res) => {
  try {
    const { id } = req.params;
    const charge = await DoctorCharge.findByIdAndDelete(id);
    if (!charge) {
      return res.status(404).json({ success: false, message: 'Charge not found' });
    }
    res.status(200).json({ success: true, message: 'Charge deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
