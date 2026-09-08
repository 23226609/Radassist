// utils/azureFindings.js
//
// Turns a free-text radiology report into a short list of structured findings
// using Azure OpenAI, so the review page carousel shows a few clean cards
// instead of one card per sentence from the local regex parser.
//
// Configuration (backend/.env) — see docs/azure-findings.md for setup:
//   AZURE_OPENAI_ENDPOINT    https://<resource>.openai.azure.com
//   AZURE_OPENAI_KEY         resource key
//   AZURE_OPENAI_DEPLOYMENT  deployment name, e.g. gpt-4o-mini
//
// When these are unset the feature stays switched off and the app keeps using
// the local parser, so the project still runs with no Azure account at all.

const API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21';

const PATTERNS = ['Nodular', 'Diffuse', 'Linear', 'Ground-glass', 'Consolidation', 'Other'];

const SYSTEM_PROMPT = `You summarise chest X-ray reports for a radiologist's review screen.

Return ONLY a JSON object of the form:
{"findings":[{"label":"...","detail":"...","location":"...","size":"...","pattern":"...","confidence":0.0,"severity":"normal|minor|significant"}]}

Rules:
- At most 6 findings, ordered most clinically important first.
- Group related observations into ONE finding. Never emit one finding per sentence.
- "label" is a short clinical phrase under 60 characters, e.g. "Clear lung fields" or "Cardiomegaly".
- "detail" is one sentence quoting what the report says.
- "location" is the anatomy, or "" if the report does not say.
- "size" is a measurement only if the report states one, otherwise "".
- "pattern" is exactly one of: ${PATTERNS.join(', ')}.
- "confidence" is 0 to 1, reflecting how explicitly the report states the finding.
- "severity" is "normal" for negative/normal statements, "minor" for incidental
  findings, "significant" for anything needing follow-up.
- Only use information present in the report. Never invent a finding.
- If the report describes an entirely normal study, return a single finding
  summarising that.`;

function isConfigured() {
  return Boolean(
    process.env.AZURE_OPENAI_ENDPOINT &&
    process.env.AZURE_OPENAI_KEY &&
    process.env.AZURE_OPENAI_DEPLOYMENT
  );
}

function clampConfidence(value) {
  let n = Number(value);
  if (!Number.isFinite(n)) return 0.6;
  // Models often answer on a 0-100 scale despite being asked for 0-1.
  if (n > 1) n /= 100;
  return Math.min(1, Math.max(0, n));
}

// Shape whatever the model returned into the finding schema review.js expects.
function normalise(raw, idx) {
  const label = String(raw?.label || '').trim();
  if (!label) return null;

  const pattern = PATTERNS.find(
    (p) => p.toLowerCase() === String(raw?.pattern || '').trim().toLowerCase()
  ) || 'Other';

  const severity = ['normal', 'minor', 'significant'].includes(raw?.severity)
    ? raw.severity
    : 'minor';

  // No _id here on purpose: the Case sub-schema generates ObjectIds, and
  // handing it a string would fail to cast.
  return {
    label: label.slice(0, 80),
    confidence: Number(clampConfidence(raw?.confidence).toFixed(2)),
    // This model reads text only and cannot localise, so the box is a
    // placeholder the clinician repositions rather than a real detection.
    bbox: [10 + idx * 12, 10 + idx * 8, 18, 18],
    location: String(raw?.location || '').trim().slice(0, 80),
    size: String(raw?.size || '').trim().slice(0, 40),
    pattern,
    severity,
    sentence: String(raw?.detail || '').trim().slice(0, 240),
    status: 'pending',
    source: 'Azure',
  };
}

/**
 * Summarise a report into structured findings.
 * @param {string} reportText
 * @returns {Promise<Array<object>>}
 */
async function summariseFindings(reportText) {
  if (!isConfigured()) {
    throw new Error(
      'Azure OpenAI is not configured. Set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY ' +
      'and AZURE_OPENAI_DEPLOYMENT in backend/.env.'
    );
  }
  const text = String(reportText || '').trim();
  if (!text) throw new Error('This case has no report text to summarise.');

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
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      temperature: 0.1,
      max_tokens: 900,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60_000),
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

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Azure OpenAI did not return valid JSON.');
  }

  const list = Array.isArray(parsed) ? parsed : parsed?.findings;
  if (!Array.isArray(list)) throw new Error('Azure OpenAI response had no findings array.');

  return list.slice(0, 6).map(normalise).filter(Boolean);
}

module.exports = { summariseFindings, isConfigured };
