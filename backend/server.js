// server.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
const ApiError = require('./utils/ApiError');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const caseRoutes = require('./routes/cases');
const patientRoutes = require('./routes/patients');
const imageRoutes = require('./routes/images');
const auditRoutes = require('./routes/auditLogs');
const statsRoutes = require('./routes/stats');

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// CORS: allow local Vite dev server and any other dev origin
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
];
if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, true); // permissive for FYP demo
  },
  credentials: true,
}));

// Body parsers
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Logging
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// Routes
app.get('/api/health', async (req, res) => {
  const mongoose = require('mongoose');
  const mongoState = mongoose.connection.readyState === 1 ? 'up' : 'down';
  res.json({ success: true, mongo: mongoState, timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/cases', caseRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/images', imageRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/stats', statsRoutes);

// 404
app.use('*', (req, res, next) => next(ApiError.notFound(`Route ${req.originalUrl} not found`)));

// Centralized error handler
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Boot — connect to MongoDB first, THEN start listening, so /api/health is
// honest from the very first request and we don't race against the driver.
// ---------------------------------------------------------------------------
async function start() {
  try {
    await connectDB();
  } catch (err) {
    // connectDB() already exits the process on hard failure. This is a
    // belt-and-suspenders guard in case that contract ever changes.
    console.error('Refusing to start without database:', err.message);
    process.exit(1);
  }

  const PORT = process.env.PORT || 5002;
  app.listen(PORT, () => {
    console.log(`RadAssist backend running on http://localhost:${PORT}`);
  });
}

module.exports = app;

start();
