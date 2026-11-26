// controllers/caseController.js
// All case-related operations: list, create (upload + AI), read, update, delete.

const mongoose = require('mongoose');
const crypto = require('crypto');
const Case = require('../models/Case');
const Patient = require('../models/Patient');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');
const addAuditLog = require('../utils/auditLogger');
const { analyzeXray } = require('../utils/aiService');
const { prepareFilm } = require('../utils/dicom');
const { buildEditChanges } = require('../utils/editDiff');
const azureFindings = require('../utils/azureFindings');
const { reasonAboutHistory } = require('../utils/historyReasoning');
const { secondOpinion } = require('../utils/secondOpinion');
const { runAgent } = require('../utils/agent');
const { dedupeFindings, mergeTagBoxes } = require('../utils/findingsMerge');
const tagReport = require('../utils/tagReport');
const { bucket, downloadImage } = require('./_gridfs');
const { nameFieldsFrom } = require('../utils/patientName');
const { toPublicCase, statusFilter, publicStatus, clinicianEdited } = require('../utils/caseStatus');
const { upsertPatientFromCase, removeCaseRecord } = require('../utils/recordSync');
const { queueChartFindings } = require('../utils/chartFindings');
const xraySlots = require('../utils/xraySlots');
const { normalizeRole, isReferringDoctor, isTechnician, isPatient } = require('../utils/roles');
const { queueLaySummary } = require('../utils/laySummary');

let requestRules;
function radiologyRequest() {
  if (!requestRules) requestRules = import('../../shared/radiologyRequest.js');
  return requestRules;
}
const { OWNED } = Case;

function publicCaseOpts(req, doc) {
  const role = normalizeRole(req.user?.role);
  const finalized = publicStatus(doc?.status) === 'finalized';
  return {
    includeShareToken: role === 'radiologist' || role === 'admin',
    includeEditLog: (role === 'radiologist' || role === 'admin') && !finalized,
    stripProvenance: role === 'doctor' || finalized,
    hideFilm: role === 'technician',
    hideReasoning: role === 'doctor',
    patientView: role === 'patient',
  };
}

function pushEditLog(doc, entry) {
  const rows = Array.isArray(doc.editLog) ? doc.editLog : [];
  rows.push({ at: new Date(), ...entry });
  doc.editLog = rows.slice(-80);
}

function sanitizeFindings(findings) {
  return (findings || []).map((raw) => {
    const f = raw && typeof raw.toObject === 'function' ? raw.toObject() : { ...raw };
    if (String(f._id || '').startsWith('tmp-')) delete f._id;
    if (String(f.id || '').startsWith('tmp-')) delete f.id;
    if (!Array.isArray(f.bbox) || f.bbox.length !== 4) f.bbox = [];
    return f;
  });
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

function tagKeyOf(value) {
  const key = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,24}$/.test(key) ? key : '';
}

// One sentence per tag, in the radiologist's order. A key is used once.
function sanitizeTags(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const key = tagKeyOf(raw?.key);
    const text = String(raw?.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!key || !text || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      text,
      abnormal: raw.abnormal !== false,
      manual: Boolean(raw.manual),
      kind: raw.kind === 'ctr' ? 'ctr' : '',
      boxDeclined: Boolean(raw.boxDeclined),
    });
    if (out.length >= 60) break;
  }
  return out;
}

function cleanView(value) {
  return ['PA', 'AP', 'AP supine', 'Lateral'].includes(value) ? value : '';
}

// The fields a film adds to its case: both spacing tags, which one was used, view and time.
function filmFields(film) {
  const fields = {};
  for (const key of ['pixelSpacingMm', 'imagerPixelSpacingMm', 'dicomPixelSpacingMm']) {
    if (Array.isArray(film[key]) && film[key].length === 2) fields[key] = film[key];
  }
  if (film.pixelSpacingSource) fields.pixelSpacingSource = film.pixelSpacingSource;
  for (const key of ['estimatedMagnification', 'distanceSourceToDetectorMm', 'distanceSourceToPatientMm', 'bodyPartThicknessMm']) {
    const n = Number(film[key]);
    if (n > 0) fields[key] = n;
  }
  if (film.view) fields.view = film.view;
  if (film.dicomViewPosition) fields.dicomViewPosition = String(film.dicomViewPosition).slice(0, 16);
  if (film.patientPosition) fields.patientPosition = String(film.patientPosition).slice(0, 16);
  if (film.projectionCues) fields.projectionCues = String(film.projectionCues).slice(0, 400);
  if (film.examinedAt) fields.examinedAt = film.examinedAt;
  return fields;
}

function sanitizeMeasurements(list) {
  const pct = (n) => Math.min(100, Math.max(0, Math.round((Number(n) || 0) * 100) / 100));
  return (list || [])
    .filter((m) => m && ['x1', 'y1', 'x2', 'y2'].every((k) => Number.isFinite(Number(m[k]))))
    .slice(0, 50)
    .map((m) => {
      const row = {
        x1: pct(m.x1),
        y1: pct(m.y1),
        x2: pct(m.x2),
        y2: pct(m.y2),
        text: String(m.text || '').trim().slice(0, 160),
        label: String(m.label || '').trim().slice(0, 80),
        kind: ['lesion', 'ctr-heart', 'ctr-thorax'].includes(m.kind) ? m.kind : 'lesion',
        tagKey: tagKeyOf(m.tagKey),
        dxPx: numberOrNull(m.dxPx),
        dyPx: numberOrNull(m.dyPx),
        lengthPx: numberOrNull(m.lengthPx),
        lengthMm: numberOrNull(m.lengthMm),
        bodyLengthMm: numberOrNull(m.bodyLengthMm),
        magnification: numberOrNull(m.magnification),
        magnificationSource: ['PixelSpacing', 'EstimatedRadiographicMagnificationFactor', 'MidPlane', 'SupportPlane', 'HkPaStandard'].includes(m.magnificationSource) ? m.magnificationSource : '',
        spacingTag: ['ImagerPixelSpacing', 'PixelSpacing'].includes(m.spacingTag) ? m.spacingTag : '',
      };
      if (m._id && !String(m._id).startsWith('tmp-')) row._id = m._id;
      return row;
    });
}

