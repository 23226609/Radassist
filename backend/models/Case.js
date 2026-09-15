// models/Case.js
// A patient X-ray case: holds report text, AI analysis metadata, findings, etc.

const mongoose = require('mongoose');

const STATUS = ['pending', 'pending_approve', 'completed', 'finalized'];

const findingSchema = new mongoose.Schema(
  {
    label: { type: String, required: true },
    confidence: { type: Number, default: 0.5, min: 0, max: 1 },
    bbox: {
      type: [Number],
      default: [],
      validate: {
        validator(v) {
          if (v == null) return true;
          if (!Array.isArray(v)) return false;
          if (v.length === 0) return true;
          return v.length === 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
        },
        message: 'bbox must be [left, top, width, height]',
      },
    },
    location: { type: String, default: '' },
    size: { type: String, default: '' },
    pattern: { type: String, default: 'Other' },
    sentence: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
    // Who produced this finding. Without these declared, strict mode drops
    // them on save and the review page can't tell AI findings from manual ones.
    source: { type: String, default: '' },
    severity: { type: String, enum: ['normal', 'minor', 'significant', ''], default: '' },
    // "vision" = Azure looked at the X-ray; "zone" = anatomical fallback.
    bboxSource: { type: String, default: '' },
    languageScore: { type: Number, default: null },
    imageSupport: { type: Number, default: null },
    confidenceSource: { type: String, default: '' },
  },
  { _id: true }
);

const caseSchema = new mongoose.Schema(
  {
    caseId: { type: String, required: true, unique: true, trim: true, index: true },
    patientId: { type: String, required: true, trim: true, index: true },
    firstName: { type: String, default: '', trim: true },
    middleName: { type: String, default: '', trim: true },
    lastName: { type: String, default: '', trim: true },
    patientName: { type: String, default: '', trim: true },
    age: { type: String, default: '' },
    sex: { type: String, enum: ['Female', 'Male', 'Other', ''], default: '' },
    history: { type: String, default: '' },
    diagnosis: { type: String, default: '' },
    // "azure" = worklist label from Azure OpenAI; "local" = first-sentence fallback.
    diagnosisSource: { type: String, default: '' },
    reportText: { type: String, default: '' },
    // Clinician notes. Also copied into a "Radiologist remarks" block at
    // the end of reportText when they save, so downloads include them.
    remarks: { type: String, default: '' },
    findings: { type: [findingSchema], default: [] },
    status: { type: String, enum: STATUS, default: 'pending' },
    urgent: { type: Boolean, default: false },
    // Ownership / audit
    createdBy: { type: String, default: '' }, // userId
    createdByName: { type: String, default: '' },
    finalizedBy: { type: String, default: null }, // userId
    finalizedByName: { type: String, default: null },
    // Image stored in GridFS
    imageId: { type: mongoose.Schema.Types.ObjectId, default: null },
    imageFilename: { type: String, default: '' },
    imageContentType: { type: String, default: 'image/jpeg' },
    imageSize: { type: Number, default: 0 },
    // Metadata about the AI generation, if any
    aiProvider: { type: String, default: '' },
    aiModel: { type: String, default: '' },
  },
  { timestamps: true }
);

// Cosmos DB requires explicit indexes for any sort/filter field used by the API.
caseSchema.index({ status: 1 });
caseSchema.index({ createdBy: 1 });
caseSchema.index({ createdAt: 1 });

module.exports = mongoose.model('Case', caseSchema);
module.exports.STATUS = STATUS;
// Documents inserted by the old FastAPI middleware have a UUID `_id` and no
// `caseId`. List/stats/patient APIs skip those so the dashboard does not
// call summarise-diagnosis (and 404) on records Express cannot mutate.
module.exports.OWNED = { caseId: { $exists: true, $ne: '' } };
