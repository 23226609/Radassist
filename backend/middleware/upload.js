// middleware/upload.js
// Multer with in-memory storage. Images are streamed into GridFS inside
// the controller so we don't touch the local disk.

const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const type = String(file.mimetype || '').toLowerCase();
    const name = String(file.originalname || '');
    const raster = /^image\/(jpe?g|png|webp)$/i.test(type);
    const dicom = /\.dcm$/i.test(name) || type === 'application/dicom';
    if (!raster && !dicom) {
      return cb(new Error('Only DICOM, JPEG, PNG, or WebP films are allowed'));
    }
    cb(null, true);
  },
});

module.exports = upload;
