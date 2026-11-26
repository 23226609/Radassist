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
  app.use('/api/share', backend('routes/share'));
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

    console.log('\n=== history reasoning (POST /api/cases/:id/reason) ===');

    // Azure is faked: any call to *.openai.azure.com is answered here and recorded.
    const realFetch = globalThis.fetch;
    const azureCalls = [];
    let azureReply = null;
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes('openai.azure.com')) return realFetch(url, init);
      const body = JSON.parse(init.body);
      azureCalls.push(body);
      const reply = typeof azureReply === 'function' ? azureReply(body) : azureReply;
      if (reply && reply.__status) {
        return new Response(JSON.stringify({ error: { message: 'upstream said no' } }), { status: reply.__status });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const useAzure = (on) => {
      for (const key of ['ENDPOINT', 'KEY', 'DEPLOYMENT']) {
        if (on) process.env[`AZURE_OPENAI_${key}`] = key === 'ENDPOINT' ? 'https://fake.openai.azure.com' : 'test';
        else delete process.env[`AZURE_OPENAI_${key}`];
      }
    };
    const GOOD_REPLY = {
      summary: 'Three days of cough and fever in a smoker.',
      differentials: [
        { diagnosis: 'Community-acquired pneumonia', supporting: ['Fever', 'Cough'], against: [], confidence: 'MEDIUM' },
        { diagnosis: '', supporting: [], against: [], confidence: 'high' },
      ],
      questions_for_doctor: ['Any recent travel?'],
      invented_field: 'must be dropped',
    };

    try {
      await resetData();
      await Patient.create({
        patientId: 'PT-API-R', firstName: 'Api', lastName: 'PatientR', name: 'Api PatientR', age: '60', sex: 'Male',
        history: 'Smoker for 30 years.', medicines: 'Salbutamol inhaler', labResults: 'CRP 80 mg/L',
      });
      await Case.create({
        caseId: 'CASE-API-R1', patientId: 'PT-API-R', status: 'pending_approve', history: 'Cough and fever for three days',
        reportText: 'FINDINGS\nThe lungs are clear.', analysisState: 'done',
      });
      await Case.create({
        caseId: 'CASE-API-R0', patientId: 'PT-API-R', status: 'finalized', finalizedAt: new Date('2026-01-02'),
        reportText: 'FINDINGS\nOld right lower zone scarring.\n\nCOMMENT\n– Stable.',
      });

      await test('a technician and a referring doctor get 403, and Azure is never called', async () => {
        useAzure(true);
        azureReply = GOOD_REPLY;
        for (const role of ['technician', 'doctor']) {
          const res = await api('POST', '/api/cases/CASE-API-R1/reason', { token: tokens[role] });
          assert.strictEqual(res.status, 403, `${role} must not run history reasoning`);
        }
        assert.strictEqual((await api('POST', '/api/cases/CASE-API-R1/reason')).status, 401);
        assert.strictEqual(azureCalls.length, 0);
        assert.strictEqual((await Case.findOne({ caseId: 'CASE-API-R1' })).historyAnalysis, null);
      });

      await test('without Azure settings it is a 400 and nothing is saved', async () => {
        useAzure(false);
        const res = await api('POST', '/api/cases/CASE-API-R1/reason', { token: tokens.radiologist });
        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /not configured/i);
        assert.strictEqual((await Case.findOne({ caseId: 'CASE-API-R1' })).historyAnalysis, null);
      });

      await test('an unknown case is 404', async () => {
        useAzure(true);
        const res = await api('POST', '/api/cases/CASE-API-NONE/reason', { token: tokens.radiologist });
        assert.strictEqual(res.status, 404);
      });

      await test('a radiologist gets the parsed JSON, stored on the case as an object', async () => {
        useAzure(true);
        azureReply = GOOD_REPLY;
        const res = await api('POST', '/api/cases/CASE-API-R1/reason', { token: tokens.radiologist });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const h = res.body.historyAnalysis;
        assert.strictEqual(h.summary, GOOD_REPLY.summary);
        assert.strictEqual(h.differentials.length, 1, 'a differential with no diagnosis is dropped');
        assert.strictEqual(h.differentials[0].confidence, 'medium');
        assert.deepStrictEqual(h.questions_for_doctor, ['Any recent travel?']);
        assert.strictEqual(h.invented_field, undefined);
        const saved = (await Case.findOne({ caseId: 'CASE-API-R1' }).lean()).historyAnalysis;
        assert.strictEqual(typeof saved, 'object');
        assert.strictEqual(saved.differentials[0].diagnosis, 'Community-acquired pneumonia');
        assert.strictEqual(res.body.case.historyAnalysis.summary, GOOD_REPLY.summary);
      });

      await test('the prompt is filled from the database and never includes this case\'s own report', async () => {
        const sent = azureCalls[azureCalls.length - 1];
        const prompt = sent.messages[0].content;
        assert.ok(prompt.startsWith('You are a clinical reasoning assistant. Use ONLY the patient history below.'));
        assert.match(prompt, /Smoker for 30 years\./);
        assert.match(prompt, /Cough and fever for three days/);
        assert.match(prompt, /Medications: Salbutamol inhaler/);
        assert.match(prompt, /Lab results: CRP 80 mg\/L/);
        assert.match(prompt, /Old right lower zone scarring/, 'the earlier endorsed report is a prior report');
        assert.ok(!/The lungs are clear/.test(prompt), 'this case\'s own draft is not sent');
        assert.ok(!/\{(history|medicines|labResults|priorReports)\}/.test(prompt), 'no placeholder is left');
        assert.deepStrictEqual(sent.response_format, { type: 'json_object' });
      });

      await test('an admin may call it, and a thin chart is sent as "Not recorded"', async () => {
        await Case.create({ caseId: 'CASE-API-R2', patientId: 'PT-API-NOPE', status: 'pending_approve' });
        azureReply = { summary: 'History is thin.', differentials: [], questions_for_doctor: [] };
        const res = await api('POST', '/api/cases/CASE-API-R2/reason', { token: tokens.admin });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        const prompt = azureCalls[azureCalls.length - 1].messages[0].content;
        assert.match(prompt, /Patient history:\nNot recorded\nMedications: Not recorded\nLab results: Not recorded\nPrior reports: Not recorded/);
      });

      await test('an Azure answer with no summary is a 400 and is not stored', async () => {
        azureReply = { differentials: [] };
        const res = await api('POST', '/api/cases/CASE-API-R2/reason', { token: tokens.radiologist });
        assert.strictEqual(res.status, 400);
        assert.strictEqual((await Case.findOne({ caseId: 'CASE-API-R2' })).historyAnalysis.summary, 'History is thin.');
      });

      await test('the History LLM output is hidden from a technician and a referring doctor', async () => {
        await Case.updateOne({ caseId: 'CASE-API-R1' }, { $set: { status: 'finalized' } });
        const doctor = await api('GET', '/api/cases/CASE-API-R1', { token: tokens.doctor });
        assert.strictEqual(doctor.status, 200);
        assert.strictEqual(doctor.body.case.historyAnalysis, undefined);
        await Case.updateOne({ caseId: 'CASE-API-R1' }, { $set: { status: 'requested' } });
        const tech = await api('GET', '/api/cases/CASE-API-R1', { token: tokens.technician });
        assert.strictEqual(tech.status, 200);
        assert.strictEqual(tech.body.case.historyAnalysis, undefined);
        const rad = await api('GET', '/api/cases/CASE-API-R1', { token: tokens.radiologist });
        assert.ok(rad.body.case.historyAnalysis.summary);
      });

      console.log('\n=== second opinion (POST /api/cases/:id/second-opinion) ===');

      // A 1x1 PNG stands in for the film.
      const FILM = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
      const { bucket } = backend('controllers/_gridfs');
      async function storeFilm(contentType = 'image/png') {
        const up = bucket('images').openUploadStream('film.png', { contentType });
        await new Promise((resolve, reject) => up.end(FILM, (err) => (err ? reject(err) : resolve())));
        return up.id;
      }
      const isSecondOpinion = (body) => /independent second-opinion AI/.test(body.messages[0].content);
      const isHistory = (body) => /clinical reasoning assistant/.test(body.messages[0].content);
      const SO_REPLY = {
        summary: 'The film and the history together suggest a right lower zone infection.',
        diagnosis: 'Right lower lobe pneumonia',
        differentials: [
          { diagnosis: 'Pneumonia', supporting: ['Fever', 'Cough'], against: ['No sputum result'], confidence: 'HIGH' },
          { diagnosis: '', supporting: [], against: [], confidence: 'low' },
          { diagnosis: 'Atelectasis', supporting: ['Volume loss'], against: [], confidence: 'certain' },
        ],
        suggested_next_step: 'Compare with the earlier film. Ask for a sputum culture.',
        recommendation: 'must be dropped',
        agreed: [{ tagKey: 't1' }],
      };
      const soReply = (body) => (isSecondOpinion(body) ? SO_REPLY : GOOD_REPLY);
      const secondAs = (id, role = 'radiologist', sepsisScreen) => api('POST', `/api/cases/${id}/second-opinion`, {
        token: tokens[role],
        body: sepsisScreen === undefined ? {} : { sepsisScreen },
      });
      const stored = (id) => Case.findOne({ caseId: id }).lean();
      const lastSecond = () => azureCalls.filter(isSecondOpinion).pop();

      await Patient.create({
        patientId: 'PT-API-S', firstName: 'Api', lastName: 'PatientS', name: 'Api PatientS', age: '64', sex: 'Female',
        history: 'Ex-smoker with COPD.', medicines: 'Tiotropium; amoxicillin', labResults: 'WBC 16.2; CRP 120 mg/L',
        observations: [
          { at: '2026-11-20T01:00:00.000Z', hr: '88', rr: '18', sbp: '120', spo2: '97', temp: '37.0' },
          { at: '2026-11-20T02:00:00.000Z', hr: '96', rr: '20', sbp: '112', spo2: '95', temp: '37.6' },
          { at: '2026-11-20T03:00:00.000Z', hr: '104', rr: '24', sbp: '104', spo2: '93', temp: '38.2' },
          { at: '2026-11-20T04:00:00.000Z', hr: '112', rr: '26', sbp: '98', spo2: '90', temp: '38.6' },
        ],
      });
      for (const [n, day] of [[1, '2025-01-05'], [2, '2025-02-05'], [3, '2025-03-05'], [4, '2025-04-05']]) {
        await Case.create({ caseId: `CASE-API-SP${n}`, patientId: 'PT-API-S', status: 'finalized', finalizedAt: new Date(day),
          reportText: `FINDINGS\nPrior study number ${n} showed hyperinflation.` });
      }
      const filmId = await storeFilm();
      const CURV_MARK = 'ZZCURVMARKER';
      const mkCase = (caseId, extra = {}) => Case.create({
        caseId, patientId: 'PT-API-S', status: 'pending_approve', analysisState: 'done', imageId: filmId,
        history: 'Cough and fever for three days',
        reportText: `FINDINGS\n${CURV_MARK} right lower zone consolidation.\n\nCOMMENT\n– ${CURV_MARK} comment line.`,
        findingTags: [{ key: 't1', text: `${CURV_MARK} right lower zone consolidation.`, abnormal: true }],
        findings: [{ label: 'ZZBOXLABEL', bbox: [11.5, 52.25, 31.75, 22.5], tagKey: 't1', status: 'pending', source: 'Azure' }],
        ...extra,
      });
      await mkCase('CASE-API-S1');

      await test('a technician and a referring doctor get 403, an anonymous caller 401, and Azure is never called', async () => {
        useAzure(true);
        azureReply = soReply;
        azureCalls.length = 0;
        for (const role of ['technician', 'doctor']) {
          assert.strictEqual((await secondAs('CASE-API-S1', role)).status, 403, role);
        }
        assert.strictEqual((await api('POST', '/api/cases/CASE-API-S1/second-opinion')).status, 401);
        assert.strictEqual(azureCalls.length, 0);
        assert.strictEqual((await stored('CASE-API-S1')).fusionResult, null);
      });

      await test('without Azure settings it is a 400; an unknown case is 404', async () => {
        useAzure(false);
        const res = await secondAs('CASE-API-S1');
        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /not configured/i);
        useAzure(true);
        assert.strictEqual((await secondAs('CASE-API-NONE')).status, 404);
      });

      await test('no film, a report still generating, or no saved draft is a 400 and Azure is not called', async () => {
        await mkCase('CASE-API-S2', { imageId: null });
        await mkCase('CASE-API-S3', { analysisState: 'running' });
        await mkCase('CASE-API-S4', { reportText: '', findingTags: [] });
        azureCalls.length = 0;
        for (const [id, why] of [['CASE-API-S2', /no x-ray image/i], ['CASE-API-S3', /still generating/i], ['CASE-API-S4', /no saved draft/i]]) {
          const res = await secondAs(id);
          assert.strictEqual(res.status, 400, id);
          assert.match(res.body.error, why);
        }
        assert.strictEqual(azureCalls.length, 0);
      });

      await test('a film Azure cannot read (wrong type) is a 400 and nothing is stored', async () => {
        const tiff = await storeFilm('image/tiff');
        await mkCase('CASE-API-S5', { imageId: tiff });
        const res = await secondAs('CASE-API-S5');
        assert.strictEqual(res.status, 400);
        assert.match(res.body.error, /x-ray image/i);
        assert.strictEqual((await stored('CASE-API-S5')).fusionResult, null);
      });

      await test('a radiologist gets the answer, stored on Case.fusionResult as an object with only the documented keys', async () => {
        azureCalls.length = 0;
        const res = await secondAs('CASE-API-S1');
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(azureCalls.length, 1, 'one call: no History step, no merge');
        const so = res.body.secondOpinion;
        assert.deepStrictEqual(Object.keys(so).sort(), ['differentials', 'diagnosis', 'generatedAt', 'suggested_next_step', 'summary'].sort());
        assert.strictEqual(so.diagnosis, 'Right lower lobe pneumonia');
        assert.deepStrictEqual(so.differentials.map((d) => [d.diagnosis, d.confidence]), [['Pneumonia', 'high'], ['Atelectasis', 'low']],
          'a differential with no name is dropped; an unknown confidence becomes low');
        const saved = (await stored('CASE-API-S1')).fusionResult;
        assert.strictEqual(typeof saved, 'object');
        assert.strictEqual(saved.suggested_next_step, SO_REPLY.suggested_next_step);
        assert.strictEqual(saved.recommendation, undefined);
        assert.strictEqual(saved.agreed, undefined);
        assert.deepStrictEqual(res.body.case.fusionResult, saved.generatedAt ? { ...saved, generatedAt: res.body.case.fusionResult.generatedAt } : saved);
      });

      await test('the prompt is the exact second-opinion prompt, with the film attached', async () => {
        const sent = lastSecond();
        const prompt = sent.messages[0].content;
        assert.ok(prompt.startsWith("You are an independent second-opinion AI for a chest X-ray case. You have NOT seen any other AI's report for this case. Do not invent symptoms, tests, or diagnoses that are not in the inputs. Use the actual lab values given — if CRP is elevated, do NOT say inflammatory markers are normal.\n\nImage: [the chest X-ray image]\nPatient history: "));
        assert.match(prompt, /Return JSON only, and keep the whole output under 120 words:/);
        assert.match(prompt, /"summary": "At most 2 sentences\. What the image and history together suggest\. Do not repeat the diagnosis here\."/);
        assert.match(prompt, /"diagnosis": "One line only\./);
        assert.match(prompt, /\["one short phrase only"\], "against": \["one short phrase only"\]/);
        assert.match(prompt, /"suggested_next_step": "At most 2 sentences\. What the radiologist should do next\."/);
        assert.match(prompt, /Rules: at most 3 differentials\. Each supporting \/ against entry is one short phrase, not a sentence\./);
        assert.match(prompt, /Sepsis screen: .* — this is a frontend-calculated screening score, not a diagnosis\. Use it only as one signal\./);
        assert.ok(prompt.endsWith("Never state a diagnosis as certain. Never invent a finding that is not in the image or history."));
        assert.ok(!/\{(history|medicines|labResults|priorReports|observations|sepsisScreen)\}/.test(prompt), 'no placeholder is left');
        const user = sent.messages[1].content;
        assert.ok(Array.isArray(user));
        const image = user.find((p) => p.type === 'image_url');
        assert.ok(image.image_url.url.startsWith('data:image/png;base64,'), 'the film itself is sent');
        assert.strictEqual(Buffer.from(image.image_url.url.split(',')[1], 'base64').length > 0, true);
        assert.deepStrictEqual(sent.response_format, { type: 'json_object' });
      });

      await test('it is given the chart: history, medicines, labs, the 3 newest prior reports and the latest observations with times', async () => {
        const prompt = lastSecond().messages[0].content;
        assert.match(prompt, /Patient history: Ex-smoker with COPD\.\nCough and fever for three days/);
        assert.match(prompt, /Medications: Tiotropium; amoxicillin/);
        assert.match(prompt, /Lab results: WBC 16\.2; CRP 120 mg\/L/);
        assert.match(prompt, /2025-04-05: FINDINGS Prior study number 4/);
        assert.match(prompt, /2025-03-05: FINDINGS Prior study number 3/);
        assert.match(prompt, /2025-02-05: FINDINGS Prior study number 2/);
        assert.ok(!/Prior study number 1/.test(prompt), 'only 3 prior reports');
        const obs = prompt.match(/Observations: ([\s\S]*?)\nSepsis screen:/)[1].split('\n');
        assert.strictEqual(obs.length, 3, 'the latest three readings');
        assert.strictEqual(obs[0], '- 2026-11-20T04:00:00.000Z: heart rate 112 bpm, temperature 38.6 °C, systolic blood pressure 98 mmHg, respiratory rate 26/min');
        assert.match(obs[2], /^- 2026-11-20T02:00:00\.000Z: heart rate 96 bpm/);
        assert.ok(!/2026-11-20T01:00/.test(prompt), 'the oldest reading is left out');
        assert.ok(!/spo2|SpO/i.test(obs.join('\n')), 'only the four listed observations');
      });

      await test('it never receives CURV\'s findings, this case\'s report, the sentence tags or the Azure boxes', async () => {
        const sent = JSON.stringify(lastSecond());
        assert.ok(!sent.includes(CURV_MARK), 'no CURV text');
        assert.ok(!/right lower zone consolidation/i.test(sent), 'no report wording');
        assert.ok(!/ZZBOXLABEL|11\.5|52\.25|31\.75/.test(sent), 'no box label or coordinates');
        assert.ok(!/FINDINGS\\nZZ|COMMENT/.test(sent), 'no report layout');
        // Even a history field that happened to hold the report text would be only the history; the
        // report itself is never read.
        const c = await Case.findOne({ caseId: 'CASE-API-S1' }).lean();
        assert.ok(c.reportText.includes(CURV_MARK) && c.findingTags[0].text.includes(CURV_MARK));
      });

      await test('the sepsis screen is passed on as one signal, and a hostile one is cleaned', async () => {
        await secondAs('CASE-API-S1', 'radiologist', { level: 'urgent', score: 52.4, reasons: ['Respiratory rate ≥25 breaths/min', 'SpO₂ ≤91%'] });
        assert.match(lastSecond().messages[0].content, /Sepsis screen: Urgent review, teaching score 52% \(Respiratory rate ≥25 breaths\/min; SpO₂ ≤91%\) — this is a frontend-calculated/);
        for (const bad of [undefined, null, 'urgent', 7, { level: 'definitely sepsis' }, { level: ['urgent'] }, { score: 90 }]) {
          await secondAs('CASE-API-S1', 'radiologist', bad);
          assert.match(lastSecond().messages[0].content, /Sepsis screen: Not available — this is a frontend/, JSON.stringify(bad));
        }
        await secondAs('CASE-API-S1', 'radiologist', { level: 'abnormal', score: 999, reasons: ['x'.repeat(500), ...Array(20).fill('r')] });
        const line = lastSecond().messages[0].content.match(/Sepsis screen: (.*?) — this is/)[1];
        assert.ok(line.startsWith('Abnormal observations — review (') && !/teaching score/.test(line), 'a score outside 0-100 is dropped');
        assert.ok(line.length < 260, `reasons are clamped (${line.length})`);
      });

      await test('a thin chart is sent as "Not recorded"', async () => {
        await Case.create({ caseId: 'CASE-API-S6', patientId: 'PT-API-NOPE', status: 'pending_approve', analysisState: 'done', imageId: filmId,
          findingTags: [{ key: 't1', text: 'Opacity.', abnormal: true }] });
        assert.strictEqual((await secondAs('CASE-API-S6')).status, 200);
        assert.match(lastSecond().messages[0].content,
          /Patient history: Not recorded\nMedications: Not recorded\nLab results: Not recorded\nPrior reports: Not recorded\nObservations: Not recorded\nSepsis screen: Not available/);
      });

      await test('text in the chart that looks like a placeholder is not filled in a second time', async () => {
        await Patient.create({ patientId: 'PT-API-S2', name: 'Api S2', history: 'Pain {medicines} and $& here', medicines: 'Aspirin' });
        await Case.create({ caseId: 'CASE-API-S7', patientId: 'PT-API-S2', status: 'pending_approve', analysisState: 'done', imageId: filmId,
          findingTags: [{ key: 't1', text: 'x', abnormal: true }] });
        assert.strictEqual((await secondAs('CASE-API-S7')).status, 200);
        const prompt = lastSecond().messages[0].content;
        assert.ok(prompt.includes('Pain {medicines} and $& here'));
        assert.strictEqual(prompt.split('Aspirin').length - 1, 1);
      });

      await test('it changes nothing in the report, the boxes or the case status, and never finalises', async () => {
        const before = await stored('CASE-API-S1');
        await secondAs('CASE-API-S1');
        await secondAs('CASE-API-S1', 'admin');
        const after = await stored('CASE-API-S1');
        for (const key of ['status', 'reportText', 'findingTags', 'findings', 'remarks', 'comment', 'diagnosis', 'analysisState', 'boxesState', 'historyAnalysis', 'editLog']) {
          assert.deepStrictEqual(after[key], before[key], key);
        }
        assert.strictEqual(after.status, 'pending_approve');
        assert.ok(!after.finalizedBy && !after.finalizedAt, 'nobody is recorded as endorsing');
      });

      await test('it runs only when asked: saving a draft, the History step and loading the case never call it', async () => {
        azureCalls.length = 0;
        const put = await api('PUT', '/api/cases/CASE-API-S1', { token: tokens.radiologist, body: { remarks: 'draft saved' } });
        assert.strictEqual(put.status, 200);
        await api('GET', '/api/cases/CASE-API-S1', { token: tokens.radiologist });
        const keep = (await stored('CASE-API-S1')).fusionResult;
        azureReply = soReply;
        const reason = await api('POST', '/api/cases/CASE-API-S1/reason', { token: tokens.radiologist });
        assert.strictEqual(reason.status, 200, JSON.stringify(reason.body));
        assert.strictEqual(azureCalls.length, 1, 'History only');
        assert.ok(isHistory(azureCalls[0]));
        assert.ok(!azureCalls.some(isSecondOpinion));
        assert.strictEqual(reason.body.fusionResult, undefined);
        assert.strictEqual(reason.body.fusionError, undefined);
        const after = await stored('CASE-API-S1');
        assert.deepStrictEqual(after.fusionResult, keep, 'the History step leaves the second opinion alone');
        assert.ok(after.historyAnalysis.summary);
      });

      await test('the old Fusion merge is gone: no merging prompt is ever sent, and the old fusionReview is not stored', async () => {
        azureCalls.length = 0;
        await api('POST', '/api/cases/CASE-API-S1/reason', { token: tokens.radiologist });
        await secondAs('CASE-API-S1');
        assert.ok(!azureCalls.some((b) => /merging two independent analyses/.test(b.messages[0].content)));
        const res = await api('PUT', '/api/cases/CASE-API-S1', { token: tokens.radiologist, body: { fusionReview: { agreed: [{ status: 'accepted' }] } } });
        assert.strictEqual(res.status, 200);
        assert.strictEqual((await stored('CASE-API-S1')).fusionResult.review, undefined);
      });

      await test('Azure failing or answering badly is a 400 and the earlier opinion is kept', async () => {
        await secondAs('CASE-API-S1');
        const before = (await stored('CASE-API-S1')).fusionResult;
        for (const bad of [{ __status: 500 }, { ...SO_REPLY, summary: '' }, { ...SO_REPLY, diagnosis: '  ' }, { ...SO_REPLY, suggested_next_step: '' }, 'just text', null, [], 7]) {
          azureReply = bad;
          const res = await secondAs('CASE-API-S1');
          assert.strictEqual(res.status, 400, JSON.stringify(bad));
          assert.deepStrictEqual((await stored('CASE-API-S1')).fusionResult, before, JSON.stringify(bad));
        }
        azureReply = soReply;
      });

      await test('an admin can run it, a re-run replaces the old answer, and it works on an endorsed report without reopening it', async () => {
        azureReply = (body) => (isSecondOpinion(body) ? { ...SO_REPLY, diagnosis: 'No acute abnormality' } : GOOD_REPLY);
        assert.strictEqual((await secondAs('CASE-API-S1', 'admin')).status, 200);
        assert.strictEqual((await stored('CASE-API-S1')).fusionResult.diagnosis, 'No acute abnormality');
        await Case.updateOne({ caseId: 'CASE-API-S1' }, { $set: { status: 'finalized', finalizedAt: new Date(), finalizedBy: 'RAD' } });
        azureReply = soReply;
        assert.strictEqual((await secondAs('CASE-API-S1')).status, 200);
        const done = await stored('CASE-API-S1');
        assert.strictEqual(done.status, 'finalized');
        assert.strictEqual(done.fusionResult.diagnosis, 'Right lower lobe pneumonia');
      });

      await test('the second opinion reaches no one but the radiologist and admin: case, list, technician, doctor and share link', async () => {
        await Case.updateOne({ caseId: 'CASE-API-S1' }, { $set: { shareToken: 'share-tok-s1' } });
        const hidden = /fusionResult|historyAnalysis|suggested_next_step|Right lower lobe pneumonia/;
        assert.ok(!hidden.test(JSON.stringify((await api('GET', '/api/cases/CASE-API-S1', { token: tokens.doctor })).body)), 'doctor case');
        assert.ok(!hidden.test(JSON.stringify((await api('GET', '/api/cases', { token: tokens.doctor })).body)), 'doctor list');
        assert.ok(!hidden.test(JSON.stringify((await api('GET', '/api/cases', { token: tokens.technician })).body)), 'technician list');
        const shared = await api('GET', '/api/share/share-tok-s1');
        assert.strictEqual(shared.status, 200, JSON.stringify(shared.body));
        assert.ok(!hidden.test(JSON.stringify(shared.body)) && !/laySummary/.test(JSON.stringify(shared.body)), 'share link');
        const rad = await api('GET', '/api/cases/CASE-API-S1', { token: tokens.radiologist });
        assert.strictEqual(rad.body.case.fusionResult.diagnosis, 'Right lower lobe pneumonia');
      });

      await test('two runs at once leave one complete answer', async () => {
        await mkCase('CASE-API-S8');
        azureReply = soReply;
        const [a, b] = await Promise.all([secondAs('CASE-API-S8'), secondAs('CASE-API-S8')]);
        assert.deepStrictEqual([a.status, b.status], [200, 200]);
        const f = (await stored('CASE-API-S8')).fusionResult;
        assert.strictEqual(f.diagnosis, 'Right lower lobe pneumonia');
        assert.strictEqual(f.differentials.length, 2);
      });
    } finally {
      globalThis.fetch = realFetch;
      useAzure(false);
    }
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
