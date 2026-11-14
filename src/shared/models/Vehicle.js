const mongoose = require('mongoose');
const toJSON = require('./toJSON');
const pointSchema = require('./pointSchema');
const { fromPoint } = require('../geo');

const VEHICLE_STATUSES = ['active', 'idle', 'maintenance', 'out_of_service', 'emergency'];
const VEHICLE_TYPES = ['car', 'van', 'truck', 'bus', 'motorcycle', 'other'];

const statusChangeSchema = new mongoose.Schema(
  {
    from: String,
    to: String,
    reason: String,
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const vehicleSchema = new mongoose.Schema(
  {
    registrationNumber: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      match: [/^[A-Z0-9-]{4,15}$/, 'registrationNumber must be 4-15 letters, digits or hyphens'],
    },
    make: { type: String, required: true, trim: true },
    model: { type: String, required: true, trim: true },
    year: { type: Number, min: 1980, max: new Date().getFullYear() + 1 },
    type: { type: String, enum: VEHICLE_TYPES, default: 'truck' },
    status: { type: String, enum: VEHICLE_STATUSES, default: 'idle', index: true },
    statusHistory: { type: [statusChangeSchema], default: [] },

    // Address of the vehicle's depot / registered location (geocoded if no GPS yet)
    address: { type: String, trim: true },
    // Current position (GeoJSON). Updated by telemetry GPS fixes.
    location: { type: pointSchema, default: undefined },
    locationSource: { type: String, enum: ['gps', 'geocoded', 'manual'] },
    lastSeenAt: Date,
    lastTelemetry: {
      speedKmh: Number,
      batteryLevel: Number,
      fuelLevel: Number,
      engineTempC: Number,
      recordedAt: Date,
    },

    assignedDriver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// 2dsphere index powers the "vehicles within X km" geospatial query
vehicleSchema.index({ location: '2dsphere' });

vehicleSchema.plugin(toJSON, {
  extra: (v) => ({ ...v, position: fromPoint(v.location) }),
});

vehicleSchema.statics.STATUSES = VEHICLE_STATUSES;
vehicleSchema.statics.TYPES = VEHICLE_TYPES;

module.exports = mongoose.models.Vehicle || mongoose.model('Vehicle', vehicleSchema);
