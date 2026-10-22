// utils/chartFindings.js
//
// After a radiologist endorses a report, Azure OpenAI reads the endorsed text
// and writes the Findings shown on the patient chart. The run happens in the
// background so Endorse returns at once; the chart polls until it lands.

const Case = require('../models/Case');
const addAuditLog = require('./auditLogger');
const azureFindings = require('./azureFindings');

// A run still marked running after this long was lost (e.g. a restart).
const STALE_MS = 3 * 60 * 1000;

function isStale(c, now = Date.now()) {
  if (c?.chartFindingsState !== 'running') return false;
  const at = c.chartFindingsAt ? new Date(c.chartFindingsAt).getTime() : 0;
  return now - at > STALE_MS;
}

// True when an endorsed case has never had chart findings written, or the
// last run was lost.
function needsChartFindings(c) {
  if (c?.status !== 'finalized') return false;
  if (!String(c.reportText || '').trim()) return false;
  if (c.chartFindingsState === 'unavailable') return azureFindings.isConfigured();
  return !c.chartFindingsState || isStale(c);
}

async function writeChartFindings(caseId, reportText, userId) {
  let findings = [];
  let error = '';
  try {
    findings = await azureFindings.summariseChartFindings(reportText);
  } catch (err) {
    error = err.message || 'Azure AI failed.';
    console.warn(`[chartFindings] ${caseId}:`, error);
  }

  const c = await Case.findOne({ caseId });
  if (!c || c.status !== 'finalized' || c.reportText !== reportText) return;
  c.chartFindings = findings;
  c.chartFindingsState = error ? 'failed' : 'done';
  c.chartFindingsAt = new Date();
  c.chartFindingsError = error.slice(0, 240);
  await c.save();
  if (!error) {
    await addAuditLog(
      userId || 'system',
      'CASE_UPDATED',
      `Azure AI wrote ${findings.length} chart findings from the endorsed report ${caseId}`,
      caseId
    );
  }
}

/**
 * Start a background run for an endorsed case. Returns the state the case is
 * now in. `force` re-runs a finished or failed case (Retry on the chart).
 * @param {object} c Case document (must have caseId, status, reportText)
 * @param {{ userId?: string, force?: boolean }} [opts]
 */
async function queueChartFindings(c, { userId, force = false } = {}) {
  if (!c?.caseId || c.status !== 'finalized') return c?.chartFindingsState || '';
  if (!String(c.reportText || '').trim()) return c.chartFindingsState || '';

  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_MS);
  const claimable = force
    ? [{ chartFindingsState: { $ne: 'running' } }, { chartFindingsAt: { $lt: staleBefore } }]
    : [
      { chartFindingsState: { $in: ['', null, 'unavailable'] } },
      { chartFindingsState: 'running', chartFindingsAt: { $lt: staleBefore } },
    ];

  if (!azureFindings.isConfigured()) {
    const unclaimed = claimable.map((q) => (
      q.chartFindingsState?.$in ? { chartFindingsState: { $in: ['', null] } } : q
    ));
    await Case.updateOne(
      { caseId: c.caseId, status: 'finalized', $or: unclaimed },
      { $set: { chartFindingsState: 'unavailable', chartFindings: [], chartFindingsAt: now } }
    );
    return 'unavailable';
  }

  const claim = await Case.updateOne(
    { caseId: c.caseId, status: 'finalized', $or: claimable },
    { $set: { chartFindingsState: 'running', chartFindingsAt: now, chartFindingsError: '' } }
  );
  if (!claim.modifiedCount) return c.chartFindingsState || '';

  writeChartFindings(c.caseId, c.reportText, userId)
    .catch((err) => console.error('[chartFindings] could not save:', err.message));
  return 'running';
}

module.exports = { queueChartFindings, needsChartFindings, isStale };
