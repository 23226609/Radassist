// middleware/auth.js
// JWT verification + role-based authorization.

const jwt = require('jsonwebtoken');
const ApiError = require('../utils/ApiError');
const User = require('../models/User');

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
  if (!roles.includes(req.user.role)) {
    return next(ApiError.forbidden('You do not have permission to perform this action.'));
  }
  next();
};

module.exports = { authenticate, authorize };
