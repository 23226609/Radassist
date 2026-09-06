// controllers/auditLogController.js
// Admin-only listing with filtering.

const AuditLog = require('../models/AuditLog');
const catchAsync = require('../utils/catchAsync');

exports.listLogs = catchAsync(async (req, res) => {
  const { action, userId, q, sortDir = 'desc' } = req.query;
  const filter = {};
  if (action) filter.action = action;
  if (userId) filter.userId = userId;
  if (q) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ details: re }, { action: re }, { userId: re }, { affectedCaseId: re }];
  }

  const docs = await AuditLog.find(filter).lean();
  docs.sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return (new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()) * dir;
  });
  res.json({ success: true, total: docs.length, logs: docs });
});
