const azureFindings = require('./azureFindings');

// Case workflow status. `completed` is the old name for pending_approve.

function publicStatus(s) {
  return s === 'completed' ? 'pending_approve' : s;
}

function analysisStateOf(doc = {}) {
  if (doc.analysisState === 'none' || doc.analysisState === 'running' || doc.analysisState === 'done') {
    return doc.analysisState;
  }
  if (publicStatus(doc.status) === 'pending') {
    if (/generating report/i.test(String(doc.diagnosis || ''))) return 'running';
    if (!String(doc.reportText || '').trim()) return 'none';
  }
  return 'done';
}

// Azure only labels a report after a clinician has changed it; the first
// CURV draft is shown as CURV wrote it.
function clinicianEdited(doc = {}) {
  return (Array.isArray(doc.editLog) ? doc.editLog : []).some((row) => row?.kind === 'manual');
}

// What a patient may read about their own endorsed case, and nothing else. This is an allow-list: the
// CURV draft, findings and boxes, history, the film, the Second Reader (fusionResult), the agent's evidence
// (agentResult), the edit log, remarks, chart findings, the share token and the source report are not in it.
// The report is the endorsed text without thinking or remarks.
function toPatientCase(o) {
  return {
    caseId: o.caseId,
    patientId: o.patientId,
    patientName: o.patientName,
    firstName: o.firstName,
    middleName: o.middleName,
    lastName: o.lastName,
    age: o.age,
    sex: o.sex,
    status: o.status,
    view: o.view,
    examinedAt: o.examinedAt,
    finalizedAt: o.finalizedAt,
    finalizedByName: o.finalizedByName,
    reportText: azureFindings.clinicalReportText(o.reportText || ''),
    laySummary: o.laySummary || null,
    laySummaryState: o.laySummaryState || '',
  };
}

function toPublicCase(doc, extra = {}) {
  const o = doc && typeof doc.toObject === 'function' ? doc.toObject() : { ...(doc || {}) };
  o.status = publicStatus(o.status);
  if (extra.patientView) {
    // Defence in depth: the reasoning is removed first, then the allow-list is applied.
    delete o.fusionResult;
    delete o.agentResult;
    delete o.historyAnalysis;
    return toPatientCase(o);
  }
  o.analysisState = analysisStateOf(o);
  o.clinicianEdited = clinicianEdited(o);
  if (o.imageId && o.imageUrl === undefined) {
    o.imageUrl = `/api/images/${o.imageId}`;
  }
  const token = o.shareToken || '';
  delete o.shareToken;
  o.shared = Boolean(token);
  if (extra.includeShareToken && token) o.shareToken = token;
  if (!extra.includeEditLog) delete o.editLog;
  if (extra.hideFilm) {
    delete o.imageId;
    delete o.imageUrl;
    o.reportText = '';
    o.findings = [];
    o.measurements = [];
    o.findingTags = [];
    o.comment = '';
    delete o.sourceReport;
    delete o.historyAnalysis;
    delete o.fusionResult;
    delete o.agentResult;
    delete o.laySummary;
  }
  if (extra.stripProvenance) {
    delete o.sourceReport;
    o.findings = (o.findings || []).map((f) => {
      const row = f && typeof f.toObject === 'function' ? f.toObject() : { ...f };
      delete row.source;
      return row;
    });
  }
  // The History LLM and second-opinion output is the radiologist's working. Endorsing does not
  // make it public, so this is by role, not by status. A referring doctor keeps laySummary (the Patient view preview).
  if (extra.hideReasoning) {
    delete o.historyAnalysis;
    delete o.fusionResult;
    delete o.agentResult;
  }
  const { includeShareToken, includeEditLog, stripProvenance, hideFilm, hideReasoning, patientView, ...rest } = extra;
  return { ...o, ...rest };
}

function statusFilter(status) {
  if (!status || status === 'all' || status === 'urgent') return null;
  if (status === 'pending_approve' || status === 'completed') {
    return { $in: ['pending_approve', 'completed'] };
  }
  return status;
}

module.exports = { publicStatus, analysisStateOf, clinicianEdited, toPublicCase, statusFilter };