const UPLOAD_DIR = process.env.UPLOAD_DIR || require('os').tmpdir();
const path = require('path');
const fs = require('fs');

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Generate a short readable id like CASE-26H8K2-3F
function newCaseId() {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `CASE-${stamp}-${rand}`;
}

// ---------------------------------------------------------------------------
// Read endpoints
// ---------------------------------------------------------------------------

exports.listCases = catchAsync(async (req, res) => {
  const { status, patientId, q, sortBy = 'createdAt', sortDir = 'desc' } = req.query;
  const filter = { ...OWNED };

  if (status) {
    const statusMatch = statusFilter(status);
    if (statusMatch) filter.status = statusMatch;
  }
  if (patientId) filter.patientId = new RegExp(escapeRegex(patientId), 'i');
  if (isReferringDoctor(req.user)) {
    const allowed = ['finalized', 'requested'];
    if (!filter.status) filter.status = { $in: allowed };
    else if (typeof filter.status === 'string' && !allowed.includes(publicStatus(filter.status))) filter.status = '__none__';
    else if (filter.status.$in) filter.status = '__none__';
  } else if (isTechnician(req.user)) {
    filter.status = 'requested';
  }
  // A patient sees their own endorsed cases only. Set last so nothing in the query string can widen it.
  const patientScope = () => {
    filter.patientId = String(req.user.patientId || '').trim() || '__none__';
    filter.status = 'finalized';
  };
  if (q) {
    const re = new RegExp(escapeRegex(q), 'i');
    filter.$or = [
      { caseId: re },
      { patientId: re },
      { patientName: re },
      { firstName: re },
      { middleName: re },
      { lastName: re },
      { createdByName: re },
      { diagnosis: re },
      { reportText: re },
      { history: re },
    ];
  }

  if (isPatient(req.user)) patientScope();

  // Cosmos DB can't sort by indexed fields the index doesn't cover reliably;
  // do an in-memory sort to be safe across all fields.
  const docs = await Case.find(filter).lean();
  const dir = sortDir === 'asc' ? 1 : -1;
  docs.sort((a, b) => {
    const av = a[sortBy];
    const bv = b[sortBy];
    if (av === bv) return 0;
    if (av === undefined || av === null) return 1;
    if (bv === undefined || bv === null) return -1;
    if (av instanceof Date || bv instanceof Date) {
      return (new Date(av).getTime() - new Date(bv).getTime()) * dir;
    }
    return String(av).localeCompare(String(bv)) * dir;
  });

  const items = docs.map((c) => toPublicCase(c, publicCaseOpts(req, c)));

  res.json({ success: true, total: items.length, cases: items });
});

exports.getCase = catchAsync(async (req, res, next) => {
  const c = await findCaseByAnyId(req.params.id);
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));
  const raw = typeof c.toObject === 'function' ? c.toObject() : c;
  const visibleStatus = publicStatus(raw.status);
  if (isReferringDoctor(req.user) && visibleStatus !== 'finalized' && visibleStatus !== 'requested') {
    return next(ApiError.forbidden('Doctors can only open endorsed reports and their X-ray requests.'));
  }
  if (isTechnician(req.user) && visibleStatus !== 'requested') {
    return next(ApiError.forbidden('Technicians can only open requested cases.'));
  }
  // Another patient's case, and an own case that is not endorsed yet, look the same as one that does not exist.
  if (isPatient(req.user)
    && (!req.user.patientId || raw.patientId !== req.user.patientId || visibleStatus !== 'finalized')) {
    return next(ApiError.notFound(`Case ${req.params.id} not found`));
  }
  res.json({ success: true, case: toPublicCase(raw, publicCaseOpts(req, raw)) });
});

// ---------------------------------------------------------------------------
// Create (upload + AI analyze)
// ---------------------------------------------------------------------------

exports.createCase = catchAsync(async (req, res, next) => {
  if (!req.file) return next(ApiError.badRequest('Please upload an X-Ray image.'));
  const { patientId, age, sex, history } = req.body || {};
  if (!patientId) return next(ApiError.badRequest('patientId is required.'));
  const names = nameFieldsFrom(req.body || {});
  if (!names.firstName || !names.lastName) {
    return next(ApiError.badRequest('First name and last name are required.'));
  }

  let film;
  try {
    film = prepareFilm(req.file);
  } catch (err) {
    return next(ApiError.badRequest(err.message || 'Could not read that DICOM file.'));
  }

  const up = bucket().openUploadStream(film.filename, {
    contentType: film.contentType,
    metadata: { patientId, uploader: req.user.userId, sourceFilename: req.file.originalname },
  });
  await new Promise((resolve, reject) => {
    up.end(film.buffer, (err) => (err ? reject(err) : resolve()));
  });
  const imageId = up.id;

  const sexValue = ['Female', 'Male', 'Other'].includes(sex) ? sex : '';
  const userId = req.user.userId;
  const userName = req.user.name;
  const requestCaseId = String(req.body.requestCaseId || '').trim();
  if (requestCaseId) {
    const open = await Case.findOne({ caseId: requestCaseId, status: 'requested' });
    if (!open) return next(ApiError.badRequest('That X-ray request is not open.'));
    const { arrivalComplete } = await radiologyRequest();
    if (!arrivalComplete(open.arrival)) {
      return next(ApiError.badRequest('Check the patient in before registering the film.'));
    }
    let tmpPath = '';
    try {
      open.imageId = imageId;
      open.registeredAt = new Date();
      Object.assign(open, filmFields(film));
      open.imageFilename = film.filename;
      open.imageContentType = film.contentType;
      open.imageSize = film.size;
      open.createdBy = userId;
      open.createdByName = userName;
      if (history) open.history = history;
      markGenerating(open);
      tmpPath = writeAnalysisFile(open, film.buffer);
      await open.save();
      await addAuditLog(userId, 'CASE_CREATED', `Registered film for request ${open.caseId}`, open.caseId, null, 'pending');
      enqueueAnalysis(open, userId, tmpPath);
    } catch (err) {
      if (tmpPath) {
        try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
      }
      await restoreOpenRequest(requestCaseId);
      return next(ApiError.badRequest(err.message || 'The film was not saved. The request is still open.'));
    }
    return res.status(201).json({
      success: true,
      analysing: true,
      case: toPublicCase(open, publicCaseOpts(req, open)),
    });
  }

  const caseId = newCaseId();

  await upsertPatientFromCase({
    patientId,
    firstName: names.firstName,
    middleName: names.middleName,
    lastName: names.lastName,
    patientName: names.name,
    age: age || '',
    sex: sexValue,
    history: history || '',
  });

  const doc = await Case.create({
    caseId,
    patientId,
    firstName: names.firstName,
    middleName: names.middleName,
    lastName: names.lastName,
    patientName: names.name,
    age: age || '',
    sex: sexValue,
    history: history || '',
    diagnosis: 'Generating report…',
    diagnosisSource: '',
    reportText: '',
    findings: [],
    status: 'pending',
    analysisState: 'running',
    editLog: [],
    createdBy: userId,
    createdByName: userName,
    registeredAt: new Date(),
    ...filmFields(film),
    imageId,
    imageFilename: film.filename,
    imageContentType: film.contentType,
    imageSize: film.size,
    aiProvider: '',
    aiModel: '',
  });

  await addAuditLog(
    userId,
    'CASE_CREATED',
    `Created case ${caseId} for ${patientId}`,
    caseId,
    null,
    'pending'
  );
  await queueAnalysis(doc, userId, film.buffer);

  res.status(201).json({
    success: true,
    analysing: true,
    case: toPublicCase(doc, publicCaseOpts(req, doc)),
  });
});

