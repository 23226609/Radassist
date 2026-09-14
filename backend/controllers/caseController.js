// controllers/caseController.js
// All case-related operations: list, create (upload + AI), read, update, delete.

const mongoose = require('mongoose');
const Case = require('../models/Case');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');
const addAuditLog = require('../utils/auditLogger');
const { analyzeXray } = require('../utils/aiService');
const azureFindings = require('../utils/azureFindings');
const { bucket, downloadImage } = require('./_gridfs');
const { nameFieldsFrom } = require('../utils/patientName');
const { toPublicCase, statusFilter } = require('../utils/caseStatus');
const { upsertPatientFromCase, removeCaseRecord } = require('../utils/recordSync');
const { OWNED } = Case;

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
  if (q) {
    const re = new RegExp(escapeRegex(q), 'i');
    filter.$or = [
      { caseId: re },
      { patientId: re },
      { patientName: re },
      { firstName: re },
      { middleName: re },
      { lastName: re },
      { diagnosis: re },
      { reportText: re },
      { history: re },
    ];
  }

  // Nurses see every case; doctors see every case (the design is intentionally permissive).
  // Admins see every case.

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

  // Add resolved image URLs and map the old `completed` status.
  const items = docs.map((c) => toPublicCase(c));

  res.json({ success: true, total: items.length, cases: items });
});

