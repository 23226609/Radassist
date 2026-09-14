// Keep patients, cases, and GridFS images in lockstep on add / delete.

const mongoose = require('mongoose');
const Case = require('../models/Case');
const Patient = require('../models/Patient');
const { nameFieldsFrom, composePatientName } = require('./patientName');
const { bucket } = require('../controllers/_gridfs');

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function patientIdFilter(patientId) {
  return { patientId: new RegExp(`^${escapeRegex(patientId)}$`, 'i') };
}

async function findPatientRecord(patientId) {
  const exact = await Patient.findOne({ patientId });
  if (exact) return exact;
  return Patient.findOne(patientIdFilter(patientId));
}

async function upsertPatientFromCase(c) {
  if (!c?.patientId) return null;
  const names = nameFieldsFrom(c);
  const sexValue = ['Female', 'Male', 'Other'].includes(c.sex) ? c.sex : '';
  let p = await findPatientRecord(c.patientId);

  if (!p) {
    try {
      p = await Patient.create({
        patientId: c.patientId,
        firstName: names.firstName,
        middleName: names.middleName,
        lastName: names.lastName,
        name: names.name,
        age: c.age || '',
        sex: sexValue,
        history: c.history || '',
        remarks: '',
      });
    } catch (err) {
      p = await findPatientRecord(c.patientId);
      if (!p) throw err;
    }
  }

  if (names.firstName && !p.firstName) p.firstName = names.firstName;
  if (names.middleName && !p.middleName) p.middleName = names.middleName;
  if (names.lastName && !p.lastName) p.lastName = names.lastName;
  if (names.name && !p.name) p.name = names.name;
  if (!p.age && c.age) p.age = c.age;
  if (!p.sex && sexValue) p.sex = sexValue;
  if (!p.history && c.history) p.history = c.history;
  if (!p.name) p.name = composePatientName(p);
  await p.save();
  return p;
}

async function deleteGridFsFile(imageId) {
  if (!imageId) return;
  let oid = imageId;
  try { oid = new mongoose.Types.ObjectId(String(imageId)); } catch { /* keep raw id */ }
  for (const name of ['images', 'fs']) {
    try { await bucket(name).delete(oid); } catch { /* missing bucket / file */ }
  }
}

async function deleteCaseDocument(c) {
  if (!c) return;
  if (c._id !== undefined) {
    try { await Case.deleteOne({ _id: c._id }); } catch { /* UUID-shaped ids */ }
    try {
      await mongoose.connection.db.collection('cases').deleteOne({ _id: c._id });
    } catch { /* ignore */ }
  }
  if (c.caseId) {
    await Case.deleteOne({ caseId: c.caseId }).catch(() => {});
  }
}

async function removeCaseRecord(c) {
  if (!c) return '';
  await deleteGridFsFile(c.imageId);
  await deleteCaseDocument(c);
  return c.caseId || String(c._id || '');
}

async function findAllCasesForPatient(patientId) {
  const filter = patientIdFilter(patientId);
  const fromModel = await Case.find(filter).lean();
  let raw = [];
  try {
    raw = await mongoose.connection.db.collection('cases').find(filter).toArray();
  } catch { /* ignore */ }
  const seen = new Set(fromModel.map((c) => String(c._id)));
  for (const c of raw) {
    if (!seen.has(String(c._id))) fromModel.push(c);
  }
  return fromModel;
}

async function removePatientRecord(patientId) {
  const cases = await findAllCasesForPatient(patientId);
  const record = await findPatientRecord(patientId);
  if (!cases.length && !record) return null;

  for (const c of cases) {
    await removeCaseRecord(c);
  }
  if (record) {
    await Patient.deleteOne({ _id: record._id });
  }
  await Patient.deleteMany(patientIdFilter(patientId)).catch(() => {});

  return {
    patientId: record?.patientId || patientId,
    deletedCases: cases.length,
  };
}

module.exports = {
  escapeRegex,
  patientIdFilter,
  findPatientRecord,
  upsertPatientFromCase,
  removeCaseRecord,
  findAllCasesForPatient,
  removePatientRecord,
};
