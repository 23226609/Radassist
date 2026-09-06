// controllers/authController.js
// Login / register / me. Register is open to the public (defaults to 'doctor')
// but you can disable it by removing the route.

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');
const addAuditLog = require('../utils/auditLogger');

function signToken(user) {
  return jwt.sign(
    {
      userId: user.userId,
      role: user.role,
      name: user.name,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
  );
}

function toSafeUser(user) {
  const u = user.toSafeJSON ? user.toSafeJSON() : user;
  return {
    userId: u.userId,
    username: u.username,
    name: u.name,
    email: u.email,
    role: u.role,
    department: u.department,
    isActive: u.isActive,
    createdAt: u.createdAt,
  };
}

exports.login = catchAsync(async (req, res, next) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return next(ApiError.badRequest('Please provide username and password.'));
  }

  const user = await User.findOne({ username: String(username).toLowerCase() });
  if (!user) return next(ApiError.unauthorized('Invalid credentials.'));

  const ok = await user.comparePassword(password);
  if (!ok) return next(ApiError.unauthorized('Invalid credentials.'));

  if (user.isActive === false) {
    return next(ApiError.forbidden('Account is deactivated. Contact an administrator.'));
  }

  const token = signToken(user);
  await addAuditLog(user.userId, 'LOGIN', `User ${user.name} (${user.role}) logged in`);

  res.json({ success: true, token, user: toSafeUser(user) });
});

exports.register = catchAsync(async (req, res, next) => {
  const { username, password, name, email, role, department } = req.body || {};
  if (!username || !password || !name || !email) {
    return next(ApiError.badRequest('username, password, name and email are required.'));
  }
  // Self-signup is restricted to doctor / nurse. Admins must be created via seed.
  const finalRole = role === 'doctor' || role === 'nurse' ? role : 'doctor';
  const userId = `${finalRole.toUpperCase()}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  try {
    const user = await User.create({
      userId,
      username: String(username).toLowerCase(),
      password,
      name,
      email: String(email).toLowerCase(),
      role: finalRole,
      department: department || 'Radiology',
    });
    const token = signToken(user);
    await addAuditLog(user.userId, 'REGISTER', `New ${finalRole} account: ${user.name}`);
    res.status(201).json({ success: true, token, user: toSafeUser(user) });
  } catch (err) {
    if (err.code === 11000) {
      return next(ApiError.badRequest('Username or email already taken.'));
    }
    next(err);
  }
});

exports.me = catchAsync(async (req, res) => {
  res.json({ success: true, user: toSafeUser(req.user) });
});

exports.logout = catchAsync(async (req, res) => {
  await addAuditLog(req.user.userId, 'LOGOUT', `User ${req.user.name} logged out`);
  res.json({ success: true });
});
