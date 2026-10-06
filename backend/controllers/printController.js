const PrintJob = require('../models/PrintJob');
const DentalCase = require('../models/DentalCase');
const { getIO, getPrintAgentStatus } = require('../services/socketService');

const META_PREFIX = '__META__\n';

function buildNotesFromPrintData(printData) {
  const meta = {
    requesterType: 'doctor',
    doctor: String(printData.doctor || '').trim(),
    branch: String(printData.branch || '').trim(),
    workDetail: String(printData.workDetail || '').trim(),
    color: String(printData.color || '').trim(),
    quantity: printData.quantity ?? 1,
    receivedDate: new Date().toISOString().slice(0, 10),
  };
  return `${META_PREFIX}${JSON.stringify(meta)}`;
}

/** Create a DB case when print job has no case number (authenticated flows). */
async function ensureCaseNumberForPrint(printData, reqUser) {
  const existing = String(printData.caseNumber || '').trim();
  if (existing) return printData;

  const uid = reqUser?.id || reqUser?.userId;
  if (!uid) return printData;

  const newCase = new DentalCase({
    patientName: String(printData.patient || '').trim() || 'غير محدد',
    patientEmail: `case+${Date.now()}@mylab.com`,
    patientPhone: '0000000000',
    requesterType: 'doctor',
    notes: buildNotesFromPrintData(printData),
    referringDoctor: String(printData.doctor || '').trim(),
    caseType: String(printData.workType || '').trim() || '—',
    priority: printData.urgent ? 'urgent' : 'normal',
    dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    createdBy: uid,
    currentStage: 'waiting',
    status: 'waiting',
  });

  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) newCase.caseNumber = undefined;
    try {
      await newCase.save();
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      if (err?.code !== 11000) throw err;
    }
  }
  if (lastError) throw lastError;

  return { ...printData, caseNumber: newCase.caseNumber };
}

