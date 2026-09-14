// controllers/patientController.js
// Patient list / chart: demographics + notes, with studies pulled from Case.

const mongoose = require('mongoose');
const Case = require('../models/Case');
const Patient = require('../models/Patient');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');
const addAuditLog = require('../utils/auditLogger');
const { nameFieldsFrom, composePatientName } = require('../utils/patientName');

function imageBucket() {
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'images' });
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function caseFilter(patientId) {
  return { patientId: new RegExp(`^${escapeRegex(patientId)}$`, 'i') };
}

async function findPatientRecord(patientId) {
  const exact = await Patient.findOne({ patientId });
  if (exact) return exact;
  return Patient.findOne({ patientId: new RegExp(`^${escapeRegex(patientId)}$`, 'i') });
}

async function upsertPatientFromCase(c) {
  if (!c?.patientId) return;
  let p = await findPatientRecord(c.patientId);
  const names = nameFieldsFrom(c);
  if (!p) {
    await Patient.create({
      patientId: c.patientId,
      firstName: names.firstName,
      middleName: names.middleName,
      lastName: names.lastName,
      name: names.name,
      age: c.age || '',
      sex: ['Female', 'Male', 'Other'].includes(c.sex) ? c.sex : '',
      history: c.history || '',
      remarks: '',
    });
    return;
  }
  if (names.firstName && !p.firstName) p.firstName = names.firstName;
  if (names.middleName && !p.middleName) p.middleName = names.middleName;
  if (names.lastName && !p.lastName) p.lastName = names.lastName;
  if (names.name && !p.name) p.name = names.name;
  if (!p.age && c.age) p.age = c.age;
  if (!p.sex && c.sex) p.sex = c.sex;
  if (!p.history && c.history) p.history = c.history;
  if (!p.name) p.name = composePatientName(p);
  await p.save();
}

async function patientIdTaken(patientId) {
  if (await findPatientRecord(patientId)) return true;
  return Boolean(await Case.findOne(caseFilter(patientId)).select('_id'));
}

async function nextPatientId() {
  const year = new Date().getFullYear();
  const prefix = `PT-${year}-`;
  const re = new RegExp(`^${escapeRegex(prefix)}\\d+$`, 'i');
  const [fromPatients, fromCases] = await Promise.all([
    Patient.find({ patientId: re }).select('patientId'),
    Case.find({ patientId: re }).select('patientId'),
  ]);
  const nums = [...fromPatients.map((p) => p.patientId), ...fromCases.map((c) => c.patientId)]
    .map((id) => parseInt(String(id).slice(prefix.length), 10))
    .filter((n) => Number.isFinite(n));
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

function summarisePatient(record, grouped = {}, cases = []) {
  const names = nameFieldsFrom({
    firstName: record?.firstName || grouped.firstName,
    middleName: record?.middleName || grouped.middleName,
    lastName: record?.lastName || grouped.lastName,
    name: record?.name,
    patientName: grouped.patientName || record?.name,
  });
  return {
    patientId: record?.patientId || grouped.patientId || '',
    firstName: names.firstName,
    middleName: names.middleName,
    lastName: names.lastName,
    name: names.name,
    age: record?.age || grouped.age || '',
    sex: record?.sex || grouped.sex || '',
    history: record?.history || grouped.history || '',
    remarks: record?.remarks || '',
    lastDiagnosis: grouped.lastDiagnosis || cases[0]?.diagnosis || '',
    lastStatus: grouped.lastStatus || cases[0]?.status || '',
    lastCaseAt: grouped.lastCaseAt || record?.updatedAt || record?.createdAt || null,
    caseCount: grouped.caseCount ?? cases.length,
    urgent: grouped.urgent ?? cases.some((c) => c.urgent),
  };
}

function summariseCase(c) {
  const findings = Array.isArray(c.findings) ? c.findings : [];
  return {
    caseId: c.caseId || String(c._id),
    _id: c._id,
    status: c.status,
    urgent: Boolean(c.urgent),
    diagnosis: c.diagnosis || '',
    history: c.history || '',
    createdAt: c.createdAt,
    imageId: c.imageId || null,
    findings: findings.slice(0, 6).map((f) => ({
      _id: f._id,
      label: f.label,
      location: f.location || '',
      pattern: f.pattern || '',
      confidence: f.confidence,
      sentence: f.sentence || '',
    })),
  };
}

function nameSearch(re) {
  return [
    { patientId: re },
    { name: re },
    { firstName: re },
    { middleName: re },
    { lastName: re },
  ];
}

exports.upsertPatientFromCase = upsertPatientFromCase;

exports.listPatients = catchAsync(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const re = q ? new RegExp(escapeRegex(q), 'i') : null;
  const match = {};
  if (re) {
    const named = await Patient.find({ $or: nameSearch(re) }).select('patientId');
    const ids = named.map((p) => p.patientId);
    match.$or = [
      { patientId: re },
      { patientName: re },
      { firstName: re },
      { middleName: re },
      { lastName: re },
      ...(ids.length ? [{ patientId: { $in: ids } }] : []),
    ];
  }

  const grouped = await Case.aggregate([
    { $match: match },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: '$patientId',
        patientId: { $first: '$patientId' },
        patientName: { $first: '$patientName' },
        firstName: { $first: '$firstName' },
        middleName: { $first: '$middleName' },
        lastName: { $first: '$lastName' },
        age: { $first: '$age' },
        sex: { $first: '$sex' },
        history: { $first: '$history' },
        lastDiagnosis: { $first: '$diagnosis' },
        lastStatus: { $first: '$status' },
        lastCaseAt: { $first: '$createdAt' },
        caseCount: { $sum: 1 },
        urgents: { $addToSet: '$urgent' },
      },
    },
    { $sort: { lastCaseAt: -1 } },
  ]);

  const notes = await Patient.find(re ? { $or: nameSearch(re) } : {});
  const byId = new Map(notes.map((n) => [String(n.patientId).toLowerCase(), n]));
  const seen = new Set();

  const patients = grouped.map((g) => {
    const p = byId.get(String(g.patientId).toLowerCase());
    seen.add(String(g.patientId).toLowerCase());
    return summarisePatient(p, {
      ...g,
      urgent: (g.urgents || []).some(Boolean),
    });
  });

  for (const p of notes) {
    const key = String(p.patientId).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    patients.push(summarisePatient(p));
  }

  patients.sort((a, b) => new Date(b.lastCaseAt || 0) - new Date(a.lastCaseAt || 0));

  res.json({ success: true, patients });
});

