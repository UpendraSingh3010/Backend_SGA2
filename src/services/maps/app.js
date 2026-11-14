/**
 * Geolocation Service - geocoding (address -> coordinates), reverse geocoding,
 * nearby-vehicle search (MongoDB $geoNear on a 2dsphere index) and GeoJSON
 * output for the map UI. Routes are mounted at /api/maps/*.
 */
const express = require('express');
const createServiceApp = require('../../shared/createServiceApp');
const { Vehicle } = require('../../shared/models');
const { HttpError } = require('../../shared/errors');
const { authenticateOrInternal } = require('../../shared/auth');
const { parseLatLng, toPoint } = require('../../shared/geo');
const geocoder = require('./geocoder');

const MAX_RADIUS_KM = 500;

async function geocodeOrThrow(address) {
  if (!address || !String(address).trim()) {
    throw new HttpError(400, 'address query parameter is required', { code: 'VALIDATION_ERROR' });
  }
  const result = await geocoder.geocode(String(address).trim());
  if (!result) {
    throw new HttpError(404, `No coordinates found for address '${address}'`, {
      code: 'ADDRESS_NOT_FOUND',
    });
  }
  return result;
}

function parseRadius(raw) {
  const radiusKm = raw === undefined ? 5 : Number(raw);
  if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > MAX_RADIUS_KM) {
    throw new HttpError(400, `radiusKm must be a number greater than 0 and at most ${MAX_RADIUS_KM}`, {
      code: 'INVALID_RADIUS',
    });
  }
  return radiusKm;
}

function createMapsApp() {
  const router = express.Router();
  const auth = authenticateOrInternal(); // any logged-in role, or an internal service

  // Address -> coordinates
  router.get('/api/maps/geocode', auth, async (req, res) => {
    const result = await geocodeOrThrow(req.query.address);
    res.json({ address: req.query.address, ...result });
  });

  // Coordinates -> address
  router.get('/api/maps/reverse', auth, async (req, res) => {
    const { lat, lng } = parseLatLng(req.query.lat, req.query.lng, { required: true });
    const result = await geocoder.reverse(lat, lng);
    if (!result) throw new HttpError(404, 'No address found for these coordinates');
    res.json(result);
  });

  /**
   * Vehicles within radiusKm of a point, nearest first.
   * Centre is either ?lat=&lng= or ?address= (geocoded first).
   */
  router.get('/api/maps/nearby', auth, async (req, res) => {
    const radiusKm = parseRadius(req.query.radiusKm);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);

    let center = parseLatLng(req.query.lat, req.query.lng);
    let centerSource = 'coordinates';
    let resolvedAddress;
    if (!center) {
      if (!req.query.address) {
        throw new HttpError(400, 'Provide either lat & lng or address', { code: 'VALIDATION_ERROR' });
      }
      const geo = await geocodeOrThrow(req.query.address);
      center = { lat: geo.lat, lng: geo.lng };
      centerSource = 'geocoded';
      resolvedAddress = geo.displayName;
    }

    const query = {};
    if (req.query.status) {
      if (!Vehicle.STATUSES.includes(req.query.status)) {
        throw new HttpError(400, `status must be one of: ${Vehicle.STATUSES.join(', ')}`, {
          code: 'VALIDATION_ERROR',
        });
      }
      query.status = req.query.status;
    }

    const docs = await Vehicle.aggregate([
      {
        $geoNear: {
          near: toPoint(center.lat, center.lng),
          distanceField: 'distanceMeters',
          maxDistance: radiusKm * 1000,
          spherical: true,
          query,
        },
      },
      { $limit: limit },
    ]);

    const vehicles = docs.map((doc) => ({
      ...Vehicle.hydrate(doc).toJSON(),
      distanceKm: Math.round(doc.distanceMeters) / 1000,
    }));

    res.json({
      center: { ...center, source: centerSource, ...(resolvedAddress && { address: resolvedAddress }) },
      radiusKm,
      count: vehicles.length,
      vehicles,
    });
  });

  // All vehicle positions as a GeoJSON FeatureCollection (for Leaflet / any map)
  router.get('/api/maps/vehicles', auth, async (req, res) => {
    const filter = { location: { $exists: true } };
    if (req.query.status) filter.status = req.query.status;
    const vehicles = await Vehicle.find(filter);
    res.json({
      type: 'FeatureCollection',
      features: vehicles.map((v) => ({
        type: 'Feature',
        geometry: v.location,
        properties: {
          id: String(v._id),
          registrationNumber: v.registrationNumber,
          make: v.make,
          model: v.model,
          type: v.type,
          status: v.status,
          lastSeenAt: v.lastSeenAt,
          locationSource: v.locationSource,
        },
      })),
    });
  });

  return createServiceApp('maps', router);
}

module.exports = { createMapsApp };
