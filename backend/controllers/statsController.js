// controllers/statsController.js
// Simple counters for the dashboard tiles.

const mongoose = require('mongoose');
const Case = require('../models/Case');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const catchAsync = require('../utils/catchAsync');
const { bucket } = require('./_gridfs');

exports.getStats = catchAsync(async (req, res) => {
  const [totalCases, finalizedCases, pendingCases, totalUsers, recentLogs, imagesCount] = await Promise.all([
    Case.countDocuments({}),
    Case.countDocuments({ status: 'finalized' }),
    Case.countDocuments({ status: 'pending' }),
    User.countDocuments({ isActive: { $ne: false } }),
    AuditLog.countDocuments({}),
    // GridFS file count
    mongoose.connection.db.collection('images.files').countDocuments().catch(() => 0),
  ]);
  res.json({
    success: true,
    stats: {
      totalCases,
      finalizedCases,
      pendingCases,
      totalUsers,
      recentLogs,
      imagesStored: imagesCount,
    },
  });
});
