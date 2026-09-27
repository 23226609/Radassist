// Align existing Cosmos documents with technician / radiologist / doctor / admin.
//
//   cd backend && node scripts/migrate-workflow.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');
const Case = require('../models/Case');
const Patient = require('../models/Patient');
const { publicStatus } = require('../utils/caseStatus');

function storedAnalysisState(c) {
  if (c.analysisState === 'running') return 'running';
  const status = publicStatus(c.status);
  const hasReport = Boolean(String(c.reportText || '').trim());
  if (status === 'pending' && /generating report/i.test(String(c.diagnosis || ''))) return 'running';
  if (status === 'pending' && !hasReport) return 'none';
  if (hasReport || status === 'pending_approve' || status === 'finalized') return 'done';
  return 'none';
}

const TECH = {
  userId: 'USR-NURSE-0001',
  username: 'tech',
  name: 'Jamie Lee',
  role: 'technician',
  department: 'Radiology',
};

const USER_PATCHES = [
  { match: { username: 'nurse' }, set: TECH },
  { match: { userId: 'USR-NURSE-0001' }, set: TECH },
  { match: { username: 'priya' }, set: { role: 'radiologist', department: 'Radiology' } },
  { match: { username: 'marcus' }, set: { role: 'radiologist', department: 'Radiology' } },
  { match: { username: 'doctor' }, set: { role: 'doctor', department: 'Medicine' } },
  { match: { role: 'nurse' }, set: { role: 'technician' } },
];

const CHARTS = {
  'PT-2026-0018': { medicines: 'Amlodipine 5 mg daily; salbutamol inhaler', heartRate: '76 bpm', labResults: 'Hb 12.8 g/dL; WBC 8.1; CRP 6' },
  'PT-2026-0021': { medicines: 'Paracetamol as needed', heartRate: '92 bpm', labResults: 'WBC 11.4; CRP 28' },
  'PT-2026-0011': { medicines: 'Metformin 500 mg twice daily', heartRate: '68 bpm', labResults: 'HbA1c 6.9%; creatinine 88' },
  'PT-2026-0033': { medicines: 'Tiotropium; salbutamol', heartRate: '88 bpm', labResults: 'SpO2 93% on air' },
  'PT-2026-0044': { medicines: 'None recorded', heartRate: '72 bpm', labResults: 'FBC within normal limits' },
  'PT-2026-0050': { medicines: 'Alendronate weekly', heartRate: '80 bpm', labResults: 'Calcium 2.3; vitamin D 42' },
  'PT-2026-0051': { medicines: 'Ibuprofen as needed', heartRate: '74 bpm', labResults: 'Hb 14.1 g/dL; WBC 6.8' },
  'PT-2025-1107': { medicines: 'None recorded', heartRate: '70 bpm', labResults: 'FBC within normal limits' },
  'PT-2026-0061': { medicines: 'Combined oral contraceptive', heartRate: '78 bpm', labResults: 'D-dimer pending' },
};

(async () => {
  await connectDB();

  console.log('\n— users —');
  for (const { match, set } of USER_PATCHES) {
    const res = await User.updateMany(match, { $set: set });
    if (res.modifiedCount) {
      console.log(`  updated ${res.modifiedCount} user(s) ${JSON.stringify(match)} → ${JSON.stringify(set)}`);
    }
  }
  const leftover = await User.find({ role: { $nin: ['technician', 'radiologist', 'doctor', 'admin'] } }).lean();
  if (leftover.length) {
    console.warn('  leftover roles:', leftover.map((u) => `${u.username}:${u.role}`).join(', '));
  }

  console.log('\n— cases —');
  const cases = await mongoose.connection.db.collection('cases').find({}).toArray();
  let caseUpdates = 0;
  for (const c of cases) {
    const patch = {};
    const nextState = storedAnalysisState(c);
    if (c.analysisState !== nextState) patch.analysisState = nextState;
    if (!Array.isArray(c.editLog)) patch.editLog = [];
    // Films uploaded by the old reporting "doctor" account now belong to the technician.
    if (c.createdBy === 'USR-DOCTOR-0001' || c.createdByName === 'Dr. Alex Wong') {
      patch.createdBy = TECH.userId;
      patch.createdByName = TECH.name;
    }
    if (c.finalizedBy === 'USR-DOCTOR-0001' || c.finalizedByName === 'Dr. Alex Wong') {
      patch.finalizedBy = 'USR-DOCTOR-0002';
      patch.finalizedByName = 'Dr. Priya Nair';
    }
    if (!Object.keys(patch).length) continue;
    await mongoose.connection.db.collection('cases').updateOne({ _id: c._id }, { $set: patch });
    caseUpdates += 1;
    console.log(`  ${c.caseId}: ${Object.keys(patch).join(', ')}`);
  }
  console.log(`  ${caseUpdates} case(s) updated`);

  console.log('\n— patients —');
  const patients = await Patient.find({});
  let patientUpdates = 0;
  for (const p of patients) {
    const extras = CHARTS[p.patientId] || {
      medicines: p.medicines || 'None recorded',
      heartRate: p.heartRate || '72 bpm',
      labResults: p.labResults || 'No lab results recorded',
    };
    const patch = {};
    if (!String(p.medicines || '').trim()) patch.medicines = extras.medicines;
    if (!String(p.heartRate || '').trim()) patch.heartRate = extras.heartRate;
    if (!String(p.labResults || '').trim()) patch.labResults = extras.labResults;
    if (!Object.keys(patch).length) continue;
    await Patient.updateOne({ _id: p._id }, { $set: patch });
    patientUpdates += 1;
    console.log(`  ${p.patientId}: ${Object.keys(patch).join(', ')}`);
  }
  console.log(`  ${patientUpdates} patient(s) updated`);

  console.log('\n✓ Database workflow migration complete.\n');
  process.exit(0);
})().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
