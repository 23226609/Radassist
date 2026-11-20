// models/Case.js
// A patient X-ray case: holds report text, AI analysis metadata, findings, etc.

const mongoose = require('mongoose');

const STATUS = ['requested', 'pending', 'pending_approve', 'completed', 'finalized'];

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
    // The sentence tag this box belongs to. One box per tag.
    tagKey: { type: String, default: '' },
  },
  { _id: true }
);

// One sentence of the report's FINDINGS list.
const tagSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    text: { type: String, default: '' },
    // Abnormal sentences get one film box; normal ones none.
    abnormal: { type: Boolean, default: true },
    manual: { type: Boolean, default: false },
    // '' = ordinary sentence, 'ctr' = the cardiothoracic ratio sentence.
    kind: { type: String, enum: ['', 'ctr'], default: '' },
    // The radiologist took this tag's box away; a later Azure pass must not re-add it.
    boxDeclined: { type: Boolean, default: false },
  },
  { _id: false }
);

// Text of an official report kept next to this system's draft.
const sourceReportSchema = new mongoose.Schema(
  {
    label: { type: String, default: '' },
    source: { type: String, default: '' },
    text: { type: String, default: '' },
    subjectId: { type: String, default: '' },
    studyId: { type: String, default: '' },
    dicomId: { type: String, default: '' },
  },
  { _id: false }
);

