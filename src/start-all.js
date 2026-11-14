/**
 * Starts the API Gateway and all five backend services in ONE Node process,
 * each Express app on its own port.
 *
 *   npm start                       # uses MONGODB_URI, or an in-memory DB if it is not set
 *   npm run start:memory            # force in-memory DB + demo data
 *   node src/start-all.js --seed    # (re)load demo data into the configured DB
 *   node src/start-all.js --skip=telemetry   # leave a service down to demo a 503
 */
const config = require('./config');
const { connectDB, isMemory } = require('./shared/db');
const { seedDatabase, USERS } = require('./seed');
const { createGateway, ROUTES } = require('./gateway/app');
const { createUsersApp } = require('./services/users/app');
const { createVehiclesApp } = require('./services/vehicles/app');
const { createTelemetryApp } = require('./services/telemetry/app');
const { createMapsApp } = require('./services/maps/app');
const { createNotificationsApp } = require('./services/notifications/app');
const { User } = require('./shared/models');

const SERVICES = {
  users: createUsersApp,
  vehicles: createVehiclesApp,
  telemetry: createTelemetryApp,
  maps: createMapsApp,
  notifications: createNotificationsApp,
};

function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const forceMemory = args.includes('--memory');
  const skipArg = args.find((a) => a.startsWith('--skip='));
  const skip = new Set(skipArg ? skipArg.slice('--skip='.length).split(',') : []);

  await connectDB(forceMemory ? 'memory' : config.mongoUri);

  // Seed when asked, or automatically when the database is empty
  if (args.includes('--seed') || isMemory() || (await User.estimatedDocumentCount()) === 0) {
    await seedDatabase({ reset: args.includes('--seed') || isMemory() });
  }

  for (const [name, createApp] of Object.entries(SERVICES)) {
    if (skip.has(name)) {
      console.log(`[start] Skipping ${name} service (requests to it will get 503)`);
      continue;
    }
    await listen(createApp(), config.ports[name]);
  }
  await listen(createGateway(), config.ports.gateway);

  const base = `http://localhost:${config.ports.gateway}`;
  const line = '='.repeat(70);
  console.log(`\n${line}`);
  console.log('  Fleet Management System is running');
  console.log(line);
  console.log(`  API Gateway  : ${base}`);
  console.log(`  Swagger UI   : ${base}/docs`);
  console.log(`  Map UI       : ${base}/map`);
  console.log(`  Health       : ${base}/health`);
  console.log(`  API key      : ${config.gateway.apiKeys[0]}   (header: x-api-key)`);
  console.log(`  Rate limit   : ${config.gateway.rateLimit.max} requests / ${config.gateway.rateLimit.windowMs / 1000}s per key`);
  console.log(`  Geocoder     : ${config.geo.provider}    SMS provider: ${config.sms.provider}`);
  console.log('  Services     :');
  for (const r of ROUTES) {
    const status = skip.has(r.service) ? 'NOT RUNNING' : `http://localhost:${config.ports[r.service]}`;
    console.log(`     ${`${r.prefix}/*`.padEnd(22)} -> ${r.label.padEnd(22)} ${status}`);
  }
  console.log('  Demo logins  :');
  for (const u of USERS) console.log(`     ${u.role.padEnd(14)} ${u.email.padEnd(26)} ${u.password}`);
  console.log(`${line}\n`);
}

main().catch((err) => {
  console.error('[start] Failed to start:', err);
  process.exit(1);
});
