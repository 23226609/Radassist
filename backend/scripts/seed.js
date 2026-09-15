// scripts/seed.js
// Seeds users + a handful of demo cases (with images uploaded into GridFS).
//
// Run with:  npm run seed
// Idempotent — won't duplicate existing users or cases.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const connectDB = require('../config/db');
const User = require('../models/User');
const Case = require('../models/Case');
const AuditLog = require('../models/AuditLog');
const { nameFieldsFrom } = require('../utils/patientName');
const { upsertPatientFromCase } = require('../utils/recordSync');

const DEMO_USERS = [
  {
    userId: 'USR-ADMIN-0001',
    username: 'admin',
    password: 'admin123',
    name: 'System Admin',
    email: 'admin@radassist.demo',
    role: 'admin',
    department: 'IT',
  },
  {
    userId: 'USR-DOCTOR-0001',
    username: 'doctor',
    password: 'doctor123',
    name: 'Dr. Alex Wong',
    email: 'alex.wong@radassist.demo',
    role: 'doctor',
    department: 'Radiology',
  },
  {
    userId: 'USR-DOCTOR-0002',
    username: 'priya',
    password: 'priya123',
    name: 'Dr. Priya Nair',
    email: 'priya.nair@radassist.demo',
    role: 'doctor',
    department: 'Radiology',
  },
  {
    userId: 'USR-DOCTOR-0003',
    username: 'marcus',
    password: 'marcus123',
    name: 'Dr. Marcus Chen',
    email: 'marcus.chen@radassist.demo',
    role: 'doctor',
    department: 'Radiology',
  },
  {
    userId: 'USR-NURSE-0001',
    username: 'nurse',
    password: 'nurse123',
    name: 'Nurse Jamie Lee',
    email: 'jamie.lee@radassist.demo',
    role: 'nurse',
    department: 'Radiology',
  },
];

// Demo cases: a mix of pending_approve / finalized. Images will be
// sourced from ../../Desktop/fyp/ if available, else from a placeholder
// generated locally.
const SAMPLE_DIR = path.resolve(__dirname, '..', '..', '..', 'Desktop', 'fyp');

