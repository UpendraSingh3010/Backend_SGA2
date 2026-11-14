const mongoose = require('mongoose');
const toJSON = require('./toJSON');

const NOTIFICATION_TYPES = ['critical_event', 'status_change', 'manual'];
const NOTIFICATION_STATUSES = ['pending', 'sent', 'failed'];

const notificationSchema = new mongoose.Schema(
  {
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    channel: { type: String, enum: ['sms'], default: 'sms' },
    recipient: {
      user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      name: String,
      role: String,
      phone: { type: String, required: true },
    },
    vehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle' },
    registrationNumber: String,
    event: String, // e.g. 'engine_fault' or 'active->maintenance'
    message: { type: String, required: true },
    status: { type: String, enum: NOTIFICATION_STATUSES, default: 'pending', index: true },
    provider: String, // 'stub' | 'twilio'
    providerMessageId: String,
    error: String,
    attempts: { type: Number, default: 0 },
    sentAt: Date,
  },
  { timestamps: true }
);

notificationSchema.index({ vehicle: 1, createdAt: -1 });
notificationSchema.plugin(toJSON);

notificationSchema.statics.TYPES = NOTIFICATION_TYPES;
notificationSchema.statics.STATUSES = NOTIFICATION_STATUSES;

module.exports =
  mongoose.models.Notification || mongoose.model('Notification', notificationSchema);
