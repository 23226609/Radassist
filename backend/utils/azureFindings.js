// utils/azureFindings.js
//
// Turns a free-text radiology report (and, when we have it, the X-ray itself)
// into a short list of structured findings using Azure OpenAI, so the review
// page carousel shows a few clean cards with boxes over the right anatomy.
//
// Configuration (backend/.env) — see docs/azure-findings.md for setup:
//   AZURE_OPENAI_ENDPOINT    https://<resource>.openai.azure.com
//   AZURE_OPENAI_KEY         resource key
//   AZURE_OPENAI_DEPLOYMENT  deployment name, e.g. gpt-4.1-mini
//
// When these are unset the feature stays switched off and the app keeps using
// the local parser, so the project still runs with no Azure account at all.

const { scoreConfidence } = require('./confidence');

const API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const PATTERNS = ['Nodular', 'Diffuse', 'Linear', 'Ground-glass', 'Consolidation', 'Other'];

// Fallback anatomical regions for a standard adult PA/AP chest X-ray, as
// [left%, top%, width%, height%]. Used only when Azure did not return a
// usable box — most often because there was no image to send.
const ZONES = {
  right_upper_lung: [8, 6, 34, 18],
  left_upper_lung: [58, 6, 34, 18],
  right_mid_lung: [8, 24, 34, 18],
  left_mid_lung: [58, 24, 34, 18],
  right_lower_lung: [8, 42, 34, 22],
  left_lower_lung: [58, 42, 34, 22],
  both_lungs: [6, 12, 88, 60],
  heart: [30, 46, 38, 32],
  mediastinum: [36, 10, 28, 60],
  hila: [26, 34, 46, 18],
  trachea: [42, 3, 16, 18],
  right_diaphragm: [8, 66, 34, 14],
  left_diaphragm: [58, 66, 34, 14],
  both_diaphragms: [8, 66, 84, 14],
  spine: [42, 6, 16, 78],
  right_chest_wall: [2, 8, 18, 78],
  left_chest_wall: [80, 8, 18, 78],
  pulmonary_vessels: [14, 20, 72, 48],
  whole_chest: [4, 4, 92, 90],
};
const ZONE_KEYS = Object.keys(ZONES);

const SYSTEM_PROMPT = `You summarise a chest X-ray report for a radiologist's review screen.

Return ONLY a JSON object of the form:
{"diagnosis":"...","findings":[{"label":"...","detail":"...","location":"...","size":"...","pattern":"...","imageSupport":0.0,"severity":"normal|minor|significant","zone":"...","bbox":[left,top,width,height]}]}

Rules:
- "diagnosis" is a short worklist label, at most 80 characters, e.g.
  "No acute cardiopulmonary findings" or "Right lower-lobe consolidation".
  No headings, no full paragraph, no markdown.
- At most 6 findings, ordered most clinically important first.
- Group related observations into ONE finding. Never emit one finding per sentence.
- "label" is a short clinical phrase under 60 characters, e.g. "Clear lung fields" or "Cardiomegaly".
- "detail" is one sentence quoting what the report says.
- "location" is the anatomy in the report's own words, or "" if it does not say.
- "size" is a measurement only if the report states one, otherwise "".
- "pattern" is exactly one of: ${PATTERNS.join(', ')}.
- "imageSupport" is 0 to 1 for how clearly the ATTACHED X-ray shows this
  finding. Use this rubric, not a polite 1.0:
    0.25 region poorly seen or the finding is not visible on the film
    0.45 possible / subtle / only faintly suggested
    0.65 visible and consistent with the report
    0.80 clearly visible
    0.90 reserved for an unmistakable sign (large pneumothorax, obvious
         device, large effusion). Never use ≥ 0.90 for a routine "normal".
  If no image is attached, omit imageSupport.
- "severity" is "normal" for negative/normal statements, "minor" for incidental
  findings, "significant" for anything needing follow-up.
- "zone" is exactly one of: ${ZONE_KEYS.join(', ')}.
  Pick the zone using the PATIENT's right/left as stated in the report, not
  the viewer's right/left. Use "both_lungs" for bilateral lung findings,
  "heart" for cardiac silhouette / cardiomegaly, "pulmonary_vessels" for
  vascular/edema findings, and "whole_chest" only when nothing more specific
  applies.
- "bbox" is [left, top, width, height] as percentages of the radiograph
  (0-100), origin at the top-left of the film. On a standard PA/AP chest
  X-ray the patient's RIGHT is on the VIEWER'S LEFT.
  If an image is attached, LOOK AT THE IMAGE and draw each box over the
  actual anatomy that finding refers to (heart over the heart shadow, lungs
  over the lung fields, diaphragm over the hemidiaphragms). Do not stack
  identical small boxes in a corner. A bilateral finding may be one box
  spanning both sides. Minimum box size 8% in each direction.
- Only use information present in the report. Never invent a finding.
- If the report describes an entirely normal study, return a single finding
  summarising that, with a box over the whole thorax.`;

