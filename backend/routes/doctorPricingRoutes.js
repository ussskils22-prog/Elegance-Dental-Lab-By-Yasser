const express = require('express');
const router = express.Router();
const doctorPricingController = require('../controllers/doctorPricingController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate);
router.use(authorize('admin')); // Only admin can edit or view doctor pricing lists

router.get('/', doctorPricingController.getAllPricings);
router.put('/', doctorPricingController.updatePricing);

module.exports = router;
