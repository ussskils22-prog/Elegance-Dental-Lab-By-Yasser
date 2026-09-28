const DentalCase = require('../models/DentalCase');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const User = require('../models/User');
const CashEntry = require('../models/CashEntry');
const DoctorPricing = require('../models/DoctorPricing');
const { validationResult } = require('express-validator');
const { emitToAll } = require('../services/socketService');
const { repairPaidZeroSalaries } = require('../utils/caseCost');

function normalizeDocId(ref) {
  if (ref === undefined || ref === null) return '';
  if (typeof ref === 'object' && ref._id !== undefined) return String(ref._id);
  return String(ref);
}

function emitCaseUpdated(dentalCase, reqUser) {
  emitToAll('case:updated', {
    caseId: String(dentalCase._id),
    caseNumber: dentalCase.caseNumber,
    currentStage: dentalCase.currentStage,
    status: dentalCase.status,
    updatedBy: reqUser?.id,
    timestamp: new Date(),
  });
}

const parseNotesMeta = (notes) => {
  const prefix = '__META__\n';
  if (!notes || typeof notes !== 'string' || !notes.startsWith(prefix)) return {};
  try {
    return JSON.parse(notes.slice(prefix.length));
  } catch {
    return {};
  }
};

const sanitizeCaseImagePath = (rawUrl) => {
  const clean = String(rawUrl || '').trim();
  if (!clean || clean.startsWith('data:') || clean.startsWith('blob:')) return '';
  if (/^https?:\/\//i.test(clean)) {
    try {
      return new URL(clean).pathname || '';
    } catch {
      return '';
    }
  }
  return clean.startsWith('/') ? clean : `/${clean}`;
};

const sanitizeNotesMetaString = (notes) => {
  const prefix = '__META__\n';
  if (!notes || typeof notes !== 'string' || !notes.startsWith(prefix)) return notes || '';
  try {
    const meta = JSON.parse(notes.slice(prefix.length));
    const rawImages = Array.isArray(meta?.designImages) ? meta.designImages : [];
    const cleanedImages = [...new Set(rawImages.map(sanitizeCaseImagePath).filter(Boolean))];
    meta.designImages = cleanedImages;
    return `${prefix}${JSON.stringify(meta)}`;
  } catch {
    return notes;
  }
};

/** Force referring-doctor name inside __META__ notes (doctor portal cannot spoof). */
function forceDoctorNameInNotes(notes, doctorFullName) {
  const prefix = '__META__\n';
  const name = String(doctorFullName || '').trim();
  let meta = {};
  if (notes && typeof notes === 'string' && notes.startsWith(prefix)) {
    try {
      meta = JSON.parse(notes.slice(prefix.length)) || {};
    } catch {
      meta = {};
    }
  }
  meta.doctor = name;
  meta.requesterType = 'doctor';
  return `${prefix}${JSON.stringify(meta)}`;
}

/** Force lab account name into notes meta (lab portal cannot spoof). */
function forceLabNameInNotes(notes, labFullName) {
  const prefix = '__META__\n';
  const name = String(labFullName || '').trim();
  let meta = {};
  if (notes && typeof notes === 'string' && notes.startsWith(prefix)) {
    try {
      meta = JSON.parse(notes.slice(prefix.length)) || {};
    } catch {
      meta = {};
    }
  }
  meta.labName = name;
  meta.requesterType = 'lab';
  // Keep referring doctor if already set; only fall back to lab name when missing
  if (!String(meta.doctor || meta.doctorName || '').trim()) {
    meta.doctor = name;
  }
  return `${prefix}${JSON.stringify(meta)}`;
}

function normalizeDoctorKey(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function referringDoctorFromNotes(notes) {
  const meta = parseNotesMeta(notes || '');
  return String(meta.doctor || meta.doctorName || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function caseBelongsToDoctor(doc, doctorFullName) {
  const want = normalizeDoctorKey(doctorFullName);
  if (!want) return false;
  const fromField = normalizeDoctorKey(doc.referringDoctor);
  if (fromField && fromField === want) return true;
  const meta = parseNotesMeta(doc.notes || '');
  const got = normalizeDoctorKey(meta.doctor || meta.doctorName || '');
  return got === want;
}

// Create a new case
exports.createCase = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    let {
      patientName,
      patientEmail,
      patientPhone,
      requesterType,
      salaryAmount,
      notes,
      caseType,
      priority,
      dueDate,
    } =
      req.body;

    // Doctor / lab accounts: lock referring name to the logged-in user
    if (req.user?.role === 'doctor') {
      notes = forceDoctorNameInNotes(notes, req.user.fullName);
      requesterType = 'doctor';
    } else if (req.user?.role === 'lab') {
      notes = forceLabNameInNotes(notes, req.user.fullName);
      requesterType = 'lab';
    }

    const normalizedRequesterType =
      requesterType === 'student' ? 'student' : requesterType === 'lab' ? 'lab' : 'doctor';
    const isStudentCase = normalizedRequesterType === 'student';
    const notesFinal = notes ?? '';
    const referringDoctor = referringDoctorFromNotes(notesFinal);

    const autoExit =
      req.body.autoExit === true ||
      req.body.autoExit === 'true' ||
      req.body.autoExit === 1 ||
      req.body.autoExit === '1';
    const now = new Date();

    const newCase = new DentalCase({
      patientName,
      patientEmail,
      patientPhone,
      requesterType: normalizedRequesterType,
      salaryAmount: Number.isFinite(Number(salaryAmount)) ? Number(salaryAmount) : 0,
      paymentStatus: isStudentCase ? 'paid' : 'unpaid',
      paidAt: isStudentCase ? new Date() : null,
      paidBy: isStudentCase ? req.user.id : null,
      notes: notesFinal,
      referringDoctor,
      caseType,
      priority,
      dueDate: new Date(dueDate),
      createdBy: req.user.id,
      currentStage: autoExit ? 'exited' : 'waiting',
      status: autoExit ? 'exited' : 'waiting',
      ...(autoExit
        ? {
            stageTimestamps: {
              exited: now,
            },
          }
        : {}),
    });

    let lastSaveError;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        newCase.caseNumber = undefined;
      }
      try {
        await newCase.save();
        lastSaveError = undefined;
        break;
      } catch (err) {
        lastSaveError = err;
        if (err?.code !== 11000) throw err;
      }
    }
    if (lastSaveError) throw lastSaveError;
    await newCase.populate('createdBy', 'fullName email');

    // Create audit log (avoid storing full Mongoose doc in Mixed — circular refs / size)
    await AuditLog.create({
      caseId: newCase._id,
      caseNumber: newCase.caseNumber,
      action: 'created',
      performedBy: req.user.id,
      performedByName: req.user.fullName,
      details: {
        newValue: {
          caseNumber: newCase.caseNumber,
          patientName: newCase.patientName,
          caseType: newCase.caseType,
          autoExit: !!autoExit,
        },
      },
    });

    if (autoExit) {
      await AuditLog.create({
        caseId: newCase._id,
        caseNumber: newCase.caseNumber,
        action: 'exited',
        performedBy: req.user.id,
        performedByName: req.user.fullName,
        details: { reason: 'auto_exit_on_create' },
      });
    }

    // Create notification
    await Notification.create({
      type: 'case_created',
      title: 'New Case Created',
      message: `Case ${newCase.caseNumber} for ${patientName} has been created`,
      caseId: newCase._id,
      caseNumber: newCase.caseNumber,
      relatedUser: req.user.id,
      targetAudience: ['all'],
    });

    emitToAll('case:created', {
      caseId: String(newCase._id),
      caseNumber: newCase.caseNumber,
      patientName: newCase.patientName,
      createdBy: req.user.id,
      timestamp: new Date(),
    });

    res.status(201).json({
      success: true,
      message: 'Case created successfully',
      case: newCase,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to create case',
      error: error.message,
    });
  }
};