exports.getCase = catchAsync(async (req, res, next) => {
  // Accept both the human-friendly `caseId` (e.g. CASE-MTPHHNL7-O1T) and
  // a raw Mongo `_id` (legacy / orphaned records where `caseId` is empty
  // and `_id` is a UUID string rather than an ObjectId).
  const id = String(req.params.id || "").trim();
  let c = null;
  if (id) {
    c = await Case.findOne({ caseId: id }).lean();
    if (!c) {
      // Fall back to a raw lookup that bypasses schema casting so we can
      // match both ObjectId and string `_id` values.
      try {
        c = await mongoose.connection.db.collection("cases").findOne({ _id: id });
      } catch {
        c = null;
      }
    }
  }
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));
  res.json({ success: true, case: toPublicCase(c) });
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

  const up = bucket().openUploadStream(req.file.originalname, {
    contentType: req.file.mimetype,
    metadata: { patientId, uploader: req.user.userId },
  });
  await new Promise((resolve, reject) => {
    up.end(req.file.buffer, (err) => (err ? reject(err) : resolve()));
  });
  const imageId = up.id;

  const tmpName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${path.extname(req.file.originalname) || '.jpg'}`;
  const tmpPath = path.join(UPLOAD_DIR, tmpName);
  fs.writeFileSync(tmpPath, req.file.buffer);

  const caseId = newCaseId();
  const sexValue = ['Female', 'Male', 'Other'].includes(sex) ? sex : '';
  const aiModel = process.env.AI_MODEL_PATH || '/Users/PHY/CURV-mlx';
  const userId = req.user.userId;
  const userName = req.user.name;

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
    createdBy: userId,
    createdByName: userName,
    imageId,
    imageFilename: req.file.originalname,
    imageContentType: req.file.mimetype,
    imageSize: req.file.size,
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

  res.status(201).json({
    success: true,
    analysing: true,
    case: toPublicCase(doc),
  });

  setImmediate(() => {
    finishAnalysis({
      caseId,
      tmpPath,
      patientId,
      age,
      sex: sexValue,
      history,
      userId,
      aiModel,
    }).catch((err) => console.error('[createCase] background analysis failed:', err));
  });
});

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

  const sentence = (reportText || '').split('.').filter(Boolean)[0] || 'AI report';
  let diagnosis = sentence.slice(0, 120);
  let diagnosisSource = 'local';
  if (azureFindings.isConfigured() && (reportText || '').trim() && !aiError) {
    try {
      diagnosis = await azureFindings.summariseDiagnosis(reportText);
      diagnosisSource = 'azure';
    } catch (err) {
      console.warn('[createCase] Azure diagnosis skipped:', err.message);
    }
  }

  c.reportText = reportText;
  c.findings = mapAiFindings(aiFindings, reportText);
  c.diagnosis = diagnosis;
  c.diagnosisSource = diagnosisSource;
  c.status = 'pending_approve';
  c.aiProvider = aiError ? '' : 'mlx_vlm';
  c.aiModel = aiError ? '' : aiModel;
  await c.save();
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

  // Only doctors (and admins) can edit case content.
  if (req.user.role === 'nurse') {
    return next(ApiError.forbidden('Nurses cannot edit case content.'));
  }

  const oldStatus = c.status;
  const { diagnosis, reportText, findings, remarks, urgent } = req.body || {};
  if (c.status === 'pending' && (diagnosis !== undefined || reportText !== undefined || Array.isArray(findings))) {
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
    if (Array.isArray(findings)) c.findings = findings;
  }

  await c.save();

  if (oldStatus !== c.status) {
    await addAuditLog(req.user.userId, 'CASE_UPDATED', `Status ${oldStatus} -> ${c.status}`, c.caseId, oldStatus, c.status);
  } else {
    await addAuditLog(req.user.userId, 'CASE_UPDATED', `Edited case ${c.caseId || c._id}`, c.caseId || String(c._id));
  }

  res.json({ success: true, case: toPublicCase(c) });
});

exports.finalizeCase = catchAsync(async (req, res, next) => {
  if (req.user.role === 'nurse') return next(ApiError.forbidden('Only doctors or admins can finalize.'));
  const c = await findCaseByAnyId(req.params.id);
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));
  if (c.status === 'pending') {
    return next(ApiError.badRequest('The report is still generating.'));
  }

  c.status = 'finalized';
  c.finalizedBy = req.user.userId;
  c.finalizedByName = req.user.name;
  await c.save();
  await addAuditLog(req.user.userId, 'CASE_FINALIZED', `Finalized case ${c.caseId || c._id}`, c.caseId || String(c._id), null, 'finalized');

  res.json({ success: true, case: toPublicCase(c) });
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
  let oid;
  try { oid = new mongoose.Types.ObjectId(req.params.id); }
  catch (_) { return next(ApiError.badRequest('Invalid image id.')); }

  const db = mongoose.connection.db;
  // Express writes to `images`; the old FastAPI middleware wrote to `fs`.
  for (const name of ['images', 'fs']) {
    const file = await db.collection(`${name}.files`).findOne({ _id: oid });
    if (!file) continue;
    const cursor = bucket(name).openDownloadStream(oid);
    cursor.on('error', (err) => next(ApiError.notFound(err.message)));
    res.set('Content-Type', file.contentType || 'image/jpeg');
    if (file.length) res.set('Content-Length', file.length);
    return cursor.pipe(res);
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

  let summarised;
  try {
    const image = await downloadImage(c.imageId);
    summarised = await azureFindings.summariseFindings(c.reportText, image);
  } catch (err) {
    return next(ApiError.badRequest(err.message));
  }
  const findings = summarised.findings || [];
  if (findings.length === 0) {
    return next(ApiError.badRequest('Azure AI did not return any findings for this report.'));
  }

  const kept = (c.findings || []).filter(
    (f) => f.status !== 'pending' || !['AI', 'Azure'].includes(f.source)
  );
  c.findings = [...kept, ...findings];
  if (summarised.diagnosis) {
    c.diagnosis = summarised.diagnosis;
    c.diagnosisSource = 'azure';
  }
  await c.save();

  await addAuditLog(
    req.user.userId,
    'CASE_UPDATED',
    `Azure AI summarised ${findings.length} findings for ${c.caseId || c._id}`,
    c.caseId || String(c._id)
  );

  res.json({
    success: true,
    added: findings.length,
    kept: kept.length,
    case: toPublicCase(c),
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
  if (c.diagnosisSource === 'azure' && String(c.diagnosis || '').trim()) {
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
