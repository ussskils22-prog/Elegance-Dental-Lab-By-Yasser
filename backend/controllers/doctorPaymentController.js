const DoctorPayment = require('../models/DoctorPayment');

function isChargeEntry(doc) {
  const type = String(doc?.entryType || '').toLowerCase().trim();
  if (type === 'charge') return true;
  const notes = String(doc?.notes || '');
  return notes.startsWith('[CHARGE]') || notes.startsWith('[زيادة]');
}

exports.getAllPayments = async (req, res) => {
  try {
    const { doctor, entryType } = req.query;
    let filter = {};
    if (doctor) {
      // Normalize and find case-insensitive matching if needed, or exact matching
      filter.doctorName = { $regex: new RegExp('^' + doctor.trim().replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '$', 'i') };
    }
    const payments = await DoctorPayment.find(filter).sort({ paymentDate: -1 });
    let data = payments;
    if (entryType === 'payment' || entryType === 'charge') {
      data = payments.filter((p) =>
        entryType === 'charge' ? isChargeEntry(p) : !isChargeEntry(p)
      );
    }
    // Ensure clients always see a concrete entryType (repair stripped legacy rows via notes marker)
    data = data.map((p) => {
      const obj = typeof p.toObject === 'function' ? p.toObject() : { ...p };
      obj.entryType = isChargeEntry(obj) ? 'charge' : 'payment';
      return obj;
    });
    res.status(200).json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.addPayment = async (req, res) => {
  try {
    const { doctorName, amount, paymentDate, notes, entryType } = req.body;
    if (!doctorName || amount === undefined || amount === null) {
      return res.status(400).json({ success: false, message: 'doctorName and amount are required' });
    }

    const normalizedName = doctorName.trim();
    if (amount <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be greater than zero' });
    }

    const rawType = String(entryType || 'payment').toLowerCase().trim();
    if (rawType && rawType !== 'payment' && rawType !== 'charge') {
      return res.status(400).json({ success: false, message: 'entryType must be payment or charge' });
    }

    let normalizedNotes = String(notes || '').trim();
    // Notes marker alone is enough to request a charge (older clients / stripped body fields)
    const type =
      rawType === 'charge' || isChargeEntry({ notes: normalizedNotes, entryType: rawType })
        ? 'charge'
        : 'payment';

    if (type === 'charge') {
      if (!normalizedNotes.startsWith('[CHARGE]') && !normalizedNotes.startsWith('[زيادة]')) {
        normalizedNotes = normalizedNotes ? `[CHARGE] ${normalizedNotes}` : '[CHARGE]';
      }
    }

    let payment = await DoctorPayment.create({
      doctorName: normalizedName,
      amount: Number(amount),
      paymentDate: paymentDate || new Date(),
      notes: normalizedNotes,
      entryType: type,
      caseId: req.body?.caseId || null,
    });

    // Force-repair if schema/default left it as payment despite charge intent
    if (type === 'charge' && !isChargeEntry(payment)) {
      payment = await DoctorPayment.findByIdAndUpdate(
        payment._id,
        { $set: { entryType: 'charge', notes: normalizedNotes } },
        { new: true }
      );
    }

    try {
      const AuditLog = require('../models/AuditLog');
      await AuditLog.create({
        caseId: payment.caseId || undefined,
        caseNumber: payment.caseId ? String(payment.caseId) : 'ACCOUNT',
        action: type === 'charge' ? 'doctor_charge_added' : 'doctor_payment_added',
        performedBy: req.user?.id,
        performedByName: req.user?.fullName || '',
        details: {
          newValue: {
            doctorName: normalizedName,
            amount: Number(amount),
            entryType: type,
            paymentId: String(payment._id),
          },
        },
      });
    } catch (auditErr) {
      console.warn('AuditLog for doctor payment failed:', auditErr.message);
    }

    if (type === 'charge' && payment && !isChargeEntry(payment)) {
      await DoctorPayment.findByIdAndDelete(payment._id);
      return res.status(500).json({
        success: false,
        message: 'Failed to persist charge entryType — check DoctorPayment schema deploy',
      });
    }

    const data = typeof payment.toObject === 'function' ? payment.toObject() : { ...payment };
    data.entryType = type;
    data.notes = normalizedNotes;

    // Case-linked payment: mark the case paid once linked payments cover the bill
    if (type === 'payment' && payment.caseId) {
      try {
        const DentalCase = require('../models/DentalCase');
        const { frozenBillAmount, hasFrozenSnapshot } = require('../services/doctorBalanceService');
        const dentalCase = await DentalCase.findById(payment.caseId);
        if (dentalCase) {
          const linked = await DoctorPayment.find({
            caseId: dentalCase._id,
            entryType: { $ne: 'charge' },
          }).lean();
          const paidTotal = linked.reduce((s, p) => s + (Number(p.amount) || 0), 0);
          const due = hasFrozenSnapshot(dentalCase)
            ? frozenBillAmount(dentalCase)
            : Number(dentalCase.salaryAmount) || 0;
          const covers = due > 0 ? paidTotal + 0.009 >= due : paidTotal > 0;
          data.casePaidTotal = paidTotal;
          data.caseDue = due;
          if (covers && dentalCase.paymentStatus !== 'paid') {
            dentalCase.paymentStatus = 'paid';
            dentalCase.paidAt = payment.paymentDate || new Date();
            dentalCase.paidBy = req.user?.id || null;
            if (!(Number(dentalCase.salaryAmount) > 0) && due > 0) dentalCase.salaryAmount = due;
            await dentalCase.save();
            try {
              const { emitToAll } = require('../services/socketService');
              emitToAll('case:updated', {
                caseId: String(dentalCase._id),
                caseNumber: dentalCase.caseNumber,
                paymentStatus: 'paid',
              });
            } catch (_) {}
          }
          data.casePaymentStatus = dentalCase.paymentStatus;
        }
      } catch (caseErr) {
        console.warn('Case paid flag update failed:', caseErr.message);
      }
    }

    if (type === 'payment') {
      try {
        const { queueCashReceipt } = require('./printController');
        const receipt = await queueCashReceipt(
          {
            doctorName: normalizedName,
            amount: Number(amount),
            notes: normalizedNotes,
            paymentDate: payment.paymentDate,
            receiptNo: String(payment._id),
          },
          req.user?.id
        );
        if (receipt) data.receiptJobId = String(receipt._id);
      } catch (printErr) {
        console.warn('Cash receipt queue failed:', printErr.message);
      }
    }

    res.status(201).json({ success: true, data });
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
    if (payment.caseId && String(payment.entryType || 'payment') !== 'charge') {
      const DentalCase = require('../models/DentalCase');
      await DentalCase.updateOne(
        { _id: payment.caseId, paymentStatus: 'paid' },
        { $set: { paymentStatus: 'unpaid', paidAt: null, paidBy: null } }
      );
    }
    res.status(200).json({ success: true, message: 'Payment deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
