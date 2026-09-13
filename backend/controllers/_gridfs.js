// controllers/_gridfs.js
// Shared GridFS bucket helper.

const mongoose = require('mongoose');

function bucket(name = 'images') {
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: name });
}

function openDownload(id) {
  return bucket().openDownloadStream(id);
}

// The Express API writes new uploads to the `images` bucket. Older / middleware
// uploads landed in the default `fs` bucket. Try both so localisation can
// still see the film.
async function downloadImage(imageId) {
  if (!imageId) return null;
  let oid;
  try {
    oid = new mongoose.Types.ObjectId(String(imageId));
  } catch {
    return null;
  }

  const db = mongoose.connection.db;
  for (const name of ['images', 'fs']) {
    const file = await db.collection(`${name}.files`).findOne({ _id: oid });
    if (!file) continue;
    const chunks = [];
    try {
      await new Promise((resolve, reject) => {
        const stream = bucket(name).openDownloadStream(oid);
        stream.on('data', (d) => chunks.push(d));
        stream.on('error', reject);
        stream.on('end', resolve);
      });
    } catch {
      continue;
    }
    const buffer = Buffer.concat(chunks);
    if (!buffer.length) continue;
    return {
      buffer,
      contentType: file.contentType || 'image/jpeg',
    };
  }
  return null;
}

module.exports = { bucket, openDownload, downloadImage };
