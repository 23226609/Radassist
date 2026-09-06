// middleware/errorHandler.js
// Centralized error handler.

const ApiError = require('../utils/ApiError');

module.exports = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal Server Error';

  if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid value for ${err.path}: ${err.value}`;
  }
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    statusCode = 400;
    message = `Duplicate value for ${field}.`;
  }
  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = Object.values(err.errors).map((e) => e.message).join('. ');
  }

  const body = { success: false, error: message };
  if (process.env.NODE_ENV === 'development' && statusCode === 500) {
    body.stack = err.stack;
  }
  res.status(statusCode).json(body);
};
