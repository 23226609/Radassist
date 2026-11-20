// scripts/test-api.cjs
//
// The backend API over real HTTP: log in, the token rule, booking an X-ray
// request, and who may endorse a report.
//
// It mounts the real route files, body parser and error handler on a fresh
// Express app and talks to a throwaway in-memory MongoDB. It never starts
// backend/server.js (which connects to the development database), never reads
// backend/.env, and never calls Azure.
//
//   node scripts/test-api.cjs

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { startTestDb } = require('./lib/test-db.cjs');

// The test's own settings. Set before the backend is loaded.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.BOOKING_UTC_OFFSET = '+08:00';
process.env.XRAY_SLOT_CAPACITY = '2';
process.env.XRAY_DAILY_QUOTA = '20';
for (const key of Object.keys(process.env)) {
  if (key.startsWith('AZURE_OPENAI')) delete process.env[key];
}

const BACKEND = path.join(__dirname, '..', 'backend');
const backend = (p) => require(path.join(BACKEND, p));
const express = backend('node_modules/express');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${name}\n      ${err.message}`);
    failed++;
  }
}

// The same routes as backend/server.js, without its database connection.
function buildApp() {
  const app = express();
  app.set('etag', false);
  app.use(backend('config/cors').corsMiddleware());
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/auth', backend('routes/auth'));
  app.use('/api/cases', backend('routes/cases'));
  app.use('*', (req, res, next) => next(backend('utils/ApiError').notFound(`Route ${req.originalUrl} not found`)));
  app.use(backend('middleware/errorHandler'));
  return app;
}

(async () => {
  const db = await startTestDb();
  const User = backend('models/User');
  const Patient = backend('models/Patient');
  const Case = backend('models/Case');
  const xraySlots = backend('utils/xraySlots');
  await db.ensureIndexes();

  const server = http.createServer(buildApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function api(method, url, { token, body } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* an empty body */ }
    return { status: res.status, body: json };
  }

  // Passwords exist only for this run.
  const secret = () => crypto.randomBytes(9).toString('base64url');
  const accounts = {};
  async function makeUser(role) {
    const password = secret();
    const user = await User.create({
      userId: `${role.toUpperCase()}-API`,
      username: `api-${role}`,
      email: `api-${role}@radassist.test`,
      name: `Test ${role}`,
      role,
      password,
    });
    accounts[role] = { user, password };
  }
  const tokens = {};
  async function loginAs(role) {
    const res = await api('POST', '/api/auth/login', { body: { username: `api-${role}`, password: accounts[role].password } });
    assert.strictEqual(res.status, 200, `could not log in as ${role}: ${JSON.stringify(res.body)}`);
    tokens[role] = res.body.token;
  }

  // A day with an open room: not today, not a Sunday.
  function bookableDay() {
    let day = xraySlots.localParts(new Date(Date.now() + 3 * 86400000)).day;
    while (new Date(`${day}T00:00:00Z`).getUTCDay() === 0) {
      day = xraySlots.localParts(new Date(new Date(`${day}T00:00:00Z`).getTime() + 86400000 + 8 * 3600000)).day;
    }
    return day;
  }
  const DAY = bookableDay();
  const TIME = '10:00';
  const SUNDAY = (() => {
    let d = new Date(`${DAY}T00:00:00Z`);
    while (d.getUTCDay() !== 0) d = new Date(d.getTime() + 86400000);
    return d.toISOString().slice(0, 10);
  })();

  // Bookings and patients only. The accounts stay, so the tokens stay valid.
  const resetData = async () => { await Case.deleteMany({}); await Patient.deleteMany({}); };
  const patient = (n) => Patient.create({ patientId: `PT-API-${n}`, firstName: 'Api', lastName: `Patient${n}`, name: `Api Patient${n}`, age: '55', sex: 'Female' });
  const request = (patientId, extra = {}) => api('POST', '/api/cases/request', {
    token: tokens.doctor,
    body: { patientId, day: DAY, time: TIME, clinicalReason: 'Cough and fever for three days', ...extra },
  });

  try {
    for (const role of ['technician', 'radiologist', 'doctor', 'admin']) await makeUser(role);
    await loginAs('technician');
    await loginAs('radiologist');
    await loginAs('doctor');
    await loginAs('admin');

    console.log('\n=== login ===');

    await test('a wrong password is rejected with 401 and no token', async () => {
      const res = await api('POST', '/api/auth/login', { body: { username: 'api-doctor', password: `${accounts.doctor.password}-wrong` } });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(res.body.token, undefined);
    });

    await test('an unknown user is rejected with 401, the same as a wrong password', async () => {
      const res = await api('POST', '/api/auth/login', { body: { username: 'nobody-here', password: secret() } });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error, 'Invalid credentials.');
    });

    await test('a missing password is a 400, not a login', async () => {
      const res = await api('POST', '/api/auth/login', { body: { username: 'api-doctor' } });
      assert.strictEqual(res.status, 400);
    });

    await test('the right password returns a token that opens /api/auth/me', async () => {
      const res = await api('POST', '/api/auth/login', { body: { username: 'api-doctor', password: accounts.doctor.password } });
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.token);
      assert.strictEqual(res.body.user.role, 'doctor');
      assert.strictEqual(res.body.user.password, undefined, 'the password hash must never be returned');
      const me = await api('GET', '/api/auth/me', { token: res.body.token });
      assert.strictEqual(me.status, 200);
      assert.strictEqual(me.body.user.username, 'api-doctor');
    });

    console.log('\n=== registering an account ===');

    const newAccount = (n) => ({ username: `api-new-${n}`, password: secret(), name: `New Person ${n}`, email: `api-new-${n}@radassist.test`, role: 'radiologist' });

    await test('register without a token is 401 and creates no account', async () => {
      const res = await api('POST', '/api/auth/register', { body: newAccount(1) });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(await User.countDocuments({ username: 'api-new-1' }), 0);
    });

    await test('register is 403 for a technician, a radiologist and a doctor', async () => {
      for (const role of ['technician', 'radiologist', 'doctor']) {
        const res = await api('POST', '/api/auth/register', { token: tokens[role], body: newAccount(2) });
        assert.strictEqual(res.status, 403, `${role} must not create accounts`);
      }
      assert.strictEqual(await User.countDocuments({ username: 'api-new-2' }), 0);
    });

    await test('an administrator can register an account, and it can log in', async () => {
      const account = newAccount(3);
      const res = await api('POST', '/api/auth/register', { token: tokens.admin, body: account });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.user.username, account.username);
      assert.strictEqual(res.body.user.role, 'radiologist');
      const login = await api('POST', '/api/auth/login', { body: { username: account.username, password: account.password } });
      assert.strictEqual(login.status, 200);
    });

    await test('even an administrator cannot register an admin through it', async () => {
      const res = await api('POST', '/api/auth/register', { token: tokens.admin, body: { ...newAccount(4), role: 'admin' } });
      assert.strictEqual(res.status, 201);
      assert.notStrictEqual(res.body.user.role, 'admin');
    });

    console.log('\n=== CORS ===');

    const preflight = (origin, url = '/api/auth/login') => fetch(base + url, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
    });

    await test('a local dev origin is allowed by default', async () => {
      const res = await preflight('http://localhost:5173');
      assert.strictEqual(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
      assert.strictEqual(res.headers.get('access-control-allow-credentials'), 'true');
    });

    await test('any other origin gets no CORS permission, on a preflight or a real request', async () => {
      const pre = await preflight('https://evil.example');
      assert.strictEqual(pre.headers.get('access-control-allow-origin'), null);
      const real = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'x', password: 'y' }),
      });
      assert.strictEqual(real.headers.get('access-control-allow-origin'), null);
    });

    await test('a request with no Origin (the Vite proxy, curl) still works', async () => {
      const res = await api('POST', '/api/auth/login', { body: { username: 'api-doctor', password: accounts.doctor.password } });
      assert.strictEqual(res.status, 200);
    });

    await test('ALLOWED_ORIGINS replaces the default list, and "*" is ignored', async () => {
      const { allowedOrigins, LOCAL_ORIGINS } = backend('config/cors');
      assert.deepStrictEqual(allowedOrigins({}), LOCAL_ORIGINS);
      assert.deepStrictEqual(allowedOrigins({ ALLOWED_ORIGINS: '' }), LOCAL_ORIGINS);
      assert.deepStrictEqual(
        allowedOrigins({ ALLOWED_ORIGINS: ' https://app.example.org/ , http://localhost:4000 ' }),
        ['https://app.example.org', 'http://localhost:4000']
      );
      assert.deepStrictEqual(allowedOrigins({ ALLOWED_ORIGINS: '*' }), LOCAL_ORIGINS, '"*" must never allow every origin');

      const own = express();
      own.use(backend('config/cors').corsMiddleware({ ALLOWED_ORIGINS: 'https://app.example.org' }));
      own.get('/ping', (req, res) => res.json({ ok: true }));
      const ownServer = http.createServer(own);
      await new Promise((resolve) => ownServer.listen(0, '127.0.0.1', resolve));
      try {
        const url = `http://127.0.0.1:${ownServer.address().port}/ping`;
        const yes = await fetch(url, { headers: { Origin: 'https://app.example.org' } });
        const no = await fetch(url, { headers: { Origin: 'http://localhost:5173' } });
        assert.strictEqual(yes.headers.get('access-control-allow-origin'), 'https://app.example.org');
        assert.strictEqual(no.headers.get('access-control-allow-origin'), null, 'the default list no longer applies');
      } finally {
        ownServer.closeAllConnections?.();
        await new Promise((resolve) => ownServer.close(resolve));
      }
    });

    console.log('\n=== the token rule ===');

    await test('creating a case without a token is 401, and nothing is saved', async () => {
      const before = await Case.countDocuments({});
      const res = await api('POST', '/api/cases', { body: { patientId: 'PT-API-1' } });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.success, false);
      assert.strictEqual(await Case.countDocuments({}), before);
    });

    await test('a made-up token is 401', async () => {
      const res = await api('POST', '/api/cases', { token: 'not.a.real-token', body: { patientId: 'PT-API-1' } });
      assert.strictEqual(res.status, 401);
    });

    await test('listing cases and booking also need a token', async () => {
      assert.strictEqual((await api('GET', '/api/cases')).status, 401);
      assert.strictEqual((await api('POST', '/api/cases/request', { body: { patientId: 'PT-API-1' } })).status, 401);
    });

    console.log('\n=== booking an X-ray request ===');

    await test('a referring doctor books a valid slot and gets a booked case', async () => {
      await resetData();
      await patient(1);
      const res = await request('PT-API-1');
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.case.status, 'requested');
      assert.strictEqual(res.body.case.patientId, 'PT-API-1');
      assert.strictEqual(new Date(res.body.case.scheduledAt).getTime(), xraySlots.slotInstant(DAY, TIME).getTime());
      const saved = await Case.findOne({ caseId: res.body.case.caseId });
      assert.ok(saved, 'the booked case is in the database');
      assert.strictEqual(saved.status, 'requested');
      assert.strictEqual(saved.requestedBy, accounts.doctor.user.userId);
    });

    await test('a fully booked slot is refused with 400 and nothing more is saved', async () => {
      await resetData();
      for (const n of [1, 2, 3]) await patient(n);
      const first = await request('PT-API-1');
      const second = await request('PT-API-2');
      assert.strictEqual(first.status, 201, JSON.stringify(first.body));
      assert.strictEqual(second.status, 201, JSON.stringify(second.body));
      const third = await request('PT-API-3');
      assert.strictEqual(third.status, 400);
      assert.strictEqual(third.body.success, false);
      assert.match(third.body.error, /fully booked/i);
      assert.strictEqual(await Case.countDocuments({ scheduledAt: xraySlots.slotInstant(DAY, TIME) }), 2);
      assert.strictEqual(await Case.countDocuments({ patientId: 'PT-API-3' }), 0);
    });

    await test('availability reports that slot as full', async () => {
      const res = await api('GET', `/api/cases/availability?from=${DAY}&to=${DAY}`, { token: tokens.doctor });
      assert.strictEqual(res.status, 200);
      const slot = res.body.days[0].slots.find((s) => s.time === TIME);
      assert.strictEqual(slot.status, 'full');
      assert.strictEqual(slot.left, 0);
    });

    await test('an urgent request can still be added to a full slot', async () => {
      const res = await request('PT-API-3', { urgent: true });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.case.urgent, true);
    });

    await test('a closed day, a time that is not offered and a missing reason are all 400', async () => {
      await resetData();
      await patient(1);
      const closed = await request('PT-API-1', { day: SUNDAY });
      assert.strictEqual(closed.status, 400);
      assert.match(closed.body.error, /closed/i);
      const odd = await request('PT-API-1', { time: '03:17' });
      assert.strictEqual(odd.status, 400);
      const noReason = await request('PT-API-1', { clinicalReason: '  ' });
      assert.strictEqual(noReason.status, 400);
      assert.strictEqual(await Case.countDocuments({}), 0);
    });

    await test('an unregistered patient cannot be booked', async () => {
      const res = await request('PT-NOT-REGISTERED');
      assert.strictEqual(res.status, 400);
      assert.match(res.body.error, /register the patient/i);
    });

    await test('a technician and a radiologist cannot book a request', async () => {
      for (const role of ['technician', 'radiologist']) {
        const res = await api('POST', '/api/cases/request', {
          token: tokens[role],
          body: { patientId: 'PT-API-1', day: DAY, time: TIME, clinicalReason: 'Cough' },
        });
        assert.strictEqual(res.status, 403, `${role} must not book`);
      }
      assert.strictEqual(await Case.countDocuments({}), 0);
    });

    console.log('\n=== who may endorse ===');

    const REPORT = ['XRAY CHEST (PA)', '', 'FINDINGS', 'The lungs are clear.', '', 'COMMENT', '– No acute abnormality.', ''].join('\n');
    async function draftCase(caseId) {
      await Patient.create({ patientId: 'PT-API-E', firstName: 'Api', lastName: 'PatientE', name: 'Api PatientE', age: '55', sex: 'Female' });
      return Case.create({
        caseId,
        patientId: 'PT-API-E',
        firstName: 'Api',
        lastName: 'PatientE',
        status: 'pending_approve',
        analysisState: 'done',
        reportText: REPORT,
        diagnosis: 'Normal chest',
        findings: [],
        editLog: [],
        createdBy: accounts.technician.user.userId,
      });
    }

    await test('a technician cannot endorse: 403, and the report stays a draft', async () => {
      await resetData();
      await draftCase('CASE-API-1');
      const res = await api('POST', '/api/cases/CASE-API-1/finalize', { token: tokens.technician });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.success, false);
      const saved = await Case.findOne({ caseId: 'CASE-API-1' });
      assert.strictEqual(saved.status, 'pending_approve');
      assert.ok(!saved.finalizedBy, 'nobody is recorded as having endorsed it');
    });

    await test('a referring doctor and a visitor with no token cannot endorse either', async () => {
      const doctor = await api('POST', '/api/cases/CASE-API-1/finalize', { token: tokens.doctor });
      assert.strictEqual(doctor.status, 403);
      const anonymous = await api('POST', '/api/cases/CASE-API-1/finalize');
      assert.strictEqual(anonymous.status, 401);
      assert.strictEqual((await Case.findOne({ caseId: 'CASE-API-1' })).status, 'pending_approve');
    });

    await test('a radiologist can endorse, and the case records who did', async () => {
      const res = await api('POST', '/api/cases/CASE-API-1/finalize', { token: tokens.radiologist });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.case.status, 'finalized');
      const saved = await Case.findOne({ caseId: 'CASE-API-1' });
      assert.strictEqual(saved.status, 'finalized');
      assert.strictEqual(saved.finalizedBy, accounts.radiologist.user.userId);
      assert.strictEqual(saved.finalizedByName, accounts.radiologist.user.name);
      assert.ok(saved.finalizedAt instanceof Date);
    });

    await test('endorsing a case that does not exist is 404', async () => {
      const res = await api('POST', '/api/cases/CASE-API-NONE/finalize', { token: tokens.radiologist });
      assert.strictEqual(res.status, 404);
    });

    console.log('\n=== share links (regression: shareToken used to default to null) ===');

    await test('many cases can exist with no share link', async () => {
      await resetData();
      for (const n of [1, 2, 3]) {
        await Case.create({ caseId: `CASE-API-S${n}`, patientId: 'PT-API-E', status: 'pending_approve', reportText: REPORT });
      }
      assert.strictEqual(await Case.countDocuments({}), 3);
      assert.strictEqual(await Case.countDocuments({ shareToken: { $exists: true } }), 0, 'no case stores an empty token');
    });

    await test('a radiologist can share two endorsed reports and revoke both', async () => {
      const links = [];
      for (const id of ['CASE-API-S1', 'CASE-API-S2']) {
        assert.strictEqual((await api('POST', `/api/cases/${id}/finalize`, { token: tokens.radiologist })).status, 200);
        const shared = await api('POST', `/api/cases/${id}/share`, { token: tokens.radiologist });
        assert.strictEqual(shared.status, 200, JSON.stringify(shared.body));
        assert.ok(shared.body.token);
        links.push(shared.body.token);
      }
      assert.notStrictEqual(links[0], links[1]);
      for (const id of ['CASE-API-S1', 'CASE-API-S2']) {
        const revoked = await api('DELETE', `/api/cases/${id}/share`, { token: tokens.radiologist });
        assert.strictEqual(revoked.status, 200, JSON.stringify(revoked.body));
      }
      assert.strictEqual(await Case.countDocuments({ shareToken: { $exists: true } }), 0);
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await db.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
