// server.js
const express = require('express');
const { corsMiddleware } = require('./config/cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
const ApiError = require('./utils/ApiError');
const { syncNotifyReady } = require('./utils/agentTools');

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

// Authenticated JSON must not be cached. Express ETag + browser If-None-Match
// was returning 304 with an empty body, which the SPA treated as missing data.
app.set('etag', false);
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// CORS: only the origins in ALLOWED_ORIGINS (local dev servers by default).
app.use(corsMiddleware());

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
app.use('/api/share', require('./routes/share'));
app.use('/api/audit-logs', auditRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/appointments', require('./routes/appointments'));

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

  // Record when the email service became ready, so notify never sends a catch-up
  // email for a report endorsed before that. A failure here only keeps notify off.
  try {
    const readyAt = await syncNotifyReady();
    console.log(readyAt ? `Notification email ready since ${readyAt.toISOString()}` : 'Notification email is not set up (ACS_CONNECTION_STRING).');
  } catch (err) {
    console.error('Could not record when notification email became ready:', err.message);
  }

  const PORT = process.env.PORT || 5002;
  app.listen(PORT, () => {
    console.log(`RadAssist backend running on http://localhost:${PORT}`);
  });
}

module.exports = app;

start();