exports.createPatient = catchAsync(async (req, res, next) => {
  if (req.user.role === 'nurse') {
    return next(ApiError.forbidden('Nurses cannot add patients.'));
  }

  const { patientId, age, sex, history } = req.body || {};
  const names = nameFieldsFrom(req.body || {});
  if (!names.firstName || !names.lastName) {
    return next(ApiError.badRequest('First name and last name are required.'));
  }

  const sexValue = ['Female', 'Male', 'Other'].includes(sex) ? sex : '';
  let id = String(patientId || '').trim();
  if (id) {
    if (await patientIdTaken(id)) {
      return next(ApiError.badRequest(`Patient ${id} already exists.`));
    }
  } else {
    id = await nextPatientId();
    while (await patientIdTaken(id)) {
      const year = new Date().getFullYear();
      const n = parseInt(id.slice(`PT-${year}-`.length), 10) + 1;
      id = `PT-${year}-${String(n).padStart(4, '0')}`;
    }
  }

  const record = await Patient.create({
    patientId: id,
    firstName: names.firstName,
    middleName: names.middleName,
    lastName: names.lastName,
    name: names.name,
    age: age != null ? String(age).trim() : '',
    sex: sexValue,
    history: history != null ? String(history) : '',
    remarks: '',
  });

  await addAuditLog(
    req.user.userId,
    'PATIENT_CREATED',
    `Created patient ${record.patientId} (${record.name})`,
    record.patientId
  );

  res.status(201).json({
    success: true,
    patient: summarisePatient(record),
    cases: [],
  });
});

exports.getPatient = catchAsync(async (req, res, next) => {
  const patientId = String(req.params.id || '').trim();
  if (!patientId) return next(ApiError.badRequest('Patient id is required.'));

  const cases = await Case.find(caseFilter(patientId)).sort({ createdAt: -1 });
  let record = await findPatientRecord(patientId);
  if (!cases.length && !record) {
    return next(ApiError.notFound(`Patient ${patientId} not found`));
  }

  const latest = cases[0];
  if (!record && latest) {
    await upsertPatientFromCase(latest);
    record = await findPatientRecord(latest.patientId);
  }

  const patient = summarisePatient(record, latest || {}, cases);

  res.json({
    success: true,
    patient,
    cases: cases.map(summariseCase),
  });
});

