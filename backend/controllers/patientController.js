// controllers/patientController.js
// Patient list / chart: demographics + notes, with studies pulled from Case.

const Case = require('../models/Case');
const Patient = require('../models/Patient');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');
const addAuditLog = require('../utils/auditLogger');

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
  if (!p) {
    await Patient.create({
      patientId: c.patientId,
      age: c.age || '',
      sex: ['Female', 'Male', 'Other'].includes(c.sex) ? c.sex : '',
      history: c.history || '',
      remarks: '',
    });
    return;
  }
  if (!p.age && c.age) p.age = c.age;
  if (!p.sex && c.sex) p.sex = c.sex;
  if (!p.history && c.history) p.history = c.history;
  await p.save();
}

function summariseCase(c) {
  const findings = Array.isArray(c.findings) ? c.findings : [];
  return {
    caseId: c.caseId || String(c._id),
    _id: c._id,
    status: c.status,
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

exports.upsertPatientFromCase = upsertPatientFromCase;

exports.listPatients = catchAsync(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const match = q ? { patientId: new RegExp(escapeRegex(q), 'i') } : {};

  const grouped = await Case.aggregate([
    { $match: match },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: '$patientId',
        patientId: { $first: '$patientId' },
        age: { $first: '$age' },
        sex: { $first: '$sex' },
        history: { $first: '$history' },
        lastDiagnosis: { $first: '$diagnosis' },
        lastStatus: { $first: '$status' },
        lastCaseAt: { $first: '$createdAt' },
        caseCount: { $sum: 1 },
      },
    },
    { $sort: { lastCaseAt: -1 } },
  ]);

  const notes = await Patient.find({
    patientId: { $in: grouped.map((g) => g.patientId) },
  });
  const byId = new Map(notes.map((n) => [String(n.patientId).toLowerCase(), n]));

  const patients = grouped.map((g) => {
    const p = byId.get(String(g.patientId).toLowerCase());
    return {
      patientId: g.patientId,
      age: p?.age || g.age || '',
      sex: p?.sex || g.sex || '',
      history: p?.history || g.history || '',
      remarks: p?.remarks || '',
      lastDiagnosis: g.lastDiagnosis || '',
      lastStatus: g.lastStatus || '',
      lastCaseAt: g.lastCaseAt,
      caseCount: g.caseCount,
    };
  });

  res.json({ success: true, patients });
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

  const patient = {
    patientId: record?.patientId || latest?.patientId || patientId,
    age: record?.age || latest?.age || '',
    sex: record?.sex || latest?.sex || '',
    history: record?.history || latest?.history || '',
    remarks: record?.remarks || '',
    lastDiagnosis: latest?.diagnosis || '',
  };

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
      age: latest.age || '',
      sex: latest.sex || '',
      history: latest.history || '',
      remarks: '',
    });
  }

  const { history, remarks, age, sex } = req.body || {};
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
    patient: {
      patientId: record.patientId,
      age: record.age,
      sex: record.sex,
      history: record.history,
      remarks: record.remarks,
      lastDiagnosis: cases[0]?.diagnosis || '',
    },
    cases: cases.map(summariseCase),
  });
});