function isConfigured() {
  return Boolean(
    process.env.AZURE_OPENAI_ENDPOINT &&
    process.env.AZURE_OPENAI_KEY &&
    process.env.AZURE_OPENAI_DEPLOYMENT
  );
}


// Accepts [left, top, width, height] in percent (or 0-1 fractions) and
// returns a box that fits on the film. Returns null if the input is unusable
// so the caller can fall back to an anatomical zone.
function clampBbox(raw) {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  let [x, y, w, h] = raw.map(Number);
  if (![x, y, w, h].every(Number.isFinite)) return null;

  // A few models return 0-1 fractions even when asked for percentages.
  if ([x, y, w, h].every((v) => v >= 0 && v <= 1.5)) {
    x *= 100;
    y *= 100;
    w *= 100;
    h *= 100;
  }

  // Some models return [x1, y1, x2, y2]. If treating the last two as width
  // / height would run off the film, they were corners — convert them.
  if (x + w > 105 || y + h > 105) {
    w = w - x;
    h = h - y;
  }

  x = Math.min(92, Math.max(0, x));
  y = Math.min(92, Math.max(0, y));
  w = Math.min(100 - x, Math.max(8, w));
  h = Math.min(100 - y, Math.max(8, h));
  return [Number(x.toFixed(1)), Number(y.toFixed(1)), Number(w.toFixed(1)), Number(h.toFixed(1))];
}

function jitteredBox(zoneKey, occurrence) {
  const [left, top, width, height] = ZONES[zoneKey] || ZONES.whole_chest;
  if (occurrence === 0) return [left, top, width, height];
  const dx = (occurrence % 3) * 4;
  const dy = Math.floor(occurrence / 3) * 4;
  return [
    Math.min(left + dx, 100 - width),
    Math.min(top + dy, 100 - height),
    width,
    height,
  ];
}

function normalise(raw, zoneCounts) {
  const label = String(raw?.label || '').trim();
  if (!label) return null;

  const pattern = PATTERNS.find(
    (p) => p.toLowerCase() === String(raw?.pattern || '').trim().toLowerCase()
  ) || 'Other';

  const severity = ['normal', 'minor', 'significant'].includes(raw?.severity)
    ? raw.severity
    : 'minor';

  const zone = ZONE_KEYS.includes(raw?.zone) ? raw.zone : 'whole_chest';
  const visionBox = clampBbox(raw?.bbox);
  let bbox;
  let bboxSource;
  if (visionBox) {
    bbox = visionBox;
    bboxSource = 'vision';
  } else {
    const occurrence = zoneCounts.get(zone) || 0;
    zoneCounts.set(zone, occurrence + 1);
    bbox = jitteredBox(zone, occurrence);
    bboxSource = 'zone';
  }

  const scored = scoreConfidence({
    label,
    detail: String(raw?.detail || '').trim(),
    severity,
    imageSupport: raw?.imageSupport,
    size: raw?.size,
    location: raw?.location,
  });

  return {
    label: label.slice(0, 80),
    confidence: scored.confidence,
    languageScore: scored.languageScore,
    imageSupport: scored.imageSupport,
    confidenceSource: scored.confidenceSource,
    bbox,
    bboxSource,
    location: String(raw?.location || '').trim().slice(0, 80),
    size: String(raw?.size || '').trim().slice(0, 40),
    pattern,
    severity,
    sentence: String(raw?.detail || '').trim().slice(0, 240),
    status: 'pending',
    source: 'Azure',
  };
}

function toDataUrl(image) {
  if (!image?.buffer?.length) return null;
  if (image.buffer.length > MAX_IMAGE_BYTES) return null;
  const mime = image.contentType || 'image/jpeg';
  if (!/^image\/(jpeg|jpg|png|webp|gif)$/i.test(mime)) return null;
  return `data:${mime};base64,${image.buffer.toString('base64')}`;
}

