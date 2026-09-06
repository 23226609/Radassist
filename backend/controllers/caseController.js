// controllers/caseController.js
// All case-related operations: list, create (upload + AI), read, update, delete.

const mongoose = require('mongoose');
const Case = require('../models/Case');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');
const addAuditLog = require('../utils/auditLogger');
const { analyzeXray } = require('../utils/aiService');

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
  const c = await Case.findOne({ caseId: req.params.id }).lean();
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
  let aiError = null;
  let aiModel = process.env.AI_MODEL_PATH || '/Users/PHY/CURV-mlx';

  try {
    reportText = await analyzeXray({
      imagePath: tmpPath,
      patientId,
      age,
      sex,
      history,
    });
    await addAuditLog(req.user.userId, 'AI_ANALYZED', `Middleware analysed X-ray for ${patientId}`);
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

  // Findings stay empty here — clinician adds them during review. The AI
  // report text becomes the "AI initial suggestion" on the review screen.
  const doc = await Case.create({
    caseId,
    patientId,
    age: age || '',
    sex: ['Female', 'Male', 'Other'].includes(sex) ? sex : '',
    history: history || '',
    diagnosis: sentence.slice(0, 120),
    reportText,
    findings: [],
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

exports.updateCase = catchAsync(async (req, res, next) => {
  const c = await Case.findOne({ caseId: req.params.id });
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));

  // Only doctors (and admins) can edit case content.
  if (req.user.role === 'nurse') {
    return next(ApiError.forbidden('Nurses cannot edit case content.'));
  }

  const oldStatus = c.status;
  const { diagnosis, reportText, findings } = req.body || {};
  if (diagnosis !== undefined) c.diagnosis = diagnosis;
  if (reportText !== undefined) c.reportText = reportText;
  if (Array.isArray(findings)) c.findings = findings;

  await c.save();

  if (oldStatus !== c.status) {
    await addAuditLog(req.user.userId, 'CASE_UPDATED', `Status ${oldStatus} -> ${c.status}`, c.caseId, oldStatus, c.status);
  } else {
    await addAuditLog(req.user.userId, 'CASE_UPDATED', `Edited case ${c.caseId}`, c.caseId);
  }

  res.json({ success: true, case: { ...c.toObject(), imageUrl: c.imageId ? `/api/images/${c.imageId}` : null } });
});

exports.finalizeCase = catchAsync(async (req, res, next) => {
  if (req.user.role === 'nurse') return next(ApiError.forbidden('Only doctors or admins can finalize.'));
  const c = await Case.findOne({ caseId: req.params.id });
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));

  c.status = 'finalized';
  c.finalizedBy = req.user.userId;
  c.finalizedByName = req.user.name;
  await c.save();
  await addAuditLog(req.user.userId, 'CASE_FINALIZED', `Finalized case ${c.caseId}`, c.caseId, null, 'finalized');

  res.json({ success: true, case: { ...c.toObject(), imageUrl: c.imageId ? `/api/images/${c.imageId}` : null } });
});

exports.deleteCase = catchAsync(async (req, res, next) => {
  if (req.user.role !== 'admin') return next(ApiError.forbidden('Only admins can delete.'));
  const c = await Case.findOne({ caseId: req.params.id });
  if (!c) return next(ApiError.notFound(`Case ${req.params.id} not found`));

  // Drop the GridFS image too.
  if (c.imageId) {
    try { await bucket().delete(c.imageId); } catch (_) { /* ignore */ }
  }
  await Case.deleteOne({ caseId: req.params.id });
  await addAuditLog(req.user.userId, 'CASE_DELETED', `Deleted case ${c.caseId}`, c.caseId);
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
