// scripts/lib/test-db.cjs
//
// A throwaway MongoDB for the API tests. It starts mongod in memory on a
// random local port, connects mongoose to it, and removes it afterwards. The
// development database (backend/.env) is never read or touched.
//
//   const { startTestDb } = require('./lib/test-db.cjs');
//   const db = await startTestDb();
//   ... use the backend models ...
//   await db.stop();

const assert = require('assert');
const path = require('path');

const BACKEND = path.join(__dirname, '..', '..', 'backend');
// The same mongoose the backend models use, so they share one connection.
const mongoose = require(path.join(BACKEND, 'node_modules', 'mongoose'));
const { MongoMemoryServer } = require(path.join(BACKEND, 'node_modules', 'mongodb-memory-server'));

async function startTestDb() {
  const server = await MongoMemoryServer.create();
  const uri = server.getUri();
  // Never run against anything but this local in-memory server.
  assert.ok(/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri), `refusing to use ${uri.replace(/\/\/.*@/, '//')}`);
  await mongoose.connect(uri, { dbName: 'radassist-test' });
  assert.ok(['127.0.0.1', 'localhost'].includes(mongoose.connection.host), 'test database must be local');

  return {
    uri,
    mongoose,
    // Build the indexes the models declare (the unique patientId, for one).
    async ensureIndexes() {
      for (const name of mongoose.modelNames()) await mongoose.model(name).init();
    },
    // Empty every collection between tests.
    async clear() {
      for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
    },
    async stop() {
      await mongoose.disconnect();
      await server.stop();
    },
  };
}

module.exports = { startTestDb };
