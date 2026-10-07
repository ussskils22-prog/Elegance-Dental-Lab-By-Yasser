const mongoose = require('mongoose');

const printJobSchema = new mongoose.Schema(
  {
    printData: {
      doctor:     { type: String, required: true },
      patient:    { type: String, required: true },
      branch:     { type: String, default: '' },
      caseType:   { type: String, default: '' },
      workType:   { type: String, default: '' },
      workDetail: { type: String, default: '' },
      color:      { type: String, default: '' },
      quantity:   { type: Number, default: 0 },
      caseNumber: { type: String, default: '' },
      printDate:  { type: String, default: '' },
      intakeType: { type: String, enum: ['', 'impression', 'scan'], default: '' },
      /** FDI tooth chart selections for print sheet highlighting */
      teeth: [
        {
          fdi: { type: String, required: true },
          material: { type: String, required: true },
          groupId: { type: String, required: true },
        },
      ],
    },
    status: {
      type: String,
      enum: ['pending', 'printing', 'done', 'failed'],
      default: 'pending',
    },
    /** Human paper confirmation on entry screen: pending | yes | no */
    paperConfirmed: {
      type: String,
      enum: ['pending', 'yes', 'no'],
      default: 'pending',
    },
    /** Atomic single-agent claim — prevents two agents printing the same job */
    claimedBy: { type: String, default: '' },
    claimedAt: { type: Date, default: null },
    errorMessage: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

/** Auto-delete jobs older than 1 day (Mongo TTL). Keep in sync with listTodayJobs. */
const PRINT_JOB_TTL_SECONDS = 24 * 60 * 60; // 86400
printJobSchema.index({ createdAt: 1 }, { expireAfterSeconds: PRINT_JOB_TTL_SECONDS });

const PrintJob = mongoose.model('PrintJob', printJobSchema);

/**
 * MongoDB does not update expireAfterSeconds when the schema changes.
 * Drop/recreate the TTL index if an old 7d (or other) value is still active.
 */
PrintJob.ensurePrintJobTtlIndex = async function ensurePrintJobTtlIndex() {
  const wanted = PRINT_JOB_TTL_SECONDS;
  try {
    const indexes = await PrintJob.collection.indexes();
    const ttl = indexes.find(
      (idx) => idx.key && idx.key.createdAt === 1 && typeof idx.expireAfterSeconds === 'number'
    );
    if (ttl && ttl.expireAfterSeconds !== wanted) {
      await PrintJob.collection.dropIndex(ttl.name);
      await PrintJob.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: wanted });
      console.log(`PrintJob TTL index updated: ${ttl.expireAfterSeconds}s → ${wanted}s (1 day)`);
    } else if (!ttl) {
      await PrintJob.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: wanted });
      console.log(`PrintJob TTL index created: ${wanted}s (1 day)`);
    }
  } catch (err) {
    console.warn('PrintJob TTL index sync skipped:', err.message);
  }
};

module.exports = PrintJob;
