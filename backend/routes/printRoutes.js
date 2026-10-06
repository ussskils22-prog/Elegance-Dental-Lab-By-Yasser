const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const printController = require('../controllers/printController');

const { verifyToken } = require('../config/jwt');

function agentSecret(req, res, next) {
  const secret = req.headers['x-agent-secret'];
  if (!secret || secret !== process.env.PRINT_AGENT_SECRET) {
    return res.status(401).json({ success: false, message: 'غير مصرح' });
  }
  next();
}

/** Attach JWT user when present (optional) — used only for create from public/requester flows. */
function optionalAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (token) {
    try {
      const decoded = verifyToken(token);
      if (decoded) req.user = { userId: decoded.userId, role: decoded.role };
    } catch (e) {
      /* ignore */
    }
  }
  next();
}

// Create print job — optional auth (requester desk / logged-in staff)
router.post('/job', optionalAuth, printController.createPrintJob);

// Print Agent updates job status (AGENT_SECRET)
router.patch('/job/:id/status', agentSecret, printController.updateJobStatus);

// Entry screen: confirm paper printed — must be logged in
router.patch(
  '/job/:id/confirm',
  authenticate,
  authorize('admin', 'secretary', 'finisher', 'designer'),
  printController.confirmPaper
);

// List recent jobs — admin only
router.get('/jobs', authenticate, authorize('admin'), printController.listJobs);

// Pending jobs for Print Agent catch-up
router.get('/jobs/pending', agentSecret, printController.listPendingJobs);

// Today's jobs for entry screen — authenticated staff only
router.get(
  '/jobs/today',
  authenticate,
  authorize('admin', 'secretary', 'finisher', 'designer'),
  printController.listTodayJobs
);

// Live Print Agent connection status (Windows service / agent.js)
router.get(
  '/agent-status',
  authenticate,
  authorize('admin', 'secretary', 'finisher', 'designer'),
  printController.getAgentStatus
);

// Destructive deletes — admin (or secretary) only
router.delete(
  '/job/:id',
  authenticate,
  authorize('admin', 'secretary'),
  printController.deletePrintJob
);

router.delete(
  '/jobs/all',
  authenticate,
  authorize('admin'),
  printController.clearAllJobs
);

module.exports = router;