function markGenerating(doc) {
  doc.status = 'pending';
  doc.analysisState = 'running';
  doc.diagnosis = 'Generating report…';
}

function writeAnalysisFile(doc, fileBuffer) {
  const ext = path.extname(doc.imageFilename || '') || '.jpg';
  const tmpPath = path.join(UPLOAD_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  fs.writeFileSync(tmpPath, fileBuffer);
  return tmpPath;
}

function enqueueAnalysis(doc, userId, tmpPath) {
  const caseId = doc.caseId;
  const patientId = doc.patientId;
  const age = doc.age;
  const sex = doc.sex;
  const history = doc.history;
  const aiModel = process.env.AI_MODEL_PATH || '/Users/PHY/CURV-mlx';
  setImmediate(() => {
    finishAnalysis({ caseId, tmpPath, patientId, age, sex, history, userId, aiModel })
      .catch((err) => console.error('[createCase] background analysis failed:', err));
  });
}

async function restoreOpenRequest(requestCaseId) {
  await Case.updateOne({ caseId: requestCaseId }, {
    $set: {
      status: 'requested',
      analysisState: 'none',
      diagnosis: 'Chest X-ray requested',
      diagnosisSource: '',
      reportText: '',
      findings: [],
      findingTags: [],
      comment: '',
      measurements: [],
      imageId: null,
      imageFilename: '',
      imageContentType: '',
      imageSize: 0,
      registeredAt: null,
    },
    $unset: {
      pixelSpacingMm: '', imagerPixelSpacingMm: '', dicomPixelSpacingMm: '', pixelSpacingSource: '',
      estimatedMagnification: '', distanceSourceToDetectorMm: '', distanceSourceToPatientMm: '', bodyPartThicknessMm: '',
      dicomViewPosition: '', patientPosition: '', projectionCues: '',
      view: '', examinedAt: '',
    },
  });
}

function queueAnalysis(doc, userId, fileBuffer) {
  markGenerating(doc);
  const tmpPath = writeAnalysisFile(doc, fileBuffer);
  return doc.save().then(() => enqueueAnalysis(doc, userId, tmpPath));
}

exports.availability = catchAsync(async (req, res, next) => {
  const from = String(req.query.from || '');
  const to = String(req.query.to || from);
  let days;
  try {
    days = await xraySlots.availability(from, to);
  } catch (err) {
    return next(ApiError.badRequest(err.message));
  }
  res.json({
    success: true,
    slotCapacity: xraySlots.SLOT_CAPACITY,
    dailyQuota: xraySlots.DAILY_QUOTA,
    slotMinutes: xraySlots.SLOT_MINUTES,
    days,
  });
});

exports.requestExam = catchAsync(async (req, res, next) => {
  const patientId = String(req.body?.patientId || '').trim();
  if (!patientId) return next(ApiError.badRequest('patientId is required.'));
  const patient = await Patient.findOne({ patientId });
  if (!patient) return next(ApiError.badRequest('Register the patient before requesting an X-ray.'));
  const open = await Case.findOne({ ...OWNED, patientId, status: 'requested' });
  if (open) return next(ApiError.badRequest('This patient already has an open X-ray request.'));
  let day = String(req.body?.day || '').trim();
  let time = String(req.body?.time || '').trim();
  if (!day && req.body?.scheduledAt) {
    const booked = new Date(req.body.scheduledAt);
    if (Number.isNaN(booked.getTime())) return next(ApiError.badRequest('Choose a valid day on the calendar.'));
    ({ day, time } = xraySlots.localParts(booked));
  }
  if (!day || !time) return next(ApiError.badRequest('Choose a day and a time for the X-ray.'));
  const urgent = req.body?.urgent === true || req.body?.urgent === 'true';
  const reason = String(req.body?.clinicalReason || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!reason) return next(ApiError.badRequest('Enter the clinical reason for this X-ray.'));
  const problem = await xraySlots.slotProblem(day, time, new Date(), { urgent });
  if (problem) return next(ApiError.badRequest(problem));
  const scheduledAt = xraySlots.slotInstant(day, time);
  const { arrangementFor } = await radiologyRequest();
  const already = await Case.countDocuments({ status: 'requested', scheduledAt });
  const plan = arrangementFor(already, urgent);

  const doc = await Case.create({
    caseId: newCaseId(),
    patientId,
    firstName: patient.firstName || '',
    middleName: patient.middleName || '',
    lastName: patient.lastName || '',
    patientName: patient.name || '',
    age: patient.age || '',
    sex: patient.sex || '',
    history: reason,
    clinicalReason: reason,
    examination: plan.examination,
    bodyPart: plan.bodyPart,
    equipment: plan.equipment,
    examRoom: plan.examRoom,
    assignedStaff: plan.assignedStaff,
    preparation: plan.preparation,
    diagnosis: 'Chest X-ray requested',
    status: 'requested',
    analysisState: 'none',
    reportText: '',
    findings: [],
    editLog: [],
    urgent,
    scheduledAt,
    requestedBy: req.user.userId,
    requestedByName: req.user.name,
    createdBy: req.user.userId,
    createdByName: req.user.name,
  });
  const lost = await xraySlots.overbooked(doc.caseId, day, time);
  if (lost) {
    await Case.deleteOne({ _id: doc._id });
    return next(new ApiError(409, lost));
  }
  await addAuditLog(req.user.userId, 'CASE_CREATED', `Requested chest X-ray ${doc.caseId} for ${patientId} on ${day} ${time} in ${doc.examRoom}`, doc.caseId, null, 'requested');
  res.status(201).json({
    success: true,
    case: toPublicCase(doc, publicCaseOpts(req, doc)),
  });
});

// The radiographer confirms identity, number, request, body part and the appointment
// before the film can be registered. The request itself is not changed.
exports.confirmArrival = catchAsync(async (req, res, next) => {
  const c = await findCaseByAnyId(req.params.id);
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));
  if (c.status !== 'requested') return next(ApiError.badRequest('Only an open request can be checked in.'));
  const { ARRIVAL_CHECKS } = await radiologyRequest();
  const body = req.body || {};
  const checks = {};
  for (const item of ARRIVAL_CHECKS) {
    if (body[item.key] !== true) {
      return next(ApiError.badRequest(`Confirm the ${item.label.toLowerCase()} before check-in.`));
    }
    checks[item.key] = true;
  }
  c.arrival = { ...checks, at: new Date(), byName: req.user.name || '' };
  await c.save();
  await addAuditLog(req.user.userId, 'CASE_UPDATED', `Checked in ${c.patientId} for ${c.caseId}`, c.caseId, null, 'requested');
  res.json({ success: true, case: toPublicCase(c, publicCaseOpts(req, c)) });
});

