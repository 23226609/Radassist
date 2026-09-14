// controllers/auditLogController.js
// Admin-only listing with filtering.

const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
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

function asIdList(body) {
  const raw = body?.ids;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))];
}

exports.deleteLog = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'admin') {
    return next(ApiError.forbidden('Only admins can delete audit logs.'));
  }
  const id = String(req.params.id || '').trim();
  if (!id) return next(ApiError.badRequest('Log id is required.'));

  let log = await AuditLog.findOne({ logId: id });
  if (!log) log = await AuditLog.findById(id).catch(() => null);
  if (!log) return next(ApiError.notFound(`Audit log ${id} not found`));

  await AuditLog.deleteOne({ _id: log._id });
  res.json({ success: true });
});

exports.deleteLogs = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'admin') {
    return next(ApiError.forbidden('Only admins can delete audit logs.'));
  }
  const ids = asIdList(req.body);
  if (!ids.length) return next(ApiError.badRequest('Select at least one audit log.'));

  const result = await AuditLog.deleteMany({ logId: { $in: ids } });
  res.json({ success: true, deleted: result.deletedCount || 0 });
});
