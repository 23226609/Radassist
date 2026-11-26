// utils/historyReasoning.js
//
// The History LLM. Reads only what the chart says about the patient (history,
// medicines, lab results and earlier endorsed reports) and asks Azure OpenAI for
// a short summary, differential diagnoses and questions for the doctor.
//
// It never sees the film or this case's own report, so it cannot just repeat
// what CURV wrote. It reuses the Azure call in azureFindings.js (same
// endpoint, key, timeout and JSON parsing) and needs the same
// AZURE_OPENAI_* settings in backend/.env.

const Case = require('../models/Case');
const Patient = require('../models/Patient');
const azureFindings = require('./azureFindings');

const NOT_RECORDED = 'Not recorded';
const CONFIDENCE = ['low', 'medium', 'high'];
const MAX_PRIOR_REPORTS = 3;
const MAX_PRIOR_CHARS = 1500;
const MAX_FIELD_CHARS = 4000;

const PROMPT = `You are a clinical reasoning assistant. Use ONLY the patient history below. Do not invent symptoms, tests, or diagnoses that are not in the history.

Patient history:
{history}
Medications: {medicines}
Lab results: {labResults}
Prior reports: {priorReports}

Return JSON only:
{
  "summary": "2-3 sentences, plain clinical language",
  "differentials": [
    {"diagnosis": "...", "supporting": ["..."], "against": ["..."], "confidence": "low|medium|high"}
  ],
  "questions_for_doctor": ["what else would help decide?"]
}

Rules: if the history is thin, say so in "summary" and mark confidence low. Never state a diagnosis as certain.`;

function clean(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, MAX_FIELD_CHARS);
}

function listOf(value, max) {
  return (Array.isArray(value) ? value : [])
    .map((v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, max);
}

// The chart history and this study's own history, without repeating one inside the other.
function historyText(c, patient) {
  const parts = [];
  for (const raw of [patient?.history, c.history]) {
    const text = clean(raw);
    if (text && !parts.some((p) => p.includes(text) || text.includes(p))) parts.push(text);
  }
  return parts.join('\n') || NOT_RECORDED;
}

// Endorsed reports from this patient's other studies, newest first. Thinking is removed.
async function priorReportsText(c) {
  const rows = await Case.find({
    patientId: c.patientId,
    caseId: { $ne: c.caseId },
    status: 'finalized',
  }).lean();
  rows.sort((a, b) => new Date(b.finalizedAt || 0).getTime() - new Date(a.finalizedAt || 0).getTime());
  const lines = [];
  for (const row of rows) {
    const text = azureFindings.clinicalReportText(row.reportText).replace(/\s+/g, ' ').slice(0, MAX_PRIOR_CHARS);
    if (!text) continue;
    const when = row.finalizedAt ? new Date(row.finalizedAt).toISOString().slice(0, 10) : 'date not recorded';
    lines.push(`- ${when}: ${text}`);
    if (lines.length === MAX_PRIOR_REPORTS) break;
  }
  return lines.join('\n') || NOT_RECORDED;
}

// Only the three documented keys are kept, so a stray field from the model never reaches the database.
function normalise(parsed) {
  const summary = String(parsed?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!summary) throw new Error('Azure OpenAI did not return a summary.');
  const differentials = (Array.isArray(parsed?.differentials) ? parsed.differentials : [])
    .map((d) => ({
      diagnosis: String(d?.diagnosis || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      supporting: listOf(d?.supporting, 8),
      against: listOf(d?.against, 8),
      confidence: CONFIDENCE.includes(String(d?.confidence || '').toLowerCase())
        ? String(d.confidence).toLowerCase()
        : 'low',
    }))
    .filter((d) => d.diagnosis)
    .slice(0, 8);
  return {
    summary,
    differentials,
    questions_for_doctor: listOf(parsed?.questions_for_doctor, 8),
  };
}

/**
 * Ask Azure OpenAI to reason over one patient's chart history.
 * @param {object} c Case document (needs patientId, caseId, history)
 * @returns {Promise<{summary: string, differentials: Array<object>, questions_for_doctor: string[]}>}
 */
async function reasonAboutHistory(c) {
  if (!azureFindings.isConfigured()) {
    throw new Error('Azure OpenAI is not configured on the server. See docs/azure-findings.md.');
  }
  const patient = await Patient.findOne({ patientId: c.patientId }).lean();
  const values = {
    history: historyText(c, patient),
    medicines: clean(patient?.medicines) || NOT_RECORDED,
    labResults: clean(patient?.labResults) || NOT_RECORDED,
    priorReports: await priorReportsText(c),
  };
  // One pass, so text inside a value that looks like {medicines} is never filled in again.
  const filled = PROMPT.replace(/\{(history|medicines|labResults|priorReports)\}/g, (_, key) => values[key]);
  const parsed = await azureFindings.chatJson(filled, 'Return the JSON now.', 900, 0);
  return normalise(parsed);
}

// historyText, priorReportsText and clean are shared with secondOpinion.js, so both AIs read the chart the same way.
module.exports = { reasonAboutHistory, historyText, priorReportsText, clean, NOT_RECORDED };
