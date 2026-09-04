// archiver v8 is ESM; CJS require returns { ZipArchive, ... } not a callable.
const { ZipArchive } = require('archiver');
const DentalCase = require('../models/DentalCase');
const User = require('../models/User');
const PrintJob = require('../models/PrintJob');
const DoctorPayment = require('../models/DoctorPayment');
const DoctorPricing = require('../models/DoctorPricing');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const MonthArchive = require('../models/MonthArchive');
const { isNonBillableCase } = require('../services/casePricingService');

function parseNotesMeta(notes) {
  const prefix = '__META__\n';
  if (!notes || typeof notes !== 'string' || !notes.startsWith(prefix)) return {};
  try {
    return JSON.parse(notes.slice(prefix.length));
  } catch {
    return {};
  }
}

function doctorNameFromCase(doc) {
  const meta = parseNotesMeta(doc.notes || '');
  return String(
    meta.doctor || meta.doctorName || (doc.assignedTo && doc.assignedTo.fullName) || 'غير محدد'
  )
    .trim()
    .replace(/\s+/g, ' ');
}

function caseExitedDate(doc) {
  if (doc?.stageTimestamps?.exited) return new Date(doc.stageTimestamps.exited);
  if (doc?.updatedAt) return new Date(doc.updatedAt);
  if (doc?.createdAt) return new Date(doc.createdAt);
  return new Date();
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, columns) {
  const header = columns.map((c) => csvEscape(c.label)).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => csvEscape(typeof c.value === 'function' ? c.value(row) : row[c.key])).join(',')
  );
  // UTF-8 BOM for Excel Arabic
  return `\uFEFF${[header, ...lines].join('\n')}`;
}

function monthBounds(year, month) {
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 1, 0, 0, 0, 0);
  return { start, end };
}

function inMonth(date, year, month) {
  if (!date) return false;
  const d = new Date(date);
  return d.getFullYear() === year && d.getMonth() + 1 === month;
}

function classifyCaseTypeUnits(caseType, quantity) {
  let type = String(caseType || '').toLowerCase();
  const qty = Math.max(1, Number(quantity) || 1);
  const units = {
    zircon: 0,
    emax: 0,
    germanZircon: 0,
    titanium: 0,
    peek: 0,
    pmma: 0,
    nightGuard: 0,
    other: 0,
  };
  // Prova / try-in phase — do not count as final material units
  if (/try\s*in\s+before|tray\s*in\s+before/.test(type)) {
    units.other += qty;
    return units;
  }
  // Final after try-in — count the material (emax / zircon / …)
  type = type
    .replace(/\s+after\s+try\s*in/gi, '')
    .replace(/\s+after\s+tray\s*in/gi, '')
    .replace(/\s+after\s+tary\s*in/gi, '')
    .trim();
  if (type.includes('german') && type.includes('zircon')) units.germanZircon += qty;
  else if (type.includes('zircon') || type.includes('زيركون')) units.zircon += qty;
  else if (type.includes('emax') || type.includes('ايماكس') || type.includes('إيماكس')) units.emax += qty;
  else if (type.includes('titanium')) units.titanium += qty;
  else if (type.includes('peek')) units.peek += qty;
  else if (type.includes('pmma')) units.pmma += qty;
  else if (type.includes('night')) units.nightGuard += qty;
  else units.other += qty;
  return units;
}

