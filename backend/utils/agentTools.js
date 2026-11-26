// utils/agentTools.js
//
// The agent's three tools, and nothing else. Each one does a real lookup and
// returns plain data. None of them can write to a case or edit a report.
//
//   search_similar_cases  Azure embeddings over the imported MIMIC cases (searched with the Second Reader's diagnosis)
//   search_guideline      StatPearls (NCBI) + NICE and Radiopaedia (Azure web search)
//   notify                one email through Azure Communication Services
//
// A tool that finds nothing returns an empty list and a note. It never makes
// up a case or a passage. A tool that cannot run throws, and agent.js records
// that as "nothing useful" and carries on.
//
// Settings (backend/.env):
//   AZURE_OPENAI_ENDPOINT / _KEY / _DEPLOYMENT      the project's Azure OpenAI (also used for web search)
//   AZURE_OPENAI_EMBEDDING_DEPLOYMENT               text-embedding-3-small deployment name
//   AZURE_OPENAI_WEBSEARCH_DEPLOYMENT               optional; a deployment that supports web_search
//   AGENT_SIMILARITY_MIN                            optional cut-off for similar cases, default 0.5
//   NCBI_API_KEY, NCBI_EMAIL                        optional, for NCBI's higher rate limit
//   ACS_CONNECTION_STRING                           Azure Communication Services (radassist-acs) email
//   ACS_SENDER_ADDRESS                              optional; defaults to the radassist-acs DoNotReply address

const crypto = require('crypto');
const Case = require('../models/Case');
const CaseEmbedding = require('../models/CaseEmbedding');
const AgentSetting = require('../models/AgentSetting');
const User = require('../models/User');
const azureFindings = require('./azureFindings');
const embeddings = require('./embeddings');
const mimic = require('./mimic');
const evidence = require('./agentEvidence');

const TOP_CASES = 3;
const POOL = 10; // the closest cases by similarity, from which the 3 most relevant are picked
const MAX_PASSAGES = 2;
const MAX_REPORT_CHARS = 1500;
const FETCH_TIMEOUT_MS = 20_000;
const WEB_TIMEOUT_MS = 60_000;
const EMAIL_TIMEOUT_MS = 45_000;
const WEB_DOMAINS = ['nice.org.uk', 'radiopaedia.org'];

const squash = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// ---------------------------------------------------------------------------
// search_similar_cases
// ---------------------------------------------------------------------------

function minSimilarity() {
  const n = Number(process.env.AGENT_SIMILARITY_MIN);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : 0.5;
}

