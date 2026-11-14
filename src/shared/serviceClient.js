/**
 * Service-to-service HTTP client (e.g. Vehicle Service -> Geolocation Service,
 * Telemetry Service -> Notification Service). Calls are authenticated with the
 * shared internal key, not a user JWT.
 */
const config = require('../config');
const registry = require('./registry');
const { HttpError } = require('./errors');

async function callService(service, path, { method = 'GET', body, requestId, timeoutMs = 8000 } = {}) {
  const url = `${registry.get(service)}${path}`;
  const headers = { 'content-type': 'application/json', 'x-internal-key': config.internalKey };
  if (requestId) headers['x-request-id'] = requestId;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new HttpError(503, `${service} service is unavailable`, {
      code: 'SERVICE_UNAVAILABLE',
      details: { service, reason: (err.cause && err.cause.code) || err.name },
    });
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, ok: res.ok, data };
}

module.exports = { callService };
