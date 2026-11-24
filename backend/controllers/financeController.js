const { cairoParts, cairoMonthRange } = require('../utils/cairoTime');
const DentalCase = require('../models/DentalCase');
const DoctorPayment = require('../models/DoctorPayment');
const Material = require('../models/Material');
const MaterialPurchase = require('../models/MaterialPurchase');
const MaterialStockMovement = require('../models/MaterialStockMovement');
const PayrollPayment = require('../models/PayrollPayment');
const PayrollEmployee = require('../models/PayrollEmployee');
const OperatingExpense = require('../models/OperatingExpense');
const {
  recordPurchase,
  adjustStock,
  round2,
} = require('../services/inventoryService');
const { isNonBillableCase } = require('../services/casePricingService');

function monthRange(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!y || !m) return null;
  const { start, endInclusive: end } = cairoMonthRange(y, m);
  return { start, end };
}

function yearRange(year) {
  const y = Number(year);
  if (!y) return null;
  return {
    start: cairoMonthRange(y, 1).start,
    end: cairoMonthRange(y, 12).endInclusive,
  };
}

function resolveRange(query) {
  const { year, month } = query || {};
  if (year && month) return monthRange(year, month);
  if (year) return yearRange(year);
  // default: current month
  const now = new Date();
  return monthRange(cairoParts(now).year, cairoParts(now).month);
}

function caseExitDate(doc) {
  if (doc?.stageTimestamps?.exited) return new Date(doc.stageTimestamps.exited);
  return doc?.updatedAt ? new Date(doc.updatedAt) : null;
}

function computePayrollTotal(body) {
  const base = Math.max(0, Number(body.baseAmount) || 0);
  const incentive = Math.max(0, Number(body.incentiveAmount) || 0);
  const pieceUnits = Math.max(0, Number(body.pieceUnits) || 0);
  const pieceRate = Math.max(0, Number(body.pieceRate) || 0);
  const pieceAmount =
    body.pieceAmount !== undefined && body.pieceAmount !== null && body.pieceAmount !== ''
      ? Math.max(0, Number(body.pieceAmount) || 0)
      : round2(pieceUnits * pieceRate);
  const deductions = Math.max(0, Number(body.deductions) || 0);
  const totalAmount = round2(Math.max(0, base + incentive + pieceAmount - deductions));
  return { base, incentive, pieceUnits, pieceRate, pieceAmount, deductions, totalAmount };
}

const CATEGORY_LABELS = {
  rent: 'إيجار',
  utilities: 'مرافق (كهربا/مياه/نت)',
  maintenance: 'صيانة',
  delivery: 'توصيل',
  supplies: 'مستلزمات',
  other: 'أخرى',
};

// ─── Summary / Profit ─────────────────────────────────────────────

