/** Loads demo data into the database from MONGODB_URI (wipes existing data). */
const config = require('../src/config');
const { connectDB, disconnectDB } = require('../src/shared/db');
const { seedDatabase } = require('../src/seed');

(async () => {
  if (!config.mongoUri) {
    console.error('MONGODB_URI is not set in .env. (With no database configured, `npm start` seeds an in-memory DB automatically.)');
    process.exit(1);
  }
  await connectDB(config.mongoUri);
  await seedDatabase({ reset: true });
  await disconnectDB();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