// What is compared in an official report: its FINDINGS and IMPRESSION. The
// indication (the patient's history) is left out, so two cases match on what
// the film showed, not on why it was ordered.
function comparableText(sourceReport) {
  const sections = mimic.reportSections(sourceReport?.text || '');
  return ['FINDINGS', 'IMPRESSION']
    .map((name) => String(sections[name] || '').replace(/_{2,}/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 2000);
}

// One line of an official report for display: its IMPRESSION, else its FINDINGS, cut at the end of a
// sentence. It is the report's own words, never rewritten.
function oneLineOf(sourceReport) {
  const sections = mimic.reportSections(sourceReport?.text || '');
  const pick = (name) => String(sections[name] || '').replace(/_{2,}/g, ' ').replace(/\s+/g, ' ').trim();
  const text = pick('IMPRESSION') || pick('FINDINGS') || squash(sourceReport?.text, 400);
  const first = (text.match(/^.*?[.!?](?=\s|$)/) || [text])[0].trim();
  return (first.length > 200 ? `${first.slice(0, 197).replace(/\s+\S*$/, '')}…` : first);
}

const hashOf = (model, text) => crypto.createHash('sha1').update(`${model}\n${text}`).digest('hex');

/**
 * The imported cases whose official report is closest to the Second Reader's diagnosis, ranked by how
 * relevant their diagnosis is (same, then related) and only then by similarity. For each: one line of its
 * report, why it is similar (features both texts really share), and its outcome if the record has one.
 * @param {{ caseId: string, findingsText: string, newCaseText?: string }} input
 *   findingsText is the Second Reader's diagnosis, which is what is searched for.
 *   newCaseText is that diagnosis with the Second Reader's summary and the patient context, for "why similar".
 */
async function searchSimilarCases({ caseId, findingsText, newCaseText } = {}) {
  const query = squash(findingsText, 2000);
  if (!query) return { results: [], compared: 0, note: 'This case has no findings text to compare.' };
  if (!embeddings.isConfigured()) {
    throw new Error('Azure embeddings are not configured (AZURE_OPENAI_EMBEDDING_DEPLOYMENT).');
  }

  const rows = await Case.find({ caseId: { $ne: caseId }, 'sourceReport.text': { $exists: true, $ne: '' } })
    .select('caseId patientId examinedAt sourceReport')
    .lean();
  const model = embeddings.deployment();
  const candidates = rows
    .map((row) => ({ row, text: comparableText(row.sourceReport) }))
    .filter((c) => c.text);
  if (!candidates.length) return { results: [], compared: 0, note: 'There are no imported cases with an official report to compare with.' };

  // Reuse the saved vectors; make the missing or changed ones, in one go with the query.
  const saved = new Map(
    (await CaseEmbedding.find({ caseId: { $in: candidates.map((c) => c.row.caseId) }, model }).lean())
      .map((e) => [e.caseId, e])
  );
  const stale = candidates.filter((c) => saved.get(c.row.caseId)?.textHash !== hashOf(model, c.text));
  const vectors = await embeddings.embedTexts([query, ...stale.map((c) => c.text)]);
  const queryVector = vectors[0];
  if (stale.length) {
    await CaseEmbedding.bulkWrite(stale.map((c, i) => ({
      updateOne: {
        filter: { caseId: c.row.caseId, model },
        update: { $set: { textHash: hashOf(model, c.text), vector: vectors[i + 1] } },
        upsert: true,
      },
    })));
    stale.forEach((c, i) => saved.set(c.row.caseId, { vector: vectors[i + 1] }));
  }

  const floor = minSimilarity();
  const pool = candidates
    .map((c) => ({ row: c.row, score: embeddings.cosine(queryVector, saved.get(c.row.caseId)?.vector) }))
    .filter((x) => x.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, POOL);

  // Which of the closest are the right diagnosis, and why. If this step fails the cases are still
  // returned by similarity alone, with no reason and no claim about their diagnosis.
  let explained = new Map();
  let explainError = '';
  if (pool.length) {
    try {
      explained = await evidence.explainCandidates({
        diagnosis: query,
        newCaseText: newCaseText || query,
        pool: pool.map((x) => ({ caseId: x.row.caseId, sourceReport: x.row.sourceReport })),
      });
    } catch (err) {
      explainError = err.message || 'failed';
    }
  }
  const ranked = pool
    .map((x) => ({ ...x, info: explained.get(x.row.caseId) || { match: 'unknown', why: '' } }))
    .sort((a, b) => evidence.tierOf(a.info) - evidence.tierOf(b.info) || b.score - a.score)
    .slice(0, TOP_CASES);

  const results = [];
  for (const x of ranked) {
    const later = await laterStudy(x.row);
    results.push({
      caseId: x.row.caseId,
      similarity: Math.round(x.score * 1000) / 1000,
      diagnosisMatch: x.info.match,
      whySimilar: x.info.why,
      outcome: evidence.outcomeOf(x.row.sourceReport, later),
      line: oneLineOf(x.row.sourceReport),
      officialReport: String(x.row.sourceReport.text).trim().slice(0, MAX_REPORT_CHARS),
      source: x.row.sourceReport.source || '',
    });
  }
  return {
    results,
    compared: candidates.length,
    note: results.length
      ? (explainError ? `Ranked by similarity only: ${explainError}` : '')
      : `No imported case was similar enough (cut-off ${floor}).`,
  };
}

// The next imported study of the same patient, if there is one: its own report is what happened next.
async function laterStudy(row) {
  if (!row.patientId || !row.examinedAt) return null;
  // No sort in the query (the database has no index for it); the earliest later study is picked here.
  const later = await Case.find({
    patientId: row.patientId,
    caseId: { $ne: row.caseId },
    examinedAt: { $gt: row.examinedAt },
    'sourceReport.text': { $exists: true, $ne: '' },
  }).select('caseId examinedAt sourceReport').lean();
  return later.sort((a, b) => new Date(a.examinedAt) - new Date(b.examinedAt))[0] || null;
}

// ---------------------------------------------------------------------------
// search_guideline
// ---------------------------------------------------------------------------

// The query goes to outside services, so it is only a short medical term:
// letters, spaces and hyphens, at most 8 words. Anything else (a name, a number,
// a date) is dropped before it leaves the server.
function cleanGuidelineQuery(raw) {
  return String(raw ?? '')
    .replace(/[^A-Za-z\- ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join(' ')
    .slice(0, 80);
}

async function fetchText(url, init = {}, timeout = FETCH_TIMEOUT_MS) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* not JSON */ }
    throw new Error(`${new URL(url).hostname} ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res;
}

// NCBI allows about 3 requests a second without a key. A "too many requests" answer is retried
// once after a pause, and the extra searches below are spaced out.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function ncbiGet(url) {
  try {
    return await fetchText(url);
  } catch (err) {
    if (!/\b429\b/.test(err.message)) throw err;
    await sleep(1200);
    return fetchText(url);
  }
}

function ncbi(path, params) {
  const q = new URLSearchParams({ tool: 'radassist', ...params });
  if (process.env.NCBI_EMAIL) q.set('email', process.env.NCBI_EMAIL);
  if (process.env.NCBI_API_KEY) q.set('api_key', process.env.NCBI_API_KEY);
  return `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/${path}?${q}`;
}

function xmlText(fragment) {
  return String(fragment || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// A condition name without its position and size words: "bilateral lower lobe pneumonia" -> "pneumonia".
const QUALIFIERS = /^(bilateral|unilateral|left|right|upper|middle|lower|lobe|lobes|lobar|zone|zones|basal|basilar|apical|acute|chronic|likely|probable|possible|suspected|early|mild|moderate|severe|small|large|multifocal|patchy|focal|diffuse|new|with|and|of|the|in|on|or|at)$/i;
const coreTerm = (query) => String(query || '').split(/\s+/).filter((w) => w && !QUALIFIERS.test(w)).join(' ');

const significantWords = (query) => query.toLowerCase().split(/[\s-]+/).filter((w) => w.length > 3);

// The patient context goes into a search, so it is cut down to the same plain characters the
// context builder allows: letters, digits, spaces, commas and hyphens.
const cleanContextString = (raw) => String(raw ?? '').replace(/[^A-Za-z0-9,\- ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

// StatPearls chapters are indexed in PubMed with their abstracts. NCBI's
// Bookshelf pages sit behind a captcha and its E-utilities return no Bookshelf
// text, so the PubMed route is the one that gives StatPearls text at all.
// The chapters PubMed returns for a term, the one named most like the condition first.
async function statPearlsArticles(term, query, core) {
  const found = await (await ncbiGet(ncbi('esearch.fcgi', { db: 'pubmed', term, retmax: '20', retmode: 'json', sort: 'relevance' }))).json();
  const ids = found?.esearchresult?.idlist || [];
  if (!ids.length) return [];
  const xml = await (await ncbiGet(ncbi('efetch.fcgi', { db: 'pubmed', id: ids.join(','), retmode: 'xml' }))).text();
  const words = significantWords(query);
  const out = [];
  const nursing = []; // the clinician chapter is preferred over its nursing twin
  for (const article of xml.match(/<PubmedBookArticle>[\s\S]*?<\/PubmedBookArticle>/g) || []) {
    const pmid = xmlText((article.match(/<PMID[^>]*>([\s\S]*?)<\/PMID>/) || [])[1]);
    const title = xmlText((article.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/) || [])[1]);
    const abstract = (article.match(/<AbstractText[^>]*>[\s\S]*?<\/AbstractText>/g) || []).map(xmlText).filter(Boolean).join(' ');
    if (!pmid || !title || !abstract) continue;
    const haystack = `${title} ${abstract}`.toLowerCase();
    if (words.length && !words.some((w) => haystack.includes(w))) continue;
    // Only a chapter named for the condition itself ("Pneumonia"), not another disease that contains the word ("Eosinophilic Pneumonia").
    const chapter = title.toLowerCase().replace(/\s*\(.*\)\s*$/, '');
    const wanted = (core || query).toLowerCase();
    if (!(chapter === wanted || chapter.startsWith(`${wanted} `) || chapter === query.toLowerCase() || chapter.startsWith(`${query.toLowerCase()} `))) continue;
    (/\(nursing\)/i.test(title) ? nursing : out).push({ id: pmid, title, text: abstract, url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` });
  }
  // The chapter named most like the condition comes first ("Pneumonia" before "Eosinophilic Pneumonia").
  const name = (core || query).toLowerCase();
  const rank = (r) => { const t = r.title.toLowerCase().replace(/\s*\(.*\)\s*$/, ''); return t === name ? 0 : t.startsWith(name) ? 1 : t.includes(name) ? 2 : 3; };
  const byName = (list) => list.map((r, i) => ({ r, i })).sort((x, y) => rank(x.r) - rank(y.r) || x.i - y.i).map((x) => x.r);
  return [...byName(out), ...byName(nursing)];
}

