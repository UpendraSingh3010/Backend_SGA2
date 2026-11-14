/**
 * Runs ONE service as its own process (e.g. `npm run svc:telemetry`).
 * Separate processes need a shared real database, so MONGODB_URI is required here.
 */
const config = require('../config');
const { connectDB } = require('./db');

async function runService(name, createApp) {
  if (!config.mongoUri) {
    console.error(
      `[${name}] MONGODB_URI is not set. Running services as separate processes needs a shared ` +
        'database. Set MONGODB_URI in .env, or use `npm start` (single process, in-memory DB).'
    );
    process.exit(1);
  }
  await connectDB(config.mongoUri);
  const port = config.ports[name];
  createApp().listen(port, () => console.log(`[${name}] service listening on http://localhost:${port}`));
}

module.exports = runService;
