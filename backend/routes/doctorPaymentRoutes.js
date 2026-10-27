const express = require('express');
const router = express.Router();
const doctorPaymentController = require('../controllers/doctorPaymentController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);
router.use(authorize('admin', 'secretary'));

router.get('/', authorize('admin'), doctorPaymentController.getAllPayments);
router.post('/', doctorPaymentController.addPayment);
router.delete('/:id', authorize('admin'), doctorPaymentController.deletePayment);

module.exports = router;
