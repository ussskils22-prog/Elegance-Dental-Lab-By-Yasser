const mongoose = require('mongoose');

const dentalCaseSchema = new mongoose.Schema(
  {
    caseNumber: {
      type: String,
      unique: true,
      index: true,
      // Not `required`: value is assigned in `pre('validate')` before save.
    },
    patientName: {
      type: String,
      required: [true, 'Patient name is required'],
      trim: true,
    },
    patientEmail: {
      type: String,
      required: [true, 'Patient email is required'],
      lowercase: true,
    },
    patientPhone: {
      type: String,
      required: [true, 'Patient phone is required'],
    },
    requesterType: {
      type: String,
      enum: ['doctor', 'student', 'lab'],
      default: 'doctor',
      index: true,
    },
    notes: {
      type: String,
      default: '',
    },
    /** Clinic referring doctor (indexed) — mirrors notes meta.doctor for fast list filters */
    referringDoctor: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },

    // Workflow
    currentStage: {
      type: String,
      enum: ['waiting', 'secretary', 'design', 'khart', 'finishing', 'completed', 'exited'],
      default: 'waiting',
      index: true,
    },
    status: {
      type: String,
      enum: ['waiting', 'in_progress', 'completed', 'exited'],
      default: 'waiting',
      index: true,
    },

    // Assignment
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    assignedAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    // Priority & Type
    caseType: {
      type: String,
      required: [true, 'Case type is required'],
      trim: true,
    },
    priority: {
      type: String,
      enum: ['low', 'normal', 'high', 'urgent'],
      default: 'normal',
      index: true,
    },
    dueDate: {
      type: Date,
      required: [true, 'Due date is required'],
    },
    salaryAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    paymentStatus: {
      type: String,
      enum: ['unpaid', 'paid'],
      default: 'unpaid',
      index: true,
    },
    paidAt: {
      type: Date,
      default: null,
    },
    paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    /** Billing period for reports (carry-forward). When set, reports filter by this instead of exitedAt. */
    billingYear: {
      type: Number,
      default: null,
      index: true,
    },
    billingMonth: {
      type: Number,
      default: null,
      min: 1,
      max: 12,
      index: true,
    },

    // Timestamps for each stage
    stageTimestamps: {
      secretary: Date,
      design: Date,
      khart: Date,
      finishing: Date,
      completed: Date,
      exited: Date,
    },
  },
  { timestamps: true }
);

// Assign unique case number before save (avoid countDocuments+1: races, deletes, and dup keys).
dentalCaseSchema.pre('validate', async function (next) {
  try {
    if (!this.caseNumber || String(this.caseNumber).trim() === '') {
      const Model = this.constructor;
      const year = new Date().getFullYear();
      const prefix = `CASE-${year}-`;
      const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const lastDoc = await Model.findOne({ caseNumber: new RegExp(`^${esc}\\d{5}$`) })
        .sort({ caseNumber: -1 })
        .select('caseNumber')
        .lean();

      let seq = 1;
      if (lastDoc?.caseNumber && lastDoc.caseNumber.startsWith(prefix)) {
        const tail = lastDoc.caseNumber.slice(prefix.length);
        seq = (parseInt(tail, 10) || 0) + 1;
      }

      let candidate = `${prefix}${String(seq).padStart(5, '0')}`;
      let guard = 0;
      while (guard < 200 && (await Model.exists({ caseNumber: candidate }))) {
        seq += 1;
        candidate = `${prefix}${String(seq).padStart(5, '0')}`;
        guard += 1;
      }
      if (guard >= 200) {
        return next(new Error('Could not assign a unique caseNumber'));
      }
      this.caseNumber = candidate;
    }
    next();
  } catch (err) {
    next(err);
  }
});

dentalCaseSchema.pre('save', function (next) {
  if (!this.caseNumber || String(this.caseNumber).trim() === '') {
    return next(new Error('caseNumber was not generated'));
  }
  if (this.requesterType === 'student') {
    this.paymentStatus = 'paid';
    if (!this.paidAt) {
      this.paidAt = new Date();
    }
  }
  next();
});

dentalCaseSchema.index({ createdAt: -1 });
dentalCaseSchema.index({ currentStage: 1, createdAt: -1 });
dentalCaseSchema.index({ referringDoctor: 1, createdAt: -1 });

module.exports = mongoose.model('DentalCase', dentalCaseSchema);
