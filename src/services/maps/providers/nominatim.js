/**
 * OpenStreetMap Nominatim geocoding provider (free, no API key).
 * Usage policy: max ~1 request/second and an identifying User-Agent, so results
 * are cached in memory.
 * https://operations.osmfoundation.org/policies/nominatim/
 */
const config = require('../../../config');
const { HttpError } = require('../../../shared/errors');

const cache = new Map();

async function request(path, params) {
  const url = new URL(path, config.geo.nominatimUrl);
  Object.entries({ format: 'jsonv2', ...params }).forEach(([k, v]) => url.searchParams.set(k, v));

  const key = url.toString();
  if (cache.has(key)) return cache.get(key);

  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': config.geo.userAgent, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    throw new HttpError(502, 'Geocoding provider (OpenStreetMap Nominatim) is unreachable', {
      code: 'GEOCODER_UNAVAILABLE',
      details: { reason: (err.cause && err.cause.code) || err.name },
    });
  }
  if (!res.ok) {
    throw new HttpError(502, `Geocoding provider returned HTTP ${res.status}`, {
      code: 'GEOCODER_ERROR',
    });
  }
  const data = await res.json();
  cache.set(key, data);
  return data;
}

module.exports = {
  name: 'nominatim',

  async geocode(address) {
    const results = await request('/search', { q: address, limit: 1 });
    if (!Array.isArray(results) || results.length === 0) return null;
    const top = results[0];
    return {
      lat: Number(top.lat),
      lng: Number(top.lon),
      displayName: top.display_name,
      provider: 'nominatim',
    };
  },

  async reverse(lat, lng) {
    const result = await request('/reverse', { lat, lon: lng });
    if (!result || result.error) return null;
    return { lat, lng, displayName: result.display_name, provider: 'nominatim' };
  },
};
