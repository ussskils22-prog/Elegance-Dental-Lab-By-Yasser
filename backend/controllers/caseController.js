const DentalCase = require('../models/DentalCase');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { validationResult } = require('express-validator');
const { emitToAll } = require('../services/socketService');

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

// Create a new case
exports.createCase = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
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
    } =
      req.body;

    const normalizedRequesterType = requesterType === 'student' ? 'student' : 'doctor';
    const isStudentCase = normalizedRequesterType === 'student';

    const newCase = new DentalCase({
      patientName,
      patientEmail,
      patientPhone,
      requesterType: normalizedRequesterType,
      salaryAmount: Number.isFinite(Number(salaryAmount)) ? Number(salaryAmount) : 0,
      paymentStatus: isStudentCase ? 'paid' : 'unpaid',
      paidAt: isStudentCase ? new Date() : null,
      paidBy: isStudentCase ? req.user.id : null,
      notes: notes ?? '',
      caseType,
      priority,
      dueDate: new Date(dueDate),
      createdBy: req.user.id,
      currentStage: 'waiting',
      status: 'waiting',
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
        },
      },
    });

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

    const skip = (page - 1) * limit;

    const cases = await DentalCase.find(filter)
      .populate('assignedTo', 'fullName email role')
      .populate('createdBy', 'fullName email')
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ createdAt: -1 });
    cases.forEach((c) => {
      c.notes = sanitizeNotesMetaString(c.notes);
    });

    const total = await DentalCase.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: cases,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit),
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
    const { year, month, doctor, paymentStatus } = req.query;

    const filter = { currentStage: { $in: ['completed', 'exited'] } };
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

        const createdAt = doc.createdAt ? new Date(doc.createdAt) : new Date();
        const salaryAmount = Number(doc.salaryAmount || 0);
        const payment = String(doc.paymentStatus || 'unpaid');

        return {
          id: String(doc._id),
          caseNumber: String(doc.caseNumber || ''),
          patientName: String(doc.patientName || ''),
          caseType: String(doc.caseType || 'General'),
          doctorName,
          assignedTo: doc.assignedTo ? String(doc.assignedTo.fullName || '') : null,
          currentStage: String(doc.currentStage || ''),
          salaryAmount: Number.isFinite(salaryAmount) ? salaryAmount : 0,
          paymentStatus: payment === 'paid' ? 'paid' : 'unpaid',
          paidAt: doc.paidAt || null,
          receivedAt: createdAt,
          receivedDateDisplay: createdAt.toISOString(),
          dueDate: doc.dueDate || null,
        };
      })
      .filter((row) => {
        const rowDate = new Date(row.receivedAt);
        if (year && Number(year) !== rowDate.getFullYear()) return false;
        if (month && Number(month) !== rowDate.getMonth() + 1) return false;
        if (doctor && !row.doctorName.toLowerCase().includes(String(doctor).toLowerCase().trim()))
          return false;
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
    } =
      req.body;

    if (patientName !== undefined) dentalCase.patientName = patientName;
    if (patientEmail !== undefined) dentalCase.patientEmail = String(patientEmail).toLowerCase();
    if (patientPhone !== undefined) dentalCase.patientPhone = patientPhone;
    if (requesterType !== undefined) {
      dentalCase.requesterType = requesterType === 'student' ? 'student' : 'doctor';
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
    if (notes !== undefined) dentalCase.notes = sanitizeNotesMetaString(notes);
    if (caseType !== undefined) dentalCase.caseType = caseType;
    if (priority !== undefined) dentalCase.priority = priority;
    if (dueDate !== undefined) dentalCase.dueDate = new Date(dueDate);

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

      dentalCase.paymentStatus = paymentStatus;
      if (paymentStatus === 'paid') {
        dentalCase.paidAt = new Date();
        dentalCase.paidBy = req.user.id;
      } else {
        dentalCase.paidAt = null;
        dentalCase.paidBy = null;
      }
    }

    await dentalCase.save();

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