// StatPearls checklists. A chapter whose abstract only defines the disease gives no line and is not used;
// the next, more general search is tried instead.
async function statPearlsChecklists(query, context) {
  const core = coreTerm(query);
  const attempts = [`"${query}"[Title] AND StatPearls[Book]`, `"${query}"[Title/Abstract] AND StatPearls[Book]`];
  if (core && core.toLowerCase() !== query.toLowerCase()) attempts.push(`"${core}"[Title] AND StatPearls[Book]`);
  const seen = new Set();
  for (const term of attempts) {
    const articles = (await statPearlsArticles(term, query, core)).filter((a) => !seen.has(a.id)).slice(0, 4);
    articles.forEach((a) => seen.add(a.id));
    if (articles.length) {
      const lines = await evidence.extractChecklists(articles, { diagnosis: query, context });
      const kept = articles.filter((a) => lines.has(a.id)).map((a) => ({ source: 'StatPearls', title: a.title, url: a.url, bullets: lines.get(a.id) }));
      if (kept.length) return kept.sort((a, b) => bulletCount(b) - bulletCount(a));
    }
    await sleep(350);
  }
  return [];
}

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
const allowedHost = (host) => WEB_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));

// NICE and Radiopaedia through Azure OpenAI's own web_search tool (the Bing Search
// API was retired in August 2025). The deployment may not support a domain filter,
// so the query names the two sites and every citation is checked against them here.
// A page is kept only if it is on one of those sites and gave at least one checklist line.
async function webChecklistsOnce(query, context) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, '');
  const model = process.env.AZURE_OPENAI_WEBSEARCH_DEPLOYMENT || process.env.AZURE_OPENAI_DEPLOYMENT;
  const res = await fetchText(`${endpoint}/openai/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': process.env.AZURE_OPENAI_KEY },
    body: JSON.stringify({
      model,
      input: `Find the nice.org.uk or radiopaedia.org page best matching: ${query}${context ? `, ${context}` : ''}. Open the page and read it. `
        + 'Write up to three lines, each starting with one of these labels:\n'
        + 'LOOK FOR: the radiographic signs to look for on the chest X-ray\n'
        + 'RULE OUT: the differential diagnoses to rule out\n'
        + 'NEXT: what to do next, or what follow-up is suggested\n'
        + 'All the lines must come from that one page. After them write a line "SOURCE:" with a markdown link to the page. '
        + 'Write a line only if the page itself says it: use what the page says, not your general knowledge, and leave a line out if the page does not say it. '
        + 'Never write a definition or a general description of the disease; if the page only defines it, do not use it. '
        + 'If a second page is also clearly specific to this diagnosis, repeat the same format for it. If nothing usable is found, reply with the single word NONE.',
      tools: [{ type: 'web_search' }],
    }),
  }, WEB_TIMEOUT_MS);
  const body = await res.json();
  const out = [];
  for (const item of body?.output || []) {
    if (item?.type !== 'message') continue;
    for (const part of item.content || []) {
      for (const page of evidence.parseWebChecklist(part?.text, part?.annotations, allowedHost)) {
        out.push({
          source: page.host.endsWith('radiopaedia.org') ? 'Radiopaedia' : 'NICE',
          title: page.title || page.host,
          url: page.url,
          bullets: page.bullets,
        });
      }
    }
  }
  return out.sort((a, b) => bulletCount(b) - bulletCount(a));
}

const bulletCount = (r) => Object.values(r.bullets || {}).filter(Boolean).length;

// The web search is not steady: the same question sometimes comes back with nothing. So a question that
// finds nothing is asked once more, with the plain condition name ("pneumonia" for "bilateral lower lobe
// pneumonia"), or the same again when there is no shorter form. Still one search for the agent's rules.
async function webChecklists(query, context) {
  const core = coreTerm(query);
  for (const q of [query, core && core.toLowerCase() !== query.toLowerCase() ? core : query]) {
    const found = await webChecklistsOnce(q, context);
    if (found.length) return found;
  }
  return [];
}

/**
 * At most two sources, each with a short checklist (what to look for, what to rule out, what to do next).
 * A source that only defines the disease is not used. A line is kept only if the source says it.
 * The search is for the diagnosis; for the web search the patient context (age, sex, main symptoms,
 * abnormal labs, never a name or a date) goes with it. PubMed matches titles, so it gets the diagnosis only.
 * @param {{ query: string, context?: string }} input
 * @returns {Promise<{ results: Array<{source: string, title: string, url: string, bullets: {lookFor: string, ruleOut: string, next: string}}>, note: string, sourceErrors: string[] }>}
 */
async function searchGuideline({ query, context } = {}) {
  const q = cleanGuidelineQuery(query);
  if (q.length < 3) return { results: [], note: 'There was no medical term to search for.', sourceErrors: [] };
  if (!azureFindings.isConfigured()) {
    throw new Error('Azure OpenAI is not configured, so the guideline checklists cannot be read.');
  }
  const ctx = cleanContextString(context);

  const jobs = [['StatPearls', statPearlsChecklists(q, ctx)], ['NICE/Radiopaedia', webChecklists(q, ctx)]];
  const settled = await Promise.allSettled(jobs.map(([, p]) => p));
  const sourceErrors = [];
  const lists = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    sourceErrors.push(`${jobs[i][0]}: ${s.reason?.message || 'failed'}`);
    return [];
  });
  if (settled.every((s) => s.status === 'rejected')) throw new Error(sourceErrors.join('; '));

  // One from each source first, so a single source cannot fill both places.
  const picked = [];
  for (const list of lists) if (list[0]) picked.push(list[0]);
  for (const list of lists) for (const p of list.slice(1)) if (picked.length < MAX_PASSAGES) picked.push(p);
  const results = picked.slice(0, MAX_PASSAGES);
  return {
    results,
    note: results.length ? '' : `No StatPearls, NICE or Radiopaedia source with a checklist was found for "${q}".`,
    sourceErrors,
  };
}

// ---------------------------------------------------------------------------
// notify
// ---------------------------------------------------------------------------
//
// One email, to the referring doctor, when a report has been endorsed. Rules:
//   - never before the report is endorsed;
//   - never for a report endorsed before the email service was ready (no catch-up
//     email): the server records when email first became ready, and only an
//     endorsement on or after that moment is emailed;
//   - at most once per case (a case cannot be endorsed twice);
//   - the text is fixed and has no patient details; the model chooses nothing.
// Azure Communication Services, resource radassist-acs. The connection string is
// ACS_CONNECTION_STRING in backend/.env; it is never defaulted or guessed.

const DEFAULT_SENDER = 'DoNotReply@bea841cf-6a1c-4660-8978-566871702bb6.azurecomm.net';
const READY_KEY = 'notifyReadyAt';

const senderAddress = () => String(process.env.ACS_SENDER_ADDRESS || '').trim() || DEFAULT_SENDER;
const emailConfigured = () => Boolean(String(process.env.ACS_CONNECTION_STRING || '').trim());

// Replaced by the tests, so no real email is sent from them.
let emailClientFactory = (connectionString) => {
  const { EmailClient } = require('@azure/communication-email');
  return new EmailClient(connectionString);
};

function _setEmailClientFactory(factory) {
  emailClientFactory = factory;
}

/**
 * Record, once, when the email service became ready. Called when the server starts.
 * Email set up and no moment recorded yet: now is the moment. Email not set up:
 * any earlier moment is forgotten, so a gap with no email service is never caught up.
 * @returns {Promise<Date|null>} when email became ready, or null if it is not set up
 */
async function syncNotifyReady() {
  if (!emailConfigured()) {
    await AgentSetting.deleteOne({ key: READY_KEY });
    return null;
  }
  const row = await AgentSetting.findOneAndUpdate(
    { key: READY_KEY },
    { $setOnInsert: { value: new Date() } },
    { upsert: true, new: true }
  ).lean();
  return new Date(row.value);
}

async function recipientOf(caseDoc) {
  const id = String(caseDoc?.requestedBy || '').trim();
  if (!id) return '';
  const user = await User.findOne({ userId: id }).select('email').lean();
  return String(user?.email || '').trim();
}

/**
 * Why notify may not run for this case now, or null when it may.
 * `unavailable` is true when the cause is set-up (the call is not used up);
 * otherwise it is a rule and the answer will not change.
 * @returns {Promise<{ reason: string, unavailable: boolean } | null>}
 */
async function notifyBlocker(caseDoc) {
  if (caseDoc?.status !== 'finalized') {
    return { reason: 'notify is only allowed after the report is endorsed, and this one is not.', unavailable: false };
  }
  if (caseDoc.agentResult?.tools?.notify) {
    return { reason: 'notify was already used for this case.', unavailable: false };
  }
  if (!emailConfigured()) {
    return { reason: 'notify is not available: the email service is not set up (ACS_CONNECTION_STRING).', unavailable: true };
  }
  const readyAt = (await syncNotifyReady()) || null;
  const endorsedAt = caseDoc.finalizedAt ? new Date(caseDoc.finalizedAt) : null;
  if (!endorsedAt || Number.isNaN(endorsedAt.getTime()) || endorsedAt < readyAt) {
    return {
      reason: 'notify is not allowed: this report was endorsed before the email service was ready, so no email is sent for it.',
      unavailable: false,
    };
  }
  if (!(await recipientOf(caseDoc))) {
    return { reason: 'notify is not available: the referring doctor has no email address on file.', unavailable: true };
  }
  return null;
}

/**
 * Send the one email for an endorsed report. Refuses, with an error, in every case
 * notifyBlocker lists, so it is safe to call on its own.
 * @param {{ caseDoc: object }} input
 * @returns {Promise<{ sent: boolean, to: string, subject: string, text: string, messageId: string, status: string, endorsedAt: string }>}
 */
async function notify({ caseDoc } = {}) {
  const blocker = await notifyBlocker(caseDoc);
  if (blocker) throw new Error(blocker.reason);

  const to = await recipientOf(caseDoc);
  const subject = `RadAssist: report endorsed for case ${caseDoc.caseId}`;
  const text = `The report for case ${caseDoc.caseId} was endorsed${caseDoc.finalizedByName ? ` by ${caseDoc.finalizedByName}` : ''}. `
    + 'Please open RadAssist to read it.\n\nThis message has no patient details.';

  const client = emailClientFactory(process.env.ACS_CONNECTION_STRING.trim());
  const poller = await client.beginSend({
    senderAddress: senderAddress(),
    content: { subject, plainText: text },
    recipients: { to: [{ address: to }] },
  });
  const result = await Promise.race([
    poller.pollUntilDone(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Azure Communication Services did not finish in time.')), EMAIL_TIMEOUT_MS).unref()),
  ]);
  const status = String(result?.status || '');
  if (status && status !== 'Succeeded') throw new Error(`Azure Communication Services email ${status}${result?.error?.message ? `: ${result.error.message}` : ''}`);
  return {
    sent: true,
    to,
    subject,
    text,
    messageId: String(result?.id || ''),
    status: status || 'Succeeded',
    endorsedAt: new Date(caseDoc.finalizedAt).toISOString(),
  };
}

module.exports = {
  searchSimilarCases,
  searchGuideline,
  notify,
  notifyBlocker,
  syncNotifyReady,
  cleanGuidelineQuery,
  cleanContextString,
  coreTerm,
  comparableText,
  oneLineOf,
  _setEmailClientFactory,
};
