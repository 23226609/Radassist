// config/db.js
// Mongoose connection helper.

const mongoose = require('mongoose');

const connectDB = async () => {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || 'radassist';

  if (!uri) {
    console.error('MONGODB_URI is not configured. See backend/.env');
    process.exit(1);
  }

  try {
    const conn = await mongoose.connect(uri, { dbName });
    console.log(`MongoDB connected: ${conn.connection.host} / ${dbName}`);
  } catch (err) {
    console.error(`MongoDB connection error: ${err.message}`);
    process.exit(1);
  }
};

const disconnectDB = async () => {
  await mongoose.disconnect();
};

module.exports = connectDB;
module.exports.disconnectDB = disconnectDB;
