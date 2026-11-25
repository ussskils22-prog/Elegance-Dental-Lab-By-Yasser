const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const printController = require('../controllers/printController');

const { verifyToken } = require('../config/jwt');
const rateLimit = require('express-rate-limit');

/** Print agent: the shared PRINT_AGENT_SECRET (old installs) or its own paired device token. */
async function agentSecret(req, res, next) {
  const secret = req.headers['x-agent-secret'];
  if (secret && process.env.PRINT_AGENT_SECRET && secret === process.env.PRINT_AGENT_SECRET) return next();
  const deviceToken = req.headers['x-device-token'];
  if (deviceToken) {
    try {
      const { verifyDeviceToken } = require('../services/stationDevices');
      const device = await verifyDeviceToken(deviceToken);
      if (device && device.kind === 'print') {
        req.stationDevice = device;
        return next();
      }
    } catch (_) {
      /* fall through */
    }
  }
  return res.status(401).json({ success: false, message: 'غير مصرح' });
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
/**
 * The public requester desk may send print jobs without logging in. Cap anonymous
 * jobs so nobody on the internet can flood the lab printer. Logged-in users are not limited here.
 */
const anonymousPrintLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => Boolean(req.user),
  message: { success: false, message: 'طلبات طباعة كتير من غير تسجيل دخول — حاول بعد شوية أو سجّل دخول' },
});
router.post('/job', optionalAuth, anonymousPrintLimiter, printController.createPrintJob);

// Print Agent updates job status (AGENT_SECRET)
router.patch('/job/:id/status', agentSecret, printController.updateJobStatus);

// Atomic claim — prevents two agents printing the same job
router.post('/job/:id/claim', agentSecret, printController.claimPrintJob);

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

// Lab-wide printing pause switch (stops every agent on every PC from claiming jobs)
router.get(
  '/paused',
  authenticate,
  authorize('admin', 'secretary', 'finisher', 'designer'),
  printController.getPaused
);
router.put('/paused', authenticate, authorize('admin', 'secretary'), printController.setPaused);

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