// POST /api/print/job  — create a new print job and push to Print Agent
exports.createPrintJob = async (req, res) => {
  try {
    const { printData } = req.body;

    if (!printData || !printData.doctor || !printData.patient) {
      return res.status(400).json({ success: false, message: 'بيانات ناقصة' });
    }

    // Doctor portal: lock printed doctor name to account fullName
    let data = { ...printData };
    if (req.user?.userId || req.user?.id) {
      const uid = req.user.id || req.user.userId;
      const User = require('../models/User');
      const u = await User.findById(uid).select('fullName role');
      if (u?.role === 'doctor') {
        data = { ...data, doctor: String(u.fullName || '').trim() };
      }
    }

    data = await ensureCaseNumberForPrint(data, req.user);

    const job = await PrintJob.create({
      printData: data,
      status: 'pending',
      createdBy: req.user?.userId || req.user?.id || null,
    });

    // Emit to the Print Agent via Socket.IO room 'print-agents'
    const io = getIO();
    if (io) {
      io.to('print-agents').emit('print:new-job', {
        jobId: job._id,
        printData: job.printData,
      });
      // Also broadcast to entry screens so they see the new job in real-time
      io.emit('print:job-created', {
        _id: job._id,
        jobId: job._id,
        printData: job.printData,
        status: job.status,
        createdAt: job.createdAt,
      });
    }

    return res.status(201).json({
      success: true,
      message: 'تم إرسال الريكويست للطباعة',
      jobId: job._id,
    });
  } catch (err) {
    console.error('createPrintJob error:', err);
    return res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
};

/** Apply agent status update with anti-downgrade / anti-double-print guards */
async function applyAgentJobStatus(jobId, status, errorMessage = '') {
  const validStatuses = ['pending', 'printing', 'done', 'failed'];
  if (!validStatuses.includes(status)) {
    return { ok: false, code: 400, message: 'status غير صحيح' };
  }

  const job = await PrintJob.findById(jobId);
  if (!job) {
    return { ok: false, code: 404, message: 'الجوب مش موجود' };
  }

  // Human already confirmed paper — never let agent reopen/reprint via status churn
  if (job.status === 'done' && job.paperConfirmed === 'yes') {
    return { ok: true, skipped: true, job, reason: 'already-confirmed' };
  }

  // Never downgrade a successful print back to pending/printing/failed (stale catch-up reports)
  if (job.status === 'done' && status !== 'done') {
    return { ok: true, skipped: true, job, reason: 'refuse-downgrade-from-done' };
  }

  job.status = status;
  job.errorMessage = errorMessage || '';

  if (status === 'done') {
    // Keep human confirmation if already yes; otherwise await confirmation
    if (job.paperConfirmed !== 'yes') job.paperConfirmed = 'pending';
  } else if (status === 'failed') {
    job.paperConfirmed = 'no';
  } else if (status === 'printing' || status === 'pending') {
    if (job.paperConfirmed !== 'yes') job.paperConfirmed = 'pending';
  }

  await job.save();
  return { ok: true, skipped: false, job };
}

exports.applyAgentJobStatus = applyAgentJobStatus;

// PATCH /api/print/job/:id/status  — called by Print Agent to update status
exports.updateJobStatus = async (req, res) => {
  try {
    const { status, errorMessage } = req.body;
    const result = await applyAgentJobStatus(req.params.id, status, errorMessage || '');

    if (!result.ok) {
      return res.status(result.code).json({ success: false, message: result.message });
    }

    const job = result.job;
    if (!result.skipped) {
      const io = getIO();
      if (io) {
        io.emit('print:job-status-updated', {
          jobId: job._id,
          status: job.status,
          paperConfirmed: job.paperConfirmed,
          errorMessage: job.errorMessage,
        });
      }
    }

    return res.json({ success: true, skipped: Boolean(result.skipped), job });
  } catch (err) {
    console.error('updateJobStatus error:', err);
    return res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
};

// PATCH /api/print/job/:id/confirm — human confirm paper actually came out
exports.confirmPaper = async (req, res) => {
  try {
    const confirmed = req.body?.confirmed;
    if (typeof confirmed !== 'boolean') {
      return res.status(400).json({ success: false, message: 'confirmed يجب أن يكون true أو false' });
    }

    const job = await PrintJob.findById(req.params.id);
    if (!job) {
      return res.status(404).json({ success: false, message: 'الجوب مش موجود' });
    }

    if (confirmed) {
      if (job.status !== 'done' && job.status !== 'printing') {
        return res.status(400).json({
          success: false,
          message: 'التأكيد متاح فقط بعد ما النظام يبلّغ إن الطباعة اكتملت',
        });
      }
      job.status = 'done';
      job.paperConfirmed = 'yes';
      job.errorMessage = '';
    } else {
      job.status = 'failed';
      job.paperConfirmed = 'no';
      job.errorMessage = 'تم التأكيد يدويًا أن الورقة لم تُطبع';
    }

    await job.save();

    const io = getIO();
    if (io) {
      io.emit('print:job-status-updated', {
        jobId: job._id,
        status: job.status,
        paperConfirmed: job.paperConfirmed,
        errorMessage: job.errorMessage,
      });
    }

    return res.json({
      success: true,
      message: confirmed ? 'تم تأكيد خروج الورقة' : 'تم تسجيل أن الورقة لم تُطبع',
      job,
    });
  } catch (err) {
    console.error('confirmPaper error:', err);
    return res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
};

// GET /api/print/jobs — list recent jobs (admin use)
exports.listJobs = async (req, res) => {
  try {
    const jobs = await PrintJob.find()
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('createdBy', 'name role');

    return res.json({ success: true, jobs });
  } catch (err) {
    console.error('listJobs error:', err);
    return res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
};

// GET /api/print/jobs/pending — Print Agent catch-up (agent secret required)
exports.listPendingJobs = async (req, res) => {
  try {
    // Include failed + stuck "printing" so catch-up works after sleep / kill.
    // Never include human-confirmed prints (prevents accidental reprints).
    const jobs = await PrintJob.find({
      status: { $in: ['pending', 'failed', 'printing'] },
      paperConfirmed: { $ne: 'yes' },
    })
      .sort({ createdAt: 1 })
      .limit(100);

    return res.json({
      success: true,
      jobs: jobs.map(j => ({
        jobId: j._id,
        printData: j.printData,
        status: j.status,
        createdAt: j.createdAt,
      })),
    });
  } catch (err) {
    console.error('listPendingJobs error:', err);
    return res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
};

/** Start of calendar day in Africa/Cairo (entry screen "today"). */
function startOfTodayCairo() {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(`${ymd}T00:00:00+03:00`);
}

// GET /api/print/jobs/today — entry screen: jobs from today only (TTL deletes after 24h)
exports.listTodayJobs = async (req, res) => {
  try {
    const since = startOfTodayCairo();

    const jobs = await PrintJob.find({
      createdAt: { $gte: since },
    }).sort({ createdAt: 1 });

    return res.json({ success: true, jobs });
  } catch (err) {
    console.error('listTodayJobs error:', err);
    return res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
};

// DELETE /api/print/job/:id — delete a single job
exports.deletePrintJob = async (req, res) => {
  try {
    const job = await PrintJob.findByIdAndDelete(req.params.id);
    if (!job) {
      return res.status(404).json({ success: false, message: 'الريكويست غير موجود' });
    }
    const io = getIO();
    if (io) {
      io.emit('print:job-deleted', { jobId: req.params.id });
    }
    return res.json({ success: true, message: 'تم حذف الريكويست' });
  } catch (err) {
    console.error('deletePrintJob error:', err);
    return res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
};

// DELETE /api/print/jobs/all — clear all jobs
exports.clearAllJobs = async (req, res) => {
  try {
    await PrintJob.deleteMany({});
    const io = getIO();
    if (io) {
      io.emit('print:all-jobs-cleared');
    }
    return res.json({ success: true, message: 'تم مسح جميع الريكويستات' });
  } catch (err) {
    console.error('clearAllJobs error:', err);
    return res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
};

// GET /api/print/agent-status — staff: is a Print Agent connected right now?
exports.getAgentStatus = async (req, res) => {
  try {
    const status = getPrintAgentStatus();
    return res.json({
      success: true,
      online: status.online,
      agentCount: status.agentCount,
      connectedAt: status.connectedAt,
    });
  } catch (err) {
    console.error('getAgentStatus error:', err);
    return res.status(500).json({ success: false, message: 'خطأ في السيرفر' });
  }
};