exports.analyzeCase = catchAsync(async (req, res, next) => {
  const c = await findCaseByAnyId(req.params.id);
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));
  if (c.status === 'finalized') {
    return next(ApiError.badRequest('This case is finalized and cannot be analysed again.'));
  }
  const runningFor = c.updatedAt ? Date.now() - new Date(c.updatedAt).getTime() : 0;
  if (c.analysisState === 'running' && runningFor < 3 * 60 * 1000) {
    return res.json({ success: true, analysing: true, case: toPublicCase(c, publicCaseOpts(req, c)) });
  }
  if (!c.imageId) return next(ApiError.badRequest('This case has no X-ray image.'));

  // Answer before reading the film. A 10 MB GridFS download was holding this
  // request open, so Re-run AI looked like it did nothing.
  c.status = 'pending';
  c.analysisState = 'running';
  c.boxesState = '';
  c.findings = [];
  c.findingTags = [];
  c.comment = '';
  c.measurements = [];
  c.diagnosis = 'Generating report…';
  await c.save();

  const caseId = c.caseId;
  const imageId = c.imageId;
  const imageFilename = c.imageFilename;
  const patientId = c.patientId;
  const age = c.age;
  const sex = c.sex;
  const history = c.history;
  const userId = req.user.userId;
  const aiModel = process.env.AI_MODEL_PATH || '/Users/PHY/CURV-mlx';

  res.json({
    success: true,
    analysing: true,
    case: toPublicCase(c, publicCaseOpts(req, c)),
  });

  setImmediate(() => {
    runStoredAnalysis({
      caseId,
      imageId,
      imageFilename,
      patientId,
      age,
      sex,
      history,
      userId,
      aiModel,
    }).catch((err) => console.error('[analyzeCase] background analysis failed:', err));
  });
});