function buildSummary(cases) {
  const byTypeUnits = {
    zircon: 0,
    emax: 0,
    germanZircon: 0,
    titanium: 0,
    peek: 0,
    pmma: 0,
    nightGuard: 0,
    other: 0,
  };
  const doctorMap = {};
  let totalAmount = 0;
  let paidAmount = 0;
  let unpaidAmount = 0;
  let exitedCases = 0;

  for (const doc of cases) {
    const meta = parseNotesMeta(doc.notes || '');
    const skipBillable = isNonBillableCase(doc.caseType, meta);
    const qty = Number(meta.quantity || meta.qty || 1) || 1;
    const units = skipBillable
      ? { zircon: 0, emax: 0, germanZircon: 0, titanium: 0, peek: 0, pmma: 0, nightGuard: 0, other: 0 }
      : classifyCaseTypeUnits(doc.caseType, qty);
    Object.keys(units).forEach((k) => {
      byTypeUnits[k] += units[k];
    });

    const doctorName = doctorNameFromCase(doc);
    if (!doctorMap[doctorName]) {
      doctorMap[doctorName] = {
        doctorName,
        cases: 0,
        totalAmount: 0,
        paidAmount: 0,
        unpaidAmount: 0,
        zirconUnits: 0,
        emaxUnits: 0,
        germanZirconUnits: 0,
      };
    }
    const d = doctorMap[doctorName];
    d.cases += 1;
    d.zirconUnits += units.zircon;
    d.emaxUnits += units.emax;
    d.germanZirconUnits += units.germanZircon;

    if (doc.currentStage === 'exited' && !skipBillable) {
      exitedCases += 1;
      const amount = Number(doc.salaryAmount || 0);
      totalAmount += amount;
      d.totalAmount += amount;
      if (doc.paymentStatus === 'paid') {
        paidAmount += amount;
        d.paidAmount += amount;
      } else {
        unpaidAmount += amount;
        d.unpaidAmount += amount;
      }
    }
  }

  return {
    totalCases: cases.length,
    exitedCases,
    byDoctor: Object.values(doctorMap).sort((a, b) => b.totalAmount - a.totalAmount),
    byTypeUnits,
    totalAmount,
    paidAmount,
    unpaidAmount,
  };
}

async function loadExportPayload(year, month) {
  const filterMonth = Number.isFinite(year) && Number.isFinite(month);

  const [allCases, payments, pricings, users, printJobs] =
    await Promise.all([
      DentalCase.find({})
        .populate('assignedTo', 'fullName role')
        .populate('createdBy', 'fullName role')
        .sort({ createdAt: -1 })
        .lean(),
      DoctorPayment.find({}).sort({ paymentDate: -1 }).lean(),
      DoctorPricing.find({}).sort({ doctorName: 1 }).lean(),
      User.find({}).select('-password').sort({ fullName: 1 }).lean(),
      PrintJob.find({}).sort({ createdAt: -1 }).limit(2000).lean(),
    ]);

  let cases = allCases;
  let filteredPayments = payments;
  let filteredPrint = printJobs;

  if (filterMonth) {
    cases = allCases.filter((doc) => {
      if (doc.currentStage === 'exited') {
        return inMonth(caseExitedDate(doc), year, month);
      }
      return inMonth(doc.createdAt, year, month);
    });
    filteredPayments = payments.filter((p) => inMonth(p.paymentDate || p.createdAt, year, month));
    filteredPrint = printJobs.filter((j) => inMonth(j.createdAt, year, month));
  }

  const caseRows = cases.map((doc) => {
    const meta = parseNotesMeta(doc.notes || '');
    return {
      id: String(doc._id),
      caseNumber: doc.caseNumber || '',
      patientName: doc.patientName || '',
      patientPhone: doc.patientPhone || '',
      patientEmail: doc.patientEmail || '',
      doctorName: doctorNameFromCase(doc),
      clinic: meta.clinic || meta.branch || '',
      caseType: doc.caseType || '',
      quantity: meta.quantity || meta.qty || '',
      color: meta.color || '',
      workType: meta.workType || '',
      currentStage: doc.currentStage || '',
      status: doc.status || '',
      requesterType: doc.requesterType || '',
      priority: doc.priority || '',
      salaryAmount: Number(doc.salaryAmount || 0),
      paymentStatus: doc.paymentStatus || 'unpaid',
      paidAt: doc.paidAt || '',
      dueDate: doc.dueDate || '',
      createdAt: doc.createdAt || '',
      exitedAt: doc.currentStage === 'exited' ? caseExitedDate(doc) : '',
      assignedTo: doc.assignedTo?.fullName || '',
      createdBy: doc.createdBy?.fullName || '',
      notesRaw: doc.notes || '',
    };
  });

  const summary = buildSummary(cases);

  return {
    year: filterMonth ? year : null,
    month: filterMonth ? month : null,
    caseRows,
    payments: filteredPayments,
    pricings,
    users,
    printJobs: filteredPrint,
    auditLogs: [],
    notifications: [],
    summary,
    start: filterMonth ? monthBounds(year, month).start : null,
    end: filterMonth ? monthBounds(year, month).end : null,
  };
}

