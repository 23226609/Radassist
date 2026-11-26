// middleware/auth.js
// JWT verification + role-based authorization.

const jwt = require('jsonwebtoken');
const ApiError = require('../utils/ApiError');
const User = require('../models/User');
const { normalizeRole, isPatient } = require('../utils/roles');

const authenticate = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) {
      return next(ApiError.unauthorized('Please log in to continue.'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findOne({ userId: decoded.userId });
    if (!user) {
      return next(ApiError.unauthorized('Session expired. Please log in again.'));
    }
    if (user.isActive === false) {
      return next(ApiError.forbidden('Account is deactivated.'));
    }
    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(ApiError.unauthorized('Session expired. Please log in again.'));
    }
    if (err.name === 'JsonWebTokenError') {
      return next(ApiError.unauthorized('Invalid session. Please log in again.'));
    }
    next(err);
  }
};

const authorize = (...roles) => (req, res, next) => {
  if (!req.user) return next(ApiError.unauthorized('Not authenticated'));
  const role = normalizeRole(req.user.role);
  if (!roles.includes(role)) {
    return next(ApiError.forbidden('You do not have permission to perform this action.'));
  }
  next();
};

// A patient account can read. It cannot do anything else, anywhere. Routes a patient may never use call
// denyPatient; the case routes call patientReadsOwnOnly, which lets a patient through only to the case list
// and to one case (the controller then limits both to that patient's own endorsed cases).
const denyPatient = (req, res, next) => {
  if (isPatient(req.user)) return next(ApiError.forbidden('Patient accounts can only read their own reports.'));
  next();
};

const patientReadsOwnOnly = (req, res, next) => {
  if (!isPatient(req.user)) return next();
  const readsList = req.method === 'GET' && req.path === '/';
  const readsOne = req.method === 'GET' && /^\/[^/]+$/.test(req.path) && req.path !== '/availability';
  if (readsList || readsOne) return next();
  return next(ApiError.forbidden('Patient accounts can only read their own reports.'));
};

module.exports = { authenticate, authorize, denyPatient, patientReadsOwnOnly };