exports.getFinanceSummary = async (req, res) => {
  try {
    const range = resolveRange(req.query);
    const mode = String(req.query.mode || 'cash').toLowerCase() === 'accrual' ? 'accrual' : 'cash';
    const { start, end } = range;

    // Revenue
    let revenue = 0;
    let revenueDetail = {};

    if (mode === 'cash') {
      const paymentsRaw = await DoctorPayment.find({
        paymentDate: { $gte: start, $lte: end },
      }).lean();
      const payments = paymentsRaw.filter((p) => {
        const type = String(p?.entryType || '').toLowerCase().trim();
        if (type === 'charge') return false;
        const notes = String(p?.notes || '');
        if (notes.startsWith('[CHARGE]') || notes.startsWith('[زيادة]')) return false;
        return true;
      });
      revenue = round2(payments.reduce((s, p) => s + (Number(p.amount) || 0), 0));
      revenueDetail = {
        label: 'المقبوض من الأطباء (سجل الدفعات)',
        paymentsCount: payments.length,
      };
    } else {
      const cases = await DentalCase.find({ currentStage: 'exited' }).lean();
      let billed = 0;
      let count = 0;
      for (const doc of cases) {
        if (isNonBillableCase(doc.caseType, doc.notes)) continue;
        const d = caseExitDate(doc);
        if (!d || d < start || d > end) continue;
        billed += Number(doc.revenueAmount) || Number(doc.salaryAmount) || 0;
        count += 1;
      }
      revenue = round2(billed);
      revenueDetail = {
        label: 'إجمالي فواتير الحالات الخارجة',
        casesCount: count,
      };
    }

    // Material purchases (cash out for buying stock)
    const purchases = await MaterialPurchase.find({
      purchaseDate: { $gte: start, $lte: end },
    }).lean();
    const materialPurchasesTotal = round2(
      purchases.reduce((s, p) => s + (Number(p.totalCost) || 0), 0)
    );

    // COGS = consume movements in period
    const consumes = await MaterialStockMovement.find({
      type: 'consume',
      movementDate: { $gte: start, $lte: end },
    }).lean();
    const cogs = round2(consumes.reduce((s, m) => s + (Number(m.costImpact) || 0), 0));

    // Payroll — use month sheet totals (paid or draft count as accrued cost for that month)
    const y = cairoParts(start).year;
    const months =
      (cairoParts(start).month - 1) === (cairoParts(end).month - 1) && cairoParts(start).year === cairoParts(end).year
        ? [cairoParts(start).month]
        : Array.from({ length: 12 }, (_, i) => i + 1);

    const payrollQuery =
      months.length === 1
        ? { year: y, month: months[0] }
        : { year: y, month: { $in: months } };
    // If range is full year from resolveRange year-only, months is all 12.
    // If custom spanning years — rare; keep year of start.
    const payrollRows = await PayrollPayment.find(payrollQuery).lean();
    const payrollTotal = round2(
      payrollRows.reduce((s, r) => s + (Number(r.totalAmount) || 0), 0)
    );
    const payrollPaid = round2(
      payrollRows
        .filter((r) => r.status === 'paid')
        .reduce((s, r) => s + (Number(r.totalAmount) || 0), 0)
    );

    const expenses = await OperatingExpense.find({
      expenseDate: { $gte: start, $lte: end },
    }).lean();
    const operatingTotal = round2(
      expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0)
    );

    // Profit views:
    // - cash-ish: revenue(cash) - purchases - payrollPaid - operating
    // - accrual-ish: revenue(billed) - cogs - payrollTotal - operating
    const expensesForProfit =
      mode === 'cash'
        ? round2(materialPurchasesTotal + payrollPaid + operatingTotal)
        : round2(cogs + payrollTotal + operatingTotal);

    const netProfit = round2(revenue - expensesForProfit);

    const inventory = await Material.find({ active: true })
      .select('key label stockQty avgUnitCost defaultPrice lowStockAlert')
      .sort({ sortOrder: 1 })
      .lean();
    const inventoryValue = round2(
      inventory.reduce(
        (s, m) => s + (Number(m.stockQty) || 0) * (Number(m.avgUnitCost) || 0),
        0
      )
    );
    const lowStock = inventory.filter(
      (m) =>
        Number(m.lowStockAlert) > 0 && Number(m.stockQty) <= Number(m.lowStockAlert)
    );

    return res.json({
      success: true,
      period: { start, end, year: req.query.year || y, month: req.query.month || null },
      mode,
      modeLabel:
        mode === 'cash'
          ? 'على المقبوض (كاش)'
          : 'على إجمالي الفواتير (محاسبي)',
      revenue,
      revenueDetail,
      costs: {
        materialPurchasesTotal,
        cogs,
        payrollTotal,
        payrollPaid,
        operatingTotal,
        expensesForProfit,
      },
      netProfit,
      inventoryValue,
      lowStockCount: lowStock.length,
      lowStock,
      explain:
        mode === 'cash'
          ? 'الربح = المقبوض − مشتريات المواد − الرواتب المدفوعة − مصاريف التشغيل'
          : 'الربح = فواتير الحالات الخارجة − تكلفة المواد المستهلكة (COGS) − رواتب الشهر − مصاريف التشغيل',
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Purchases & inventory ────────────────────────────────────────

exports.listPurchases = async (req, res) => {
  try {
    const range = resolveRange(req.query);
    const q = { purchaseDate: { $gte: range.start, $lte: range.end } };
    if (req.query.materialKey) q.materialKey = String(req.query.materialKey).toLowerCase();
    const purchases = await MaterialPurchase.find(q).sort({ purchaseDate: -1 }).lean();
    return res.json({ success: true, purchases });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.createPurchase = async (req, res) => {
  try {
    const result = await recordPurchase(req.body, req.user);
    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

exports.listStock = async (req, res) => {
  try {
    const materials = await Material.find({})
      .sort({ sortOrder: 1, label: 1 })
      .select('key label labelAr stockQty avgUnitCost defaultPrice lowStockAlert active color')
      .lean();
    return res.json({ success: true, materials });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.adjustStock = async (req, res) => {
  try {
    const result = await adjustStock(req.body, req.user);
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

exports.listMovements = async (req, res) => {
  try {
    const range = resolveRange(req.query);
    const q = { movementDate: { $gte: range.start, $lte: range.end } };
    if (req.query.type) q.type = req.query.type;
    if (req.query.materialKey) q.materialKey = String(req.query.materialKey).toLowerCase();
    const movements = await MaterialStockMovement.find(q).sort({ movementDate: -1 }).limit(500).lean();
    return res.json({ success: true, movements });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateMaterialStockSettings = async (req, res) => {
  try {
    const mat = await Material.findById(req.params.id);
    if (!mat) return res.status(404).json({ success: false, message: 'الماتريال غير موجود' });
    if (req.body.lowStockAlert !== undefined) {
      mat.lowStockAlert = Math.max(0, Number(req.body.lowStockAlert) || 0);
    }
    await mat.save();
    return res.json({ success: true, material: mat });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Payroll ──────────────────────────────────────────────────────

exports.listPayrollEmployees = async (req, res) => {
  try {
    const includeInactive = String(req.query.all || '') === '1';
    const q = includeInactive ? {} : { isActive: true };
    const employees = await PayrollEmployee.find(q).sort({ name: 1 }).lean();
    return res.json({ success: true, employees });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.createPayrollEmployee = async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, message: 'اسم الموظف مطلوب' });
    }
    const payType = ['fixed', 'piece', 'mixed'].includes(body.payType) ? body.payType : 'fixed';
    const doc = await PayrollEmployee.create({
      name,
      jobTitle: String(body.jobTitle || '').trim(),
      phone: String(body.phone || '').trim(),
      baseSalary: Math.max(0, Number(body.baseSalary) || 0),
      defaultPieceRate: Math.max(0, Number(body.defaultPieceRate) || 0),
      payType,
      payrollEnabled: body.payrollEnabled !== false,
      isActive: body.isActive !== false,
      notes: String(body.notes || '').trim(),
    });
    return res.status(201).json({ success: true, employee: doc });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateEmployeePayroll = async (req, res) => {
  try {
    const emp = await PayrollEmployee.findById(req.params.id);
    if (!emp) return res.status(404).json({ success: false, message: 'الموظف غير موجود' });
    const body = req.body || {};
    if (body.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name) return res.status(400).json({ success: false, message: 'اسم الموظف مطلوب' });
      emp.name = name;
    }
    if (body.jobTitle !== undefined) emp.jobTitle = String(body.jobTitle || '').trim();
    if (body.phone !== undefined) emp.phone = String(body.phone || '').trim();
    if (typeof body.payrollEnabled === 'boolean') emp.payrollEnabled = body.payrollEnabled;
    if (typeof body.isActive === 'boolean') emp.isActive = body.isActive;
    if (body.baseSalary !== undefined) emp.baseSalary = Math.max(0, Number(body.baseSalary) || 0);
    if (body.defaultPieceRate !== undefined) {
      emp.defaultPieceRate = Math.max(0, Number(body.defaultPieceRate) || 0);
    }
    if (body.payType && ['fixed', 'piece', 'mixed'].includes(body.payType)) {
      emp.payType = body.payType;
    }
    if (body.notes !== undefined) emp.notes = String(body.notes || '').trim();
    await emp.save();
    return res.json({ success: true, employee: emp });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.deletePayrollEmployee = async (req, res) => {
  try {
    const emp = await PayrollEmployee.findById(req.params.id);
    if (!emp) return res.status(404).json({ success: false, message: 'الموظف غير موجود' });
    emp.isActive = false;
    emp.payrollEnabled = false;
    await emp.save();
    return res.json({ success: true, employee: emp });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.listPayroll = async (req, res) => {
  try {
    const year = Number(req.query.year) || cairoParts(new Date()).year;
    const month = Number(req.query.month) || cairoParts(new Date()).month;
    const rows = await PayrollPayment.find({ year, month }).sort({ employeeName: 1 }).lean();
    return res.json({ success: true, year, month, rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.upsertPayroll = async (req, res) => {
  try {
    const body = req.body || {};
    const payrollEmployeeId = body.payrollEmployeeId || body.employeeId || body.employee;
    const year = Number(body.year);
    const month = Number(body.month);
    if (!payrollEmployeeId || !year || !month) {
      return res.status(400).json({ success: false, message: 'الموظف والسنة والشهر مطلوبين' });
    }
    const employee = await PayrollEmployee.findById(payrollEmployeeId);
    if (!employee) return res.status(404).json({ success: false, message: 'الموظف غير موجود' });

    const calc = computePayrollTotal({
      baseAmount:
        body.baseAmount !== undefined ? body.baseAmount : employee.baseSalary,
      incentiveAmount: body.incentiveAmount,
      pieceUnits: body.pieceUnits,
      pieceRate:
        body.pieceRate !== undefined ? body.pieceRate : employee.defaultPieceRate,
      pieceAmount: body.pieceAmount,
      deductions: body.deductions,
    });

    const status = body.status === 'paid' ? 'paid' : 'draft';
    const employeeKey = `ext:${employee._id}`;
    const update = {
      employeeKey,
      source: 'external',
      payrollEmployee: employee._id,
      employee: null,
      employeeName: employee.name,
      employeeRole: employee.jobTitle || '',
      year,
      month,
      baseAmount: calc.base,
      incentiveAmount: calc.incentive,
      pieceUnits: calc.pieceUnits,
      pieceRate: calc.pieceRate,
      pieceAmount: calc.pieceAmount,
      deductions: calc.deductions,
      totalAmount: calc.totalAmount,
      status,
      notes: String(body.notes || ''),
      createdBy: req.user.id,
      createdByName: req.user.fullName,
    };
    if (status === 'paid') {
      update.paidAt = body.paidAt ? new Date(body.paidAt) : new Date();
    } else {
      update.paidAt = undefined;
    }

    const row = await PayrollPayment.findOneAndUpdate(
      { employeeKey, year, month },
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({ success: true, row });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.generatePayrollDrafts = async (req, res) => {
  try {
    const year = Number(req.body?.year) || cairoParts(new Date()).year;
    const month = Number(req.body?.month) || cairoParts(new Date()).month;
    const employees = await PayrollEmployee.find({
      isActive: true,
      payrollEnabled: true,
    });

    const created = [];
    for (const emp of employees) {
      const employeeKey = `ext:${emp._id}`;
      const existing = await PayrollPayment.findOne({ employeeKey, year, month });
      if (existing) continue;
      const base =
        emp.payType === 'piece' ? 0 : Math.max(0, Number(emp.baseSalary) || 0);
      const pieceRate = Math.max(0, Number(emp.defaultPieceRate) || 0);
      const row = await PayrollPayment.create({
        employeeKey,
        source: 'external',
        payrollEmployee: emp._id,
        employee: null,
        employeeName: emp.name,
        employeeRole: emp.jobTitle || '',
        year,
        month,
        baseAmount: base,
        incentiveAmount: 0,
        pieceUnits: 0,
        pieceRate,
        pieceAmount: 0,
        deductions: 0,
        totalAmount: base,
        status: 'draft',
        createdBy: req.user.id,
        createdByName: req.user.fullName,
      });
      created.push(row);
    }
    return res.json({ success: true, createdCount: created.length, created });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.deletePayroll = async (req, res) => {
  try {
    const row = await PayrollPayment.findByIdAndDelete(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'السجل غير موجود' });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Operating expenses ───────────────────────────────────────────

exports.listExpenses = async (req, res) => {
  try {
    const range = resolveRange(req.query);
    const q = { expenseDate: { $gte: range.start, $lte: range.end } };
    if (req.query.category) q.category = req.query.category;
    const expenses = await OperatingExpense.find(q).sort({ expenseDate: -1 }).lean();
    return res.json({
      success: true,
      expenses,
      categoryLabels: CATEGORY_LABELS,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.createExpense = async (req, res) => {
  try {
    const body = req.body || {};
    const title = String(body.title || '').trim();
    const amount = Number(body.amount);
    if (!title || !(amount >= 0) || Number.isNaN(amount)) {
      return res.status(400).json({ success: false, message: 'العنوان والمبلغ مطلوبان' });
    }
    const category = CATEGORY_LABELS[body.category] ? body.category : 'other';
    const doc = await OperatingExpense.create({
      category,
      title,
      amount: round2(amount),
      expenseDate: body.expenseDate ? new Date(body.expenseDate) : new Date(),
      notes: String(body.notes || '').trim(),
      createdBy: req.user.id,
      createdByName: req.user.fullName,
    });
    return res.status(201).json({ success: true, expense: doc });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.deleteExpense = async (req, res) => {
  try {
    const doc = await OperatingExpense.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ success: false, message: 'المصروف غير موجود' });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── Alerts / debts / case profit ─────────────────────────────────

exports.getStockAlerts = async (req, res) => {
  try {
    const materials = await Material.find({ active: true })
      .select('key label stockQty lowStockAlert avgUnitCost lastLowStockAlertAt')
      .sort({ sortOrder: 1 })
      .lean();
    const low = materials.filter(
      (m) => Number(m.lowStockAlert) > 0 && Number(m.stockQty) <= Number(m.lowStockAlert)
    );
    return res.json({ success: true, lowStock: low, count: low.length });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.getDoctorDebts = async (req, res) => {
  try {
    const {
      doctorKeysMatch,
      isNonBillableCase,
      parseNotesMeta,
      calculateCaseCostBreakdown,
      loadActiveMaterials,
      materialsToDefaultPrices,
      mergePricesForDoctor,
    } = require('../services/casePricingService');
    const { caseBillAmount, resolveDoctorPaid } = require('../services/doctorBalanceService');
    const DoctorPricing = require('../models/DoctorPricing');
    const User = require('../models/User');

    const [cases, pricings, materials, doctors, payments] = await Promise.all([
      DentalCase.find({ currentStage: 'exited' })
        .select(
          'caseNumber patientName caseType notes referringDoctor salaryAmount revenueAmount paymentStatus stageTimestamps createdAt updatedAt'
        )
        .lean(),
      DoctorPricing.find().lean(),
      loadActiveMaterials(),
      User.find({ role: 'doctor', isActive: true }).select('fullName phone').lean(),
      DoctorPayment.find().lean(),
    ]);
    const labDefaults = materialsToDefaultPrices(materials);
    const now = Date.now();
    const byDoctor = new Map();

    for (const doc of cases) {
      if (isNonBillableCase(doc.caseType, doc.notes)) continue;
      const meta = parseNotesMeta(doc.notes || '');
      const doctorName = String(
        doc.referringDoctor || meta.doctor || meta.doctorName || ''
      ).trim();
      if (!doctorName) continue;

      const doctorPrices = mergePricesForDoctor(pricings, doctorName);
      const breakdown = calculateCaseCostBreakdown(
        doc.caseType,
        meta,
        doctorPrices,
        materials,
        labDefaults
      );
      const amount = caseBillAmount(doc, breakdown.total);

      const exitedAt = doc.stageTimestamps?.exited
        ? new Date(doc.stageTimestamps.exited)
        : doc.updatedAt
          ? new Date(doc.updatedAt)
          : new Date(doc.createdAt);
      const daysOverdue = Math.max(
        0,
        Math.floor((now - exitedAt.getTime()) / (24 * 60 * 60 * 1000))
      );

      let key = null;
      for (const k of byDoctor.keys()) {
        if (doctorKeysMatch(k, doctorName)) {
          key = k;
          break;
        }
      }
      if (!key) key = doctorName;

      const row = byDoctor.get(key) || {
        doctorName: key,
        totalDue: 0,
        paidFromCases: 0,
        unpaidAmount: 0,
        unpaidCases: 0,
        maxDaysOverdue: 0,
        cases: [],
        phone: '',
      };
      row.totalDue += amount;
      if (String(doc.paymentStatus) === 'paid') {
        row.paidFromCases += amount;
      } else {
        row.unpaidCases += 1;
        row.maxDaysOverdue = Math.max(row.maxDaysOverdue, daysOverdue);
        row.cases.push({
          id: String(doc._id),
          caseNumber: doc.caseNumber,
          patientName: doc.patientName,
          amount: round2(amount),
          daysOverdue,
          exitedAt: exitedAt.toISOString(),
        });
      }
      byDoctor.set(key, row);
    }

    for (const row of byDoctor.values()) {
      const match = doctors.find((d) => doctorKeysMatch(d.fullName, row.doctorName));
      row.phone = match?.phone || '';
      const isChargeEntry = (p) => {
        const type = String(p?.entryType || '').toLowerCase().trim();
        if (type === 'charge') return true;
        const notes = String(p?.notes || '');
        return notes.startsWith('[CHARGE]') || notes.startsWith('[زيادة]');
      };
      const paidFromPayments = payments
        .filter((p) => doctorKeysMatch(p.doctorName, row.doctorName))
        .filter((p) => !isChargeEntry(p))
        .filter((p) => !p.caseId)
        .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
      const chargesTotal = payments
        .filter((p) => doctorKeysMatch(p.doctorName, row.doctorName))
        .filter((p) => isChargeEntry(p))
        .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
      const balance = resolveDoctorPaid({
        totalDue: row.totalDue + chargesTotal,
        paidFromCases: row.paidFromCases,
        paidFromPayments,
      });
      row.unpaidAmount = balance.remaining;
      row.totalPaid = balance.totalPaid;
      row.paidSource = balance.paidSource;
      row.cases.sort((a, b) => b.daysOverdue - a.daysOverdue);
    }

    const debts = [...byDoctor.values()]
      .filter((d) => d.unpaidAmount > 0)
      .sort((a, b) => b.unpaidAmount - a.unpaidAmount);
    const totalUnpaid = round2(debts.reduce((s, d) => s + d.unpaidAmount, 0));

    return res.json({
      success: true,
      totalUnpaid,
      doctorCount: debts.length,
      debts,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.remindDoctorDebt = async (req, res) => {
  try {
    const doctorName = String(req.body?.doctorName || '').trim();
    if (!doctorName) {
      return res.status(400).json({ success: false, message: 'اسم الطبيب مطلوب' });
    }
    // Reuse debts list for accurate amount
    const fakeReq = { query: {} };
    const fakeRes = {
      statusCode: 200,
      payload: null,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(p) {
        this.payload = p;
        return this;
      },
    };
    await exports.getDoctorDebts(fakeReq, fakeRes);
    const debts = fakeRes.payload?.debts || [];
    const {
      doctorKeysMatch,
    } = require('../services/casePricingService');
    const row = debts.find((d) => doctorKeysMatch(d.doctorName, doctorName));
    if (!row || !(row.unpaidAmount > 0)) {
      return res.status(404).json({ success: false, message: 'لا يوجد دين مسجّل لهذا الطبيب' });
    }

    const wa = require('../services/whatsappService');
    const result = await wa.sendDoctorDebtReminder({
      doctorName: row.doctorName,
      phone: req.body?.phone || row.phone,
      unpaidAmount: row.unpaidAmount,
      unpaidCases: row.unpaidCases,
    });

    if (!result.ok) {
      return res.status(400).json({ success: false, message: result.error || 'فشل إرسال التذكير' });
    }

    const Notification = require('../models/Notification');
    await Notification.create({
      type: 'finance_alert',
      title: 'تذكير دين طبيب',
      message: `تم إرسال تذكير لـ ${row.doctorName} بمبلغ ${row.unpaidAmount} EGP`,
      targetAudience: ['admin'],
    });

    return res.json({ success: true, message: 'تم إرسال التذكير', debt: row });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.getCaseProfitability = async (req, res) => {
  try {
    const range = resolveRange(req.query);
    const cases = await DentalCase.find({
      currentStage: 'exited',
      'stageTimestamps.exited': { $gte: range.start, $lte: range.end },
    })
      .select(
        'caseNumber patientName referringDoctor caseType salaryAmount revenueAmount materialCost caseProfit paymentStatus stageTimestamps'
      )
      .sort({ 'stageTimestamps.exited': -1 })
      .lean();

    // Fallback for older exits without exit timestamp filter match
    let rows = cases;
    if (!rows.length) {
      const all = await DentalCase.find({ currentStage: 'exited' })
        .select(
          'caseNumber patientName referringDoctor caseType salaryAmount revenueAmount materialCost caseProfit paymentStatus stageTimestamps updatedAt'
        )
        .sort({ updatedAt: -1 })
        .limit(500)
        .lean();
      rows = all.filter((doc) => {
        const d = doc.stageTimestamps?.exited
          ? new Date(doc.stageTimestamps.exited)
          : doc.updatedAt
            ? new Date(doc.updatedAt)
            : null;
        return d && d >= range.start && d <= range.end;
      });
    }

    const mapped = rows.map((doc) => {
      const revenue =
        Number(doc.revenueAmount) > 0
          ? Number(doc.revenueAmount)
          : Number(doc.salaryAmount) || 0;
      const materialCost = Number(doc.materialCost) || 0;
      const caseProfit =
        doc.caseProfit !== undefined && doc.caseProfit !== null
          ? Number(doc.caseProfit)
          : round2(revenue - materialCost);
      return {
        id: String(doc._id),
        caseNumber: doc.caseNumber,
        patientName: doc.patientName,
        doctorName: doc.referringDoctor || '—',
        caseType: doc.caseType,
        revenue: round2(revenue),
        materialCost: round2(materialCost),
        caseProfit: round2(caseProfit),
        paymentStatus: doc.paymentStatus || 'unpaid',
        exitedAt: doc.stageTimestamps?.exited || null,
      };
    });

    const totals = mapped.reduce(
      (acc, r) => {
        acc.revenue += r.revenue;
        acc.materialCost += r.materialCost;
        acc.caseProfit += r.caseProfit;
        return acc;
      },
      { revenue: 0, materialCost: 0, caseProfit: 0 }
    );
    totals.revenue = round2(totals.revenue);
    totals.materialCost = round2(totals.materialCost);
    totals.caseProfit = round2(totals.caseProfit);

    return res.json({ success: true, rows: mapped, totals, count: mapped.length });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.categoryLabels = CATEGORY_LABELS;