function parseDiagnosis(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '');
  if (!text) return '';
  // Dashboard column — keep it to a short clinical label.
  return text.split(/[.\n]/)[0].trim().slice(0, 80);
}

function needsAzureDiagnosis(c = {}) {
  if (c.diagnosisSource === 'azure') return false;
  if (!String(c.reportText || '').trim()) return false;
  if (c.diagnosisSource === 'local') return true;
  const d = String(c.diagnosis || '').trim();
  if (!d) return true;
  if (/^(awaiting ai analysis|ai report)$/i.test(d)) return true;
  if (/^chest x[- ]?ray/i.test(d)) return true;
  return d.length > 90;
}

function parseFindingsList(parsed) {
  const list = Array.isArray(parsed) ? parsed : parsed?.findings;
  if (!Array.isArray(list)) throw new Error('Azure OpenAI response had no findings array.');
  const zoneCounts = new Map();
  return list.slice(0, 6).map((f) => normalise(f, zoneCounts)).filter(Boolean);
}

function parseSummary(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Azure OpenAI did not return valid JSON.');
  }
  const findings = parseFindingsList(parsed);
  const diagnosis = parseDiagnosis(parsed?.diagnosis) || parseDiagnosis(findings[0]?.label);
  return { findings, diagnosis };
}

const DIAGNOSIS_PROMPT = `You write the Diagnosis column for a chest X-ray worklist.

Return ONLY JSON of the form: {"diagnosis":"..."}

Rules:
- One short clinical label, at most 80 characters.
- Examples: "No acute cardiopulmonary findings", "Mild cardiomegaly", "Right lower-lobe pneumonia".
- No report headings, no full paragraph, no markdown, no trailing period unless it is an abbreviation.
- Use only what the report states. If the study is normal, say so.`;

async function chatJson(systemPrompt, userContent, maxTokens) {
  if (!isConfigured()) {
    throw new Error(
      'Azure OpenAI is not configured. Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY ' +
      'and AZURE_OPENAI_DEPLOYMENT in backend/.env.'
    );
  }

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, '');
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const url = `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${API_VERSION}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.AZURE_OPENAI_KEY,
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.error?.message || '';
    } catch { /* body was not JSON */ }
    throw new Error(`Azure OpenAI ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
  }

  const body = await res.json();
  const content = body?.choices?.[0]?.message?.content || '';
  try {
    return JSON.parse(content);
  } catch {
    throw new Error('Azure OpenAI did not return valid JSON.');
  }
}

/**
 * Summarise a report into structured findings, using the X-ray pixels when
 * available so each card can sit over the matching anatomy.
 * @param {string} reportText
 * @param {{ buffer: Buffer, contentType?: string } | null} [image]
 * @returns {Promise<{ findings: Array<object>, diagnosis: string }>}
 */
async function summariseFindings(reportText, image = null) {
  const text = String(reportText || '').trim();
  if (!text) throw new Error('This case has no report text to summarise.');

  const dataUrl = toDataUrl(image);
  const userContent = dataUrl
    ? [
        { type: 'text', text: `${text}\n\nThe attached image is this case's chest X-ray. Place each bbox on the anatomy you can see.` },
        { type: 'image_url', image_url: { url: dataUrl } },
      ]
    : text;

  const parsed = await chatJson(SYSTEM_PROMPT, userContent, 1100);
  const findings = parseFindingsList(parsed);
  const diagnosis = parseDiagnosis(parsed?.diagnosis) || parseDiagnosis(findings[0]?.label);
  return { findings, diagnosis };
}

/**
 * Short dashboard Diagnosis label from the report text only.
 * @param {string} reportText
 * @returns {Promise<string>}
 */
async function summariseDiagnosis(reportText) {
  const text = String(reportText || '').trim();
  if (!text) throw new Error('This case has no report text to summarise.');
  const parsed = await chatJson(DIAGNOSIS_PROMPT, text, 200);
  const diagnosis = parseDiagnosis(parsed?.diagnosis);
  if (!diagnosis) throw new Error('Azure OpenAI did not return a diagnosis.');
  return diagnosis;
}

module.exports = {
  summariseFindings,
  summariseDiagnosis,
  isConfigured,
  clampBbox,
  parseDiagnosis,
  needsAzureDiagnosis,
  ZONES,
};
