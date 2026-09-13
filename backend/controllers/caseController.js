// controllers/caseController.js
// All case-related operations: list, create (upload + AI), read, update, delete.

const mongoose = require('mongoose');
const Case = require('../models/Case');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');
const addAuditLog = require('../utils/auditLogger');
const { analyzeXray } = require('../utils/aiService');
const azureFindings = require('../utils/azureFindings');
const { downloadImage } = require('./_gridfs');
const { upsertPatientFromCase } = require('./patientController');

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

// Open a GridFS bucket lazily (mongoose driver 4+ exposes .bucket()).
function bucket() {
  const db = mongoose.connection.db;
  return new mongoose.mongo.GridFSBucket(db, { bucketName: 'images' });
}

// ---------------------------------------------------------------------------
// Read endpoints
// ---------------------------------------------------------------------------

exports.listCases = catchAsync(async (req, res) => {
  const { status, patientId, q, sortBy = 'createdAt', sortDir = 'desc' } = req.query;
  const filter = {};

  if (status) filter.status = status;
  if (patientId) filter.patientId = new RegExp(escapeRegex(patientId), 'i');
  if (q) {
    const re = new RegExp(escapeRegex(q), 'i');
    filter.$or = [
      { caseId: re },
      { patientId: re },
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

  // Add resolved image URLs.
  const items = docs.map((c) => ({
    ...c,
    imageUrl: c.imageId ? `/api/images/${c.imageId}` : null,
  }));

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
  c.imageUrl = c.imageId ? `/api/images/${c.imageId}` : null;
  res.json({ success: true, case: c });
});

// ---------------------------------------------------------------------------
// Create (upload + AI analyze)
// ---------------------------------------------------------------------------

exports.createCase = catchAsync(async (req, res, next) => {
  if (!req.file) return next(ApiError.badRequest('Please upload an X-Ray image.'));
  const { patientId, age, sex, history } = req.body || {};
  if (!patientId) return next(ApiError.badRequest('patientId is required.'));

  // Push the image into GridFS.
  const up = bucket().openUploadStream(req.file.originalname, {
    contentType: req.file.mimetype,
    metadata: { patientId, uploader: req.user.userId },
  });
  await new Promise((resolve, reject) => {
    up.end(req.file.buffer, (err) => (err ? reject(err) : resolve()));
  });
  const imageId = up.id;

  // Stash a temp file path so the local mlx_vlm server can read it.
  const tmpName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${path.extname(req.file.originalname) || '.jpg'}`;
  const tmpPath = path.join(UPLOAD_DIR, tmpName);
  fs.writeFileSync(tmpPath, req.file.buffer);

  let reportText = '';
  let aiFindings = [];
  let aiError = null;
  let aiModel = process.env.AI_MODEL_PATH || '/Users/PHY/CURV-mlx';

  try {
    const aiResult = await analyzeXray({
      imagePath: tmpPath,
      patientId,
      age,
      sex,
      history,
    });
    // Middleware returns { report, findings } now.
    reportText = aiResult.report || aiResult.reportText || '';
    aiFindings = Array.isArray(aiResult.findings) ? aiResult.findings : [];
    await addAuditLog(req.user.userId, 'AI_ANALYZED', `Middleware analysed X-ray for ${patientId} (${aiFindings.length} findings)`);
  } catch (err) {
    aiError = err.message;
    console.warn('AI middleware call failed:', err.message);
    // Fallback: keep the case but with a placeholder so the workflow doesn't break.
    reportText = `[AI analysis unavailable: ${err.message}]\n\nA clinician should review the uploaded image and complete this report.`;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
  }

  const caseId = newCaseId();
  const sentence = (reportText || '').split('.').filter(Boolean)[0] || 'AI report';
  let diagnosis = sentence.slice(0, 120);
  let diagnosisSource = 'local';
  if (azureFindings.isConfigured() && (reportText || '').trim()) {
    try {
      diagnosis = await azureFindings.summariseDiagnosis(reportText);
      diagnosisSource = 'azure';
    } catch (err) {
      console.warn('[createCase] Azure diagnosis skipped:', err.message);
    }
  }

  // Findings come straight from the AI service. Don't parse the report —
  // the AI model produces them as a structured JSON list with bbox / confidence
  // / location / size / pattern / source. The clinician can edit / accept /
  // reject each one or add manual findings.
  const findings = (aiFindings || []).map((f, idx) => ({
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

  const doc = await Case.create({
    caseId,
    patientId,
    age: age || '',
    sex: ['Female', 'Male', 'Other'].includes(sex) ? sex : '',
    history: history || '',
    diagnosis,
    diagnosisSource,
    reportText,
    findings,
    status: 'completed',
    createdBy: req.user.userId,
    createdByName: req.user.name,
    imageId,
    imageFilename: req.file.originalname,
    imageContentType: req.file.mimetype,
    imageSize: req.file.size,
    aiProvider: aiError ? '' : 'mlx_vlm',
    aiModel: aiError ? '' : aiModel,
  });

  try { await upsertPatientFromCase(doc); } catch (err) {
    console.warn('[createCase] patient upsert skipped:', err.message);
  }

  await addAuditLog(
    req.user.userId,
    'CASE_CREATED',
    `Created case ${caseId} for ${patientId}${aiError ? ' (AI failed)' : ''}`,
    caseId,
    null,
    'completed'
  );

  res.status(201).json({
    success: true,
    case: { ...doc.toObject(), imageUrl: `/api/images/${imageId}` },
    aiError,
  });
});

// ---------------------------------------------------------------------------
// Update (edit findings / save draft / finalize / delete)
// ---------------------------------------------------------------------------

// Locate a case by either its human-readable `caseId` (CASE-...) or a raw
// Mongo `_id` (used by legacy / orphaned records where `caseId` is empty
// and `_id` is a UUID string rather than an ObjectId).  Returns the
// mongoose model instance so callers can `c.save()`, or `null` if not
// found.
async function findCaseByAnyId(id) {
  const sid = String(id || "").trim();
  if (!sid) return null;
  let c = await Case.findOne({ caseId: sid });
  if (c) return c;
  try {
    const raw = await mongoose.connection.db.collection("cases").findOne({ _id: sid });
    if (!raw) return null;
    // Re-hydrate through the mongoose model so callers get a save()-able
    // instance and benefit from schema defaults.
    return await Case.findById(raw._id);
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
  const { diagnosis, reportText, findings, remarks } = req.body || {};
  // A finalized report is locked. Clinicians can still leave remarks, but
  // those notes must not rewrite the stored report or findings.
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

  res.json({ success: true, case: { ...c.toObject(), imageUrl: c.imageId ? `/api/images/${c.imageId}` : null } });
});

exports.finalizeCase = catchAsync(async (req, res, next) => {
  if (req.user.role === 'nurse') return next(ApiError.forbidden('Only doctors or admins can finalize.'));
  const c = await findCaseByAnyId(req.params.id);
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));

  c.status = 'finalized';
  c.finalizedBy = req.user.userId;
  c.finalizedByName = req.user.name;
  await c.save();
  await addAuditLog(req.user.userId, 'CASE_FINALIZED', `Finalized case ${c.caseId || c._id}`, c.caseId || String(c._id), null, 'finalized');

  res.json({ success: true, case: { ...c.toObject(), imageUrl: c.imageId ? `/api/images/${c.imageId}` : null } });
});

exports.deleteCase = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'admin') return next(ApiError.forbidden('Only admins can delete.'));
  const c = await findCaseByAnyId(req.params.id);
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));

  // Drop the GridFS image too.
  if (c.imageId) {
    try { await bucket().delete(c.imageId); } catch (_) { /* ignore */ }
  }
  await Case.deleteOne({ _id: c._id });
  await addAuditLog(req.user.userId, 'CASE_DELETED', `Deleted case ${c.caseId || c._id}`, c.caseId || String(c._id));
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Image streaming
// ---------------------------------------------------------------------------

exports.streamImage = catchAsync(async (req, res, next) => {
  let oid;
  try { oid = new mongoose.Types.ObjectId(req.params.id); }
  catch (_) { return next(ApiError.badRequest('Invalid image id.')); }

  let cursor;
  try {
    cursor = bucket().openDownloadStream(oid);
  } catch (err) {
    return next(ApiError.notFound('Image not found.'));
  }

  cursor.on('error', (err) => next(ApiError.notFound(err.message)));
  cursor.on('file', (file) => {
    res.set('Content-Type', file.contentType || 'image/jpeg');
    res.set('Content-Length', file.length);
  });
  cursor.pipe(res);
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
    case: c.toObject(),
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
  if (c.diagnosisSource === 'azure' && String(c.diagnosis || '').trim()) {
    return res.json({ success: true, reused: true, case: c.toObject() });
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

  res.json({ success: true, case: c.toObject() });
});
