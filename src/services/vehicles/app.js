/**
 * Vehicle / Fleet Service - vehicle registration, retrieval, updates,
 * operational status changes (which trigger SMS notifications) and deletion.
 * Routes are mounted at /api/vehicles/*.
 */
const express = require('express');
const mongoose = require('mongoose');
const createServiceApp = require('../../shared/createServiceApp');
const { Vehicle, User } = require('../../shared/models');
const { HttpError } = require('../../shared/errors');
const { ROLES, authenticate, authorize } = require('../../shared/auth');
const { parseLatLng, toPoint } = require('../../shared/geo');
const { callService } = require('../../shared/serviceClient');

const EDITABLE_FIELDS = ['make', 'model', 'year', 'type', 'address'];

function loadVehicle(id) {
  if (!mongoose.isValidObjectId(id)) {
    throw new HttpError(400, `Invalid vehicle id '${id}'`, { code: 'INVALID_ID' });
  }
  return Vehicle.findById(id).then((v) => {
    if (!v) throw new HttpError(404, 'Vehicle not found', { code: 'VEHICLE_NOT_FOUND' });
    return v;
  });
}

async function resolveDriver(driverId) {
  if (driverId === undefined) return undefined;
  if (driverId === null || driverId === '') return null;
  if (!mongoose.isValidObjectId(driverId)) {
    throw new HttpError(400, 'assignedDriverId must be a valid user id', { code: 'VALIDATION_ERROR' });
  }
  const driver = await User.findById(driverId);
  if (!driver || driver.role !== ROLES.DRIVER) {
    throw new HttpError(400, 'assignedDriverId must reference an existing driver', { code: 'VALIDATION_ERROR' });
  }
  return driver._id;
}

