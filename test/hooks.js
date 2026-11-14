/**
 * Root hooks (loaded by .mocharc.json before any test file).
 * Spins up the whole system in-process:
 *   in-memory MongoDB  ->  5 backend services on random ports  ->  API Gateway
 * so every test exercises real HTTP routing through the gateway.
 */

// Must be set before any project module reads the config
process.env.NODE_ENV = 'test';
process.env.GEO_PROVIDER = 'mock';
process.env.SMS_PROVIDER = 'stub';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.INTERNAL_SERVICE_KEY = 'test-internal-key';
process.env.API_KEYS = 'test-api-key,second-test-key';

const { connectDB, disconnectDB } = require('../src/shared/db');
const registry = require('../src/shared/registry');
const { createGateway } = require('../src/gateway/app');
const { createUsersApp } = require('../src/services/users/app');
const { createVehiclesApp } = require('../src/services/vehicles/app');
const { createTelemetryApp } = require('../src/services/telemetry/app');
const { createMapsApp } = require('../src/services/maps/app');
const { createNotificationsApp } = require('../src/services/notifications/app');
const ctx = require('./support/context');
const { listen, close } = require('./support/servers');

const SERVICES = {
  users: createUsersApp,
  vehicles: createVehiclesApp,
  telemetry: createTelemetryApp,
  maps: createMapsApp,
  notifications: createNotificationsApp,
};

exports.mochaHooks = {
  async beforeAll() {
    // First run downloads a MongoDB binary (~100 MB), so allow plenty of time
    this.timeout(300_000);
    await connectDB('memory');

    for (const [name, createApp] of Object.entries(SERVICES)) {
      const { server, url } = await listen(createApp());
      registry.set(name, url);
      ctx.serviceUrls[name] = url;
      ctx.servers.push(server);
    }

    // Main gateway used by most tests (high limit so tests don't trip it)
    ctx.gateway = createGateway({
      apiKeys: [ctx.API_KEY, ctx.SECOND_API_KEY],
      rateLimit: { windowMs: 60_000, max: 100_000 },
    });
  },

  async afterAll() {
    await Promise.all(ctx.servers.map(close));
    await disconnectDB();
  },
};
