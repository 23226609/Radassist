// utils/patientId.js
// Patient numbers: PT-{year}-{nnnn}, for example PT-2026-0086.
//
// The next number comes from one atomic $inc on a counter document, not from
// "highest existing + 1", so two patients created at the same moment cannot
// get the same number. The counter is seeded once from the highest number
// already in use, so existing patients keep their ids and new ones continue
// after them.

const Case = require('../models/Case');
const Counter = require('../models/Counter');
const Patient = require('../models/Patient');
const { escapeRegex } = require('./recordSync');

const WIDTH = 4;

const prefixFor = (year) => `PT-${year}-`;
const counterIdFor = (year) => `patient-${year}`;

// The highest PT-{year}-nnnn already stored on a patient or a study.
async function highestInUse(prefix) {
  const re = new RegExp(`^${escapeRegex(prefix)}\\d+$`, 'i');
  const [fromPatients, fromCases] = await Promise.all([
    Patient.find({ patientId: re }).select('patientId').lean(),
    Case.find({ patientId: re }).select('patientId').lean(),
  ]);
  const nums = [...fromPatients.map((p) => p.patientId), ...fromCases.map((c) => c.patientId)]
    .map((id) => parseInt(String(id).slice(prefix.length), 10))
    .filter((n) => Number.isFinite(n));
  return nums.length ? Math.max(...nums) : 0;
}

// Create the counter at the current maximum if it does not exist yet. The
// upsert only writes on insert, so when two requests seed at once the first
// one wins and the second changes nothing.
async function ensureCounter(year) {
  const _id = counterIdFor(year);
  if (await Counter.exists({ _id })) return;
  const start = await highestInUse(prefixFor(year));
  try {
    await Counter.updateOne({ _id }, { $setOnInsert: { seq: start } }, { upsert: true });
  } catch (err) {
    if (err?.code !== 11000) throw err; // another request seeded it first
  }
}

// The next free number for this year. Each call advances the counter by one,
// atomically.
async function nextPatientId(now = new Date()) {
  const year = now.getFullYear();
  await ensureCounter(year);
  const counter = await Counter.findOneAndUpdate(
    { _id: counterIdFor(year) },
    { $inc: { seq: 1 } },
    { new: true }
  );
  return `${prefixFor(year)}${String(counter.seq).padStart(WIDTH, '0')}`;
}

module.exports = { nextPatientId, ensureCounter, highestInUse, prefixFor, counterIdFor };
