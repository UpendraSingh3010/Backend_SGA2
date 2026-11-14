/**
 * Central configuration. Every value can be overridden through environment
 * variables (see .env.example). Sensible defaults let the project run locally
 * without any setup.
 */
require('dotenv').config();

const env = process.env;

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const list = (value, fallback) =>
  (value || fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

module.exports = {
  env: env.NODE_ENV || 'development',

  mongoUri: env.MONGODB_URI || '',

  jwt: {
    secret: env.JWT_SECRET || 'dev-only-jwt-secret-change-me',
    expiresIn: env.JWT_EXPIRES_IN || '1h',
    issuer: 'fleet-users-service',
  },

  // Shared secret used for service-to-service calls (never exposed to clients;
  // the gateway strips this header from incoming requests).
  internalKey: env.INTERNAL_SERVICE_KEY || 'dev-only-internal-key',

  gateway: {
    apiKeys: list(env.API_KEYS, 'dev-api-key-123'),
    rateLimit: {
      windowMs: toInt(env.RATE_LIMIT_WINDOW_MS, 60_000),
      max: toInt(env.RATE_LIMIT_MAX, 100),
    },
    proxyTimeoutMs: toInt(env.PROXY_TIMEOUT_MS, 10_000),
  },

  ports: {
    gateway: toInt(env.PORT || env.GATEWAY_PORT, 8080),
    users: toInt(env.USER_SERVICE_PORT, 4001),
    vehicles: toInt(env.VEHICLE_SERVICE_PORT, 4002),
    telemetry: toInt(env.TELEMETRY_SERVICE_PORT, 4003),
    maps: toInt(env.MAPS_SERVICE_PORT, 4004),
    notifications: toInt(env.NOTIFICATION_SERVICE_PORT, 4005),
  },

  geo: {
    // 'nominatim' = real OpenStreetMap geocoding, 'mock' = offline dictionary
    provider: env.GEO_PROVIDER || 'nominatim',
    nominatimUrl: env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org',
    // Nominatim's usage policy requires an identifying User-Agent.
    userAgent: env.NOMINATIM_USER_AGENT || 'FleetManagementSystem/1.0 (educational project)',
  },

  sms: {
    // 'stub' = custom mock SMS provider, 'twilio' = Twilio REST API (sandbox/trial)
    provider: env.SMS_PROVIDER || 'stub',
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID || '',
      authToken: env.TWILIO_AUTH_TOKEN || '',
      from: env.TWILIO_FROM_NUMBER || '',
    },
  },

  // Thresholds used to auto-detect critical events from raw telemetry
  thresholds: {
    lowBatteryPercent: toInt(env.LOW_BATTERY_THRESHOLD, 15),
    engineOverheatC: toInt(env.ENGINE_OVERHEAT_THRESHOLD, 110),
  },
};
