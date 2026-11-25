const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticate, authorize } = require('../middleware/auth');
const c = require('../controllers/stationController');

const router = express.Router();

// A 6-digit code must not be guessable: only a few tries per IP
const pairLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

router.post('/pair', pairLimiter, c.pair);
router.post('/session', c.session);

router.post('/pair-codes', authenticate, authorize('admin'), c.createPairCode);
router.get('/', authenticate, authorize('admin'), c.list);
router.post('/:id/revoke', authenticate, authorize('admin'), c.revoke);

module.exports = router;
