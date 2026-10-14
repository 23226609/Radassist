// controllers/_gridfs.js
// Shared GridFS bucket helper.

const mongoose = require('mongoose');
const { shrinkForDisplay } = require('../utils/displayFilm');

function bucket(name = 'images') {
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: name });
}

function openDownload(id) {
  return bucket().openDownloadStream(id);
}

// Cosmos GridFS is slow for a multi-megabyte film. One read is shared by the
// page and by Re-run AI, and the bytes stay in memory for the next open.
const imageCache = new Map();
const imageFlights = new Map();
const IMAGE_CACHE_LIMIT = 6;

function rememberImage(key, image) {
  if (!image) return;
  if (imageCache.has(key)) imageCache.delete(key);
  imageCache.set(key, image);
  while (imageCache.size > IMAGE_CACHE_LIMIT) {
    const oldest = imageCache.keys().next().value;
    imageCache.delete(oldest);
  }
}

function chunkBytes(data) {
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data.read === 'function') {
    const len = typeof data.length === 'function' ? data.length() : data.length;
    return Buffer.from(data.read(0, len));
  }
  return Buffer.from(data);
}

async function readChunks(db, name, oid) {
  const docs = await db.collection(`${name}.chunks`).find({ files_id: oid }).sort({ n: 1 }).toArray();
  if (!docs.length) return null;
  return Buffer.concat(docs.map((doc) => chunkBytes(doc.data)));
}

async function storeDisplayCopy(bucketName, previousId, image) {
  const Case = require('../models/Case');
  const up = bucket(bucketName).openUploadStream('xray.jpg', { contentType: 'image/jpeg' });
  await new Promise((resolve, reject) => {
    up.end(image.buffer, (err) => (err ? reject(err) : resolve()));
  });
  const rows = await Case.find({ imageId: previousId });
  for (const row of rows) {
    if (Array.isArray(row.pixelSpacingMm) && row.pixelSpacingMm.length === 2 && (image.rowScale !== 1 || image.colScale !== 1)) {
      row.pixelSpacingMm = [
        Number(row.pixelSpacingMm[0]) * image.rowScale,
        Number(row.pixelSpacingMm[1]) * image.colScale,
      ];
      row.markModified('pixelSpacingMm');
    }
    row.imageId = up.id;
    row.imageContentType = 'image/jpeg';
    row.imageSize = image.buffer.length;
    if (row.imageFilename && !/\.jpe?g$/i.test(row.imageFilename)) {
      row.imageFilename = `${row.imageFilename.replace(/\.[^.]+$/, '')}.jpg`;
    }
    await row.save();
  }
}

async function readGridImage(imageId) {
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
    let buffer;
    try {
      buffer = await readChunks(db, name, oid);
    } catch {
      buffer = null;
    }
    if (!buffer?.length) continue;
    let display;
    try {
      display = shrinkForDisplay(buffer, file.contentType || 'image/jpeg');
    } catch (err) {
      console.warn('[image] could not shrink the film:', err.message);
      display = { buffer, contentType: file.contentType || 'image/jpeg', shrunk: false, rowScale: 1, colScale: 1 };
    }
    if (display.shrunk) {
      console.log(`[image] ${buffer.length} bytes -> ${display.buffer.length} bytes for display`);
      // Keep the open request on the small JPEG. Saving the copy and updating
      // the case happens after the response, so a slow Cosmos write cannot
      // drop the page connection.
      const snapshot = {
        buffer: display.buffer,
        contentType: display.contentType,
        rowScale: display.rowScale,
        colScale: display.colScale,
      };
      storeDisplayCopy(name, oid, snapshot).catch((err) => {
        console.warn('[image] could not keep the smaller film:', err.message);
      });
    }
    return {
      buffer: display.buffer,
      contentType: display.contentType,
      rowScale: display.rowScale || 1,
      colScale: display.colScale || 1,
    };
  }
  return null;
}

// The Express API writes new uploads to the `images` bucket. Older / middleware
// uploads landed in the default `fs` bucket. Try both so localisation can
// still see the film.
async function downloadImage(imageId) {
  const key = String(imageId || '');
  if (!key) return null;
  if (imageCache.has(key)) return imageCache.get(key);
  if (imageFlights.has(key)) return imageFlights.get(key);
  const job = readGridImage(key).then((image) => {
    rememberImage(key, image);
    return image;
  }).finally(() => {
    imageFlights.delete(key);
  });
  imageFlights.set(key, job);
  return job;
}

module.exports = { bucket, openDownload, downloadImage };
