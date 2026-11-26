// scripts/test-patient-portal.cjs
//
// The patient portal's server side: GET /api/appointments.
//
//   - a patient sees their own appointments only, newest first, and only a small allow-list of fields;
//   - another patient's appointments, other roles and anonymous callers get nothing.
//
// Real routes and a throwaway in-memory MongoDB. It never reads backend/.env.
//
//   node scripts/test-patient-portal.cjs

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { startTestDb } = require('./lib/test-db.cjs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(24).toString('hex');
process.env.BOOKING_UTC_OFFSET = '+08:00';
for (const key of Object.keys(process.env)) {
  if (/^(AZURE_OPENAI|ACS_|NCBI_|AGENT_)/.test(key)) delete process.env[key];
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

function buildApp() {
  const app = express();
  app.set('etag', false);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/auth', backend('routes/auth'));
  app.use('/api/cases', backend('routes/cases'));
  app.use('/api/appointments', backend('routes/appointments'));
  app.use('*', (req, res, next) => next(backend('utils/ApiError').notFound(`Route ${req.originalUrl} not found`)));
  app.use(backend('middleware/errorHandler'));
  return app;
}

(async () => {
  const db = await startTestDb();
  const User = backend('models/User');
  const Patient = backend('models/Patient');
  const Case = backend('models/Case');
  await db.ensureIndexes();

  const server = http.createServer(buildApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(method, url, { token } = {}) {
    const res = await fetch(base + url, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    let body = null;
    try { body = await res.json(); } catch { /* an empty body */ }
    return { status: res.status, body };
  }

  const tokens = {};
  async function makeUser(key, fields) {
    const password = crypto.randomBytes(9).toString('base64url');
    await User.create({ userId: `${key.toUpperCase()}-A`, username: `ap-${key}`, email: `ap-${key}@radassist.test`, name: `Test ${key}`, password, ...fields });
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: `ap-${key}`, password }) });
    tokens[key] = (await res.json()).token;
  }
  for (const role of ['admin', 'radiologist', 'technician', 'doctor']) await makeUser(role, { role });
  await Patient.create({ patientId: 'PT-1', firstName: 'Mei', lastName: 'Chen', name: 'Mei Chen' });
  await Patient.create({ patientId: 'PT-2', firstName: 'Other', lastName: 'Person', name: 'Other Person' });
  await Patient.create({ patientId: 'PT-3', firstName: 'Nobody', lastName: 'Booked', name: 'Nobody Booked' });
  await makeUser('patient', { role: 'patient', patientId: 'PT-1' });
  await makeUser('patient2', { role: 'patient', patientId: 'PT-2' });
  await makeUser('patient3', { role: 'patient', patientId: 'PT-3' });

  const mk = (caseId, patientId, extra = {}) => Case.create({
    caseId, patientId, patientName: patientId === 'PT-1' ? 'Mei Chen' : 'Other Person', status: 'requested',
    history: 'HISTORY-MARKER cough', clinicalReason: 'REASON-MARKER', requestedByName: 'DOCTOR-MARKER', examRoom: 'ROOM-MARKER',
    reportText: 'REPORT-MARKER', ...extra,
  });
  // Hospital time is +08:00: 2026-12-01 09:30 there is 01:30 UTC.
  await mk('CASE-A-BOOKED', 'PT-1', { scheduledAt: new Date('2026-12-01T09:30:00+08:00') });
  await mk('CASE-A-CHECKED', 'PT-1', { scheduledAt: new Date('2026-11-20T14:00:00+08:00'), arrival: { at: new Date('2026-11-20T05:50:00Z') } });
  await mk('CASE-A-DONE', 'PT-1', { scheduledAt: new Date('2026-10-27T10:00:00+08:00'), status: 'finalized', view: 'AP' });
  await mk('CASE-A-REVIEW', 'PT-1', { scheduledAt: new Date('2026-09-14T11:00:00+08:00'), status: 'pending_approve', view: 'PA' });
  await mk('CASE-A-WALKIN', 'PT-1', { status: 'finalized' }); // never booked: not an appointment
  await mk('CASE-B-BOOKED', 'PT-2', { scheduledAt: new Date('2026-12-02T10:00:00+08:00') });

  const P = (key = 'patient') => ({ token: tokens[key] });

  console.log('\n=== my appointments ===');
  await test('a patient gets their own appointments, newest first, and not the case booked for someone else', async () => {
    const res = await api('GET', '/api/appointments', P());
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.total, 4);
    assert.deepStrictEqual(res.body.appointments.map((a) => a.date), ['2026/12/01', '2026/11/20', '2026/10/27', '2026/09/14']);
  });

  await test('each appointment has a date, a time (hospital time), the exam view and a plain status', async () => {
    const rows = (await api('GET', '/api/appointments', P())).body.appointments;
    assert.deepStrictEqual(rows.map((a) => a.time), ['09:30', '14:00', '10:00', '11:00']);
    assert.deepStrictEqual(rows.map((a) => a.status), ['booked', 'checked in', 'completed', 'completed']);
    assert.deepStrictEqual(rows.map((a) => a.view), ['', '', 'AP', 'PA']);
  });

  await test('a case that was never booked into a slot is not an appointment', async () => {
    const rows = (await api('GET', '/api/appointments', P())).body.appointments;
    assert.strictEqual(rows.length, 4);
  });

  await test('only the allow-listed fields come back: no case ID, reason, history, staff, room or report', async () => {
    const res = await api('GET', '/api/appointments', P());
    for (const a of res.body.appointments) {
      assert.deepStrictEqual(Object.keys(a).sort(), ['date', 'scheduledAt', 'status', 'time', 'view']);
    }
    const text = JSON.stringify(res.body);
    for (const secret of ['CASE-', 'HISTORY-MARKER', 'REASON-MARKER', 'DOCTOR-MARKER', 'ROOM-MARKER', 'REPORT-MARKER', 'PT-2', 'Other Person']) {
      assert.ok(!text.includes(secret), `${secret} reached the patient`);
    }
  });

  await test('another patient sees only their own appointment, and a patient with none gets an empty list', async () => {
    const two = (await api('GET', '/api/appointments', P('patient2'))).body;
    assert.strictEqual(two.total, 1);
    assert.strictEqual(two.appointments[0].date, '2026/12/02');
    const three = (await api('GET', '/api/appointments', P('patient3'))).body;
    assert.deepStrictEqual(three.appointments, []);
  });

  await test('no query string can widen the list', async () => {
    for (const q of ['?patientId=PT-2', '?patientId=.*', '?patientId[$ne]=x', '?status=all']) {
      const res = await api('GET', `/api/appointments${q}`, P());
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.total, 4, q);
    }
  });

  await test('staff and anonymous callers cannot use the patient route', async () => {
    for (const role of ['admin', 'radiologist', 'technician', 'doctor']) {
      assert.strictEqual((await api('GET', '/api/appointments', P(role))).status, 403, role);
    }
    assert.strictEqual((await api('GET', '/api/appointments')).status, 401);
  });

  await test('a patient still cannot use any other case route', async () => {
    assert.strictEqual((await api('GET', '/api/cases/availability', P())).status, 403);
    assert.strictEqual((await api('POST', '/api/cases/request', P())).status, 403);
  });

  server.close();
  await db.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
