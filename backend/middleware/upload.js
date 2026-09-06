// middleware/upload.js
// Multer with in-memory storage. Images are streamed into GridFS inside
// the controller so we don't touch the local disk.

const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpe?g|png|webp)$/i.test(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, or WebP images are allowed'));
    }
    cb(null, true);
  },
});

module.exports = upload;