async function runStoredAnalysis({ caseId, imageId, imageFilename, patientId, age, sex, history, userId, aiModel }) {
  let tmpPath = '';
  try {
    const image = await downloadImage(imageId);
    if (!image?.buffer) throw new Error('Could not load the stored X-ray.');
    const ext = path.extname(imageFilename || '') || '.png';
    tmpPath = path.join(UPLOAD_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    fs.writeFileSync(tmpPath, image.buffer);
    await finishAnalysis({
      caseId,
      tmpPath,
      patientId,
      age,
      sex,
      history,
      userId,
      aiModel,
    });
  } catch (err) {
    console.error('[analyzeCase] could not start from the stored film:', err.message);
    try { if (tmpPath) fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    const doc = await Case.findOne({ caseId });
    if (!doc || doc.status === 'finalized') return;
    doc.reportText = `[AI analysis unavailable: ${err.message}]\n\nA clinician should review the uploaded image and complete this report.`;
    doc.diagnosis = 'Report needs a manual draft';
    doc.status = 'pending_approve';
    doc.analysisState = 'done';
    await doc.save().catch((err2) => console.error('[analyzeCase] could not clear the stuck run:', err2.message));
  }
}

function mapAiFindings(aiFindings, reportText) {
  return (aiFindings || []).map((f, idx) => ({
    _id: f._id || `ai-${Date.now()}-${idx}`,
    id: f.id || `ai-${idx}`,
    label: f.label || 'AI finding',
    confidence: typeof f.confidence === 'number' ? f.confidence : 0.5,
    bbox: Array.isArray(f.bbox) && f.bbox.length === 4 ? f.bbox : [10, 10, 20, 20],
    location: f.location || '',
    size: f.size || '',
    pattern: f.pattern || 'Other',
    sentence: f.sentence || (reportText ? reportText.slice(0, 240) : ''),
    status: f.status || 'pending',
    source: f.source || 'AI',
  }));
}

async function finishAnalysis({ caseId, tmpPath, patientId, age, sex, history, userId, aiModel }) {
  let reportText = '';
  let aiFindings = [];
  let aiError = null;
  try {
    const aiResult = await analyzeXray({
      imagePath: tmpPath,
      patientId,
      age,
      sex,
      history,
    });
    reportText = aiResult.report || aiResult.reportText || '';
    aiFindings = Array.isArray(aiResult.findings) ? aiResult.findings : [];
    await addAuditLog(userId, 'AI_ANALYZED', `Middleware analysed X-ray for ${patientId} (${aiFindings.length} findings)`);
  } catch (err) {
    aiError = err.message;
    console.warn('AI middleware call failed:', err.message);
    reportText = `[AI analysis unavailable: ${err.message}]\n\nA clinician should review the uploaded image and complete this report.`;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
  }

  const c = await Case.findOne({ caseId });
  if (!c || c.status === 'finalized') return;

  // One tag per FINDINGS sentence and the COMMENT line. Thinking stays inside the
  // stored text, out of the list.
  let tags = [];
  let comment = '';
  if (!aiError && reportText.trim()) {
    try {
      const derived = await tagReport.derive(reportText);
      if (derived.findingTags.length || derived.comment) {
        tags = derived.findingTags;
        comment = derived.comment;
        reportText = await tagReport.assemble({ view: c.view, tags, comment, previousReportText: reportText, remarks: '' });
      }
    } catch (err) {
      console.warn('[finishAnalysis] could not split the draft into sentences:', err.message);
    }
  }

  let findings = dedupeFindings(mapAiFindings(aiFindings, reportText));
  let diagnosis = azureFindings.pickDiagnosis('', [], reportText) || (aiError ? 'Report needs a manual draft' : 'AI report');

  // Store the CURV draft before any slower labelling step. The model log
  // already says OK at this point; leaving analysisState running made the
  // work list stay on Generating.
  const wantBoxes = !aiError && Boolean((reportText || '').trim()) && azureFindings.isConfigured();
  c.reportText = reportText;
  c.findingTags = tags;
  c.comment = comment;
  c.findings = findings;
  c.diagnosis = diagnosis;
  c.diagnosisSource = 'local';
  c.status = 'pending_approve';
  c.analysisState = 'done';
  c.boxesState = wantBoxes ? 'running' : '';
  c.aiProvider = aiError ? '' : 'mlx_vlm';
  c.aiModel = aiError ? '' : aiModel;
  pushEditLog(c, {
    userId: userId || 'system',
    userName: 'CURV',
    kind: 'ai',
    summary: aiError
      ? `AI unavailable (${aiError}). Radiologist can complete the report by hand.`
      : 'AI generated draft report.',
  });
  try {
    await c.save();
  } catch (err) {
    console.error('[finishAnalysis] could not store the draft:', err.message);
    c.findings = [];
    c.findingTags = [];
    c.comment = '';
    c.diagnosis = 'Report needs a manual draft';
    c.reportText = reportText || `The draft could not be stored: ${err.message}`;
    c.status = 'pending_approve';
    c.analysisState = 'done';
    c.boxesState = '';
    await c.save().catch((err2) => console.error('[finishAnalysis] fallback save failed:', err2.message));
    return;
  }

  if (wantBoxes) await placeFilmBoxes(c, userId);
}

// Azure looks at the film and places one box for each abnormal sentence tag.
// The report text and the diagnosis label stay as CURV produced them.
async function placeFilmBoxes(c, userId) {
  const { caseId, reportText } = c;
  let boxes = [];
  let failed = false;
  try {
    const image = await downloadImage(c.imageId);
    boxes = (await azureFindings.placeTagBoxes(plainTags(c.findingTags), image)).boxes || [];
  } catch (err) {
    failed = true;
    console.warn('[placeFilmBoxes] Azure boxes skipped:', err.message);
  }
  c = await Case.findOne({ caseId });
  if (!c) return;
  const stale = c.status === 'finalized' || c.reportText !== reportText;
  if (boxes.length && !stale) c.findings = mergeTagBoxes(c.findings, plainTags(c.findingTags), boxes);
  c.boxesState = failed ? 'failed' : 'done';
  await c.save();
  if (boxes.length && !stale) {
    await addAuditLog(userId, 'CASE_UPDATED', `Azure AI placed ${boxes.length} film boxes for ${caseId}`);
  }
}

function plainTags(list) {
  return (Array.isArray(list) ? list : []).map((t) => (t && typeof t.toObject === 'function' ? t.toObject() : { ...t }));
}

// ---------------------------------------------------------------------------
// Update (edit findings / save draft / finalize / delete)
// ---------------------------------------------------------------------------

// Locate a case by human-readable `caseId` (CASE-...) or Mongo ObjectId.
// UUID `_id` documents from the old FastAPI writer have no `caseId` and
// cannot be saved through Mongoose, so they are treated as not found.
async function findCaseByAnyId(id) {
  const sid = String(id || "").trim();
  if (!sid) return null;
  let c = await Case.findOne({ caseId: sid });
  if (c) return c;
  // Missing CASE-* ids are gone from Mongo; skip ObjectId / raw _id
  // lookups so deleted-case polls do not burn Cosmos RUs.
  if (/^CASE-/i.test(sid)) return null;
  if (mongoose.Types.ObjectId.isValid(sid)) {
    try {
      c = await Case.findById(sid);
      if (c && c.caseId) return c;
    } catch { /* UUID-shaped values can look valid to isValid() */ }
  }
  try {
    const raw = await mongoose.connection.db.collection("cases").findOne({ _id: sid });
    if (!raw || !raw.caseId) return null;
    return Case.hydrate(raw);
  } catch {
    return null;
  }
}

exports.updateCase = catchAsync(async (req, res, next) => {
  const c = await findCaseByAnyId(req.params.id);
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));

  const oldStatus = c.status;
  const prevSnapshot = {
    findingTags: plainTags(c.findingTags),
    reportText: c.reportText,
    remarks: c.remarks,
    findings: (c.findings || []).map((row) => (row.toObject ? row.toObject() : { ...row })),
    measurements: (c.measurements || []).map((row) => (row.toObject ? row.toObject() : { ...row })),
  };
  const { diagnosis, reportText, findings, remarks, urgent, measurements, findingTags, comment, view } = req.body || {};
  const tagged = Array.isArray(findingTags);
  if (c.analysisState === 'running' && (diagnosis !== undefined || reportText !== undefined || Array.isArray(findings) || tagged)) {
    return next(ApiError.badRequest('The report is still generating.'));
  }
  // A finalized report is locked. Clinicians can still leave remarks and
  // toggle urgency, but those notes must not rewrite the stored report.
  if (urgent !== undefined) c.urgent = Boolean(urgent);
  if (c.status === 'finalized') {
    if (remarks !== undefined) c.remarks = remarks;
  } else {
    if (diagnosis !== undefined) c.diagnosis = diagnosis;
    if (reportText !== undefined) c.reportText = reportText;
    if (remarks !== undefined) c.remarks = remarks;
    if (Array.isArray(findings)) c.findings = sanitizeFindings(findings);
    if (Array.isArray(measurements)) c.measurements = sanitizeMeasurements(measurements);
    if (view !== undefined) c.view = cleanView(view);
    if (tagged) {
      c.findingTags = sanitizeTags(findingTags);
      if (comment !== undefined) c.comment = String(comment || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    } else if (comment !== undefined) {
      c.comment = String(comment || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    }
    if (tagged || comment !== undefined || view !== undefined) {
      // The stored report is always what the tags say, so the referring doctor,
      // the share link and both downloads match what the radiologist sees.
      if (tagged || c.findingTags.length || c.comment) {
        c.reportText = await tagReport.assemble({
          view: c.view,
          tags: c.findingTags,
          comment: c.comment,
          previousReportText: c.reportText,
          remarks: c.remarks,
        });
      }
    }
    const diff = buildEditChanges(prevSnapshot, {
      findingTags: plainTags(c.findingTags),
      reportText: c.reportText,
      remarks: c.remarks,
      findings: (c.findings || []).map((row) => (row.toObject ? row.toObject() : { ...row })),
      measurements: (c.measurements || []).map((row) => (row.toObject ? row.toObject() : { ...row })),
    });
    if (diff.changes.length) {
      pushEditLog(c, {
        userId: req.user.userId,
        userName: req.user.name,
        kind: 'manual',
        summary: diff.summary,
        changes: diff.changes,
      });
    }
  }

  await c.save();

  if (oldStatus !== c.status) {
    await addAuditLog(req.user.userId, 'CASE_UPDATED', `Status ${oldStatus} -> ${c.status}`, c.caseId, oldStatus, c.status);
  } else {
    await addAuditLog(req.user.userId, 'CASE_UPDATED', `Edited case ${c.caseId || c._id}`, c.caseId || String(c._id));
  }

  res.json({ success: true, case: toPublicCase(c, publicCaseOpts(req, c)) });
});

exports.finalizeCase = catchAsync(async (req, res, next) => {
  const c = await findCaseByAnyId(req.params.id);
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));
  if (c.analysisState === 'running') {
    return next(ApiError.badRequest('The report is still generating.'));
  }

  c.status = 'finalized';
  c.finalizedBy = req.user.userId;
  c.finalizedByName = req.user.name;
  c.finalizedAt = new Date();
  c.chartFindings = [];
  c.chartFindingsState = '';
  c.chartFindingsError = '';
  await c.save();
  await addAuditLog(req.user.userId, 'CASE_FINALIZED', `Finalized case ${c.caseId || c._id}`, c.caseId || String(c._id), null, 'finalized');

  c.chartFindingsState = await queueChartFindings(c, { userId: req.user.userId });
  // The lay summary is written only now, from the endorsed report, in the background. It does not slow
  // endorsement down and a failure cannot undo it.
  c.laySummaryState = await queueLaySummary(c, { userId: req.user.userId });
  res.json({ success: true, case: toPublicCase(c, publicCaseOpts(req, c)) });
});

