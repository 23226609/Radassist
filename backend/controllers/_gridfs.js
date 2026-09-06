// controllers/_gridfs.js
// Shared GridFS bucket helper.

const mongoose = require('mongoose');

function bucket() {
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'images' });
}

module.exports = { bucket };
