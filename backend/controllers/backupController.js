const { cairoParts } = require('../utils/cairoTime');
const DentalCase = require('../models/DentalCase');
const DoctorPayment = require('../models/DoctorPayment');
const AuditLog = require('../models/AuditLog');
const Material = require('../models/Material');

/**
 * Admin backup export — JSON snapshot of operational data for a year/month (exit-based).
 * GET /api/backup/export?year=&month=
 */
exports.exportBackup = async (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : cairoParts(new Date()).year;
    const month = req.query.month ? Number(req.query.month) : null;
    if (!Number.isFinite(year)) {
      return res.status(400).json({ success: false, message: 'year required' });
    }

    const cases = await DentalCase.find({ currentStage: 'exited' }).lean();
    const inPeriod = (doc) => {
      const raw = doc?.stageTimestamps?.exited || doc?.updatedAt || doc?.createdAt;
      if (!raw) return false;
      const d = new Date(raw);
      if (cairoParts(d).year !== year) return false;
      if (month && cairoParts(d).month !== month) return false;
      return true;
    };
    const exitedCases = cases.filter(inPeriod);

    const payments = await DoctorPayment.find({}).sort({ paymentDate: -1 }).lean();
    const paymentsInPeriod = payments.filter((p) => {
      const d = p.paymentDate ? new Date(p.paymentDate) : null;
      if (!d) return false;
      if (cairoParts(d).year !== year) return false;
      if (month && cairoParts(d).month !== month) return false;
      return true;
    });

    const caseIds = exitedCases.map((c) => c._id);
    const audits = await AuditLog.find({ caseId: { $in: caseIds } })
      .sort({ timestamp: -1 })
      .limit(5000)
      .lean();

    const stock = await Material.find({ active: true })
      .select('key label stockQty avgUnitCost lowStockAlert defaultPrice')
      .lean();

    const payload = {
      exportedAt: new Date().toISOString(),
      scope: { year, month: month || null, basis: 'exitedAt' },
      counts: {
        exitedCases: exitedCases.length,
        payments: paymentsInPeriod.length,
        auditLogs: audits.length,
        materials: stock.length,
      },
      exitedCases,
      payments: paymentsInPeriod,
      auditLogs: audits,
      materials: stock,
    };

    const stamp = month ? `${year}-${String(month).padStart(2, '0')}` : String(year);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="elegance-backup-${stamp}.json"`
    );
    return res.status(200).send(JSON.stringify(payload, null, 2));
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Backup export failed',
      error: error.message,
    });
  }
};
