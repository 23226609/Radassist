// utils/catchAsync.js
// Wrap an async controller so any rejection flows to the next middleware.

module.exports = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
