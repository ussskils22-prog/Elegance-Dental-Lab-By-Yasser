const AuditLog = require('../models/AuditLog');

// Get all audit logs with pagination
exports.getAllAuditLogs = async (req, res) => {
  try {
    const { page = 1, limit = 20, caseId, action, userId } = req.query;

    const filter = {};

    if (caseId) filter.caseId = caseId;
    if (action) filter.action = action;
    if (userId) filter.performedBy = userId;

    const skip = (page - 1) * limit;

    const logs = await AuditLog.find(filter)
      .populate('performedBy', 'fullName email role')
      .populate('caseId', 'caseNumber patientName')
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ timestamp: -1 });

    const total = await AuditLog.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: logs,
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
      message: 'Failed to fetch audit logs',
      error: error.message,
    });
  }
};

// Get audit logs for a specific case
exports.getCaseAuditLogs = async (req, res) => {
  try {
    const { caseId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    const skip = (page - 1) * limit;

    const logs = await AuditLog.find({ caseId })
      .populate('performedBy', 'fullName email role')
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ timestamp: -1 });

    const total = await AuditLog.countDocuments({ caseId });

    res.status(200).json({
      success: true,
      data: logs,
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
      message: 'Failed to fetch case audit logs',
      error: error.message,
    });
  }
};
