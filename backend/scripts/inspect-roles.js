// Read-only: print users, case analysisState, and patient chart extras.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const connectDB = require('../config/db');
const User = require('../models/User');
const Case = require('../models/Case');
const Patient = require('../models/Patient');

(async () => {
  await connectDB();
  const users = await User.find({}).select('userId username name role department isActive').lean();
  console.log('\n=== users ===');
  for (const u of users) {
    console.log(`${u.username.padEnd(12)} ${String(u.role).padEnd(14)} ${u.userId}  ${u.name}  (${u.department || ''})`);
  }

  const cases = await Case.find({}).select('caseId patientId status analysisState createdBy createdByName finalizedByName').lean();
  console.log(`\n=== cases (${cases.length}) ===`);
  for (const c of cases) {
    console.log(`${c.caseId}  ${c.status}/${c.analysisState || '-'}  by ${c.createdByName || c.createdBy}  ${c.patientId}`);
  }

  const patients = await Patient.find({}).select('patientId name medicines heartRate labResults').lean();
  console.log(`\n=== patients (${patients.length}) ===`);
  for (const p of patients) {
    const extras = [p.medicines, p.heartRate, p.labResults].filter(Boolean).length;
    console.log(`${p.patientId}  ${p.name || ''}  extras=${extras}  meds=${JSON.stringify(p.medicines || '')}`);
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
