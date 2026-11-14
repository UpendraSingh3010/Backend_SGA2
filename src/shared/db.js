/**
 * MongoDB connection.
 * - With a real MONGODB_URI (local MongoDB or Atlas) it connects there.
 * - With uri === 'memory' it starts an in-memory MongoDB (mongodb-memory-server),
 *   which is handy for a zero-setup demo and for the automated tests.
 */
const mongoose = require('mongoose');
const models = require('./models');

let memoryServer = null;

async function connectDB(uri) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;

  let target = uri;
  if (!target || target === 'memory') {
    // Lazy-require so production deployments never load it
    const { MongoMemoryServer } = require('mongodb-memory-server');
    memoryServer = await MongoMemoryServer.create();
    target = memoryServer.getUri('fleet');
    if (process.env.NODE_ENV !== 'test') {
      console.log('[db] Using in-memory MongoDB (data is lost when the app stops)');
    }
  }

  await mongoose.connect(target);
  // Make sure indexes (unique + 2dsphere) exist before handling requests
  await Promise.all(Object.values(models).map((m) => m.init()));

  if (process.env.NODE_ENV !== 'test') {
    console.log(`[db] Connected to MongoDB database '${mongoose.connection.name}'`);
  }
  return mongoose.connection;
}

async function disconnectDB() {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}

module.exports = { connectDB, disconnectDB, isMemory: () => Boolean(memoryServer) };
