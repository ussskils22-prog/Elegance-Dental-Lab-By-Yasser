const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        'case_created',
        'case_assigned',
        'case_reassigned',
        'case_moved',
        'case_completed',
        'case_released',
        'case_exited',
        'patient_update',
        'patient_removed',
      ],
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    caseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DentalCase',
    },
    caseNumber: {
      type: String,
    },
    relatedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
    read: {
      type: Boolean,
      default: false,
      index: true,
    },
    targetAudience: {
      type: [mongoose.Schema.Types.Mixed],
      default: ['all'],
    },
    targetUsers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
  },
  { timestamps: false }
);

module.exports = mongoose.model('Notification', notificationSchema);