/** Asks the Geolocation Service to geocode an address. Never throws. */
async function geocodeAddress(address, requestId) {
  try {
    const { ok, status, data } = await callService(
      'maps',
      `/api/maps/geocode?address=${encodeURIComponent(address)}`,
      { requestId }
    );
    if (ok) return { success: true, ...data };
    return { success: false, message: (data && data.error && data.error.message) || `HTTP ${status}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Applies coordinates (preferred) or a geocoded address to the vehicle. */
async function applyLocation(vehicle, body, requestId) {
  const coords = parseLatLng(body.latitude, body.longitude);
  if (coords) {
    vehicle.location = toPoint(coords.lat, coords.lng);
    vehicle.locationSource = 'manual';
    return null;
  }
  if (body.address) {
    const geo = await geocodeAddress(body.address, requestId);
    if (geo.success) {
      vehicle.location = toPoint(geo.lat, geo.lng);
      vehicle.locationSource = 'geocoded';
      return { success: true, lat: geo.lat, lng: geo.lng, displayName: geo.displayName, provider: geo.provider };
    }
    return { success: false, message: `Address could not be geocoded: ${geo.message}` };
  }
  return null;
}

function canManageVehicle(user, vehicle) {
  if (user.role === ROLES.ADMIN || user.role === ROLES.FLEET_MANAGER) return true;
  return user.role === ROLES.DRIVER && vehicle.assignedDriver && String(vehicle.assignedDriver) === user.id;
}

function createVehiclesApp() {
  const router = express.Router();
  const staff = [ROLES.ADMIN, ROLES.FLEET_MANAGER];
  router.use('/api/vehicles', authenticate);

  // Register a vehicle
  router.post('/api/vehicles', authorize(...staff), async (req, res) => {
    const body = req.body || {};
    const vehicle = new Vehicle({
      registrationNumber: body.registrationNumber,
      make: body.make,
      model: body.model,
      year: body.year,
      type: body.type,
      address: body.address,
      status: body.status,
      createdBy: req.user.id,
    });
    const driver = await resolveDriver(body.assignedDriverId);
    if (driver) vehicle.assignedDriver = driver;

    await vehicle.validate(); // fail fast before calling the geocoder
    const geocoding = await applyLocation(vehicle, body, req.get('x-request-id'));
    await vehicle.save();
    res.status(201).json({ vehicle, ...(geocoding && { geocoding }) });
  });

  // List vehicles (filters + pagination)
  router.get('/api/vehicles', async (req, res) => {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.type) filter.type = req.query.type;
    if (req.query.search) {
      const rx = new RegExp(req.query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ registrationNumber: rx }, { make: rx }, { model: rx }];
    }
    if (req.user.role === ROLES.DRIVER && req.query.mine === 'true') filter.assignedDriver = req.user.id;

    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const [data, total] = await Promise.all([
      Vehicle.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      Vehicle.countDocuments(filter),
    ]);
    res.json({ data, page, limit, total });
  });

  router.get('/api/vehicles/:id', async (req, res) => {
    const vehicle = await loadVehicle(req.params.id);
    res.json({ vehicle });
  });

  // Update vehicle details (not status - see /status)
  router.patch('/api/vehicles/:id', authorize(...staff), async (req, res) => {
    const vehicle = await loadVehicle(req.params.id);
    const body = req.body || {};
    for (const key of EDITABLE_FIELDS) {
      if (body[key] !== undefined) vehicle[key] = body[key];
    }
    const driver = await resolveDriver(body.assignedDriverId);
    if (driver !== undefined) vehicle.assignedDriver = driver || undefined;

    // Re-geocode only if new coordinates or a new address were supplied
    const locationInput = {
      latitude: body.latitude,
      longitude: body.longitude,
      address: body.address !== undefined ? body.address : undefined,
    };
    const geocoding = await applyLocation(vehicle, locationInput, req.get('x-request-id'));
    await vehicle.save();
    res.json({ vehicle, ...(geocoding && { geocoding }) });
  });

  // Change operational status -> notify relevant users by SMS
  router.patch('/api/vehicles/:id/status', async (req, res) => {
    const vehicle = await loadVehicle(req.params.id);
    if (!canManageVehicle(req.user, vehicle)) {
      throw new HttpError(403, 'Drivers can only update the status of their assigned vehicle', {
        code: 'INSUFFICIENT_ROLE',
      });
    }
    const { status, reason } = req.body || {};
    if (!Vehicle.STATUSES.includes(status)) {
      throw new HttpError(400, `status must be one of: ${Vehicle.STATUSES.join(', ')}`, {
        code: 'VALIDATION_ERROR',
      });
    }

    const previousStatus = vehicle.status;
    if (previousStatus === status) {
      return res.json({ vehicle, statusChanged: false, notification: { triggered: false } });
    }

    vehicle.status = status;
    vehicle.statusHistory.push({ from: previousStatus, to: status, reason, changedBy: req.user.id });
    if (vehicle.statusHistory.length > 50) vehicle.statusHistory.shift();
    await vehicle.save();

    let notification;
    try {
      const { ok, data } = await callService('notifications', '/api/notifications/events', {
        method: 'POST',
        requestId: req.get('x-request-id'),
        body: { type: 'status_change', vehicleId: vehicle.id, previousStatus, newStatus: status, reason },
      });
      notification = ok
        ? { triggered: data.triggered, total: data.total, sent: data.sent, failed: data.failed }
        : { triggered: false, error: data && data.error ? data.error.message : 'Notification failed' };
    } catch (err) {
      // Status change still succeeds if the notification service is down
      notification = { triggered: false, error: err.message };
    }

    return res.json({ vehicle, statusChanged: true, previousStatus, notification });
  });

  // Only admins may delete vehicles (RBAC)
  router.delete('/api/vehicles/:id', authorize(ROLES.ADMIN), async (req, res) => {
    const vehicle = await loadVehicle(req.params.id);
    await vehicle.deleteOne();
    res.status(204).end();
  });

  return createServiceApp('vehicles', router);
}

module.exports = { createVehiclesApp };
