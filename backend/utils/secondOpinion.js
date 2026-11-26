// utils/secondOpinion.js
//
// The independent second-opinion AI. It looks at the chest X-ray itself (Azure
// vision, the same endpoint, key and deployment as azureFindings.js) and reads
// the patient's chart: history, medicines, lab results, up to three earlier
// endorsed reports, the latest observations and the frontend's sepsis screen.
//
// It is never given CURV's findings, this case's report or the Azure boxes, so
// it cannot repeat them. That is enforced by the signature below: the only case
// data it accepts is the id, the patient id and the clinical history. It reads
// nothing from the report, and it never changes the case. The caller stores
// the answer on Case.fusionResult for the radiologist to read. Only a
// radiologist endorses a report.

const Patient = require('../models/Patient');
const azureFindings = require('./azureFindings');
const { historyText, priorReportsText, clean, NOT_RECORDED } = require('./historyReasoning');

const CONFIDENCE = ['low', 'medium', 'high'];
const MAX_OBSERVATIONS = 3;
const SCREEN_LEVELS = {
  urgent: 'Urgent review',
  abnormal: 'Abnormal observations — review',
  none: 'No configured trigger',
};

const PROMPT = `You are an independent second-opinion AI for a chest X-ray case. You have NOT seen any other AI's report for this case. Do not invent symptoms, tests, or diagnoses that are not in the inputs. Use the actual lab values given — if CRP is elevated, do NOT say inflammatory markers are normal.

Image: [the chest X-ray image]
Patient history: {history}
Medications: {medicines}
Lab results: {labResults}
Prior reports: {priorReports}
Observations: {observations}
Sepsis screen: {sepsisScreen} — this is a frontend-calculated screening score, not a diagnosis. Use it only as one signal.

Return JSON only, and keep the whole output under 120 words:
{
  "summary": "At most 2 sentences. What the image and history together suggest. Do not repeat the diagnosis here.",
  "diagnosis": "One line only. The most likely diagnosis, or 'no acute abnormality' if none.",
  "differentials": [
    {"diagnosis": "...", "supporting": ["one short phrase only"], "against": ["one short phrase only"], "confidence": "low|medium|high"}
  ],
  "suggested_next_step": "At most 2 sentences. What the radiologist should do next."
}

Rules: at most 3 differentials. Each supporting / against entry is one short phrase, not a sentence. If the history or image is thin, say so in 'summary' and mark confidence low. Never state a diagnosis as certain. Never invent a finding that is not in the image or history.`;

const oneLine = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function listOf(value, max) {
  return (Array.isArray(value) ? value : []).map((v) => oneLine(v, 300)).filter(Boolean).slice(0, max);
}

// The newest readings first, each with its time. The chart stores heart rate, respiratory
// rate, systolic pressure and temperature as text; only what was recorded is listed, and
// no diastolic pressure is made up. SpO2 and the lab values are left out: labs are already
// in "Lab results".
function observationsText(observations) {
  const rows = (Array.isArray(observations) ? observations : []).filter((r) => r && typeof r === 'object');
  const lines = [];
  for (const row of rows.slice(-MAX_OBSERVATIONS).reverse()) {
    const parts = [];
    const add = (label, value, unit) => {
      const v = oneLine(value, 12);
      if (v) parts.push(`${label} ${v}${unit}`);
    };
    add('heart rate', row.hr, ' bpm');
    add('temperature', row.temp, ' °C');
    add('systolic blood pressure', row.sbp, ' mmHg');
    add('respiratory rate', row.rr, '/min');
    if (!parts.length) continue;
    const when = row.at && !Number.isNaN(new Date(row.at).getTime()) ? new Date(row.at).toISOString() : 'time not recorded';
    lines.push(`- ${when}: ${parts.join(', ')}`);
  }
  return lines.join('\n') || NOT_RECORDED;
}