// A line the radiologist drew with the Measure tool. Ends are % of the film.
const measurementSchema = new mongoose.Schema(
  {
    x1: { type: Number, required: true, min: 0, max: 100 },
    y1: { type: Number, required: true, min: 0, max: 100 },
    x2: { type: Number, required: true, min: 0, max: 100 },
    y2: { type: Number, required: true, min: 0, max: 100 },
    text: { type: String, default: '' },
    label: { type: String, default: '' },
    // 'lesion' = one freehand line; 'ctr-heart' / 'ctr-thorax' = the two heart-size diameters.
    kind: { type: String, enum: ['lesion', 'ctr-heart', 'ctr-thorax'], default: 'lesion' },
    tagKey: { type: String, default: '' },
    // Pixels on the film shown, and millimetres on the film (null: no spacing).
    dxPx: { type: Number, default: null },
    dyPx: { type: Number, default: null },
    lengthPx: { type: Number, default: null },
    lengthMm: { type: Number, default: null },
    // Size inside the body, when the file's own geometry gives a magnification.
    bodyLengthMm: { type: Number, default: null },
    magnification: { type: Number, default: null },
    magnificationSource: {
      type: String,
      enum: ['', 'PixelSpacing', 'EstimatedRadiographicMagnificationFactor', 'MidPlane', 'SupportPlane', 'HkPaStandard'],
      default: '',
    },
    // Which DICOM tag the millimetres came from.
    spacingTag: { type: String, enum: ['ImagerPixelSpacing', 'PixelSpacing', ''], default: '' },
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
    // FINDINGS as one tag per sentence, in report order, and the COMMENT line.
    // reportText is assembled from these whenever they change.
    findingTags: { type: [tagSchema], default: [] },
    comment: { type: String, default: '' },
    // '' = unknown, else PA, AP, AP supine or Lateral. Only PA is an erect PA.
    view: { type: String, enum: ['', 'PA', 'AP', 'AP supine', 'Lateral'], default: '' },
    examinedAt: { type: Date, default: null },
    // The official report for imported cases (MIMIC-CXR), never edited here.
    sourceReport: { type: sourceReportSchema, default: undefined },
    findings: { type: [findingSchema], default: [] },
    measurements: { type: [measurementSchema], default: [] },
    // none = film stored, AI not started; running = CURV in progress; done = draft ready.
    analysisState: { type: String, enum: ['none', 'running', 'done'], default: 'none' },
    // Azure film boxes, placed after the CURV draft is stored. '' = not requested.
    boxesState: { type: String, enum: ['', 'running', 'done', 'failed'], default: '' },
    // Patient-chart findings Azure writes from the endorsed report.
    // '' = not requested; unavailable = Azure is not configured.
    chartFindings: {
      type: [{
        label: { type: String, required: true },
        detail: { type: String, default: '' },
        location: { type: String, default: '' },
        severity: { type: String, enum: ['normal', 'minor', 'significant'], default: 'minor' },
      }],
      default: [],
    },
    chartFindingsState: { type: String, enum: ['', 'running', 'done', 'failed', 'unavailable'], default: '' },
    chartFindingsAt: { type: Date, default: null },
    chartFindingsError: { type: String, default: '' },
    editLog: {
      type: [{
        at: { type: Date, default: Date.now },
        userId: { type: String, default: '' },
        userName: { type: String, default: '' },
        kind: { type: String, enum: ['ai', 'manual'], default: 'manual' },
        summary: { type: String, default: '' },
        changes: {
          type: [{
            action: { type: String, enum: ['added', 'removed', 'edited'], default: 'edited' },
            field: { type: String, default: '' },
            label: { type: String, default: '' },
            before: { type: String, default: '' },
            after: { type: String, default: '' },
          }],
          default: [],
        },
      }],
      default: [],
    },
    status: { type: String, enum: STATUS, default: 'pending' },
    urgent: { type: Boolean, default: false },
    // The radiology request and the room, unit and radiographer assigned with the booking.
    examination: { type: String, default: '' },
    bodyPart: { type: String, default: '' },
    clinicalReason: { type: String, default: '' },
    equipment: { type: String, default: '' },
    examRoom: { type: String, default: '' },
    assignedStaff: { type: String, default: '' },
    preparation: { type: String, default: '' },
    arrival: {
      type: new mongoose.Schema({
        identity: { type: Boolean, default: false },
        patientNumber: { type: Boolean, default: false },
        request: { type: Boolean, default: false },
        bodyPart: { type: Boolean, default: false },
        appointment: { type: Boolean, default: false },
        at: { type: Date, default: null },
        byName: { type: String, default: '' },
      }, { _id: false }),
      default: () => ({}),
    },
    // Ownership / audit
    createdBy: { type: String, default: '' }, // userId of the uploader once the film is registered
    createdByName: { type: String, default: '' },
    requestedBy: { type: String, default: '' },
    requestedByName: { type: String, default: '' },
    finalizedBy: { type: String, default: null }, // userId
    finalizedByName: { type: String, default: null },
    finalizedAt: { type: Date, default: null },
    // Image stored in GridFS
    // When the technician saved the film. Requested exams have no film yet.
    registeredAt: { type: Date, default: null },
    // Day the referring doctor booked the examination.
    scheduledAt: { type: Date, default: null },
    // Millimetres on the film per pixel, [row, column]. This is the spacing every
    // centimetre uses: Imager Pixel Spacing when the file has it, else Pixel Spacing.
    pixelSpacingMm: { type: [Number], default: undefined },
    // Both DICOM tags as read, for the record. Imager Pixel Spacing (0018,1164) is the
    // distance on the detector; Pixel Spacing (0028,0030) may be a vendor calibration.
    imagerPixelSpacingMm: { type: [Number], default: undefined },
    dicomPixelSpacingMm: { type: [Number], default: undefined },
    pixelSpacingSource: { type: String, enum: ['ImagerPixelSpacing', 'PixelSpacing', ''], default: '' },
    // Projection geometry from the DICOM header, used to turn film size into
    // body size. Absent unless the file recorded them. Never a guessed 180 cm.
    estimatedMagnification: { type: Number, default: undefined },
    distanceSourceToDetectorMm: { type: Number, default: undefined },
    distanceSourceToPatientMm: { type: Number, default: undefined },
    bodyPartThicknessMm: { type: Number, default: undefined },
    // What the DICOM header said about projection. The View dropdown can disagree.
    dicomViewPosition: { type: String, default: '' },
    patientPosition: { type: String, default: '' },
    projectionCues: { type: String, default: '' },
    imageId: { type: mongoose.Schema.Types.ObjectId, default: null },
    imageFilename: { type: String, default: '' },
    imageContentType: { type: String, default: 'image/jpeg' },
    imageSize: { type: Number, default: 0 },
    // Metadata about the AI generation, if any
    aiProvider: { type: String, default: '' },
    aiModel: { type: String, default: '' },
    // No default: a sparse unique index skips a missing field but not a stored
    // null, so a null here made the second case ever created a duplicate.
    shareToken: { type: String, trim: true, sparse: true, unique: true },
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
