// models/AuditLog.js
// Same shape as the example project.

const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    logId: { type: String, required: true, unique: true, trim: true },
    timestamp: { type: Date, default: Date.now },
    userId: { type: String, required: true, trim: true },
    action: { type: String, required: true },
    details: { type: String, default: '' },
    affectedCaseId: { type: String, default: null },
    oldValue: { type: String, default: null },
    newValue: { type: String, default: null },
  },
  { timestamps: true }
);

auditLogSchema.index({ timestamp: 1 });
auditLogSchema.index({ action: 1 });
auditLogSchema.index({ userId: 1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