// The screen is worked out in the browser (src/components/clinical.js) from the same
// observations. The server only checks its shape, so a stray value cannot reach the prompt.
function sepsisScreenText(screen) {
  const level = typeof screen?.level === 'string' ? screen.level : '';
  const title = Object.hasOwn(SCREEN_LEVELS, level) ? SCREEN_LEVELS[level] : '';
  if (!title) return 'Not available';
  const score = Number(screen.score);
  const reasons = listOf(screen.reasons, 6).map((r) => oneLine(r, 120));
  const bits = [title];
  if (Number.isFinite(score) && score >= 0 && score <= 100) bits.push(`teaching score ${Math.round(score)}%`);
  return reasons.length ? `${bits.join(', ')} (${reasons.join('; ')})` : bits.join(', ');
}

// Only the documented keys are kept, so a stray field from the model never reaches the database.
function normalise(parsed) {
  const summary = oneLine(parsed?.summary, 1000);
  if (!summary) throw new Error('Azure OpenAI did not return a summary.');
  const diagnosis = oneLine(parsed?.diagnosis, 200);
  if (!diagnosis) throw new Error('Azure OpenAI did not return a diagnosis.');
  const nextStep = oneLine(parsed?.suggested_next_step, 800);
  if (!nextStep) throw new Error('Azure OpenAI did not return a suggested next step.');
  const differentials = (Array.isArray(parsed?.differentials) ? parsed.differentials : [])
    .map((d) => ({
      diagnosis: oneLine(d?.diagnosis, 120),
      supporting: listOf(d?.supporting, 8),
      against: listOf(d?.against, 8),
      confidence: CONFIDENCE.includes(String(d?.confidence || '').toLowerCase())
        ? String(d.confidence).toLowerCase()
        : 'low',
    }))
    .filter((d) => d.diagnosis)
    .slice(0, 8);
  return { summary, diagnosis, differentials, suggested_next_step: nextStep };
}

/**
 * Ask Azure OpenAI for an independent second opinion on one chest X-ray.
 * @param {object} input
 * @param {string} input.caseId        used only to leave this case out of the prior reports
 * @param {string} input.patientId     the chart to read
 * @param {string} [input.history]     the clinical history written on this study's request
 * @param {{ buffer: Buffer, contentType?: string }} input.image  the X-ray
 * @param {{ level: string, score?: number, reasons?: string[] }} [input.sepsisScreen]
 * @returns {Promise<{summary: string, diagnosis: string, differentials: Array<object>, suggested_next_step: string}>}
 */
async function secondOpinion({ caseId, patientId, history, image, sepsisScreen } = {}) {
  if (!azureFindings.isConfigured()) {
    throw new Error('Azure OpenAI is not configured on the server. See docs/azure-findings.md.');
  }
  const dataUrl = azureFindings.toDataUrl(image);
  if (!dataUrl) throw new Error('This case has no X-ray image Azure can read (missing, too large, or not JPEG/PNG).');

  const patient = await Patient.findOne({ patientId }).lean();
  const values = {
    history: historyText({ history }, patient),
    medicines: clean(patient?.medicines) || NOT_RECORDED,
    labResults: clean(patient?.labResults) || NOT_RECORDED,
    priorReports: await priorReportsText({ caseId, patientId }),
    observations: observationsText(patient?.observations),
    sepsisScreen: sepsisScreenText(sepsisScreen),
  };
  // One pass, so text inside a value that looks like {medicines} is never filled in again.
  const filled = PROMPT.replace(
    /\{(history|medicines|labResults|priorReports|observations|sepsisScreen)\}/g,
    (_, key) => values[key]
  );
  const userContent = [
    { type: 'text', text: 'Return the JSON now. The attached image is this patient\'s chest X-ray.' },
    { type: 'image_url', image_url: { url: dataUrl } },
  ];
  const parsed = await azureFindings.chatJson(filled, userContent, 1400, 0);
  return normalise(parsed);
}

module.exports = { secondOpinion };