// Write the lay summary again (after a failure, or when Azure was not set up at endorsement).
// Refused for a report that is not endorsed. Waits for the result.
exports.laySummaryCase = catchAsync(async (req, res, next) => {
  const c = await findCaseByAnyId(req.params.id);
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));
  if (c.status !== 'finalized') {
    return next(ApiError.badRequest('A lay summary is written only after the report is endorsed.'));
  }
  if (!azureFindings.isConfigured()) {
    return next(ApiError.badRequest('Azure OpenAI is not configured on the server. See docs/azure-findings.md.'));
  }
  const state = await queueLaySummary(c, { userId: req.user.userId, force: true, wait: true });
  const fresh = await findCaseByAnyId(req.params.id);
  res.json({ success: true, state, case: toPublicCase(fresh, publicCaseOpts(req, fresh)) });
});

// Retry from the patient chart when Azure failed on an endorsed report.
exports.rewriteChartFindings = catchAsync(async (req, res, next) => {
  const c = await findCaseByAnyId(req.params.id);
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));
  if (c.status !== 'finalized') {
    return next(ApiError.badRequest('Chart findings are written after the report is endorsed.'));
  }
  const state = await queueChartFindings(c, { userId: req.user.userId, force: true });
  res.json({ success: true, chartFindingsState: state });
});

exports.createShareLink = catchAsync(async (req, res, next) => {
  const c = await findCaseByAnyId(req.params.id);
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));
  if (c.status !== 'finalized') {
    return next(ApiError.badRequest('Only a finalized report can be shared.'));
  }
  if (!c.shareToken) {
    c.shareToken = crypto.randomBytes(24).toString('base64url');
    await c.save();
    await addAuditLog(
      req.user.userId,
      'CASE_SHARED',
      `Created a share link for ${c.caseId || c._id}`,
      c.caseId || String(c._id)
    );
  }
  res.json({
    success: true,
    token: c.shareToken,
    case: toPublicCase(c, { includeShareToken: true }),
  });
});

exports.revokeShareLink = catchAsync(async (req, res, next) => {
  const c = await findCaseByAnyId(req.params.id);
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));
  c.shareToken = undefined; // unset, not null: see the shareToken note in models/Case.js
  await c.save();
  await addAuditLog(
    req.user.userId,
    'CASE_SHARED',
    `Revoked the share link for ${c.caseId || c._id}`,
    c.caseId || String(c._id)
  );
  res.json({ success: true, case: toPublicCase(c, { includeShareToken: true }) });
});

async function findSharedCase(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  return Case.findOne({ shareToken: t, status: 'finalized', ...OWNED });
}

