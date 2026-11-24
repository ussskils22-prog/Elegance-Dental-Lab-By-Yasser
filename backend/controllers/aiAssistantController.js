const { cairoParts } = require('../utils/cairoTime');
const DentalCase = require('../models/DentalCase');
const User = require('../models/User');
const PrintJob = require('../models/PrintJob');

function normalizeArabicQuestion(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[^\u0600-\u06FFa-z0-9\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNotesMeta(notes) {
  const prefix = '__META__\n';
  if (!notes || typeof notes !== 'string' || !notes.startsWith(prefix)) return {};
  try {
    return JSON.parse(notes.slice(prefix.length));
  } catch {
    return {};
  }
}

function monthNameAr(monthNumber) {
  const names = [
    '',
    'يناير',
    'فبراير',
    'مارس',
    'أبريل',
    'مايو',
    'يونيو',
    'يوليو',
    'أغسطس',
    'سبتمبر',
    'أكتوبر',
    'نوفمبر',
    'ديسمبر',
  ];
  return names[monthNumber] || '';
}

function monthNumberFromQuestion(question) {
  const q = normalizeArabicQuestion(question);
  const monthMap = {
    يناير: 1,
    فبراير: 2,
    مارس: 3,
    ابريل: 4,
    مايو: 5,
    يونيو: 6,
    يوليو: 7,
    اغسطس: 8,
    سبتمبر: 9,
    اكتوبر: 10,
    نوفمبر: 11,
    ديسمبر: 12,
  };
  for (const [name, number] of Object.entries(monthMap)) {
    if (q.includes(normalizeArabicQuestion(name))) return number;
  }
  return null;
}

function doctorNameFromCase(doc) {
  const notesMeta = parseNotesMeta(doc.notes || '');
  return String(
    notesMeta.doctor ||
      notesMeta.doctorName ||
      (doc.assignedTo && doc.assignedTo.fullName) ||
      'غير محدد'
  )
    .trim()
    .replace(/\s+/g, ' ');
}

function caseExitedDate(doc) {
  return doc?.stageTimestamps?.exited
    ? new Date(doc.stageTimestamps.exited)
    : doc?.updatedAt
      ? new Date(doc.updatedAt)
      : doc?.createdAt
        ? new Date(doc.createdAt)
        : new Date();
}

function stageLabelAr(stage) {
  const map = {
    waiting: 'انتظار',
    secretary: 'سكرتارية',
    design: 'تصميم',
    khart: 'خارج',
    finishing: 'تشطيب',
    completed: 'منتهية',
    exited: 'خارجة',
  };
  return map[stage] || stage;
}

function priorityLabelAr(priority) {
  const map = { low: 'منخفضة', normal: 'عادية', high: 'عالية', urgent: 'عاجلة' };
  return map[priority] || priority;
}

function formatMoney(amount) {
  return `${Number(amount || 0).toLocaleString('en-US')} EGP`;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfWeek(date) {
  const d = startOfDay(date);
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d;
}

function extractCaseNumber(question) {
  const match = String(question || '').match(/CASE-\d{4}-\d{5}/i);
  return match ? match[0].toUpperCase() : null;
}

function extractSearchTerm(question, markers) {
  const raw = String(question || '').trim();
  for (const marker of markers) {
    const idx = normalizeArabicQuestion(raw).indexOf(normalizeArabicQuestion(marker));
    if (idx >= 0) {
      const slice = raw.slice(idx + marker.length).trim();
      if (slice.length >= 2) return slice.replace(/[؟?]/g, '').trim();
    }
  }
  return '';
}

async function loadCaseDocs() {
  return DentalCase.find({})
    .populate('assignedTo', 'fullName role')
    .populate('createdBy', 'fullName role')
    .sort({ createdAt: -1 })
    .lean();
}

function mapCaseRow(doc) {
  const meta = parseNotesMeta(doc.notes || '');
  const needsRevision = meta.uiStatusOverride === 'needs-revision';
  return {
    id: String(doc._id),
    caseNumber: String(doc.caseNumber || ''),
    patientName: String(doc.patientName || ''),
    caseType: String(doc.caseType || ''),
    doctorName: doctorNameFromCase(doc),
    clinic: String(meta.clinic || meta.branch || ''),
    currentStage: String(doc.currentStage || ''),
    status: String(doc.status || ''),
    priority: String(doc.priority || 'normal'),
    requesterType: String(doc.requesterType || 'doctor'),
    salaryAmount: Number(doc.salaryAmount || 0),
    paymentStatus: String(doc.paymentStatus || 'unpaid') === 'paid' ? 'paid' : 'unpaid',
    dueDate: doc.dueDate ? new Date(doc.dueDate) : null,
    createdAt: doc.createdAt ? new Date(doc.createdAt) : new Date(),
    exitedAt: caseExitedDate(doc),
    assignedToName: doc.assignedTo?.fullName || '',
    needsRevision,
  };
}

function buildHelpAnswer() {
  return (
    'أقدر أساعدك في:\n' +
    '• المالية: أرباح الشهر، مقارنة الشهور، أعلى الأطباء، غير المدفوعة، متوسط Zircon\n' +
    '• الحالات: عدد كل مرحلة، اليوم/الأسبوع، المتأخرة، العاجلة، محتاجة تعديل\n' +
    '• البحث: برقم الحالة، اسم المريض، اسم الدكتور\n' +
    '• الموظفين: عدد كل دور (مصممين، تشطيب، سكرتارية)\n' +
    '• الطباعة: مهام pending/failed/done\n' +
    '• ملخص عام: إحصائيات شاملة للمعمل'
  );
}

function answerFromCases(question, q, rows, now) {
  const currentMonth = cairoParts(now).month;
  const currentYear = cairoParts(now).year;
  const exitedRows = rows.filter((r) => r.currentStage === 'exited');
  const monthRange = (year, month) =>
    exitedRows.filter((r) => cairoParts(r.exitedAt).year === year && cairoParts(r.exitedAt).month === month);

  if (
    q.includes('مساعده') ||
    q.includes('تقدر تعمل') ||
    q.includes('ايه اللي تقدر') ||
    q.includes('help')
  ) {
    return { answer: buildHelpAnswer(), data: { type: 'help' } };
  }

  if (
    q.includes('ملخص') ||
    q.includes('نظرة عام') ||
    q.includes('احصائ') ||
    q.includes('كام حالة') && q.includes('في المعمل')
  ) {
    const byStage = rows.reduce((acc, row) => {
      acc[row.currentStage] = (acc[row.currentStage] || 0) + 1;
      return acc;
    }, {});
    const overdue = rows.filter((r) => r.currentStage !== 'exited' && r.dueDate && r.dueDate < startOfDay(now)).length;
    const urgent = rows.filter((r) => r.currentStage !== 'exited' && (r.priority === 'urgent' || r.priority === 'high')).length;
    const revision = rows.filter((r) => r.needsRevision).length;
    const totalRevenue = exitedRows.reduce((s, r) => s + r.salaryAmount, 0);
    const parts = Object.entries(byStage).map(([stage, count]) => `${stageLabelAr(stage)}: ${count}`);
    return {
      answer:
        `إجمالي الحالات: ${rows.length}. ` +
        `المراحل: ${parts.join(' | ')}. ` +
        `متأخرة: ${overdue}. عاجلة/عالية: ${urgent}. محتاجة تعديل: ${revision}. ` +
        `إجمالي إيرادات الحالات الخارجة: ${formatMoney(totalRevenue)}.`,
      data: { type: 'overview', byStage, overdue, urgent, revision, totalRevenue, total: rows.length },
    };
  }

  const stagePatterns = [
    { keys: ['انتظار', 'waiting'], stage: 'waiting' },
    { keys: ['سكرتار', 'secretary'], stage: 'secretary' },
    { keys: ['تصميم', 'design'], stage: 'design' },
    { keys: ['خارجه', 'exited'], stage: 'exited' },
    { keys: ['خارج', 'khart'], stage: 'khart' },
    { keys: ['تشطيب', 'finishing'], stage: 'finishing' },
    { keys: ['منته', 'completed'], stage: 'completed' },
  ];
  for (const { keys, stage } of stagePatterns) {
    if (keys.some((k) => q.includes(normalizeArabicQuestion(k))) && (q.includes('كام') || q.includes('عدد') || q.includes('حالات'))) {
      const count = rows.filter((r) => r.currentStage === stage).length;
      return {
        answer: `يوجد ${count} حالة في مرحلة ${stageLabelAr(stage)}.`,
        data: { type: 'stage-count', stage, count },
      };
    }
  }

  if (q.includes('متاخ') || q.includes('فات موعد') || q.includes('overdue')) {
    const overdueRows = rows
      .filter((r) => r.currentStage !== 'exited' && r.dueDate && r.dueDate < startOfDay(now))
      .slice(0, 15);
    const total = rows.filter((r) => r.currentStage !== 'exited' && r.dueDate && r.dueDate < startOfDay(now)).length;
    const list =
      overdueRows.length > 0
        ? overdueRows.map((r) => `${r.caseNumber} — ${r.patientName} (${stageLabelAr(r.currentStage)})`).join(' | ')
        : '';
    return {
      answer:
        total > 0
          ? `يوجد ${total} حالة متأخرة عن موعد التسليم.${list ? ' أمثلة: ' + list : ''}`
          : 'لا توجد حالات متأخرة حالياً.',
      data: { type: 'overdue', total, rows: overdueRows },
    };
  }

  if (q.includes('عاج') || q.includes('urgent') || (q.includes('اولو') && q.includes('عال'))) {
    const urgentRows = rows
      .filter((r) => r.currentStage !== 'exited' && (r.priority === 'urgent' || r.priority === 'high'))
      .slice(0, 15);
    const total = rows.filter((r) => r.currentStage !== 'exited' && (r.priority === 'urgent' || r.priority === 'high')).length;
    return {
      answer:
        total > 0
          ? `يوجد ${total} حالة بأولوية عالية/عاجلة: ` +
            urgentRows.map((r) => `${r.caseNumber} — ${r.patientName} (${priorityLabelAr(r.priority)})`).join(' | ')
          : 'لا توجد حالات عاجلة حالياً.',
      data: { type: 'urgent', total, rows: urgentRows },
    };
  }

  if (q.includes('محتاج') && q.includes('تعديل')) {
    const revisionRows = rows.filter((r) => r.needsRevision).slice(0, 15);
    const total = rows.filter((r) => r.needsRevision).length;
    return {
      answer:
        total > 0
          ? `يوجد ${total} حالة محتاجة تعديل: ` +
            revisionRows.map((r) => `${r.caseNumber} — ${r.patientName}`).join(' | ')
          : 'لا توجد حالات محتاجة تعديل.',
      data: { type: 'needs-revision', total, rows: revisionRows },
    };
  }

  const caseNumber = extractCaseNumber(question);
  if (caseNumber || (q.includes('رقم الحال') && q.includes('حال'))) {
    const num = caseNumber || extractSearchTerm(question, ['رقم الحالة', 'حالة']).toUpperCase();
    const found = rows.find((r) => r.caseNumber.toUpperCase() === num);
    if (!found) {
      return { answer: `لم أجد حالة برقم ${num || caseNumber}.`, data: { type: 'case-not-found', caseNumber: num } };
    }
    return {
      answer:
        `حالة ${found.caseNumber}: المريض ${found.patientName}، الدكتور ${found.doctorName}، ` +
        `النوع ${found.caseType}، المرحلة ${stageLabelAr(found.currentStage)}، ` +
        `الأولوية ${priorityLabelAr(found.priority)}، المبلغ ${formatMoney(found.salaryAmount)}، ` +
        `الدفع ${found.paymentStatus === 'paid' ? 'مدفوع' : 'غير مدفوع'}.`,
      data: { type: 'case-detail', row: found },
    };
  }

  if (q.includes('مريض') || q.includes('patient')) {
    const term = normalizeArabicQuestion(extractSearchTerm(question, ['المريض', 'مريض', 'patient']));
    if (term.length >= 2) {
      const matches = rows.filter((r) => normalizeArabicQuestion(r.patientName).includes(term)).slice(0, 10);
      return {
        answer:
          matches.length > 0
            ? `وجدت ${matches.length} حالة للمريض "${extractSearchTerm(question, ['المريض', 'مريض', 'patient'])}": ` +
              matches.map((r) => `${r.caseNumber} — ${stageLabelAr(r.currentStage)}`).join(' | ')
            : `لا توجد حالات للمريض "${extractSearchTerm(question, ['المريض', 'مريض', 'patient'])}".`,
        data: { type: 'patient-search', term, rows: matches },
      };
    }
  }

  if (
    (q.includes('دكت') || q.includes('طبيب') || q.includes('doctor')) &&
    (q.includes('حالات') || q.includes('شغل') || q.includes('كام'))
  ) {
    const term = normalizeArabicQuestion(
      extractSearchTerm(question, ['الدكتور', 'دكتور', 'الطبيب', 'طبيب', 'doctor'])
    );
    if (term.length >= 2) {
      const matches = rows.filter((r) => normalizeArabicQuestion(r.doctorName).includes(term));
      const active = matches.filter((r) => r.currentStage !== 'exited');
      const exited = matches.filter((r) => r.currentStage === 'exited');
      const totalAmount = exited.reduce((s, r) => s + r.salaryAmount, 0);
      return {
        answer:
          matches.length > 0
            ? `الدكتور "${extractSearchTerm(question, ['الدكتور', 'دكتور', 'الطبيب', 'طبيب'])}" — ` +
              `${matches.length} حالة (${active.length} نشطة، ${exited.length} خارجة). ` +
              `إجمالي المبالغ للحالات الخارجة: ${formatMoney(totalAmount)}.`
            : `لم أجد حالات للدكتور "${extractSearchTerm(question, ['الدكتور', 'دكتور', 'الطبيب', 'طبيب'])}".`,
        data: { type: 'doctor-search', term, total: matches.length, active: active.length, exited: exited.length, totalAmount },
      };
    }
  }

  if (q.includes('النهار') || q.includes('اليوم') || q.includes('today')) {
    const todayStart = startOfDay(now);
    const createdToday = rows.filter((r) => r.createdAt >= todayStart);
    const exitedToday = exitedRows.filter((r) => r.exitedAt >= todayStart);
    return {
      answer:
        `اليوم: ${createdToday.length} حالة جديدة، ${exitedToday.length} حالة خرجت، ` +
        `بإجمالي ${formatMoney(exitedToday.reduce((s, r) => s + r.salaryAmount, 0))}.`,
      data: { type: 'today', created: createdToday.length, exited: exitedToday.length },
    };
  }

  if (q.includes('الاسبو') || q.includes('week')) {
    const weekStart = startOfWeek(now);
    const created = rows.filter((r) => r.createdAt >= weekStart).length;
    const exited = exitedRows.filter((r) => r.exitedAt >= weekStart).length;
    return {
      answer: `هذا الأسبوع: ${created} حالة جديدة و ${exited} حالة خرجت.`,
      data: { type: 'week', created, exited },
    };
  }

  if (q.includes('طلب') && (q.includes('student') || q.includes('طالب'))) {
    const studentRows = rows.filter((r) => r.requesterType === 'student');
    const active = studentRows.filter((r) => r.currentStage !== 'exited').length;
    return {
      answer: `حالات الطلبة: ${studentRows.length} (${active} نشطة).`,
      data: { type: 'students', total: studentRows.length, active },
    };
  }

  if (q.includes('نوع') && (q.includes('شغل') || q.includes('حالات'))) {
    const counts = rows.reduce((acc, row) => {
      const key = row.caseType || 'غير محدد';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([type, count]) => `${type}: ${count}`)
      .join(' | ');
    return {
      answer: top ? `توزيع أنواع الشغل: ${top}` : 'لا توجد بيانات لأنواع الشغل.',
      data: { type: 'case-types', counts },
    };
  }

  if (q.includes('مصم') || q.includes('designer')) {
    const designers = rows
      .filter((r) => r.currentStage === 'design' && r.assignedToName)
      .reduce((acc, r) => {
        acc[r.assignedToName] = (acc[r.assignedToName] || 0) + 1;
        return acc;
      }, {});
    const list = Object.entries(designers)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}: ${count}`)
      .join(' | ');
    return {
      answer: list ? `شغل التصميم الحالي: ${list}` : 'لا توجد حالات في التصميم حالياً.',
      data: { type: 'designer-workload', designers },
    };
  }

  if (q.includes('كام ارباح الشهر') || q.includes('ارباح الشهر') || q.includes('اجمالي الشهر')) {
    const thisMonthRows = monthRange(currentYear, currentMonth);
    const total = thisMonthRows.reduce((sum, row) => sum + row.salaryAmount, 0);
    const paid = thisMonthRows.filter((r) => r.paymentStatus === 'paid').reduce((s, r) => s + r.salaryAmount, 0);
    const unpaid = total - paid;
    return {
      answer:
        `إجمالي شهر ${monthNameAr(currentMonth)} ${currentYear}: ${formatMoney(total)}. ` +
        `المدفوع ${formatMoney(paid)} والمتبقي ${formatMoney(unpaid)} على ${thisMonthRows.length} حالة خارجة.`,
      data: { type: 'monthly-profit', month: currentMonth, year: currentYear, total, paid, unpaid },
    };
  }

  if (q.includes('اجمالي') && (q.includes('ارباح') || q.includes('ايراد') || q.includes('فلوس'))) {
    const total = exitedRows.reduce((s, r) => s + r.salaryAmount, 0);
    const paid = exitedRows.filter((r) => r.paymentStatus === 'paid').reduce((s, r) => s + r.salaryAmount, 0);
    return {
      answer: `إجمالي كل الحالات الخارجة: ${formatMoney(total)} (${exitedRows.length} حالة). المدفوع ${formatMoney(paid)}.`,
      data: { type: 'total-revenue', total, paid, cases: exitedRows.length },
    };
  }

  if (q.includes('قارن') && q.includes('يونيو') && q.includes('يوليو')) {
    const juneRows = monthRange(currentYear, 6);
    const julyRows = monthRange(currentYear, 7);
    const juneTotal = juneRows.reduce((sum, row) => sum + row.salaryAmount, 0);
    const julyTotal = julyRows.reduce((sum, row) => sum + row.salaryAmount, 0);
    const diff = julyTotal - juneTotal;
    const direction = diff === 0 ? 'مساوي' : diff > 0 ? 'أعلى' : 'أقل';
    return {
      answer:
        `يونيو ${currentYear}: ${formatMoney(juneTotal)} (${juneRows.length} حالة). ` +
        `يوليو ${currentYear}: ${formatMoney(julyTotal)} (${julyRows.length} حالة). ` +
        `يوليو ${direction} من يونيو بـ ${formatMoney(Math.abs(diff))}.`,
      data: { type: 'month-compare', june: juneTotal, july: julyTotal, difference: diff },
    };
  }

  if (q.includes('اكتر') && (q.includes('5') || q.includes('خمس')) && (q.includes('دكت') || q.includes('طب'))) {
    const topDoctors = Object.values(
      exitedRows.reduce((acc, row) => {
        const key = row.doctorName.toLowerCase();
        if (!acc[key]) acc[key] = { doctorName: row.doctorName, cases: 0, totalAmount: 0 };
        acc[key].cases += 1;
        acc[key].totalAmount += row.salaryAmount;
        return acc;
      }, {})
    )
      .sort((a, b) => b.totalAmount - a.totalAmount || b.cases - a.cases)
      .slice(0, 5);
    return {
      answer:
        topDoctors.length > 0
          ? 'أكتر 5 دكاترة: ' +
            topDoctors.map((d, i) => `${i + 1}) ${d.doctorName} — ${formatMoney(d.totalAmount)} (${d.cases} حالة)`).join(' | ')
          : 'لا توجد بيانات كافية.',
      data: { type: 'top-doctors', rows: topDoctors },
    };
  }

  if (q.includes('غير') && (q.includes('مدف') || q.includes('unpaid'))) {
    const unpaidRows = exitedRows.filter((r) => r.paymentStatus === 'unpaid');
    const totalUnpaid = unpaidRows.reduce((s, r) => s + r.salaryAmount, 0);
    const sample = unpaidRows.slice(0, 10).map((r) => `${r.caseNumber} — ${r.patientName} (${formatMoney(r.salaryAmount)})`).join(' | ');
    return {
      answer:
        unpaidRows.length > 0
          ? `${unpaidRows.length} حالة خارجة غير مدفوعة بإجمالي ${formatMoney(totalUnpaid)}.${sample ? ' أمثلة: ' + sample : ''}`
          : 'لا توجد حالات خارجة غير مدفوعة.',
      data: { type: 'unpaid-exited', totalUnpaid, count: unpaidRows.length },
    };
  }

  if (q.includes('متوسط') && (q.includes('zircon') || q.includes('زيركون'))) {
    const targetMonth = monthNumberFromQuestion(q) || currentMonth;
    const zirconRows = monthRange(currentYear, targetMonth).filter((r) =>
      String(r.caseType || '').toLowerCase().includes('zircon')
    );
    const avg = zirconRows.length ? zirconRows.reduce((s, r) => s + r.salaryAmount, 0) / zirconRows.length : 0;
    return {
      answer:
        zirconRows.length > 0
          ? `متوسط Zircon في ${monthNameAr(targetMonth)} ${currentYear}: ${avg.toFixed(2)} EGP (${zirconRows.length} حالة).`
          : `لا توجد حالات Zircon في ${monthNameAr(targetMonth)} ${currentYear}.`,
      data: { type: 'avg-zircon', month: targetMonth, average: avg, cases: zirconRows.length },
    };
  }

  return null;
}

async function answerFromStaff(q) {
  const asksStaff =
    q.includes('موظ') ||
    q.includes('staff') ||
    q.includes('كام مصمم') ||
    q.includes('عدد المصمم') ||
    q.includes('كام تشطيب') ||
    q.includes('عدد التشطيب') ||
    q.includes('كام سكرت') ||
    q.includes('عدد السكرت') ||
    ((q.includes('مصمم') || q.includes('تشطيب') || q.includes('سكرتار')) &&
      (q.includes('موظف') || q.includes('عدد') || q.includes('كام')) &&
      !q.includes('حاله') &&
      !q.includes('تصميم'));
  if (!asksStaff) return null;
  const users = await User.find({ isActive: { $ne: false } }).select('fullName role').lean();
  const byRole = users.reduce((acc, u) => {
    acc[u.role] = (acc[u.role] || 0) + 1;
    return acc;
  }, {});
  const roleLabels = {
    admin: 'أدمن',
    secretary: 'سكرتارية',
    designer: 'مصمم',
    finisher: 'تشطيب',
    requester: 'طالب',
  };
  const parts = Object.entries(byRole).map(([role, count]) => `${roleLabels[role] || role}: ${count}`);
  return {
    answer: `الموظفون النشطون (${users.length}): ${parts.join(' | ')}.`,
    data: { type: 'staff', byRole, total: users.length },
  };
}

async function answerFromPrint(q) {
  if (!(q.includes('طباع') || q.includes('print') || q.includes('ورق'))) {
    return null;
  }
  const jobs = await PrintJob.find({}).sort({ createdAt: -1 }).limit(500).lean();
  const pending = jobs.filter((j) => j.status === 'pending').length;
  const failed = jobs.filter((j) => j.status === 'failed').length;
  const done = jobs.filter((j) => j.status === 'done').length;
  const unconfirmed = jobs.filter((j) => j.status === 'done' && j.paperConfirmed === 'pending').length;
  return {
    answer: `الطباعة: ${pending} pending، ${done} done، ${failed} failed. ${unconfirmed} done بدون تأكيد ورق.`,
    data: { type: 'print-stats', pending, done, failed, unconfirmed },
  };
}

exports.getAiAssistantAnswer = async (req, res) => {
  try {
    const question = String(req.query.question || '').trim();
    if (!question) {
      return res.status(400).json({ success: false, message: 'question is required' });
    }

    const q = normalizeArabicQuestion(question);
    const now = new Date();
    const yearParam = req.query.year ? Number(req.query.year) : null;
    const monthParam = req.query.month ? Number(req.query.month) : null;
    const hasPeriod =
      Number.isFinite(yearParam) &&
      Number.isFinite(monthParam) &&
      monthParam >= 1 &&
      monthParam <= 12;

    // When year/month selected in UI, treat that as "current" for monthly questions
    if (hasPeriod) {
      now.setFullYear(yearParam, monthParam - 1, 15);
    }

    const docs = await loadCaseDocs();
    let rows = docs.map(mapCaseRow);

    if (hasPeriod) {
      rows = rows.filter((r) => {
        if (r.currentStage === 'exited') {
          return cairoParts(r.exitedAt).year === yearParam && cairoParts(r.exitedAt).month === monthParam;
        }
        return cairoParts(r.createdAt).year === yearParam && cairoParts(r.createdAt).month === monthParam;
      });
    }

    let result = answerFromCases(question, q, rows, now);
    if (!result) result = await answerFromPrint(q);
    if (!result) result = await answerFromStaff(q);

    if (!result) {
      result = {
        answer:
          'لم أفهم السؤال بالكامل. جرّب: "ملخص المعمل"، "كام حالة في التصميم؟"، "حالات متأخرة"، "كام أرباح الشهر ده؟"، "CASE-2026-00001"، أو "مساعدة".',
        data: { type: 'unsupported' },
      };
    }

    if (hasPeriod && result?.answer) {
      result.answer = `[${monthNameAr(monthParam)} ${yearParam}] ${result.answer}`;
    }

    return res.status(200).json({
      success: true,
      question,
      answer: result.answer,
      data: result.data,
      period: hasPeriod ? { year: yearParam, month: monthParam } : null,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to answer question',
      error: error.message,
    });
  }
};