// Sample image is picked up from a few well-known locations on macOS so
// the script works regardless of how it was launched (e.g., launchd).
function findSampleImage() {
  const home = require('os').homedir();
  const candidates = [
    path.join(home, 'Desktop', 'fyp', 'x-ray-images-patients-bone-problems-ray-images-patients-bone-problems-scoliosis-spine-hospital-medical-155484843.webp'),
    path.join(home, 'Desktop', 'fyp', '360_F_214542407_TE9lLerS80zUF7bB71Ct7BFI2kzwURDo.jpg'),
    path.resolve(__dirname, '..', '..', '..', 'Desktop', 'fyp', 'x-ray-images-patients-bone-problems-ray-images-patients-bone-problems-scoliosis-spine-hospital-medical-155484843.webp'),
    path.resolve(__dirname, '..', '..', '..', 'Desktop', 'fyp', '360_F_214542407_TE9lLerS80zUF7bB71Ct7BFI2kzwURDo.jpg'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function generatePlaceholderPng() {
  // Tiny 1x1 grey PNG (binary, base64-decoded)
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  return Buffer.from(b64, 'base64');
}

const SAMPLE_CASES = [
  {
    caseId: 'CASE-DEMO-0001',
    patientId: 'PT-2026-0018',
    firstName: 'Mei',
    lastName: 'Chen',
    patientName: 'Mei Chen',
    age: '67',
    sex: 'Female',
    history: 'Persistent cough and mild dyspnoea',
    diagnosis: 'Mild cardiomegaly',
    reportText:
      'Calcified aortic atheromatosis is noted. Bilateral apical pleural thickening is observed. No other significant radiological findings.',
    status: 'pending_approve',
    createdBy: 'USR-DOCTOR-0001',
    createdByName: 'Dr. Alex Wong',
    findingsSeed: [
      { label: 'Calcified aortic atheromatosis', confidence: 0.92, bbox: [29, 17, 22, 18], location: 'Aortic arch', size: '2.3 cm', pattern: 'Nodular', sentence: 'Calcified aortic atheromatosis is noted.', status: 'accepted' },
      { label: 'Bilateral apical pleural thickening', confidence: 0.78, bbox: [23, 9, 52, 17], location: 'Pleural, apical', size: 'N/A', pattern: 'Diffuse', sentence: 'Bilateral apical pleural thickening is observed.', status: 'accepted' },
    ],
  },
  {
    caseId: 'CASE-DEMO-0002',
    patientId: 'PT-2026-0021',
    firstName: 'James',
    middleName: 'Wei',
    lastName: 'Tan',
    patientName: 'James Wei Tan',
    age: '45',
    sex: 'Male',
    history: 'Fever for three days',
    diagnosis: 'Possible right-lower-zone opacity',
    reportText:
      'A faint opacity is seen in the right lower zone. The remainder of the lungs are clear. Clinical correlation is advised.',
    status: 'pending_approve',
    createdBy: 'USR-DOCTOR-0002',
    createdByName: 'Dr. Priya Nair',
    findingsSeed: [],
  },
  {
    caseId: 'CASE-DEMO-0003',
    patientId: 'PT-2026-0011',
    firstName: 'David',
    lastName: 'Lim',
    patientName: 'David Lim',
    age: '58',
    sex: 'Male',
    history: 'Follow-up examination',
    diagnosis: 'Right lower-zone opacity',
    reportText:
      'A focal opacity is present in the right lower zone. The cardiac silhouette is mildly enlarged. No other significant radiological findings.',
    status: 'finalized',
    createdBy: 'USR-DOCTOR-0001',
    createdByName: 'Dr. Alex Wong',
    finalizedBy: 'USR-DOCTOR-0001',
    finalizedByName: 'Dr. Alex Wong',
    findingsSeed: [
      { label: 'Right lower-zone opacity', confidence: 0.86, bbox: [54, 58, 23, 20], location: 'Right lower lobe', size: '3.1 cm', pattern: 'Consolidation', sentence: 'A focal opacity is present in the right lower zone.', status: 'accepted' },
      { label: 'Mild cardiomegaly', confidence: 0.83, bbox: [36, 53, 34, 28], location: 'Cardiac silhouette', size: 'CTR 0.56', pattern: 'Other', sentence: 'The cardiac silhouette is mildly enlarged.', status: 'accepted' },
    ],
  },
  {
    caseId: 'CASE-DEMO-0004',
    patientId: 'PT-2026-0033',
    firstName: 'Robert',
    lastName: 'Ng',
    patientName: 'Robert Ng',
    age: '72',
    sex: 'Male',
    history: 'Shortness of breath, history of COPD',
    diagnosis: 'Hyperinflation',
    reportText:
      'Lungs appear hyperinflated with flattened diaphragms consistent with COPD. No focal consolidation.',
    status: 'pending_approve',
    createdBy: 'USR-DOCTOR-0003',
    createdByName: 'Dr. Marcus Chen',
    findingsSeed: [
      { label: 'Hyperinflated lungs', confidence: 0.81, bbox: [10, 5, 80, 90], location: 'Bilateral', size: 'N/A', pattern: 'Diffuse', sentence: 'Lungs appear hyperinflated.', status: 'pending' },
    ],
  },
  {
    caseId: 'CASE-DEMO-0005',
    patientId: 'PT-2026-0044',
    firstName: 'Aisha',
    lastName: 'Rahman',
    patientName: 'Aisha Rahman',
    age: '34',
    sex: 'Female',
    history: 'Routine pre-employment check',
    diagnosis: 'No acute cardiopulmonary findings',
    reportText: 'Heart size is normal. Lungs are clear. No pleural effusion or pneumothorax.',
    status: 'pending_approve',
    createdBy: 'USR-DOCTOR-0002',
    createdByName: 'Dr. Priya Nair',
    findingsSeed: [],
  },
  {
    caseId: 'CASE-DEMO-0006',
    patientId: 'PT-2026-0050',
    firstName: 'Henry',
    lastName: 'Wong',
    patientName: 'Henry Wong',
    age: '80',
    sex: 'Male',
    history: 'Fall, rib pain',
    diagnosis: 'Left lateral rib fracture',
    reportText: 'Nondisplaced fracture of the left 8th lateral rib. No pneumothorax.',
    status: 'finalized',
    urgent: true,
    createdBy: 'USR-DOCTOR-0003',
    createdByName: 'Dr. Marcus Chen',
    finalizedBy: 'USR-DOCTOR-0003',
    finalizedByName: 'Dr. Marcus Chen',
    findingsSeed: [
      { label: 'Left 8th rib fracture', confidence: 0.95, bbox: [22, 50, 12, 6], location: 'Left lateral chest wall', size: 'N/A', pattern: 'Linear', sentence: 'Nondisplaced fracture of the left 8th lateral rib.', status: 'accepted' },
    ],
  },
];

async function seedUsers() {
  let created = 0;
  for (const u of DEMO_USERS) {
    const exists = await User.findOne({ username: u.username });
    if (exists) {
      console.log(`  · user ${u.username} already exists, skipping`);
      continue;
    }
    await User.create(u);
    created++;
    console.log(`  + created user ${u.username} (${u.role})`);
  }
  return created;
}

function bucket() {
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'images' });
}

async function uploadSampleImage(filename) {
  let buf;
  let contentType = 'image/jpeg';
  const samplePath = findSampleImage();
  if (samplePath) {
    buf = fs.readFileSync(samplePath);
    if (samplePath.endsWith('.webp')) contentType = 'image/webp';
  } else {
    buf = generatePlaceholderPng();
    contentType = 'image/png';
  }
  return new Promise((resolve, reject) => {
    const up = bucket().openUploadStream(filename, { contentType });
    up.once('error', reject);
    up.once('finish', () => resolve({ id: up.id, size: buf.length, contentType }));
    up.end(buf);
  });
}

async function seedCases() {
  let created = 0;
  const sampleImage = await uploadSampleImage('demo-xray.webp');

  for (const c of SAMPLE_CASES) {
    const exists = await Case.findOne({ caseId: c.caseId });
    if (exists) {
      const names = nameFieldsFrom(c);
      const patch = {};
      if (names.firstName && exists.firstName !== names.firstName) patch.firstName = names.firstName;
      if (names.middleName && exists.middleName !== names.middleName) patch.middleName = names.middleName;
      if (names.lastName && exists.lastName !== names.lastName) patch.lastName = names.lastName;
      if (names.name && exists.patientName !== names.name) patch.patientName = names.name;
      if (Boolean(c.urgent) && !exists.urgent) patch.urgent = true;
      if (c.createdBy && exists.createdBy !== c.createdBy) patch.createdBy = c.createdBy;
      if (c.createdByName && exists.createdByName !== c.createdByName) patch.createdByName = c.createdByName;
      if (c.finalizedBy && exists.finalizedBy !== c.finalizedBy) patch.finalizedBy = c.finalizedBy;
      if (c.finalizedByName && exists.finalizedByName !== c.finalizedByName) patch.finalizedByName = c.finalizedByName;
      if (Object.keys(patch).length) {
        await Case.updateOne({ _id: exists._id }, { $set: patch });
        console.log(`  · case ${c.caseId} updated (${Object.keys(patch).join(', ')})`);
      } else {
        console.log(`  · case ${c.caseId} already exists, skipping`);
      }
      continue;
    }
    const names = nameFieldsFrom(c);
    await Case.create({
      caseId: c.caseId,
      patientId: c.patientId,
      firstName: names.firstName,
      middleName: names.middleName,
      lastName: names.lastName,
      patientName: names.name,
      age: c.age,
      sex: c.sex,
      history: c.history,
      diagnosis: c.diagnosis,
      reportText: c.reportText,
      findings: c.findingsSeed,
      status: c.status,
      urgent: Boolean(c.urgent),
      createdBy: c.createdBy || 'USR-DOCTOR-0001',
      createdByName: c.createdByName || 'Dr. Alex Wong',
      finalizedBy: c.finalizedBy || null,
      finalizedByName: c.finalizedByName || null,
      imageId: sampleImage.id,
      imageFilename: 'demo-xray.webp',
      imageContentType: sampleImage.contentType,
      imageSize: sampleImage.size,
      aiProvider: 'curv-mlx',
      aiModel: '/Users/PHY/CURV-mlx',
    });
    created++;
    console.log(`  + created case ${c.caseId} for ${c.patientId} (${c.status})`);
    await upsertPatientFromCase({
      patientId: c.patientId,
      firstName: names.firstName,
      middleName: names.middleName,
      lastName: names.lastName,
      patientName: names.name,
      age: c.age,
      sex: c.sex,
      history: c.history,
    });
  }

  for (const c of SAMPLE_CASES) {
    const doc = await Case.findOne({ caseId: c.caseId });
    if (doc) await upsertPatientFromCase(doc);
  }
  return created;
}

async function seedAuditLogs() {
  const exists = await AuditLog.findOne({});
  if (exists) {
    console.log('  · audit logs already populated, skipping');
    return 0;
  }
  const logs = [
    { logId: 'LOG-SEED-0001', userId: 'USR-ADMIN-0001', action: 'LOGIN', details: 'Seed admin logged in' },
    { logId: 'LOG-SEED-0002', userId: 'USR-DOCTOR-0001', action: 'CASE_CREATED', details: 'Seed: created CASE-DEMO-0001', affectedCaseId: 'CASE-DEMO-0001' },
    { logId: 'LOG-SEED-0003', userId: 'USR-DOCTOR-0001', action: 'CASE_CREATED', details: 'Seed: created CASE-DEMO-0003', affectedCaseId: 'CASE-DEMO-0003' },
    { logId: 'LOG-SEED-0004', userId: 'USR-DOCTOR-0001', action: 'CASE_FINALIZED', details: 'Seed: finalized CASE-DEMO-0003', affectedCaseId: 'CASE-DEMO-0003' },
    { logId: 'LOG-SEED-0005', userId: 'USR-DOCTOR-0001', action: 'CASE_CREATED', details: 'Seed: created CASE-DEMO-0006', affectedCaseId: 'CASE-DEMO-0006' },
    { logId: 'LOG-SEED-0006', userId: 'USR-DOCTOR-0001', action: 'CASE_FINALIZED', details: 'Seed: finalized CASE-DEMO-0006', affectedCaseId: 'CASE-DEMO-0006' },
  ];
  await AuditLog.insertMany(logs);
  console.log(`  + created ${logs.length} audit log entries`);
  return logs.length;
}

(async function run() {
  try {
    await connectDB();

    console.log('\n— Seeding users —');
    const u = await seedUsers();
    console.log(`  total new users: ${u}`);

    console.log('\n— Seeding cases (uploads X-ray image to GridFS) —');
    const c = await seedCases();
    console.log(`  total new cases: ${c}`);

    console.log('\n— Seeding audit logs —');
    const a = await seedAuditLogs();
    console.log(`  total new audit logs: ${a}`);

    console.log('\n✓ Seed complete.\n');
    process.exit(0);
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  }
})();
