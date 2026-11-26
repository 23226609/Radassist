// utils/agentEvidence.js
//
// The parts of the agent's supporting evidence that need reading and checking, kept apart from the
// lookups in agentTools.js:
//
//   patientContext     age, sex, main symptoms and abnormal labs of this case, for the guideline search
//   explainCandidates  for each similar case: how close its diagnosis is to the Second Reader's, and the
//                      features the two really share
//   outcomeOf          what the record says happened to that patient (never made up)
//   extractChecklists  the look-for / rule-out / next-step lines a source really gives
//
// Where a model is used it only picks and words things. Every claim it makes has to come with the exact
// words from the text it read, and the code checks those words are really in that text. A claim that
// cannot be checked is dropped, so nothing in the panel is something the model made up.

const Patient = require('../models/Patient');
const azureFindings = require('./azureFindings');
const mimic = require('./mimic');
const { historyText, NOT_RECORDED } = require('./historyReasoning');

const squash = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Lower case, punctuation as a space, one space between words: for "are these words in that text".
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const contains = (text, quote) => {
  const q = norm(quote);
  return q.length >= 3 && ` ${norm(text)} `.includes(` ${q} `);
};

// ---------------------------------------------------------------------------
// The patient context sent with a guideline search
// ---------------------------------------------------------------------------

const MAX_SYMPTOMS = 4;
const MAX_LABS = 3;