exports.exportMonthData = async (req, res) => {
  try {
    const year = req.query.year ? Number(req.query.year) : null;
    const month = req.query.month ? Number(req.query.month) : null;
    const hasMonth = Number.isFinite(year) && Number.isFinite(month) && month >= 1 && month <= 12;

    if ((req.query.year || req.query.month) && !hasMonth) {
      return res.status(400).json({ success: false, message: 'Provide valid year and month' });
    }

    const payload = await loadExportPayload(
      hasMonth ? year : null,
      hasMonth ? month : null
    );

    let liveCounts = [];
    try {
      liveCounts = await DentalCase.aggregate([
        { $group: { _id: '$currentStage', count: { $sum: 1 } } },
      ]);
    } catch (aggErr) {
      console.warn('dashboard aggregate skipped:', aggErr.message);
    }
    const countMap = Object.fromEntries(liveCounts.map((r) => [r._id || 'unknown', r.count]));

    const exitedRows = payload.caseRows.filter((r) => r.currentStage === 'exited');
    const reportByDoctor = Object.values(
      exitedRows.reduce((acc, row) => {
        const key = row.doctorName || 'غير محدد';
        if (!acc[key]) {
          acc[key] = {
            doctorName: key,
            cases: 0,
            totalAmount: 0,
            paidAmount: 0,
            unpaidAmount: 0,
          };
        }
        acc[key].cases += 1;
        const amount = Number(row.salaryAmount || 0);
        acc[key].totalAmount += amount;
        if (row.paymentStatus === 'paid') acc[key].paidAmount += amount;
        else acc[key].unpaidAmount += amount;
        return acc;
      }, {})
    ).sort((a, b) => b.totalAmount - a.totalAmount);

    const dashRows = [
      {
        metric: 'إجمالي الحالات النشطة (غير خارجة)',
        value: Object.entries(countMap)
          .filter(([k]) => k !== 'exited')
          .reduce((s, [, n]) => s + n, 0),
      },
      { metric: 'الحالات الجديدة (انتظار)', value: countMap.waiting || 0 },
      { metric: 'الحالات المنتهية (قبل الخروج)', value: countMap.completed || 0 },
      { metric: 'في التصميم', value: countMap.design || 0 },
      { metric: 'في الخارج/الخراطة', value: countMap.khart || 0 },
      { metric: 'في التشطيب', value: countMap.finishing || 0 },
      { metric: 'سكرتارية', value: countMap.secretary || 0 },
      { metric: 'الحالات الخارجة', value: countMap.exited || 0 },
    ];

    const safeName = (name) =>
      String(name || 'unknown')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 80) || 'doctor';

    // Build the entire ZIP in memory first (avoids broken streams on Railway)
    const zipBuffer = await new Promise((resolve, reject) => {
      const archive = new ZipArchive({ zlib: { level: 5 } });
      const chunks = [];
      archive.on('data', (chunk) => chunks.push(chunk));
      archive.on('error', reject);
      archive.on('end', () => resolve(Buffer.concat(chunks)));

      archive.append(
        toCsv(payload.caseRows, [
          { label: 'caseNumber', key: 'caseNumber' },
          { label: 'patientName', key: 'patientName' },
          { label: 'doctorName', key: 'doctorName' },
          { label: 'clinic', key: 'clinic' },
          { label: 'caseType', key: 'caseType' },
          { label: 'quantity', key: 'quantity' },
          { label: 'color', key: 'color' },
          { label: 'workType', key: 'workType' },
          { label: 'currentStage', key: 'currentStage' },
          { label: 'paymentStatus', key: 'paymentStatus' },
          { label: 'salaryAmount', key: 'salaryAmount' },
          { label: 'createdAt', key: 'createdAt' },
          { label: 'exitedAt', key: 'exitedAt' },
          { label: 'paidAt', key: 'paidAt' },
          { label: 'createdBy', key: 'createdBy' },
        ]),
        { name: 'cases.csv' }
      );

      archive.append(
        toCsv(payload.payments, [
          { label: 'doctorName', key: 'doctorName' },
          { label: 'amount', key: 'amount' },
          { label: 'paymentDate', key: 'paymentDate' },
          { label: 'notes', key: 'notes' },
        ]),
        { name: 'doctor_payments.csv' }
      );

      archive.append(
        toCsv(
          payload.pricings.map((p) => ({
            doctorName: p.doctorName,
            ...(p.prices || {}),
          })),
          [
            { label: 'doctorName', key: 'doctorName' },
            { label: 'emax', key: 'emax' },
            { label: 'zircon', key: 'zircon' },
            { label: 'germanZircon', key: 'germanZircon' },
            { label: 'titanium', key: 'titanium' },
            { label: 'peek', key: 'peek' },
            { label: 'pmma', key: 'pmma' },
            { label: 'nightGuard', key: 'nightGuard' },
            { label: 'mockup', key: 'mockup' },
            { label: 'wax', key: 'wax' },
            { label: 'ring', key: 'ring' },
            { label: 'tryIn', key: 'tryIn' },
          ]
        ),
        { name: 'doctor_pricing.csv' }
      );

      archive.append(
        toCsv(payload.users, [
          { label: 'fullName', key: 'fullName' },
          { label: 'email', key: 'email' },
          { label: 'phone', key: 'phone' },
          { label: 'role', key: 'role' },
          { label: 'isActive', key: 'isActive' },
        ]),
        { name: 'users.csv' }
      );

      archive.append(
        toCsv(
          (payload.printJobs || []).map((j) => ({
            status: j.status,
            doctor: j.printData?.doctor,
            patient: j.printData?.patient,
            caseType: j.printData?.caseType,
            caseNumber: j.printData?.caseNumber,
            createdAt: j.createdAt,
          })),
          [
            { label: 'status', key: 'status' },
            { label: 'doctor', key: 'doctor' },
            { label: 'patient', key: 'patient' },
            { label: 'caseType', key: 'caseType' },
            { label: 'caseNumber', key: 'caseNumber' },
            { label: 'createdAt', key: 'createdAt' },
          ]
        ),
        { name: 'print_jobs.csv' }
      );

      archive.append(
        JSON.stringify(
          {
            year: payload.year,
            month: payload.month,
            exportedAt: new Date().toISOString(),
            ...payload.summary,
          },
          null,
          2
        ),
        { name: 'summary.json' }
      );

      archive.append(
        toCsv(dashRows, [
          { label: 'البند', key: 'metric' },
          { label: 'العدد', key: 'value' },
        ]),
        { name: 'dashboard_snapshot.csv' }
      );

      archive.append(
        toCsv(reportByDoctor, [
          { label: 'اسم الطبيب', key: 'doctorName' },
          { label: 'عدد الحالات الخارجة', key: 'cases' },
          { label: 'إجمالي الحساب', key: 'totalAmount' },
          { label: 'المدفوع', key: 'paidAmount' },
          { label: 'المتبقي', key: 'unpaidAmount' },
        ]),
        { name: 'reports_by_doctor.csv' }
      );

      archive.append(
        toCsv(exitedRows, [
          { label: 'caseNumber', key: 'caseNumber' },
          { label: 'patientName', key: 'patientName' },
          { label: 'doctorName', key: 'doctorName' },
          { label: 'caseType', key: 'caseType' },
          { label: 'quantity', key: 'quantity' },
          { label: 'salaryAmount', key: 'salaryAmount' },
          { label: 'paymentStatus', key: 'paymentStatus' },
          { label: 'createdAt', key: 'createdAt' },
          { label: 'exitedAt', key: 'exitedAt' },
        ]),
        { name: 'exited_cases_all.csv' }
      );

      const byDoctorCases = exitedRows.reduce((acc, row) => {
        const key = row.doctorName || 'غير محدد';
        if (!acc[key]) acc[key] = [];
        acc[key].push(row);
        return acc;
      }, {});

      // Cap doctor sheets to avoid huge zips / timeouts
      const doctorEntries = Object.entries(byDoctorCases).slice(0, 200);
      for (const [doctorName, rows] of doctorEntries) {
        archive.append(
          toCsv(rows, [
            { label: 'رقم الحالة', key: 'caseNumber' },
            { label: 'المريض', key: 'patientName' },
            { label: 'النوع', key: 'caseType' },
            { label: 'الكمية', key: 'quantity' },
            { label: 'المبلغ', key: 'salaryAmount' },
            { label: 'حالة الدفع', key: 'paymentStatus' },
            { label: 'تاريخ الدخول', key: 'createdAt' },
            { label: 'تاريخ الخروج', key: 'exitedAt' },
          ]),
          { name: `doctors/${safeName(doctorName)}.csv` }
        );
      }

      archive.finalize();
    });

    if (hasMonth) {
      try {
        await MonthArchive.findOneAndUpdate(
          { year, month },
          {
            $set: {
              exportedAt: new Date(),
              summary: {
                ...payload.summary,
                activeCasesKept: 0,
                deletedExitedCases: 0,
                deletedPayments: 0,
              },
            },
          },
          { upsert: true, new: true }
        );
      } catch (metaErr) {
        console.warn('MonthArchive meta update skipped:', metaErr.message);
      }
    }

    const stamp = hasMonth
      ? `${year}-${String(month).padStart(2, '0')}`
      : new Date().toISOString().slice(0, 10);
    const filename = `Elegance-Lab-Export-${stamp}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(zipBuffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
    return res.status(200).end(zipBuffer);
  } catch (error) {
    console.error('exportMonthData failed:', error);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: `Failed to export data: ${error.message || 'unknown error'}`,
        error: error.message,
      });
    }
  }
};

exports.listArchives = async (_req, res) => {
  try {
    const rows = await MonthArchive.find({}).sort({ year: -1, month: -1 }).lean();
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to list archives',
      error: error.message,
    });
  }
};

exports.closeMonth = async (req, res) => {
  try {
    const year = Number(req.body.year);
    const month = Number(req.body.month);
    const confirm = String(req.body.confirm || '').trim();
    const force = Boolean(req.body.force);

    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      return res.status(400).json({ success: false, message: 'Valid year and month are required' });
    }

    const expected = `${year}-${String(month).padStart(2, '0')}`;
    if (confirm !== expected) {
      return res.status(400).json({
        success: false,
        message: `اكتب للتأكيد: ${expected}`,
      });
    }

    const existing = await MonthArchive.findOne({ year, month });
    if (existing?.closedAt && !force) {
      return res.status(409).json({
        success: false,
        message: 'هذا الشهر مقفول بالفعل. أرسل force=true للإعادة.',
      });
    }

    if (!existing?.exportedAt && !force) {
      return res.status(400).json({
        success: false,
        message: 'حمّل بيانات الشهر أولاً قبل الإغلاق، أو أرسل force=true',
      });
    }

    // Snapshot month data, then delete ONLY this month's exited cases + this month's payments.
    const allCases = await DentalCase.find({})
      .populate('assignedTo', 'fullName')
      .lean();
    const monthCases = allCases.filter((doc) => {
      if (doc.currentStage === 'exited') return inMonth(caseExitedDate(doc), year, month);
      return inMonth(doc.createdAt, year, month);
    });
    const summary = buildSummary(monthCases);

    const exitedIds = allCases
      .filter(
        (doc) =>
          doc.currentStage === 'exited' && inMonth(caseExitedDate(doc), year, month)
      )
      .map((doc) => doc._id);

    const activeKept = allCases.filter((doc) => {
      if (doc.currentStage !== 'exited') return true;
      // Exited cases from other months stay in DB until their month is closed
      return !inMonth(caseExitedDate(doc), year, month);
    }).length;

    const deleteCasesResult = await DentalCase.deleteMany({
      _id: { $in: exitedIds },
    });

    // Delete only payments dated in this closed month (never wipe full ledger)
    const monthStart = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);
    const deletePaymentsResult = await DoctorPayment.deleteMany({
      paymentDate: { $gte: monthStart, $lte: monthEnd },
    });

    if (exitedIds.length) {
      await AuditLog.deleteMany({ caseId: { $in: exitedIds } });
      await Notification.deleteMany({ caseId: { $in: exitedIds } });
    }

    // Clear only print jobs created in this month (do not wipe the whole queue forever)
    const deletePrintResult = await PrintJob.deleteMany({
      createdAt: { $gte: monthStart, $lte: monthEnd },
    });

    const archive = await MonthArchive.findOneAndUpdate(
      { year, month },
      {
        $set: {
          closedAt: new Date(),
          closedBy: req.user.id,
          confirmPhrase: confirm,
          summary: {
            ...summary,
            activeCasesKept: activeKept,
            deletedExitedCases: deleteCasesResult.deletedCount || 0,
            deletedPayments: deletePaymentsResult.deletedCount || 0,
            deletedPrintJobs: deletePrintResult.deletedCount || 0,
          },
        },
      },
      { upsert: true, new: true }
    );

    return res.status(200).json({
      success: true,
      message: 'تم إغلاق الشهر وحذف حالات/دفعات هذا الشهر فقط',
      data: {
        year,
        month,
        deletedExitedCases: deleteCasesResult.deletedCount || 0,
        deletedPayments: deletePaymentsResult.deletedCount || 0,
        deletedPrintJobs: deletePrintResult.deletedCount || 0,
        activeCasesKept: activeKept,
        archive,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to close month',
      error: error.message,
    });
  }
};
