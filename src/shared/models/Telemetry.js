const mongoose = require('mongoose');
const toJSON = require('./toJSON');
const pointSchema = require('./pointSchema');
const { fromPoint } = require('../geo');

const CRITICAL_EVENTS = ['engine_fault', 'low_battery', 'emergency_stop'];

const telemetrySchema = new mongoose.Schema(
  {
    vehicle: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true },
    registrationNumber: String,
    recordedAt: { type: Date, default: Date.now },
    location: { type: pointSchema, required: true },
    speedKmh: { type: Number, min: 0, max: 300 },
    heading: { type: Number, min: 0, max: 360 },
    batteryLevel: { type: Number, min: 0, max: 100 },
    fuelLevel: { type: Number, min: 0, max: 100 },
    engineTempC: { type: Number, min: -50, max: 200 },
    odometerKm: { type: Number, min: 0 },
    faultCode: String,
    // Critical events reported by the vehicle or detected from sensor thresholds
    events: { type: [{ type: String, enum: CRITICAL_EVENTS }], default: [] },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: 'receivedAt', updatedAt: false } }
);

telemetrySchema.index({ vehicle: 1, recordedAt: -1 });
telemetrySchema.index({ events: 1 });

telemetrySchema.plugin(toJSON, {
  extra: (t) => ({ ...t, position: fromPoint(t.location) }),
});

telemetrySchema.statics.CRITICAL_EVENTS = CRITICAL_EVENTS;

module.exports = mongoose.models.Telemetry || mongoose.model('Telemetry', telemetrySchema);