// Letters, spaces and hyphens only, short. No digit, name or date can get through in a symptom or lab.
const phrase = (s, max) => String(s ?? '').replace(/[^A-Za-z\- ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The context as the one short line that goes into a search, e.g.
 * "67-year-old female, persistent cough, mild dyspnoea, CRP elevated".
 * Age is the only number in it. Names, ids, dates and lab values never are.
 */
function contextText(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const parts = [];
  const age = Number(ctx.age);
  const sex = /^(male|female)$/i.test(String(ctx.sex || '').trim()) ? String(ctx.sex).trim().toLowerCase() : '';
  if (Number.isInteger(age) && age > 0 && age < 121) parts.push(`${age}-year-old${sex ? ` ${sex}` : ''}`);
  else if (sex) parts.push(sex);
  for (const s of (Array.isArray(ctx.symptoms) ? ctx.symptoms : []).slice(0, MAX_SYMPTOMS)) {
    const p = phrase(s, 40);
    if (p) parts.push(p.toLowerCase());
  }
  for (const l of (Array.isArray(ctx.abnormalLabs) ? ctx.abnormalLabs : []).slice(0, MAX_LABS)) {
    const name = phrase(l?.name, 20);
    if (name) parts.push(`${name} ${l?.direction === 'low' ? 'low' : 'elevated'}`);
  }
  return parts.join(', ');
}

const CONTEXT_PROMPT = `You read a patient's chart text and pick out what matters for a chest X-ray search. Use only the text given. Do not guess.
Return JSON only:
{"symptoms":["each main presenting symptom, copied in the chart's own words"],"abnormalLabs":[{"name":"the test name exactly as written in the lab text","direction":"high or low"}]}
Rules:
- At most 4 symptoms. Copy the words from the history exactly; do not rephrase.
- Only list a lab if its value is clearly outside the usual adult reference range. A normal or borderline value is not listed. If none is clearly abnormal, return an empty list.
- If there is no history or no lab text, return an empty list for it.`;

/**
 * Age, sex, main symptoms and abnormal labs of this case, each checked against the chart.
 * Never throws: when the chart cannot be read it returns what it has (age and sex).
 * @returns {Promise<{ age: number|null, sex: string, symptoms: string[], abnormalLabs: Array<{name: string, direction: string}>, text: string }>}
 */
async function patientContext(caseDoc, { chat = azureFindings.chatJson } = {}) {
  const patient = await Patient.findOne({ patientId: caseDoc?.patientId }).select('age sex history labResults').lean().catch(() => null);
  const ageNum = Number(String(patient?.age ?? caseDoc?.age ?? '').match(/\d{1,3}/)?.[0]);
  const age = Number.isInteger(ageNum) && ageNum > 0 && ageNum < 121 ? ageNum : null;
  const sex = String(patient?.sex || caseDoc?.sex || '').trim();
  const history = historyText(caseDoc || {}, patient);
  const labs = squash(patient?.labResults, 1500);
  const out = { age, sex, symptoms: [], abnormalLabs: [] };

  if (history !== NOT_RECORDED || labs) {
    try {
      const reply = await chat(CONTEXT_PROMPT, `History:\n${history === NOT_RECORDED ? '(none)' : history}\n\nLab results:\n${labs || '(none)'}`, 400, 0);
      out.symptoms = (Array.isArray(reply?.symptoms) ? reply.symptoms : [])
        .map((s) => squash(s, 60))
        .filter((s) => s && contains(history, s))
        .slice(0, MAX_SYMPTOMS);
      out.abnormalLabs = (Array.isArray(reply?.abnormalLabs) ? reply.abnormalLabs : [])
        .map((l) => ({ name: squash(l?.name, 30), direction: l?.direction === 'low' ? 'low' : 'high' }))
        .filter((l) => l.name && contains(labs, l.name))
        .slice(0, MAX_LABS);
    } catch {
      // The search still runs on the diagnosis, age and sex.
    }
  }
  out.text = contextText(out);
  return out;
}

// ---------------------------------------------------------------------------
// Similar cases: how close, and why
// ---------------------------------------------------------------------------

// The part of an official report a model reads: why it was ordered, what it showed, what it concluded.
function reportForReading(sourceReport) {
  const s = mimic.reportSections(sourceReport?.text || '');
  const pick = (names) => {
    for (const n of names) {
      const v = String(s[n] || '').replace(/_{2,}/g, ' ').replace(/\s+/g, ' ').trim();
      if (v) return v;
    }
    return '';
  };
  return [
    ['INDICATION', pick(['INDICATION', 'CLINICAL HISTORY', 'HISTORY'])],
    ['FINDINGS', pick(['FINDINGS'])],
    ['IMPRESSION', pick(['IMPRESSION'])],
  ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n').slice(0, 1100);
}

const EXPLAIN_PROMPT = `You compare a new chest X-ray case with earlier cases, using only the texts given. Do not use outside knowledge and do not guess.
For each earlier case return:
- "caseId"
- "diagnosisMatch": "same" if the earlier report's diagnosis is the same condition as the new case's diagnosis, "related" if it is a closely related condition (a different lobe or side, or a type of the same disease), "different" otherwise
- "caseDiagnosis": the earlier report's diagnosis, copied in its own words from that report
- "shared": up to 3 features that BOTH the new case and the earlier case have. Each is {"feature":"2 to 6 words","newCaseQuote":"exact words copied from the new case text","caseQuote":"exact words copied from the earlier case's text"}.
A feature counts only if it is really in both texts. If nothing is shared, return an empty list. Never invent a feature.
Return JSON only: {"cases":[{"caseId":"","diagnosisMatch":"","caseDiagnosis":"","shared":[]}]}`;

const MATCH_TIER = { same: 0, related: 1, unknown: 2, different: 3 };

/**
 * For each candidate, its diagnosis match and the shared features, each checked against the texts.
 * @param {{ diagnosis: string, newCaseText: string, pool: Array<{ caseId: string, sourceReport: object }> }} input
 * @returns {Promise<Map<string, { match: string, why: string }>>}  a candidate the model skipped is not in the map
 */
async function explainCandidates({ diagnosis, newCaseText, pool }, { chat = azureFindings.chatJson } = {}) {
  const texts = new Map(pool.map((c) => [c.caseId, reportForReading(c.sourceReport)]));
  const full = new Map(pool.map((c) => [c.caseId, String(c.sourceReport?.text || '')]));
  const user = JSON.stringify({
    newCase: { diagnosis, text: squash(newCaseText, 1500) },
    earlierCases: pool.map((c) => ({ caseId: c.caseId, report: texts.get(c.caseId) })),
  });
  const reply = await chat(EXPLAIN_PROMPT, user, 2200, 0);
  const result = new Map();
  for (const row of Array.isArray(reply?.cases) ? reply.cases : []) {
    const id = String(row?.caseId || '');
    if (!texts.has(id) || result.has(id)) continue;
    // "same" and "related" count only when the diagnosis the model names is really in that report.
    const claimed = ['same', 'related', 'different'].includes(row.diagnosisMatch) ? row.diagnosisMatch : 'unknown';
    const named = contains(full.get(id), row.caseDiagnosis) || contains(texts.get(id), row.caseDiagnosis);
    const match = claimed === 'different' || named ? claimed : 'unknown';
    const features = (Array.isArray(row.shared) ? row.shared : [])
      .filter((f) => f && contains(newCaseText, f.newCaseQuote) && (contains(full.get(id), f.caseQuote) || contains(texts.get(id), f.caseQuote)))
      .map((f) => phraseLoose(f.feature))
      .filter(Boolean)
      .filter((f, i, all) => all.findIndex((g) => g.toLowerCase() === f.toLowerCase()) === i)
      .slice(0, 3);
    result.set(id, { match, why: features.join(' + ') });
  }
  return result;
}

// A short feature label: letters, digits, spaces, a few joining marks.
const phraseLoose = (s) => String(s ?? '').replace(/[^\p{L}\p{N} \-/,]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

const tierOf = (info) => MATCH_TIER[info?.match] ?? MATCH_TIER.unknown;

// ---------------------------------------------------------------------------
// Outcome: only what the record itself says
// ---------------------------------------------------------------------------

const CHANGE = /\b(resolved|resolving|resolution|improv\w*|worsen\w*|progress\w*|persist\w*|unchanged|stable|interval|increas\w*|decreas\w*|enlarg\w*|new)\b/i;
const PRIOR = /\b(compar\w*|prior|previous\w*|earlier|since|follow[- ]?up|interval)\b/i;

const sentencesOf = (text) => String(text || '').replace(/_{2,}/g, ' ').replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) || [];

/**
 * What happened to this patient, from the record only:
 *  - a later imported study of the same patient (its own impression), or
 *  - a sentence of the report itself that says how the condition changed since an earlier film.
 * Nothing else counts: the MIMIC reports carry no treatment or confirmation, and the ward charts in this
 * database are demonstration data, so they are not used. Returns '' when the record has neither.
 * @param {object} sourceReport
 * @param {object|null} later  a later study of the same patient, with its own sourceReport
 */
function outcomeOf(sourceReport, later = null) {
  if (later?.sourceReport?.text) {
    const s = mimic.reportSections(later.sourceReport.text);
    const impression = squash(String(s.IMPRESSION || s.FINDINGS || '').replace(/_{2,}/g, ' '), 400);
    const first = (impression.match(/^.*?[.!?](?=\s|$)/) || [impression])[0].trim();
    if (first) return `Later study: ${first.length > 180 ? `${first.slice(0, 177).replace(/\s+\S*$/, '')}…` : first}`;
  }
  const s = mimic.reportSections(sourceReport?.text || '');
  for (const name of ['IMPRESSION', 'FINDINGS']) {
    const hit = sentencesOf(s[name]).map((x) => x.trim()).find((x) => CHANGE.test(x) && PRIOR.test(x) && x.length >= 15);
    if (hit) return `Course on the report: ${hit.length > 180 ? `${hit.slice(0, 177).replace(/\s+\S*$/, '')}…` : hit}`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Guideline checklists
// ---------------------------------------------------------------------------

const CHECKLIST = [['lookFor', 'LOOK FOR'], ['ruleOut', 'RULE OUT'], ['next', 'NEXT']];
const BULLET_MAX = 220;

const cleanBullet = (t) => {
  const text = squash(String(t ?? '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\(?\bhttps?:\/\/\S+/g, '')
    .replace(/\*+/g, '')
    .replace(/\s*[([]+\s*$/, ''), 2000);
  if (text.length <= BULLET_MAX) return text;
  // Cut at the end of the last whole word that fits, so a line never stops in the middle of a word.
  return `${text.slice(0, BULLET_MAX - 1).replace(/\s+\S*$/, '').replace(/[,;:\s]+$/, '')}…`;
};

const hasBullets = (b) => CHECKLIST.some(([key]) => b?.[key]);

const CHECKLIST_PROMPT = `You read short source texts about a chest X-ray diagnosis and copy out a checklist for a radiologist. Use only the words in each source. Do not use outside knowledge.
For each source return up to three lines, each copied exactly from that source (a clause or one sentence, not rephrased):
- "lookFor": what to look for on the X-ray for this diagnosis (an imaging finding, something that can be seen on a chest X-ray or scan)
- "ruleOut": which other diagnoses to rule out
- "next": what to do next, or what follow-up is suggested
Leave a line as "" if the source does not say it. A definition or general description of the disease is not a line: if the source only defines or describes the disease, return all three empty.
Return JSON only: {"items":[{"id":"","lookFor":"","ruleOut":"","next":""}]}`;

/**
 * The checklist lines each source really gives. Every line must be words copied from that source's text;
 * a line that is not found there is dropped. A source left with no line is not returned.
 * @param {Array<{ id: string, title: string, text: string }>} sources
 * @returns {Promise<Map<string, {lookFor: string, ruleOut: string, next: string}>>}
 */
async function extractChecklists(sources, { diagnosis, context }, { chat = azureFindings.chatJson } = {}) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const reply = await chat(
    CHECKLIST_PROMPT,
    JSON.stringify({ diagnosis, patient: context || '', sources: sources.map((s) => ({ id: s.id, title: s.title, text: squash(s.text, 3000) })) }),
    1200,
    0
  );
  const out = new Map();
  for (const item of Array.isArray(reply?.items) ? reply.items : []) {
    const src = byId.get(String(item?.id || ''));
    if (!src || out.has(src.id)) continue;
    const bullets = {};
    for (const [key] of CHECKLIST) {
      const line = cleanBullet(item[key]);
      bullets[key] = line && contains(src.text, line) ? line : '';
    }
    if (hasBullets(bullets)) out.set(src.id, bullets);
  }
  return out;
}

// The web search answers in blocks: up to three labelled lines ("LOOK FOR: ...") for one page, then a line
// that cites the page. A citation belongs to the labelled lines written since the last citation, and a line
// with no citation after it is dropped. Only a page on an allowed site is kept.
function parseWebChecklist(text, annotations, allowedHost) {
  const lines = [];
  let offset = 0;
  for (const raw of String(text || '').split('\n')) {
    lines.push({ raw, start: offset, end: offset + raw.length, url: '', host: '', title: '', cited: false });
    offset += raw.length + 1;
  }
  for (const a of annotations || []) {
    if (a?.type !== 'url_citation' || !a.url) continue;
    let host = '';
    try { host = new URL(a.url).hostname.toLowerCase(); } catch { continue; }
    const line = lines.find((l) => (a.start_index ?? 0) >= l.start && (a.start_index ?? 0) <= l.end);
    if (!line) continue;
    line.cited = true; // a citation of any site ends a block; only an allowed site gives it a page
    if (allowedHost(host) && !line.url) Object.assign(line, { url: a.url.split('?')[0], host, title: squash(a.title, 200) });
  }

  const pages = new Map();
  let pending = [];
  for (const line of lines) {
    const m = line.raw.match(/^\s*(?:[-*\u2022]\s*|\d+\.\s*)?\**\s*(LOOK FOR|RULE OUT|NEXT)\s*\**\s*:\s*(.*)$/i);
    if (m) {
      const key = CHECKLIST.find(([, label]) => label === m[1].toUpperCase())?.[0];
      const bullet = cleanBullet(m[2]);
      if (key && bullet.length >= 8) pending.push([key, bullet]);
    }
    if (!line.url) {
      if (line.cited) pending = []; // lines that cite a page on another site are dropped
      continue;
    }
    const page = pages.get(line.url) || { url: line.url, host: line.host, title: line.title, bullets: { lookFor: '', ruleOut: '', next: '' } };
    for (const [key, bullet] of pending) if (!page.bullets[key]) page.bullets[key] = bullet;
    pending = [];
    pages.set(line.url, page);
  }
  return [...pages.values()].filter((p) => hasBullets(p.bullets));
}

module.exports = {
  patientContext,
  contextText,
  explainCandidates,
  outcomeOf,
  extractChecklists,
  parseWebChecklist,
  reportForReading,
  hasBullets,
  tierOf,
  contains,
  norm,
  CHECKLIST,
};
