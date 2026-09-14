// controllers/statsController.js
// Simple counters for the dashboard tiles.

const mongoose = require('mongoose');
const Case = require('../models/Case');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const catchAsync = require('../utils/catchAsync');
const { OWNED } = Case;

exports.getStats = catchAsync(async (req, res) => {
  const [totalCases, finalizedCases, pendingCases, urgentCases, totalUsers, recentLogs, imagesCount] = await Promise.all([
    Case.countDocuments(OWNED),
    Case.countDocuments({ ...OWNED, status: 'finalized' }),
    Case.countDocuments({ ...OWNED, status: { $in: ['pending_approve', 'completed'] } }),
    Case.countDocuments({ ...OWNED, urgent: true }),
    User.countDocuments({ isActive: { $ne: false } }),
    AuditLog.countDocuments({}),
    mongoose.connection.db.collection('images.files').countDocuments().catch(() => 0),
  ]);
  res.json({
    success: true,
    stats: {
      totalCases,
      finalizedCases,
      pendingCases,
      urgentCases,
      totalUsers,
      recentLogs,
      imagesStored: imagesCount,
    },
  });
});
