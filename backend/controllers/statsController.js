// controllers/statsController.js
// Simple counters for the dashboard tiles.

const mongoose = require('mongoose');
const Case = require('../models/Case');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const catchAsync = require('../utils/catchAsync');
const { OWNED } = Case;
const { normalizeRole } = require('../utils/roles');

let statsCache = { at: 0, body: null };
const STATS_TTL_MS = 15_000;

exports.getStats = catchAsync(async (req, res) => {
  if (statsCache.body && Date.now() - statsCache.at < STATS_TTL_MS) {
    return res.json(statsCache.body);
  }
  const role = normalizeRole(req.user?.role);
  const scope = { ...OWNED };
  if (role === 'doctor') scope.status = 'finalized';
  else if (role === 'technician') scope.createdBy = req.user.userId;

  const [totalCases, finalizedCases, pendingCases, urgentCases, totalUsers, recentLogs, imagesCount] = await Promise.all([
    Case.countDocuments(scope),
    Case.countDocuments({ ...scope, status: 'finalized' }),
    Case.countDocuments({ ...scope, status: { $in: ['pending_approve', 'completed'] } }),
    Case.countDocuments({ ...scope, urgent: true }),
    User.countDocuments({ isActive: { $ne: false } }),
    AuditLog.countDocuments({}),
    mongoose.connection.db.collection('images.files').countDocuments().catch(() => 0),
  ]);
  const body = {
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
  };
  statsCache = { at: Date.now(), body };
  res.json(body);
});
