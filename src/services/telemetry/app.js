/**
 * Telemetry Service - receives GPS + sensor readings from vehicles, stores
 * them, updates the vehicle's current position, detects critical events and
 * asks the Notification Service to alert fleet administrators.
 * Routes are mounted at /api/telemetry/*.
 */
const express = require('express');
const mongoose = require('mongoose');
const createServiceApp = require('../../shared/createServiceApp');
const { Vehicle, Telemetry } = require('../../shared/models');
const { HttpError } = require('../../shared/errors');
const { ROLES, authenticate } = require('../../shared/auth');
const { parseLatLng, toPoint } = require('../../shared/geo');
const { callService } = require('../../shared/serviceClient');
const config = require('../../config');

function assertVehicleAccess(user, vehicle) {
  if (user.role === ROLES.DRIVER && String(vehicle.assignedDriver) !== user.id) {
    throw new HttpError(403, 'Drivers can only access telemetry for their assigned vehicle', {
      code: 'INSUFFICIENT_ROLE',
    });
  }
}

async function loadVehicle(id) {
  if (!id || !mongoose.isValidObjectId(id)) {
    throw new HttpError(400, 'vehicleId must be a valid vehicle id', { code: 'VALIDATION_ERROR' });
  }
  const vehicle = await Vehicle.findById(id);
  if (!vehicle) throw new HttpError(404, 'Vehicle not found', { code: 'VEHICLE_NOT_FOUND' });
  return vehicle;
}

/** Explicitly reported events + events derived from sensor thresholds. */
function detectCriticalEvents(body) {
  const reported = [].concat(body.events || [], body.event || []).filter(Boolean);
  const invalid = reported.filter((e) => !Telemetry.CRITICAL_EVENTS.includes(e));
  if (invalid.length) {
    throw new HttpError(400, `Unknown event(s): ${invalid.join(', ')}. Allowed: ${Telemetry.CRITICAL_EVENTS.join(', ')}`, {
      code: 'VALIDATION_ERROR',
    });
  }
  const events = new Set(reported);
  const { lowBatteryPercent, engineOverheatC } = config.thresholds;
  if (body.batteryLevel !== undefined && Number(body.batteryLevel) < lowBatteryPercent) events.add('low_battery');
  if (body.engineTempC !== undefined && Number(body.engineTempC) > engineOverheatC) events.add('engine_fault');
  if (body.faultCode) events.add('engine_fault');
  return [...events];
}

function createTelemetryApp() {
  const router = express.Router();
  router.use('/api/telemetry', authenticate);

  // Submit a telemetry reading (GPS fix + sensors)
  router.post('/api/telemetry', async (req, res) => {
    const body = req.body || {};
    const vehicle = await loadVehicle(body.vehicleId);
    assertVehicleAccess(req.user, vehicle);

    const coords = parseLatLng(body.latitude, body.longitude, { required: true });
    const events = detectCriticalEvents(body);
    const recordedAt = body.recordedAt ? new Date(body.recordedAt) : new Date();
    if (Number.isNaN(recordedAt.getTime())) {
      throw new HttpError(400, 'recordedAt must be an ISO-8601 date', { code: 'VALIDATION_ERROR' });
    }

    const telemetry = await Telemetry.create({
      vehicle: vehicle._id,
      registrationNumber: vehicle.registrationNumber,
      recordedAt,
      location: toPoint(coords.lat, coords.lng),
      speedKmh: body.speedKmh,
      heading: body.heading,
      batteryLevel: body.batteryLevel,
      fuelLevel: body.fuelLevel,
      engineTempC: body.engineTempC,
      odometerKm: body.odometerKm,
      faultCode: body.faultCode,
      events,
      submittedBy: req.user.id,
    });

    // Store the GPS position on the vehicle (ignore out-of-order old readings)
    if (!vehicle.lastSeenAt || recordedAt >= vehicle.lastSeenAt) {
      vehicle.location = telemetry.location;
      vehicle.locationSource = 'gps';
      vehicle.lastSeenAt = recordedAt;
      vehicle.lastTelemetry = {
        speedKmh: body.speedKmh,
        batteryLevel: body.batteryLevel,
        fuelLevel: body.fuelLevel,
        engineTempC: body.engineTempC,
        recordedAt,
      };
      await vehicle.save();
    }

    let notification = { triggered: false };
    if (events.length) {
      try {
        const { ok, data } = await callService('notifications', '/api/notifications/events', {
          method: 'POST',
          requestId: req.get('x-request-id'),
          body: {
            type: 'critical_event',
            vehicleId: vehicle.id,
            events,
            details: {
              location: telemetry.location,
              batteryLevel: body.batteryLevel,
              engineTempC: body.engineTempC,
              faultCode: body.faultCode,
              recordedAt,
            },
          },
        });
        notification = ok
          ? { triggered: data.triggered, total: data.total, sent: data.sent, failed: data.failed }
          : { triggered: false, error: data && data.error ? data.error.message : 'Notification failed' };
      } catch (err) {
        // Telemetry is still stored even if notifications are down
        notification = { triggered: false, error: err.message };
      }
    }

    res.status(201).json({ telemetry, criticalEvents: events, notification });
  });

  // Recent critical events across the fleet
  router.get('/api/telemetry/events', async (req, res) => {
    const filter = { 'events.0': { $exists: true } };
    if (req.query.event) filter.events = req.query.event;
    if (req.query.vehicleId) {
      const vehicle = await loadVehicle(req.query.vehicleId);
      assertVehicleAccess(req.user, vehicle);
      filter.vehicle = vehicle._id;
    } else if (req.user.role === ROLES.DRIVER) {
      throw new HttpError(403, 'Drivers must specify their vehicleId', { code: 'INSUFFICIENT_ROLE' });
    }
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
    const data = await Telemetry.find(filter).sort({ recordedAt: -1 }).limit(limit);
    res.json({ data, count: data.length });
  });

  // Telemetry history for a vehicle
  router.get('/api/telemetry/vehicles/:vehicleId', async (req, res) => {
    const vehicle = await loadVehicle(req.params.vehicleId);
    assertVehicleAccess(req.user, vehicle);

    const filter = { vehicle: vehicle._id };
    if (req.query.from || req.query.to) {
      filter.recordedAt = {};
      if (req.query.from) filter.recordedAt.$gte = new Date(req.query.from);
      if (req.query.to) filter.recordedAt.$lte = new Date(req.query.to);
    }
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 500);
    const data = await Telemetry.find(filter).sort({ recordedAt: -1 }).limit(limit);
    res.json({ vehicleId: vehicle.id, registrationNumber: vehicle.registrationNumber, count: data.length, data });
  });

  // Latest reading for a vehicle
  router.get('/api/telemetry/vehicles/:vehicleId/latest', async (req, res) => {
    const vehicle = await loadVehicle(req.params.vehicleId);
    assertVehicleAccess(req.user, vehicle);
    const telemetry = await Telemetry.findOne({ vehicle: vehicle._id }).sort({ recordedAt: -1 });
    if (!telemetry) throw new HttpError(404, 'No telemetry recorded for this vehicle yet');
    res.json({ telemetry });
  });

  return createServiceApp('telemetry', router);
}

module.exports = { createTelemetryApp, detectCriticalEvents };
