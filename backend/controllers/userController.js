// controllers/userController.js
// Admin-only listing.

const crypto = require('crypto');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');
const addAuditLog = require('../utils/auditLogger');
const { ROLES } = require('../utils/roles');

const EMAIL_RE = /^[\w-.]+@([\w-]+\.)+[\w-]{2,4}$/;

function temporaryPassword() {
  return crypto.randomBytes(9).toString('base64url');
}

async function uniqueUsername(email) {
  const local = String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
  let username = local.slice(0, 20);
  let n = 1;
  while (await User.exists({ username })) {
    n += 1;
    username = `${local.slice(0, 16)}${n}`;
  }
  return username;
}

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

exports.createUser = catchAsync(async (req, res, next) => {
  const { name, email, role } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(name || '').trim();
  if (!cleanName || !cleanEmail) {
    return next(ApiError.badRequest('Name and email are required.'));
  }
  if (!EMAIL_RE.test(cleanEmail)) {
    return next(ApiError.badRequest('Please provide a valid email.'));
  }
  if (!ROLES.includes(role)) {
    return next(ApiError.badRequest('Choose a role.'));
  }
  const password = temporaryPassword();
  const username = await uniqueUsername(cleanEmail);
  const userId = `${role.toUpperCase()}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const department = role === 'doctor' ? 'Medicine' : role === 'admin' ? 'IT' : 'Radiology';
  try {
    const user = await User.create({
      userId,
      username,
      password,
      name: cleanName,
      email: cleanEmail,
      role,
      department,
    });
    await addAuditLog(req.user.userId, 'USER_UPDATED', `Added user ${user.username} (${user.email}) as ${role}`);
    res.status(201).json({
      success: true,
      temporaryPassword: password,
      user: user.toSafeJSON(),
    });
  } catch (err) {
    if (err.code === 11000) return next(ApiError.badRequest('That email is already used.'));
    next(err);
  }
});

exports.deleteUser = catchAsync(async (req, res, next) => {
  const id = String(req.params.id || '').trim();
  const user = await User.findOne({ $or: [{ userId: id }, { username: id.toLowerCase() }] });
  if (!user) return next(ApiError.notFound('User not found.'));
  if (user.userId === req.user.userId) {
    return next(ApiError.badRequest('You cannot delete your own account.'));
  }
  if (user.role === 'admin') {
    const otherAdmins = await User.countDocuments({
      role: 'admin',
      isActive: { $ne: false },
      userId: { $ne: user.userId },
    });
    if (otherAdmins === 0) {
      return next(ApiError.badRequest('Cannot delete the last active administrator.'));
    }
  }
  await user.deleteOne();
  await addAuditLog(req.user.userId, 'USER_UPDATED', `Deleted user ${user.username} (${user.userId})`);
  res.json({ success: true });
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
