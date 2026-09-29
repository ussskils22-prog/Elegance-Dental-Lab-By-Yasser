const express = require('express');
const router = express.Router();
const doctorChargeController = require('../controllers/doctorChargeController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);
router.use(authorize('admin'));

router.get('/', doctorChargeController.getAllCharges);
router.post('/', doctorChargeController.addCharge);
router.delete('/:id', doctorChargeController.deleteCharge);

module.exports = router;
