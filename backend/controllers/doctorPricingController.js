const DoctorPricing = require('../models/DoctorPricing');

exports.getAllPricings = async (req, res) => {
  try {
    const pricings = await DoctorPricing.find();
    res.status(200).json({ success: true, data: pricings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updatePricing = async (req, res) => {
  try {
    const { doctorName, prices } = req.body;
    if (!doctorName) {
      return res.status(400).json({ success: false, message: 'doctorName is required' });
    }

    const normalizedName = doctorName.trim();

    let pricing = await DoctorPricing.findOne({ doctorName: normalizedName });
    if (pricing) {
      pricing.prices = { ...pricing.prices, ...prices };
      await pricing.save();
    } else {
      pricing = await DoctorPricing.create({
        doctorName: normalizedName,
        prices
      });
    }

    res.status(200).json({ success: true, data: pricing });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
