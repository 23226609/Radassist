// controllers/userController.js
// Admin-only listing.

const User = require('../models/User');
const catchAsync = require('../utils/catchAsync');

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
