// utils/auditLogger.js
// Append a row to the audit log collection.

const AuditLog = require('../models/AuditLog');

const ACTIONS = {
  LOGIN: 'LOGIN',
  LOGOUT: 'LOGOUT',
  REGISTER: 'REGISTER',
  CASE_CREATED: 'CASE_CREATED',
  CASE_UPDATED: 'CASE_UPDATED',
  CASE_FINALIZED: 'CASE_FINALIZED',
  CASE_DELETED: 'CASE_DELETED',
  PATIENT_CREATED: 'PATIENT_CREATED',
  PATIENT_UPDATED: 'PATIENT_UPDATED',
  PATIENT_DELETED: 'PATIENT_DELETED',
  AI_ANALYZED: 'AI_ANALYZED',
};

module.exports.ACTIONS = ACTIONS;

module.exports = async function addAuditLog(userId, action, details, affectedCaseId = null, oldValue = null, newValue = null) {
  try {
    // Generate a small readable log id (no atomic counter so we don't rely on extra collections).
    const stamp = Date.now().toString(36).toUpperCase();
    const rand = Math.floor(Math.random() * 0xfff).toString(16).toUpperCase().padStart(3, '0');
    await AuditLog.create({
      logId: `LOG-${stamp}-${rand}`,
      userId: userId || 'anonymous',
      action,
      details: details || '',
      affectedCaseId,
      oldValue: oldValue != null ? String(oldValue) : null,
      newValue: newValue != null ? String(newValue) : null,
    });
  } catch (err) {
    // Audit log failures must never break the main flow.
    console.error('audit log error:', err.message);
  }
};