exports.updatePatient = catchAsync(async (req, res, next) => {
  if (req.user.role === 'nurse') {
    return next(ApiError.forbidden('Nurses cannot edit patient notes.'));
  }

  const patientId = String(req.params.id || '').trim();
  if (!patientId) return next(ApiError.badRequest('Patient id is required.'));

  const latest = await Case.findOne(caseFilter(patientId)).sort({ createdAt: -1 });
  let record = await findPatientRecord(patientId);
  if (!record && !latest) {
    return next(ApiError.notFound(`Patient ${patientId} not found`));
  }
  if (!record) {
    record = await Patient.create({
      patientId: latest.patientId,
      ...nameFieldsFrom(latest),
      age: latest.age || '',
      sex: latest.sex || '',
      history: latest.history || '',
      remarks: '',
    });
  }

  const { history, remarks, age, sex, name, firstName, middleName, lastName } = req.body || {};
  if (firstName !== undefined || middleName !== undefined || lastName !== undefined || name !== undefined) {
    const names = nameFieldsFrom({
      firstName: firstName !== undefined ? firstName : record.firstName,
      middleName: middleName !== undefined ? middleName : record.middleName,
      lastName: lastName !== undefined ? lastName : record.lastName,
      name,
    });
    record.firstName = names.firstName;
    record.middleName = names.middleName;
    record.lastName = names.lastName;
    record.name = names.name;
  }
  if (history !== undefined) record.history = String(history);
  if (remarks !== undefined) record.remarks = String(remarks);
  if (age !== undefined) record.age = String(age);
  if (sex !== undefined && ['Female', 'Male', 'Other', ''].includes(sex)) record.sex = sex;
  await record.save();

  await addAuditLog(
    req.user.userId,
    'PATIENT_UPDATED',
    `Updated patient ${record.patientId}`,
    record.patientId
  );

  const cases = await Case.find(caseFilter(record.patientId)).sort({ createdAt: -1 });
  res.json({
    success: true,
    patient: summarisePatient(record, {}, cases),
    cases: cases.map(summariseCase),
  });
});

async function removePatientById(patientId) {
  const cases = await Case.find(caseFilter(patientId));
  const record = await findPatientRecord(patientId);
  if (!cases.length && !record) return null;

  if (cases.some((c) => c.imageId)) {
    const bucket = imageBucket();
    for (const c of cases) {
      if (!c.imageId) continue;
      try { await bucket.delete(c.imageId); } catch (_) { /* ignore missing images */ }
    }
  }
  if (cases.length) await Case.deleteMany(caseFilter(patientId));
  if (record) await Patient.deleteOne({ _id: record._id });
  return {
    patientId: record?.patientId || patientId,
    deletedCases: cases.length,
  };
}

exports.deletePatient = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'admin') {
    return next(ApiError.forbidden('Only admins can delete patients.'));
  }

  const patientId = String(req.params.id || '').trim();
  if (!patientId) return next(ApiError.badRequest('Patient id is required.'));

  const removed = await removePatientById(patientId);
  if (!removed) return next(ApiError.notFound(`Patient ${patientId} not found`));

  await addAuditLog(
    req.user.userId,
    'PATIENT_DELETED',
    `Deleted patient ${removed.patientId} and ${removed.deletedCases} ${removed.deletedCases === 1 ? 'study' : 'studies'}`,
    removed.patientId
  );

  res.json({ success: true, deletedCases: removed.deletedCases });
});

exports.deletePatients = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'admin') {
    return next(ApiError.forbidden('Only admins can delete patients.'));
  }
  const ids = Array.isArray(req.body?.ids)
    ? [...new Set(req.body.ids.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
  if (!ids.length) return next(ApiError.badRequest('Select at least one patient.'));

  const deleted = [];
  let deletedCases = 0;
  for (const id of ids) {
    const removed = await removePatientById(id);
    if (!removed) continue;
    deleted.push(removed.patientId);
    deletedCases += removed.deletedCases;
  }
  await addAuditLog(
    req.user.userId,
    'PATIENT_DELETED',
    `Deleted ${deleted.length} ${deleted.length === 1 ? 'patient' : 'patients'} and ${deletedCases} ${deletedCases === 1 ? 'study' : 'studies'}`,
    deleted[0] || null
  );
  res.json({ success: true, deleted: deleted.length, deletedCases, ids: deleted });
});
