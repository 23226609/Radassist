// controllers/userController.js
// Admin-only listing.

const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');
const addAuditLog = require('../utils/auditLogger');

exports.listUsers = catchAsync(async (req, res) => {
  const { role, q } = req.query;
  const filter = {};
  if (role) filter.role = role;
  if (q) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: re }, { email: re }, { username: re }, { userId: re }];
  }
  // Cosmos DB can't sort by indexed fields the index doesn't cover.
  // Fetch without ordering, then sort in-memory.
  const docs = await User.find(filter).lean();
  docs.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  res.json({ success: true, users: docs.map((u) => {
    const { password, ...safe } = u;
    return safe;
  }) });
});

exports.setUserActive = catchAsync(async (req, res, next) => {
  const id = String(req.params.id || '').trim();
  const { isActive } = req.body || {};
  if (typeof isActive !== 'boolean') {
    return next(ApiError.badRequest('isActive must be true or false.'));
  }
  const user = await User.findOne({ $or: [{ userId: id }, { username: id.toLowerCase() }] });
  if (!user) return next(ApiError.notFound('User not found.'));
  if (user.userId === req.user.userId) {
    return next(ApiError.badRequest('You cannot disable your own account.'));
  }
  if (user.role === 'admin' && isActive === false) {
    const otherAdmins = await User.countDocuments({
      role: 'admin',
      isActive: { $ne: false },
      userId: { $ne: user.userId },
    });
    if (otherAdmins === 0) {
      return next(ApiError.badRequest('Cannot disable the last active administrator.'));
    }
  }
  user.isActive = isActive;
  await user.save();
  await addAuditLog(
    req.user.userId,
    'USER_UPDATED',
    `${isActive ? 'Enabled' : 'Disabled'} user ${user.username} (${user.userId})`
  );
  res.json({ success: true, user: user.toSafeJSON() });
});