// Get all cases with pagination and filtering
exports.getAllCases = async (req, res) => {
  try {
    const { page = 1, limit = 10, stage, status, priority, search } = req.query;

    const filter = {};

    if (stage) filter.currentStage = stage;
    if (status) filter.status = status;
    if (priority) filter.priority = priority;

    if (search) {
      filter.$or = [
        { patientName: { $regex: search, $options: 'i' } },
        { caseNumber: { $regex: search, $options: 'i' } },
        { patientEmail: { $regex: search, $options: 'i' } },
      ];
    }

    // Resolve doctor/lab identity when JWT is present (optional auth on GET /)
    let portalFullName = '';
    let isDoctor = req.user?.role === 'doctor';
    let isLab = req.user?.role === 'lab';
    if (req.user?.userId || req.user?.id) {
      const uid = req.user.id || req.user.userId;
      if (!req.user.fullName || !req.user.role) {
        const u = await User.findById(uid).select('fullName role');
        if (u) {
          req.user.fullName = u.fullName;
          req.user.role = u.role;
          isDoctor = u.role === 'doctor';
          isLab = u.role === 'lab';
        }
      }
      if (isDoctor || isLab) portalFullName = String(req.user.fullName || '').trim();
    }

    // Doctor/lab portal: filter by indexed referringDoctor (+ legacy notes match)
    if ((isDoctor || isLab) && portalFullName) {
      const portalClause = {
        $or: [
          { referringDoctor: new RegExp(`^${escapeRegex(portalFullName)}$`, 'i') },
          {
            $and: [
              {
                $or: [
                  { referringDoctor: { $exists: false } },
                  { referringDoctor: null },
                  { referringDoctor: '' },
                ],
              },
              {
                notes: {
                  $regex: `"(doctor|labName)"\\s*:\\s*"${escapeRegex(portalFullName)}"`,
                  $options: 'i',
                },
              },
            ],
          },
        ],
      };
      if (filter.$or) {
        const searchOr = filter.$or;
        delete filter.$or;
        filter.$and = [{ $or: searchOr }, portalClause];
      } else {
        Object.assign(filter, portalClause);
      }
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    // Cap payload size — clients used to request 3000 and freeze the UI
    const requested = parseInt(limit, 10) || 10;
    const limitNum = Math.min(Math.max(1, requested), 1500);
    const skip = (pageNum - 1) * limitNum;

    const [cases, total] = await Promise.all([
      DentalCase.find(filter)
        .populate('assignedTo', 'fullName email role')
        .populate('createdBy', 'fullName email')
        .select(
          'caseNumber patientName patientEmail patientPhone requesterType notes referringDoctor currentStage status assignedTo createdBy caseType priority dueDate salaryAmount paymentStatus paidAt stageTimestamps createdAt updatedAt'
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      DentalCase.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: cases,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch cases',
      error: error.message,
    });
  }
};

// Financial report rows + summary (admin only)
exports.getFinancialReport = async (req, res) => {
  try {
    // Safe one-time-style heal: only paid cases stuck at salaryAmount=0
    try {
      await repairPaidZeroSalaries({
        DentalCase,
        DoctorPricing,
        CashEntry,
        userId: req.user?.id || null,
      });
    } catch (healErr) {
      console.error('repairPaidZeroSalaries failed:', healErr);
    }

    const { year, month, doctor, paymentStatus } = req.query;

    const filter = { currentStage: 'exited' };
    if (paymentStatus && ['paid', 'unpaid'].includes(String(paymentStatus))) {
      filter.paymentStatus = String(paymentStatus);
    }

    const cases = await DentalCase.find(filter)
      .populate('assignedTo', 'fullName')
      .populate('createdBy', 'fullName')
      .sort({ createdAt: -1 });

    const rows = cases
      .map((doc) => {
        const notesMeta = parseNotesMeta(doc.notes || '');
        const doctorNameRaw =
          notesMeta.doctor ||
          notesMeta.doctorName ||
          (doc.assignedTo && doc.assignedTo.fullName) ||
          'غير محدد';
        const doctorName = String(doctorNameRaw).trim() || 'غير محدد';
        const labName = String(notesMeta.labName || '').trim();
        const requesterRaw = String(
          notesMeta.requesterType || doc.requesterType || 'doctor'
        ).toLowerCase();
        const requesterType =
          requesterRaw === 'lab' ? 'lab' : requesterRaw === 'student' ? 'student' : 'doctor';
        const isLab = requesterType === 'lab' || !!labName;
        // Group/list by lab for lab cases; keep referring doctorName for details
        const accountName = isLab ? labName || doctorName : doctorName;

        const createdAt = doc.createdAt ? new Date(doc.createdAt) : new Date();
        const salaryAmount = Number(doc.salaryAmount || 0);
        const payment = String(doc.paymentStatus || 'unpaid');

        return {
          id: String(doc._id),
          caseNumber: String(doc.caseNumber || ''),
          patientName: String(doc.patientName || ''),
          caseType: String(doc.caseType || 'General'),
          doctorName,
          labName,
          accountName,
          requesterType: isLab ? 'lab' : requesterType,
          assignedTo: doc.assignedTo ? String(doc.assignedTo.fullName || '') : null,
          currentStage: String(doc.currentStage || ''),
          salaryAmount: Number.isFinite(salaryAmount) ? salaryAmount : 0,
          paymentStatus: payment === 'paid' ? 'paid' : 'unpaid',
          paidAt: doc.paidAt || null,
          receivedAt: createdAt,
          receivedDateDisplay: createdAt.toISOString(),
          dueDate: doc.dueDate || null,
          notes: doc.notes || '',
          exitedAt: doc.stageTimestamps?.exited || doc.updatedAt || null,
        };
      })
      .filter((row) => {
        const rowDate = new Date(row.receivedAt);
        if (year && Number(year) !== rowDate.getFullYear()) return false;
        if (month && Number(month) !== rowDate.getMonth() + 1) return false;
        if (doctor) {
          const q = String(doctor).toLowerCase().trim();
          const hay = `${row.accountName} ${row.doctorName} ${row.labName}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

    const summary = rows.reduce(
      (acc, row) => {
        acc.totalCases += 1;
        acc.totalAmount += row.salaryAmount;
        if (row.paymentStatus === 'paid') {
          acc.paidCases += 1;
          acc.paidAmount += row.salaryAmount;
        }
        return acc;
      },
      { totalCases: 0, paidCases: 0, totalAmount: 0, paidAmount: 0 }
    );

    res.status(200).json({
      success: true,
      data: rows,
      summary: {
        ...summary,
        unpaidAmount: summary.totalAmount - summary.paidAmount,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch financial report',
      error: error.message,
    });
  }
};

// Get case by ID
exports.getCaseById = async (req, res) => {
  try {
    const dentalCase = await DentalCase.findById(req.params.id)
      .populate('assignedTo', 'fullName email role phone')
      .populate('createdBy', 'fullName email');

    if (!dentalCase) {
      return res.status(404).json({ message: 'Case not found' });
    }

    dentalCase.notes = sanitizeNotesMetaString(dentalCase.notes);
    res.status(200).json({
      success: true,
      case: dentalCase,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch case',
      error: error.message,
    });
  }
};

// Claim case (Atomic operation)
exports.claimCase = async (req, res) => {
  try {
    const dentalCase = await DentalCase.findById(req.params.id);

    if (!dentalCase) {
      return res.status(404).json({ message: 'Case not found' });
    }

    // Check if already assigned
    if (dentalCase.assignedTo && dentalCase.assignedTo.toString() !== req.user.id) {
      return res.status(400).json({
        message: `Case is already assigned to another user`,
        assignedTo: dentalCase.assignedTo,
      });
    }

    // Assign case
    dentalCase.assignedTo = req.user.id;
    dentalCase.assignedAt = new Date();
    dentalCase.status = 'in_progress';

    await dentalCase.save();
    await dentalCase.populate('assignedTo', 'fullName email role');

    // Create audit log
    await AuditLog.create({
      caseId: dentalCase._id,
      caseNumber: dentalCase.caseNumber,
      action: 'assigned',
      performedBy: req.user.id,
      performedByName: req.user.fullName,
      details: { newValue: req.user.id },
    });

    // Create notification
    await Notification.create({
      type: 'case_assigned',
      title: 'Case Assigned',
      message: `Case ${dentalCase.caseNumber} has been claimed by ${req.user.fullName}`,
      caseId: dentalCase._id,
      caseNumber: dentalCase.caseNumber,
      relatedUser: req.user.id,
      targetAudience: ['all'],
    });

    emitToAll('case:assigned', {
      caseId: String(dentalCase._id),
      caseNumber: dentalCase.caseNumber,
      assignedTo: req.user.id,
      assignedToName: req.user.fullName,
      timestamp: new Date(),
    });

    res.status(200).json({
      success: true,
      message: 'Case claimed successfully',
      case: dentalCase,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to claim case',
      error: error.message,
    });
  }
};

// Admin assign case
exports.assignCase = async (req, res) => {
  try {
    const { userId } = req.body;

    const dentalCase = await DentalCase.findById(req.params.id);

    if (!dentalCase) {
      return res.status(404).json({ message: 'Case not found' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const oldAssignee = dentalCase.assignedTo;

    dentalCase.assignedTo = userId;
    dentalCase.assignedAt = new Date();
    dentalCase.status = 'in_progress';

    await dentalCase.save();
    await dentalCase.populate('assignedTo', 'fullName email role');

    // Create audit log
    await AuditLog.create({
      caseId: dentalCase._id,
      caseNumber: dentalCase.caseNumber,
      action: oldAssignee ? 'reassigned' : 'assigned',
      performedBy: req.user.id,
      performedByName: req.user.fullName,
      details: { oldValue: oldAssignee, newValue: userId },
    });

    // Create notification
    await Notification.create({
      type: oldAssignee ? 'case_reassigned' : 'case_assigned',
      title: oldAssignee ? 'Case Reassigned' : 'Case Assigned',
      message: `Case ${dentalCase.caseNumber} has been assigned to ${user.fullName}`,
      caseId: dentalCase._id,
      caseNumber: dentalCase.caseNumber,
      relatedUser: userId,
      targetUsers: [userId],
      targetAudience: ['all'],
    });

    emitToAll(oldAssignee ? 'case:reassigned' : 'case:assigned', {
      caseId: String(dentalCase._id),
      caseNumber: dentalCase.caseNumber,
      oldAssignee: oldAssignee ? String(oldAssignee) : null,
      newAssignee: userId,
      assignedTo: userId,
      assignedToName: user.fullName,
      timestamp: new Date(),
    });

    res.status(200).json({
      success: true,
      message: 'Case assigned successfully',
      case: dentalCase,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to assign case',
      error: error.message,
    });
  }
};

// Move case to next stage
exports.moveStage = async (req, res) => {
  try {
    const { stage } = req.body;

    const validStages = ['waiting', 'secretary', 'design', 'khart', 'finishing', 'completed', 'exited'];

    if (!validStages.includes(stage)) {
      return res.status(400).json({ message: 'Invalid stage' });
    }

    const dentalCase = await DentalCase.findById(req.params.id);

    if (!dentalCase) {
      return res.status(404).json({ message: 'Case not found' });
    }

    const oldStage = dentalCase.currentStage;
    dentalCase.currentStage = stage;

    // Sync status with stage for key transitions
    if (stage === 'completed') {
      dentalCase.status = 'completed';
    } else if (stage === 'exited') {
      dentalCase.status = 'exited';
    } else if (stage === 'waiting') {
      dentalCase.status = 'waiting';
    } else {
      // secretary | design | khart | finishing (reopens completed)
      dentalCase.status = 'in_progress';
    }

    // Update stage timestamp
    if (stage !== 'waiting') {
      dentalCase.stageTimestamps[stage] = new Date();
    }

    await dentalCase.save();

    // Create audit log
    await AuditLog.create({
      caseId: dentalCase._id,
      caseNumber: dentalCase.caseNumber,
      action: 'moved_stage',
      performedBy: req.user.id,
      performedByName: req.user.fullName,
      details: { oldValue: oldStage, newValue: stage },
    });

    // Create notification
    await Notification.create({
      type: 'case_moved',
      title: 'Case Stage Updated',
      message: `Case ${dentalCase.caseNumber} has moved from ${oldStage} to ${stage}`,
      caseId: dentalCase._id,
      caseNumber: dentalCase.caseNumber,
      targetAudience: ['all'],
    });

    emitToAll('case:moved-stage', {
      caseId: String(dentalCase._id),
      caseNumber: dentalCase.caseNumber,
      oldStage,
      newStage: stage,
      timestamp: new Date(),
    });

    res.status(200).json({
      success: true,
      message: 'Case moved to next stage',
      case: dentalCase,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to move case',
      error: error.message,
    });
  }
};

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeScanCode(raw) {
  let code = String(raw || '').trim();
  if (!code) return '';
  // Scanner may send a URL: .../s/CASE-xxx or query ?c=CASE-xxx
  try {
    if (/^https?:\/\//i.test(code)) {
      const u = new URL(code);
      const parts = u.pathname.split('/').filter(Boolean);
      const last = parts[parts.length - 1] || '';
      code = u.searchParams.get('c') || u.searchParams.get('case') || last || code;
    }
  } catch {
    /* keep raw */
  }
  // Strip control chars, bidi marks, Arabic harakat (keyboard-wedge junk)
  code = code
    .replace(/[\r\n\t]+/g, '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .trim();
  return code;
}

/** Pull CASE-YYYY-NNNNN from messy wedge input (Arabic layout → }ٍُِ-2026-00015) */
function extractYearSeq(code) {
  const s = String(code || '');
  // Prefer explicit YEAR-SEQ
  let m = s.match(/(20\d{2})\D+(\d{3,8})/);
  if (m) return { year: m[1], seq: m[2].padStart(5, '0') };
  // Digits only fallback: 202600015
  m = s.replace(/\D/g, '').match(/(20\d{2})(\d{3,8})$/);
  if (m) return { year: m[1], seq: m[2].padStart(5, '0') };
  return null;
}

/** Build lookup candidates — handles Arabic keyboard wedge garbage before the year */
function caseNumberCandidates(raw) {
  const code = normalizeScanCode(raw);
  if (!code) return [];

  const out = new Set();
  const add = (v) => {
    const s = String(v || '').trim();
    if (!s) return;
    out.add(s);
    out.add(s.toUpperCase());
  };

  add(code);

  // Cleaned latin-ish form
  const asciiish = code.replace(/[^A-Za-z0-9\-]/g, '');
  add(asciiish);

  const ys = extractYearSeq(code) || extractYearSeq(asciiish);
  if (ys) {
    add(`CASE-${ys.year}-${ys.seq}`);
    add(`${ys.year}-${ys.seq}`);
  }

  // Prefix like CASE / أ / ا before year-seq
  const prefixed = code.match(/^([A-Za-z\u0600-\u06FF]+)?[-_\s]?(\d{4})[-_\s]?(\d{1,8})$/u);
  if (prefixed) {
    const year = prefixed[2];
    const seqRaw = prefixed[3];
    const seqPad = seqRaw.padStart(5, '0');
    add(`CASE-${year}-${seqPad}`);
    add(`CASE-${year}-${seqRaw}`);
  }

  return [...out];
}

async function findCaseByScanCode(raw) {
  const candidates = caseNumberCandidates(raw);
  if (!candidates.length) return null;

  const or = candidates.map((cn) => ({
    caseNumber: new RegExp(`^${escapeRegex(cn)}$`, 'i'),
  }));

  let dentalCase = await DentalCase.findOne({ $or: or });
  if (dentalCase) return dentalCase;

  // Last resort: YEAR-SEQ → CASE-YYYY-NNNNN
  const ys = extractYearSeq(normalizeScanCode(raw));
  if (ys) {
    dentalCase = await DentalCase.findOne({
      caseNumber: new RegExp(`^CASE-${escapeRegex(ys.year)}-${escapeRegex(ys.seq)}$`, 'i'),
    });
  }
  return dentalCase;
}

const STATION_TARGET = {
  // Scanner accounts: scanner1=reception, scanner2=design, scanner3=finishing
  design: 'design',
  finishing: 'finishing',
  reception: 'completed',
};

const STATION_ALLOWED_FROM = {
  // Any non-exited stage → target station
  design: new Set(['waiting', 'secretary', 'design', 'khart', 'finishing', 'completed']),
  finishing: new Set(['waiting', 'secretary', 'design', 'khart', 'finishing', 'completed']),
  reception: new Set(['waiting', 'secretary', 'design', 'khart', 'finishing', 'completed']),
};

const STATION_LABEL_AR = {
  reception: 'سكان 1 — منتهية',
  design: 'سكان 2 — ديزاين',
  finishing: 'سكان 3 — فينيش',
};

function stationFromUserRole(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'scanner1' || r === 'secretary') return 'reception';
  if (r === 'scanner2') return 'design';
  if (r === 'scanner3') return 'finishing';
  return null;
}

// POST /api/cases/scan — barcode/QR scan; station comes from scanner account role
exports.scanAtStation = async (req, res) => {
  try {
    const scannedRaw = normalizeScanCode(req.body?.caseNumber || req.body?.code || '');
    if (!scannedRaw) {
      return res.status(400).json({ success: false, message: 'رقم الحالة مطلوب' });
    }

    // Prefer station locked to the logged-in scanner/secretary role
    let station = stationFromUserRole(req.user?.role);
    if (!station && ['admin', 'designer', 'finisher'].includes(String(req.user?.role || ''))) {
      station = String(req.body?.station || '')
        .trim()
        .toLowerCase();
    }

    if (!station || !STATION_TARGET[station]) {
      return res.status(400).json({
        success: false,
        message: 'حساب السكان غير معروف أو المحطة غير صحيحة',
      });
    }

    const dentalCase = await findCaseByScanCode(scannedRaw);

    if (!dentalCase) {
      return res.status(404).json({
        success: false,
        message: `لم يتم العثور على حالة برقم: ${scannedRaw}`,
      });
    }

    const oldStage = String(dentalCase.currentStage || 'waiting');
    const targetStage = STATION_TARGET[station];

    if (oldStage === 'exited') {
      return res.status(400).json({
        success: false,
        message: 'الحالة خارجة بالفعل ولا يمكن نقلها',
        case: {
          id: dentalCase._id,
          caseNumber: dentalCase.caseNumber,
          patientName: dentalCase.patientName,
          currentStage: oldStage,
        },
      });
    }

    // Already at target → acknowledge without error (re-scan OK)
    if (oldStage === targetStage) {
      return res.status(200).json({
        success: true,
        alreadyAtStage: true,
        message: `الحالة ${dentalCase.caseNumber} موجودة بالفعل في ${STATION_LABEL_AR[station]}`,
        case: {
          id: dentalCase._id,
          caseNumber: dentalCase.caseNumber,
          patientName: dentalCase.patientName,
          currentStage: oldStage,
          caseType: dentalCase.caseType,
        },
      });
    }

    if (!STATION_ALLOWED_FROM[station].has(oldStage)) {
      return res.status(400).json({
        success: false,
        message: `لا يمكن نقل الحالة من «${oldStage}» إلى محطة ${STATION_LABEL_AR[station]}`,
        case: {
          id: dentalCase._id,
          caseNumber: dentalCase.caseNumber,
          patientName: dentalCase.patientName,
          currentStage: oldStage,
        },
      });
    }

    dentalCase.currentStage = targetStage;
    // Keep status in sync with stage — otherwise completed cases stay "منتهية" in the UI
    // even after سكان 2/3 moves them back to design/finishing.
    if (targetStage === 'completed') {
      dentalCase.status = 'completed';
    } else if (targetStage === 'exited') {
      dentalCase.status = 'exited';
    } else if (targetStage === 'waiting') {
      dentalCase.status = 'waiting';
    } else {
      // secretary | design | khart | finishing (reopens completed)
      dentalCase.status = 'in_progress';
    }
    if (targetStage !== 'waiting') {
      if (!dentalCase.stageTimestamps) dentalCase.stageTimestamps = {};
      dentalCase.stageTimestamps[targetStage] = new Date();
      dentalCase.markModified('stageTimestamps');
    }

    await dentalCase.save();

    try {
      await AuditLog.create({
        caseId: dentalCase._id,
        caseNumber: dentalCase.caseNumber,
        action: 'moved_stage',
        performedBy: req.user.id,
        performedByName: req.user.fullName,
        details: {
          oldValue: oldStage,
          newValue: targetStage,
          notes: `station-scan:${station}`,
        },
      });
    } catch (auditErr) {
      console.error('scanAtStation audit log failed:', auditErr.message);
    }

    try {
      await Notification.create({
        type: 'case_moved',
        title: 'Station Scan',
        message: `Case ${dentalCase.caseNumber} scanned at ${station}: ${oldStage} → ${targetStage}`,
        caseId: dentalCase._id,
        caseNumber: dentalCase.caseNumber,
        targetAudience: ['all'],
      });
    } catch (notifErr) {
      console.error('scanAtStation notification failed:', notifErr.message);
    }

    emitToAll('case:moved-stage', {
      caseId: String(dentalCase._id),
      caseNumber: dentalCase.caseNumber,
      oldStage,
      newStage: targetStage,
      station,
      timestamp: new Date(),
    });
    emitCaseUpdated(dentalCase, req.user);

    return res.status(200).json({
      success: true,
      message: `تم نقل ${dentalCase.caseNumber} إلى ${STATION_LABEL_AR[station]}`,
      case: {
        id: dentalCase._id,
        caseNumber: dentalCase.caseNumber,
        patientName: dentalCase.patientName,
        currentStage: targetStage,
        previousStage: oldStage,
        caseType: dentalCase.caseType,
      },
    });
  } catch (error) {
    console.error('scanAtStation failed:', error);
    return res.status(500).json({
      success: false,
      message: 'فشل مسح الحالة',
      error: error.message,
    });
  }
};

// Complete case
exports.completeCase = async (req, res) => {
  try {
    const dentalCase = await DentalCase.findById(req.params.id);

    if (!dentalCase) {
      return res.status(404).json({ message: 'Case not found' });
    }

    dentalCase.status = 'completed';
    dentalCase.currentStage = 'completed';
    dentalCase.stageTimestamps.completed = new Date();

    await dentalCase.save();

    // Create audit log
    await AuditLog.create({
      caseId: dentalCase._id,
      caseNumber: dentalCase.caseNumber,
      action: 'completed',
      performedBy: req.user.id,
      performedByName: req.user.fullName,
    });

    // Create notification
    await Notification.create({
      type: 'case_completed',
      title: 'Case Completed',
      message: `Case ${dentalCase.caseNumber} has been completed`,
      caseId: dentalCase._id,
      caseNumber: dentalCase.caseNumber,
      targetAudience: ['all'],
    });

    emitToAll('case:completed', {
      caseId: String(dentalCase._id),
      caseNumber: dentalCase.caseNumber,
      completedBy: req.user.id,
      timestamp: new Date(),
    });

    res.status(200).json({
      success: true,
      message: 'Case completed successfully',
      case: dentalCase,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to complete case',
      error: error.message,
    });
  }
};

// Send completed case back for revision (secretary/admin)
exports.requestRevision = async (req, res) => {
  try {
    const dentalCase = await DentalCase.findById(req.params.id);

    if (!dentalCase) {
      return res.status(404).json({ message: 'Case not found' });
    }

    if (!['admin', 'secretary'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Only admin or secretary can request revision' });
    }



    const isCompletedCase =
      dentalCase.currentStage === 'completed' || dentalCase.status === 'completed';
    if (!isCompletedCase) {
      return res.status(400).json({ message: 'Revision is only available for completed cases' });
    }

    if (dentalCase.status === 'exited') {
      return res.status(400).json({ message: 'Exited cases cannot be sent for revision' });
    }

    const prefix = '__META__\n';
    const raw = dentalCase.notes || '';
    let meta = parseNotesMeta(raw);
    if (!raw.startsWith(prefix) && raw.trim()) {
      meta = { ...meta, instructions: raw.slice(0, 8000) };
    }
    if (!meta || typeof meta !== 'object') meta = {};

    meta.uiStatusOverride = 'needs-revision';

    const oldStage = dentalCase.currentStage;
    dentalCase.notes = sanitizeNotesMetaString(`${prefix}${JSON.stringify(meta)}`);
    dentalCase.status = 'in_progress';
    dentalCase.currentStage = 'design';
    dentalCase.stageTimestamps.design = new Date();
    await dentalCase.save();

    await AuditLog.create({
      caseId: dentalCase._id,
      caseNumber: dentalCase.caseNumber,
      action: 'reopened',
      performedBy: req.user.id,
      performedByName: req.user.fullName,
      details: { oldValue: oldStage, newValue: 'design', notes: 'needs-revision' },
    });

    await Notification.create({
      type: 'case_moved',
      title: 'Case Needs Revision',
      message: `Case ${dentalCase.caseNumber} was sent back for revision by ${req.user.fullName}`,
      caseId: dentalCase._id,
      caseNumber: dentalCase.caseNumber,
      relatedUser: req.user.id,
      targetAudience: ['all'],
    });

    emitToAll('case:moved-stage', {
      caseId: String(dentalCase._id),
      caseNumber: dentalCase.caseNumber,
      oldStage,
      newStage: dentalCase.currentStage,
      timestamp: new Date(),
    });
    emitCaseUpdated(dentalCase, req.user);

    return res.status(200).json({
      success: true,
      message: 'Case sent for revision successfully',
      case: dentalCase,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to request revision',
      error: error.message,
    });
  }
};

// Exit completed case (secretary/admin)
exports.exitCase = async (req, res) => {
  try {
    const dentalCase = await DentalCase.findById(req.params.id);

    if (!dentalCase) {
      return res.status(404).json({ message: 'Case not found' });
    }

    if (!['admin', 'secretary'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Only admin or secretary can exit cases' });
    }

    if (dentalCase.status === 'exited') {
      return res.status(400).json({ message: 'Case is already exited' });
    }

    dentalCase.status = 'exited';
    dentalCase.currentStage = 'exited';
    dentalCase.stageTimestamps.exited = new Date();
    await dentalCase.save();

    await AuditLog.create({
      caseId: dentalCase._id,
      caseNumber: dentalCase.caseNumber,
      action: 'exited',
      performedBy: req.user.id,
      performedByName: req.user.fullName,
    });

    await Notification.create({
      type: 'case_exited',
      title: 'Case Exited',
      message: `Case ${dentalCase.caseNumber} has been exited by ${req.user.fullName}`,
      caseId: dentalCase._id,
      caseNumber: dentalCase.caseNumber,
      relatedUser: req.user.id,
      targetAudience: ['all'],
    });

    emitToAll('case:exited', {
      caseId: String(dentalCase._id),
      caseNumber: dentalCase.caseNumber,
      exitedBy: req.user.id,
      timestamp: new Date(),
    });
    emitCaseUpdated(dentalCase, req.user);

    return res.status(200).json({
      success: true,
      message: 'Case exited successfully',
      case: dentalCase,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to exit case',
      error: error.message,
    });
  }
};

// Release case
exports.releaseCase = async (req, res) => {
  try {
    const dentalCase = await DentalCase.findById(req.params.id);

    if (!dentalCase) {
      return res.status(404).json({ message: 'Case not found' });
    }

    const oldAssignee = dentalCase.assignedTo;

    dentalCase.assignedTo = null;
    dentalCase.assignedAt = null;
    dentalCase.status = 'waiting';

    await dentalCase.save();

    // Create audit log
    await AuditLog.create({
      caseId: dentalCase._id,
      caseNumber: dentalCase.caseNumber,
      action: 'released',
      performedBy: req.user.id,
      performedByName: req.user.fullName,
      details: { oldValue: oldAssignee },
    });

    // Create notification
    await Notification.create({
      type: 'case_released',
      title: 'Case Released',
      message: `Case ${dentalCase.caseNumber} has been released`,
      caseId: dentalCase._id,
      caseNumber: dentalCase.caseNumber,
      targetAudience: ['all'],
    });

    emitToAll('case:released', {
      caseId: String(dentalCase._id),
      caseNumber: dentalCase.caseNumber,
      releasedBy: req.user.id,
      timestamp: new Date(),
    });

    res.status(200).json({
      success: true,
      message: 'Case released successfully',
      case: dentalCase,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to release case',
      error: error.message,
    });
  }
};

// Update case (secretary: own created, designer/finisher: assigned case, admin: any)
exports.updateCase = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const dentalCase = await DentalCase.findById(req.params.id);

    if (!dentalCase) {
      return res.status(404).json({ message: 'Case not found' });
    }



    if (req.user.role === 'designer') {
      // Allow designer to edit any case; ownership is reassigned automatically on edit.
      const assignedTo = dentalCase.assignedTo ? dentalCase.assignedTo.toString() : null;
      if (!assignedTo || assignedTo !== req.user.id.toString()) {
        dentalCase.assignedTo = req.user.id;
        dentalCase.assignedAt = new Date();
      }
      if (dentalCase.status === 'waiting') {
        dentalCase.status = 'in_progress';
      }
      if (dentalCase.currentStage === 'waiting' || dentalCase.currentStage === 'secretary') {
        dentalCase.currentStage = 'design';
        dentalCase.stageTimestamps.design = new Date();
      }
    }

    if (req.user.role === 'finisher') {
      const assignedTo = dentalCase.assignedTo ? dentalCase.assignedTo.toString() : null;
      if (assignedTo && assignedTo !== req.user.id.toString()) {
        // Allow handover in finishing stage (designer -> finisher).
        if (dentalCase.currentStage !== 'finishing' && dentalCase.currentStage !== 'completed') {
          return res.status(403).json({ message: 'You can only edit cases assigned to you' });
        }
        dentalCase.assignedTo = req.user.id;
        dentalCase.assignedAt = new Date();
      }
      if (!assignedTo) {
        // Auto-claim on first finisher edit only when case is already in finishing stage.
        if (dentalCase.currentStage !== 'finishing' && dentalCase.currentStage !== 'completed') {
          return res.status(403).json({ message: 'Case must be in finishing stage first' });
        }
        dentalCase.assignedTo = req.user.id;
        dentalCase.assignedAt = new Date();
        if (dentalCase.status === 'waiting') {
          dentalCase.status = 'in_progress';
        }
      }
    }

    // Doctor/lab may edit only their own cases before design starts
    // Exception: may set priority (urgent/normal) on their cases at any stage
    if (req.user.role === 'doctor' || req.user.role === 'lab') {
      const meta = parseNotesMeta(dentalCase.notes || '');
      const ownerName = String(
        meta.labName || meta.doctor || meta.doctorName || dentalCase.referringDoctor || ''
      )
        .trim()
        .toLowerCase();
      const me = String(req.user.fullName || '')
        .trim()
        .toLowerCase();
      if (!me || ownerName !== me) {
        return res.status(403).json({ message: 'يمكنك تعديل حالاتك فقط' });
      }

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const providedKeys = Object.keys(body).filter((k) => body[k] !== undefined);
      const priorityOnly =
        providedKeys.length > 0 && providedKeys.every((k) => k === 'priority');

      if (!priorityOnly) {
        const stage = String(dentalCase.currentStage || '');
        if (stage !== 'waiting' && stage !== 'secretary') {
          return res.status(403).json({
            message: 'لا يمكن التعديل بعد دخول الحالة للديزاين',
          });
        }
      }
    }

    const {
      patientName,
      patientEmail,
      patientPhone,
      requesterType,
      salaryAmount,
      notes,
      caseType,
      priority,
      dueDate,
      stageTimestamps,
    } =
      req.body;

    if (patientName !== undefined) dentalCase.patientName = patientName;
    if (patientEmail !== undefined) dentalCase.patientEmail = String(patientEmail).toLowerCase();
    if (patientPhone !== undefined) dentalCase.patientPhone = patientPhone;
    if (requesterType !== undefined) {
      dentalCase.requesterType =
        requesterType === 'student' ? 'student' : requesterType === 'lab' ? 'lab' : 'doctor';
      if (dentalCase.requesterType === 'student') {
        dentalCase.paymentStatus = 'paid';
        dentalCase.paidAt = new Date();
        dentalCase.paidBy = req.user.id;
      }
    }
    if (salaryAmount !== undefined) {
      const parsedSalary = Number(salaryAmount);
      if (!Number.isFinite(parsedSalary) || parsedSalary < 0) {
        return res.status(400).json({ message: 'salaryAmount must be a non-negative number' });
      }
      dentalCase.salaryAmount = parsedSalary;
    }
    if (notes !== undefined) {
      dentalCase.notes = sanitizeNotesMetaString(notes);
      dentalCase.referringDoctor = referringDoctorFromNotes(dentalCase.notes);
    }
    if (caseType !== undefined) dentalCase.caseType = caseType;
    if (priority !== undefined) {
      const allowed = ['low', 'normal', 'high', 'urgent'];
      const p = String(priority);
      if (!allowed.includes(p)) {
        return res.status(400).json({ message: 'Invalid priority' });
      }
      dentalCase.priority = p;
    }
    if (dueDate !== undefined) dentalCase.dueDate = new Date(dueDate);

    if (stageTimestamps !== undefined && typeof stageTimestamps === 'object' && stageTimestamps !== null) {
      if (!dentalCase.stageTimestamps) {
        dentalCase.stageTimestamps = {};
      }
      for (const [key, val] of Object.entries(stageTimestamps)) {
        dentalCase.stageTimestamps[key] = val ? new Date(String(val)) : null;
      }
      dentalCase.markModified('stageTimestamps');
    }

    await dentalCase.save();
    await dentalCase.populate('createdBy', 'fullName email');

    emitCaseUpdated(dentalCase, req.user);

    res.status(200).json({
      success: true,
      message: 'Case updated successfully',
      case: dentalCase,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update case',
      error: error.message,
    });
  }
};

// Update financial data (admin only)
exports.updateCaseFinancials = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const dentalCase = await DentalCase.findById(req.params.id);

    if (!dentalCase) {
      return res.status(404).json({ message: 'Case not found' });
    }

    const { salaryAmount, paymentStatus } = req.body;

    if (salaryAmount !== undefined) {
      const parsedSalary = Number(salaryAmount);
      if (!Number.isFinite(parsedSalary) || parsedSalary < 0) {
        return res.status(400).json({ message: 'salaryAmount must be a non-negative number' });
      }
      dentalCase.salaryAmount = parsedSalary;
    }

    if (paymentStatus !== undefined) {
      if (!['paid', 'unpaid'].includes(paymentStatus)) {
        return res.status(400).json({ message: 'paymentStatus must be paid or unpaid' });
      }

      // Never mark paid without a positive amount — prevents counters showing مدفوع with 0
      if (paymentStatus === 'paid') {
        const amountNow = Number(dentalCase.salaryAmount) || 0;
        if (amountNow <= 0) {
          return res.status(400).json({
            message: 'Cannot mark case as paid without a positive salaryAmount',
          });
        }
      }

      dentalCase.paymentStatus = paymentStatus;
      if (paymentStatus === 'paid') {
        dentalCase.paidAt = new Date();
        dentalCase.paidBy = req.user.id;
      } else {
        dentalCase.paidAt = null;
        dentalCase.paidBy = null;
      }
    }

    const becamePaid = paymentStatus === 'paid';
    const becameUnpaid = paymentStatus === 'unpaid';

    await dentalCase.save();

    try {
      if (becamePaid) {
        const amount = Number(dentalCase.salaryAmount) || 0;
        if (amount > 0) {
          const existing = await CashEntry.findOne({ caseId: dentalCase._id, type: 'income' });
          const account =
            String(dentalCase.referringDoctor || '').trim() ||
            String(dentalCase.patientName || '').trim() ||
            'account';
          const note = 'Case ' + dentalCase.caseNumber + ' — ' + account;
          if (existing) {
            existing.amount = amount;
            existing.date = dentalCase.paidAt || new Date();
            existing.notes = note;
            existing.category = 'case_payment';
            await existing.save();
          } else {
            await CashEntry.create({
              type: 'income',
              amount,
              date: dentalCase.paidAt || new Date(),
              category: 'case_payment',
              notes: note,
              createdBy: req.user?.id || null,
              caseId: dentalCase._id,
            });
          }
        }
      } else if (becameUnpaid) {
        await CashEntry.deleteMany({ caseId: dentalCase._id, type: 'income' });
      }
    } catch (cashErr) {
      console.error('Failed to sync case payment to cash ledger:', cashErr);
    }

    await AuditLog.create({
      caseId: dentalCase._id,
      caseNumber: dentalCase.caseNumber,
      action: 'financial_updated',
      performedBy: req.user.id,
      performedByName: req.user.fullName,
      details: {
        newValue: {
          salaryAmount: dentalCase.salaryAmount,
          paymentStatus: dentalCase.paymentStatus,
        },
      },
    });

    emitCaseUpdated(dentalCase, req.user);

    res.status(200).json({
      success: true,
      message: 'Case financials updated successfully',
      case: dentalCase,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update case financials',
      error: error.message,
    });
  }
};

// Delete case (secretary: only own; admin: any)
exports.deleteCase = async (req, res) => {
  try {
    const dentalCase = await DentalCase.findById(req.params.id);

    if (!dentalCase) {
      return res.status(404).json({ message: 'Case not found' });
    }



    const caseId = String(dentalCase._id);
    const caseNumber = dentalCase.caseNumber;
    await DentalCase.findByIdAndDelete(req.params.id);

    emitToAll('case:deleted', {
      caseId,
      caseNumber,
      timestamp: new Date(),
    });

    res.status(200).json({
      success: true,
      message: 'Case deleted successfully',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to delete case',
      error: error.message,
    });
  }
};

// Reopen case
exports.reopenCase = async (req, res) => {
  try {
    const dentalCase = await DentalCase.findById(req.params.id);

    if (!dentalCase) {
      return res.status(404).json({ message: 'Case not found' });
    }

    const oldStage = dentalCase.currentStage;
    dentalCase.status = 'in_progress';
    dentalCase.currentStage = 'design'; // Default to design stage

    await dentalCase.save();

    // Create audit log
    await AuditLog.create({
      caseId: dentalCase._id,
      caseNumber: dentalCase.caseNumber,
      action: 'reopened',
      performedBy: req.user.id,
      performedByName: req.user.fullName,
    });

    emitToAll('case:moved-stage', {
      caseId: String(dentalCase._id),
      caseNumber: dentalCase.caseNumber,
      oldStage,
      newStage: dentalCase.currentStage,
      timestamp: new Date(),
    });
    emitCaseUpdated(dentalCase, req.user);

    res.status(200).json({
      success: true,
      message: 'Case reopened successfully',
      case: dentalCase,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to reopen case',
      error: error.message,
    });
  }
};

// Upload PLY scan (secretary / admin) — path stored in notes meta
exports.uploadCasePly = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No .ply file uploaded' });
    }

    const dentalCase = await DentalCase.findById(req.params.id);
    if (!dentalCase) {
      return res.status(404).json({ message: 'Case not found' });
    }



    const prefix = '__META__\n';
    const raw = dentalCase.notes || '';
    let meta = parseNotesMeta(raw);
    if (!raw.startsWith(prefix) && raw.trim()) {
      meta = { ...meta, instructions: raw.slice(0, 8000) };
    }
    if (!meta || typeof meta !== 'object') meta = {};

    meta.plyScanPath = `/uploads/cases/${req.file.filename}`;
    meta.plyFileName = String(req.file.originalname || req.file.filename || '').slice(0, 280);

    dentalCase.notes = sanitizeNotesMetaString(`${prefix}${JSON.stringify(meta)}`);
    await dentalCase.save();

    emitCaseUpdated(dentalCase, req.user);

    return res.status(201).json({
      success: true,
      message: 'PLY file uploaded successfully',
      plyUrl: meta.plyScanPath,
      plyFileName: meta.plyFileName,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to upload PLY file',
      error: error.message,
    });
  }
};

// Upload case design image (designer / finisher)
exports.uploadCaseImage = async (req, res) => {
  try {
    const dentalCase = await DentalCase.findById(req.params.id);
    if (!dentalCase) {
      return res.status(404).json({ message: 'Case not found' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No image file uploaded' });
    }

    if (!['designer', 'finisher', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied for image upload' });
    }

    const assignedTo = dentalCase.assignedTo ? dentalCase.assignedTo.toString() : null;
    if (
      req.user.role !== 'admin' &&
      assignedTo &&
      assignedTo !== req.user.id.toString() &&
      !['finishing', 'completed'].includes(dentalCase.currentStage)
    ) {
      return res.status(403).json({ message: 'Case is assigned to another user' });
    }

    const imageUrl = `/uploads/cases/${req.file.filename}`;

    emitCaseUpdated(dentalCase, req.user);

    return res.status(201).json({
      success: true,
      message: 'Image uploaded successfully',
      imageUrl,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to upload image',
      error: error.message,
    });
  }
};
