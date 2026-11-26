const mongoose = require('mongoose');

const ALL_STAGES = [
  'waiting',
  'secretary',
  'design',
  'khart',
  'finishing',
  'completed',
  'exited',
];

const appSettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'app',
    },
    /** White-label branding for this lab deployment */
    branding: {
      labName: { type: String, default: 'OCCLA Dental Lab' },
      logoUrl: { type: String, default: '' },
      primaryColor: { type: String, default: '#2563eb' },
    },
    /** Which workflow stages this lab uses (order preserved from ALL_STAGES) */
    workflow: {
      enabledStages: {
        type: [String],
        default: ALL_STAGES,
      },
      allowSkipSecretary: { type: Boolean, default: true },
      allowSkipKhart: { type: Boolean, default: true },
    },
    whatsapp: {
      enabled: { type: Boolean, default: false },
      provider: {
        type: String,
        enum: ['', 'ultramsg', 'meta', 'waweb'],
        default: 'ultramsg',
      },
      token: { type: String, default: '' },
      instanceId: { type: String, default: '' },
      phoneNumberId: { type: String, default: '' },
      dailyHour: { type: Number, default: 18 },
      labName: { type: String, default: 'OCCLA Dental Lab' },
      msgCompleted: {
        type: String,
        default:
          '{lab}\nحالة ({patient})\n{workType} — {quantity} قطعة\nجاهزة للاستلام تواصل مع المعمل لاستلام الحالة',
      },
      msgExited: {
        type: String,
        default:
          '{lab}\nحالة ({patient})\n{workType} — {quantity} قطعة\nتم التسليم / خرجت من المعمل',
      },
      msgDaily: {
        type: String,
        default: '{lab} — ملخص يومي\nعندك {count} حالات جاهزة للاستلام.\n{list}',
      },
      /** Comma-separated phones for lab admin alerts (low stock, etc.) */
      alertPhones: { type: String, default: '' },
    },
  },
  { timestamps: true }
);

const AppSettings = mongoose.model('AppSettings', appSettingsSchema);
AppSettings.ALL_STAGES = ALL_STAGES;
module.exports = AppSettings;