exports.getSharedCase = catchAsync(async (req, res, next) => {
  const c = await findSharedCase(req.params.token);
  if (!c) return next(ApiError.notFound('This share link is invalid or has been turned off.'));
  const pub = toPublicCase(c);
  res.json({
    success: true,
    case: {
      caseId: pub.caseId,
      patientId: pub.patientId,
      patientName: pub.patientName,
      firstName: pub.firstName,
      middleName: pub.middleName,
      lastName: pub.lastName,
      age: pub.age,
      sex: pub.sex,
      history: pub.history,
      diagnosis: pub.diagnosis,
      reportText: pub.reportText,
      remarks: pub.remarks,
      findings: pub.findings,
      findingTags: pub.findingTags,
      comment: pub.comment,
      view: pub.view,
      examinedAt: pub.examinedAt,
      requestedByName: pub.requestedByName,
      measurements: pub.measurements,
      imagerPixelSpacingMm: pub.imagerPixelSpacingMm,
      dicomPixelSpacingMm: pub.dicomPixelSpacingMm,
      pixelSpacingMm: pub.pixelSpacingMm,
      pixelSpacingSource: pub.pixelSpacingSource,
      estimatedMagnification: pub.estimatedMagnification,
      distanceSourceToDetectorMm: pub.distanceSourceToDetectorMm,
      distanceSourceToPatientMm: pub.distanceSourceToPatientMm,
      bodyPartThicknessMm: pub.bodyPartThicknessMm,
      dicomViewPosition: pub.dicomViewPosition,
      patientPosition: pub.patientPosition,
      projectionCues: pub.projectionCues,
      status: pub.status,
      imageId: pub.imageId,
      createdByName: pub.createdByName,
      finalizedByName: pub.finalizedByName,
      finalizedAt: pub.finalizedAt,
    },
  });
});

exports.streamSharedImage = catchAsync(async (req, res, next) => {
  const c = await findSharedCase(req.params.token);
  if (!c || !c.imageId) return next(ApiError.notFound('Image not found.'));
  req.params.id = String(c.imageId);
  return exports.streamImage(req, res, next);
});

async function removeCaseDoc(c) {
  return removeCaseRecord(c);
}

exports.deleteCase = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'admin') return next(ApiError.forbidden('Only admins can delete.'));
  const c = await findCaseByAnyId(req.params.id);
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));

  const caseId = await removeCaseDoc(c);
  await addAuditLog(req.user.userId, 'CASE_DELETED', `Deleted case ${caseId}`, caseId);
  res.json({ success: true });
});

exports.deleteCases = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'admin') return next(ApiError.forbidden('Only admins can delete.'));
  const ids = Array.isArray(req.body?.ids)
    ? [...new Set(req.body.ids.map((id) => String(id || '').trim()).filter(Boolean))]
    : [];
  if (!ids.length) return next(ApiError.badRequest('Select at least one case.'));

  const deleted = [];
  for (const id of ids) {
    const c = await findCaseByAnyId(id);
    if (!c) continue;
    deleted.push(await removeCaseDoc(c));
  }
  await addAuditLog(
    req.user.userId,
    'CASE_DELETED',
    `Deleted ${deleted.length} ${deleted.length === 1 ? 'case' : 'cases'}`,
    deleted[0] || null
  );
  res.json({ success: true, deleted: deleted.length, ids: deleted });
});

// ---------------------------------------------------------------------------
// Image streaming
// ---------------------------------------------------------------------------

exports.streamImage = catchAsync(async (req, res, next) => {
  if (isPatient(req.user)) return next(ApiError.forbidden('Patients cannot open the X-ray image.'));
  let oid;
  try { oid = new mongoose.Types.ObjectId(req.params.id); }
  catch (_) { return next(ApiError.badRequest('Invalid image id.')); }

  const db = mongoose.connection.db;
  // Express writes to `images`; the old FastAPI middleware wrote to `fs`.
  for (const name of ['images', 'fs']) {
    const file = await db.collection(`${name}.files`).findOne({ _id: oid });
    if (!file) continue;
    const image = await downloadImage(req.params.id);
    if (!image?.buffer) continue;
    res.set('Content-Type', image.contentType || file.contentType || 'image/jpeg');
    res.set('Content-Length', image.buffer.length);
    res.set('Cache-Control', 'private, max-age=86400');
    if ((image.rowScale && image.rowScale !== 1) || (image.colScale && image.colScale !== 1)) {
      res.set('X-Pixel-Scale', `${image.rowScale},${image.colScale}`);
      res.set('Access-Control-Expose-Headers', 'X-Pixel-Scale');
    }
    return res.end(image.buffer);
  }
  return next(ApiError.notFound('Image not found.'));
});

// ---------------------------------------------------------------------------
// Azure AI findings summary
// ---------------------------------------------------------------------------

// Replace the case's machine-generated findings with a short, grouped set
// produced by Azure OpenAI from the report text. Findings the clinician has
// already accepted, rejected or added by hand are kept.
exports.summariseFindings = catchAsync(async (req, res, next) => {
  if (!azureFindings.isConfigured()) {
    return next(ApiError.badRequest(
      'Azure OpenAI is not configured on the server. See docs/azure-findings.md.'
    ));
  }

  const c = await findCaseByAnyId(req.params.id);
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));
  if (c.status === 'pending') {
    return next(ApiError.badRequest('The report is still generating.'));
  }
  if (c.status === 'finalized') {
    return next(ApiError.badRequest('This case is finalized and cannot be changed.'));
  }

  // An older case has only report text: split it into tags once.
  if (!c.findingTags.length && String(c.reportText || '').trim()) {
    const derived = await tagReport.derive(c.reportText);
    if (derived.findingTags.length || derived.comment) {
      c.findingTags = derived.findingTags;
      if (!c.comment) c.comment = derived.comment;
    }
  }
  const tags = plainTags(c.findingTags);
  if (!azureFindings.tagsNeedingBoxes(tags).length) {
    return next(ApiError.badRequest('No abnormal sentence in this report needs a box.'));
  }

  let placed;
  try {
    const image = await downloadImage(c.imageId);
    placed = await azureFindings.placeTagBoxes(tags, image);
  } catch (err) {
    return next(ApiError.badRequest(err.message));
  }
  const findings = placed.boxes || [];
  if (findings.length === 0) {
    return next(ApiError.badRequest('Azure AI did not return any boxes for this report.'));
  }

  c.findings = mergeTagBoxes(c.findings, tags, findings);
  c.boxesState = 'done';
  await c.save();

  await addAuditLog(
    req.user.userId,
    'CASE_UPDATED',
    `Azure AI summarised ${findings.length} findings for ${c.caseId || c._id}`,
    c.caseId || String(c._id)
  );

  res.json({
    success: true,
    case: toPublicCase(c),
  });
});

