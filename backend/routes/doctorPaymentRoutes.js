const express = require('express');
const router = express.Router();
const doctorPaymentController = require('../controllers/doctorPaymentController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);
router.use(authorize('admin')); // Only admin can record or view payments

router.get('/', doctorPaymentController.getAllPayments);
router.post('/', doctorPaymentController.addPayment);
router.delete('/:id', doctorPaymentController.deletePayment);

module.exports = router;
