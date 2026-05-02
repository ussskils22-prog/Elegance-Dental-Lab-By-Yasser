const express = require('express');
const auditController = require('../controllers/auditController');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();

// All audit routes require authentication and admin role
router.use(authenticate);
router.use(authorize('admin'));

// Get all audit logs
router.get('/', auditController.getAllAuditLogs);

// Get audit logs for a specific case
router.get('/case/:caseId', auditController.getCaseAuditLogs);

module.exports = router;