// History LLM: summary, differentials and questions from the patient's chart
// history alone. The logic is in utils/historyReasoning.js; this stores it.
// It does not run the second opinion and does not touch the report or the film.
// Allowed on a finalized case because it does not touch the stored report.
exports.reasonCase = catchAsync(async (req, res, next) => {
  if (!azureFindings.isConfigured()) {
    return next(ApiError.badRequest(
      'Azure OpenAI is not configured on the server. See docs/azure-findings.md.'
    ));
  }

  const c = await findCaseByAnyId(req.params.id);
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));

  let analysis;
  try {
    analysis = await reasonAboutHistory(c);
  } catch (err) {
    return next(ApiError.badRequest(err.message));
  }

  c.historyAnalysis = { ...analysis, generatedAt: new Date().toISOString() };
  await c.save();

  await addAuditLog(
    req.user.userId,
    'AI_ANALYZED',
    `History reasoning for ${c.caseId || c._id} (${analysis.differentials.length} differentials)`,
    c.caseId || String(c._id)
  );

  res.json({
    success: true,
    historyAnalysis: c.historyAnalysis,
    case: toPublicCase(c, publicCaseOpts(req, c)),
  });
});

// Independent second opinion (utils/secondOpinion.js): the AI reads the film and the
// patient's chart, never CURV's sentences, the report or the boxes. It runs only when the
// radiologist asks, on a stored draft, and its answer is kept on Case.fusionResult as
// reference text. It never edits the report and never finalises a case: only
// finalizeCase does, and only a radiologist can call that.
exports.secondOpinionCase = catchAsync(async (req, res, next) => {
  if (!azureFindings.isConfigured()) {
    return next(ApiError.badRequest(
      'Azure OpenAI is not configured on the server. See docs/azure-findings.md.'
    ));
  }

  const c = await findCaseByAnyId(req.params.id);
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));
  if (c.analysisState === 'running') {
    return next(ApiError.badRequest('The report is still generating.'));
  }
  if (!c.imageId) return next(ApiError.badRequest('This case has no X-ray image.'));
  if (!String(c.reportText || '').trim() && !plainTags(c.findingTags).length) {
    return next(ApiError.badRequest('There is no saved draft yet. Save a draft first.'));
  }

  let result;
  try {
    const image = await downloadImage(c.imageId);
    // Only these three case fields go in: no reportText, findingTags, findings or boxes.
    result = await secondOpinion({
      caseId: c.caseId,
      patientId: c.patientId,
      history: c.history,
      image,
      sepsisScreen: req.body?.sepsisScreen,
    });
  } catch (err) {
    return next(ApiError.badRequest(err.message));
  }

  // Saved with a targeted update, so a draft edit made while Azure was thinking is not overwritten.
  const fusionResult = { ...result, generatedAt: new Date().toISOString() };
  await Case.updateOne({ caseId: c.caseId }, { $set: { fusionResult } });
  c.fusionResult = fusionResult;

  await addAuditLog(
    req.user.userId,
    'AI_ANALYZED',
    `Second opinion for ${c.caseId || c._id}: ${result.diagnosis}`,
    c.caseId || String(c._id)
  );

  res.json({
    success: true,
    secondOpinion: fusionResult,
    case: toPublicCase(c, publicCaseOpts(req, c)),
  });
});

// ---------------------------------------------------------------------------
// The reasoning agent (utils/agent.js). It runs after the Second Reader, on demand, for a
// radiologist or admin, and its two searches use the Second Reader's diagnosis. It never edits
// the report: it returns suggestions and the results of its tools, and keeps them on
// Case.agentResult. Each tool call is in the audit log. notify is part of a run only when the
// request body says {"notify": true}; the review panel never sends that.
// ---------------------------------------------------------------------------
exports.agentCase = catchAsync(async (req, res, next) => {
  if (!azureFindings.isConfigured()) {
    return next(ApiError.badRequest(
      'Azure OpenAI is not configured on the server. See docs/azure-findings.md.'
    ));
  }

  const c = await findCaseByAnyId(req.params.id);
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));
  if (!c.caseId) return next(ApiError.badRequest('This record cannot be analysed by the agent.'));
  if (c.analysisState === 'running') {
    return next(ApiError.badRequest('The report is still generating.'));
  }
  if (!String(c.reportText || '').trim() && !plainTags(c.findingTags).length) {
    return next(ApiError.badRequest('There is no saved draft yet. Save a draft first.'));
  }

  let outcome;
  try {
    // The review panel's run is for supporting evidence only. notify is offered only when asked for.
    outcome = await runAgent({ caseDoc: c.toObject(), userId: req.user.userId, allowNotify: req.body?.notify === true });
  } catch (err) {
    return next(ApiError.badRequest(err.message));
  }

  const fresh = await findCaseByAnyId(req.params.id);
  res.json({
    success: true,
    agent: outcome.agent,
    toolCalls: outcome.calls,
    reusedTools: outcome.reused,
    case: toPublicCase(fresh || c, publicCaseOpts(req, fresh || c)),
  });
});

// Dashboard Diagnosis column. Text-only, cheap, and allowed on finalized
// cases because it does not rewrite the stored report.
exports.summariseDiagnosis = catchAsync(async (req, res, next) => {
  if (!azureFindings.isConfigured()) {
    return next(ApiError.badRequest(
      'Azure OpenAI is not configured on the server. See docs/azure-findings.md.'
    ));
  }

  const c = await findCaseByAnyId(req.params.id);
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));
  if (c.status === 'pending') {
    return next(ApiError.badRequest('The report is still generating.'));
  }
  if (!clinicianEdited(c)) {
    return res.json({ success: true, reused: true, case: toPublicCase(c) });
  }
  if (c.diagnosisSource === 'azure' && String(c.diagnosis || '').trim() && !azureFindings.needsAzureDiagnosis(c)) {
    return res.json({ success: true, reused: true, case: toPublicCase(c) });
  }

  let diagnosis;
  try {
    diagnosis = await azureFindings.summariseDiagnosis(c.reportText);
  } catch (err) {
    return next(ApiError.badRequest(err.message));
  }

  c.diagnosis = diagnosis;
  c.diagnosisSource = 'azure';
  await c.save();

  await addAuditLog(
    req.user.userId,
    'CASE_UPDATED',
    `Azure AI wrote diagnosis for ${c.caseId || c._id}`,
    c.caseId || String(c._id)
  );

  res.json({ success: true, case: toPublicCase(c) });
});
