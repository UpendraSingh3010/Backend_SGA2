/** Small helpers for working with GeoJSON points and lat/lng input. */
const { HttpError } = require('./errors');

function toPoint(lat, lng) {
  // GeoJSON order is [longitude, latitude]
  return { type: 'Point', coordinates: [Number(lng), Number(lat)] };
}

function fromPoint(point) {
  if (!point || !Array.isArray(point.coordinates) || point.coordinates.length !== 2) return null;
  return { lat: point.coordinates[1], lng: point.coordinates[0] };
}

function isValidLatLng(lat, lng) {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

/**
 * Parses lat/lng from raw input (query string or body). Returns null if both
 * are absent; throws 400 if present but invalid.
 */
function parseLatLng(rawLat, rawLng, { required = false } = {}) {
  const missing = (v) => v === undefined || v === null || v === '';
  if (missing(rawLat) && missing(rawLng)) {
    if (required) throw new HttpError(400, 'latitude and longitude are required', { code: 'VALIDATION_ERROR' });
    return null;
  }
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (missing(rawLat) || missing(rawLng) || !isValidLatLng(lat, lng)) {
    throw new HttpError(
      400,
      'Invalid coordinates: latitude must be between -90 and 90 and longitude between -180 and 180',
      { code: 'INVALID_COORDINATES' }
    );
  }
  return { lat, lng };
}

module.exports = { toPoint, fromPoint, isValidLatLng, parseLatLng };
