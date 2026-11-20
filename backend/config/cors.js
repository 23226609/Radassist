// config/cors.js
// Which browser origins may call the API from another origin.
//
// Set ALLOWED_ORIGINS in backend/.env to a comma-separated list, for example
//   ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
// With nothing set, only the local development servers are allowed. "*" is
// ignored: the API sends cookies and tokens, so it must never allow every origin.
//
// This is not a login. A request with no Origin header (curl, another server,
// the Vite proxy) is always answered, and every route still checks the token.

const cors = require('cors');

const LOCAL_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
];

function allowedOrigins(env = process.env) {
  const listed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o && o !== '*');
  return listed.length ? listed : LOCAL_ORIGINS;
}

function corsOptions(env = process.env) {
  const allowed = new Set(allowedOrigins(env));
  return {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      return cb(null, allowed.has(origin));
    },
    credentials: true,
  };
}

const corsMiddleware = (env = process.env) => cors(corsOptions(env));

module.exports = { LOCAL_ORIGINS, allowedOrigins, corsOptions, corsMiddleware };
