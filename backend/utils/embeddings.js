// utils/embeddings.js
//
// Azure OpenAI embeddings, with the same endpoint, key and API version as
// azureFindings.js. The one extra setting is the embedding deployment:
//
//   AZURE_OPENAI_EMBEDDING_DEPLOYMENT   e.g. the text-embedding-3-small deployment name

const azureFindings = require('./azureFindings');

const BATCH = 64;

function deployment() {
  return String(process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || '').trim();
}

function isConfigured() {
  return azureFindings.isConfigured() && Boolean(deployment());
}

/**
 * Embed texts, in order. Throws if Azure is not configured or answers badly.
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function embedTexts(texts) {
  if (!isConfigured()) {
    throw new Error('Azure embeddings are not configured. Set AZURE_OPENAI_EMBEDDING_DEPLOYMENT in backend/.env.');
  }
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, '');
  const url = `${endpoint}/openai/deployments/${encodeURIComponent(deployment())}/embeddings?api-version=${azureFindings.API_VERSION}`;
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const input = texts.slice(i, i + BATCH);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': process.env.AZURE_OPENAI_KEY },
      body: JSON.stringify({ input }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch { /* not JSON */ }
      throw new Error(`Azure embeddings ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
    }
    const data = (await res.json())?.data;
    if (!Array.isArray(data) || data.length !== input.length) throw new Error('Azure embeddings returned the wrong number of vectors.');
    const rows = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const row of rows) {
      const v = row?.embedding;
      if (!Array.isArray(v) || !v.length || !v.every((n) => Number.isFinite(n))) throw new Error('Azure embeddings returned a bad vector.');
      out.push(v);
    }
  }
  return out;
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

module.exports = { embedTexts, cosine, isConfigured, deployment };
