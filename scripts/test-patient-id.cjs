// scripts/test-patient-id.cjs
//
// Patient numbers (PT-{year}-nnnn) come from an atomic counter, so patients
// created at the same moment never share a number. Runs against a throwaway
// in-memory MongoDB, never the development database.
//
//   node scripts/test-patient-id.cjs

const assert = require('assert');
const { startTestDb } = require('./lib/test-db.cjs');

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

// Call an Express handler the way the router does, without a server.
function call(handler, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    handler(req, res, (error) => resolve({ error }));
  });
}

const technician = { role: 'technician', userId: 'tech-1', name: 'Jamie Lee' };
const create = (body) => ({ user: technician, body: { firstName: 'Test', lastName: 'Patient', age: '40', sex: 'Female', ...body } });
const YEAR = new Date().getFullYear();
const ID_FORMAT = new RegExp(`^PT-${YEAR}-\\d{4}$`);

(async () => {
  const db = await startTestDb();
  const Patient = require('../backend/models/Patient');
  const Case = require('../backend/models/Case');
  const Counter = require('../backend/models/Counter');
  const { nextPatientId } = require('../backend/utils/patientId');
  const { createPatient } = require('../backend/controllers/patientController');
  await db.ensureIndexes();

  const seed = async (patientId, name = 'Existing Patient') => Patient.create({ patientId, name, firstName: 'Existing', lastName: 'Patient' });

  try {
    console.log('\n=== patient numbers ===');

    await test('two patients created at the same moment get different numbers', async () => {
      await db.clear();
      const [a, b] = await Promise.all([call(createPatient, create({})), call(createPatient, create({}))]);
      assert.ok(!a.error && !b.error, `create failed: ${a.error?.message || b.error?.message}`);
      assert.strictEqual(a.status, 201);
      assert.strictEqual(b.status, 201);
      assert.notStrictEqual(a.body.patient.patientId, b.body.patient.patientId);
      assert.match(a.body.patient.patientId, ID_FORMAT);
      assert.match(b.body.patient.patientId, ID_FORMAT);
      assert.strictEqual(await Patient.countDocuments({}), 2);
    });

    await test('twenty patients created at once all get different, consecutive numbers', async () => {
      await db.clear();
      const results = await Promise.all(Array.from({ length: 20 }, () => call(createPatient, create({}))));
      assert.ok(results.every((r) => !r.error && r.status === 201), 'every create should succeed');
      const ids = results.map((r) => r.body.patient.patientId);
      assert.strictEqual(new Set(ids).size, 20, 'no number is handed out twice');
      const nums = ids.map((id) => Number(id.slice(-4))).sort((x, y) => x - y);
      assert.deepStrictEqual(nums, Array.from({ length: 20 }, (_, i) => i + 1), 'numbers run 0001 to 0020 with no gap');
      assert.strictEqual(await Patient.countDocuments({}), 20);
    });

    await test('the format stays PT-year-nnnn with four digits', async () => {
      await db.clear();
      assert.strictEqual(await nextPatientId(new Date('2026-03-01T00:00:00Z')), 'PT-2026-0001');
      assert.strictEqual(await nextPatientId(new Date('2026-03-01T00:00:00Z')), 'PT-2026-0002');
    });

    await test('the counter starts after the highest number already in use and existing ids are kept', async () => {
      await db.clear();
      await seed('PT-2026-0085');
      await seed('PT-2025-1107');
      // A study can hold a number that has no patient record yet.
      await Case.collection.insertOne({ caseId: 'CASE-OLD', patientId: 'PT-2026-0090' });
      assert.strictEqual(await nextPatientId(new Date('2026-06-01T00:00:00Z')), 'PT-2026-0091');
      assert.ok(await Patient.findOne({ patientId: 'PT-2026-0085' }), 'existing patient keeps its id');
      assert.ok(await Patient.findOne({ patientId: 'PT-2025-1107' }), 'an older year keeps its id');
    });

    await test('another year has its own counter and starts again at 0001', async () => {
      await db.clear();
      await seed('PT-2026-0085');
      assert.strictEqual(await nextPatientId(new Date('2026-06-01T00:00:00Z')), 'PT-2026-0086');
      assert.strictEqual(await nextPatientId(new Date('2027-01-02T00:00:00Z')), 'PT-2027-0001');
    });

    await test('many first calls at once, before any counter exists, give no duplicates', async () => {
      await db.clear();
      await seed('PT-2026-0085');
      const date = new Date('2026-06-01T00:00:00Z');
      const ids = await Promise.all(Array.from({ length: 12 }, () => nextPatientId(date)));
      assert.strictEqual(new Set(ids).size, 12);
      assert.strictEqual(Math.min(...ids.map((id) => Number(id.slice(-4)))), 86, 'continues after 0085');
      assert.strictEqual(await Counter.countDocuments({ _id: 'patient-2026' }), 1, 'one counter document');
    });

    await test('a number someone typed by hand is skipped, not reused', async () => {
      await db.clear();
      const first = await call(createPatient, create({}));
      const n = Number(first.body.patient.patientId.slice(-4));
      const taken = `PT-${YEAR}-${String(n + 1).padStart(4, '0')}`;
      await seed(taken);
      const next = await call(createPatient, create({}));
      assert.ok(!next.error);
      assert.strictEqual(next.body.patient.patientId, `PT-${YEAR}-${String(n + 2).padStart(4, '0')}`);
    });

    await test('a patient number typed in the form is used as typed, and a taken one is refused', async () => {
      await db.clear();
      const typed = await call(createPatient, create({ patientId: 'PT-HAND-1' }));
      assert.strictEqual(typed.status, 201);
      assert.strictEqual(typed.body.patient.patientId, 'PT-HAND-1');
      const again = await call(createPatient, create({ patientId: 'pt-hand-1' }));
      assert.ok(again.error, 'second create is refused');
      assert.strictEqual(again.error.statusCode, 400);
      assert.ok(/already exists/.test(again.error.message));
    });

    await test('two creates with the same typed number: one is made, the other refused', async () => {
      await db.clear();
      const results = await Promise.all([
        call(createPatient, create({ patientId: 'PT-HAND-2' })),
        call(createPatient, create({ patientId: 'PT-HAND-2' })),
      ]);
      assert.strictEqual(results.filter((r) => r.status === 201).length, 1);
      const refused = results.find((r) => r.error);
      assert.ok(refused, 'the loser is refused');
      assert.strictEqual(refused.error.statusCode, 400);
      assert.strictEqual(await Patient.countDocuments({ patientId: 'PT-HAND-2' }), 1);
    });

    await test('the database itself rejects a second patient with the same number', async () => {
      await db.clear();
      const indexes = await Patient.collection.indexes();
      assert.ok(indexes.some((i) => i.key.patientId === 1 && i.unique), 'unique index on patientId');
      await seed('PT-2026-0500');
      await assert.rejects(() => seed('PT-2026-0500'), (err) => err.code === 11000);
    });
  } finally {
    await db.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
