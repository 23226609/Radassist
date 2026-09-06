// utils/aiService.js
// Forward uploaded X-ray to the FastAPI middleware (~/Desktop/fyp/middleware.py)
// which handles: scratch-file write -> mlx_vlm server -> report text.
// We pass the file bytes back to the middleware so it can re-stream them to the
// AI server — this keeps the Node backend thin and avoids duplicating logic.

const fs = require('fs');

const AI_BASE_URL = process.env.AI_BASE_URL || 'http://localhost:8001';

/**
 * Ask the FastAPI middleware to analyze an X-ray.
 * @param {{ imagePath: string, patientId?: string, age?: string, sex?: string, history?: string }} opts
 * @returns {Promise<string>} the AI report text
 */
async function analyzeXray({ imagePath, patientId, age, sex, history }) {
  if (!fs.existsSync(imagePath)) {
    throw new Error(`AI service: image not found at ${imagePath}`);
  }

  // Node 22+ exposes File / FormData / Blob globally, so no extra deps needed.
  const fileBuffer = fs.readFileSync(imagePath);
  const filename = imagePath.split('/').pop() || 'xray.jpg';
  const mime = filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

  const blob = new Blob([fileBuffer], { type: mime });
  const form = new FormData();
  form.append('file', blob, filename);
  form.append('patientId', patientId || '');
  form.append('age', age || '');
  form.append('sex', sex || '');
  form.append('history', history || '');

  const res = await fetch(`${AI_BASE_URL}/analyze`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(180_000),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).detail || ''; } catch (_) { /* ignore */ }
    throw new Error(`AI middleware ${res.status} ${res.statusText}${detail ? ': ' + detail : ''}`);
  }

  const data = await res.json();
  // Middleware returns { report, case_id, ... } — pull the report text out.
  const text = data?.report || data?.report_text || data?.choices?.[0]?.message?.content || '';
  if (!text.trim()) {
    throw new Error('AI middleware returned an empty report.');
  }
  return text.trim();
}

module.exports = { analyzeXray };
