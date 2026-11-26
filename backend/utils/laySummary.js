// utils/laySummary.js
//
// A plain-language summary of an ENDORSED report, in English and in formal written Traditional Chinese.
//
//   - It is made only after endorsement. A draft report never gets one (queueLaySummary refuses it).
//   - The model reads ONE thing: the endorsed report text. Not the X-ray, not the Second Reader, not the
//     agent's evidence, not the chart.
//   - Four parts per language: what we found, what it means, what happens next, when to seek help sooner.
//   - The model's answer is checked in code and thrown away if it breaks a rule (too long, a part missing,
//     spoken Cantonese or simplified characters in the Chinese, a number that is not in the report). It
//     gets one second try with the problems listed; if that fails too, nothing is saved.
//   - The fixed disclaimer is added by this code, never by the model.
//
// Length rule (agreed): English under 120 words; Chinese under 250 characters. The fixed disclaimer is
// not counted in either.
//
// Same Azure OpenAI setup as the Second Reader (AZURE_OPENAI_* in backend/.env, deployment gpt-4.1-mini).

const crypto = require('crypto');
const Case = require('../models/Case');
const azureFindings = require('./azureFindings');
const addAuditLog = require('./auditLogger');

const MAX_ENGLISH_WORDS = 119; // under 120
const MAX_CHINESE_CHARS = 249; // under 250
const MIN_CHINESE_CHARS = 40;
const STALE_MS = 3 * 60 * 1000;

const DISCLAIMER = {
  english: 'This is an explanation aid, not a diagnosis. If you are worried, speak to your doctor.',
  traditionalChinese: '本摘要僅供參考，並非診斷。如有擔心，請諮詢醫生。',
};
const PARTS = ['found', 'meaning', 'next', 'help'];

const PROMPT = `You write a short plain-language summary of a chest X-ray report for the patient, in two languages. The text you are given is the radiologist's endorsed report. It is your only source.

Return JSON only, in exactly this shape:
{"english":{"found":"","meaning":"","next":"","help":""},"traditionalChinese":{"found":"","meaning":"","next":"","help":""}}

The four parts, in both languages:
- found: what the X-ray showed, using only what the report says.
- meaning: what that means in plain words.
- next: what happens next. Use what the report advises. If it advises nothing, say the doctor will go through the report and decide if any more tests or treatment are needed.
- help: when to seek help sooner. Give general warning signs only (for example difficulty breathing, chest pain, a high fever, coughing up blood, feeling much worse) and say to see a doctor or go to the emergency department. Do not name a disease that the report does not name.

Rules for both languages:
- Use only the report. Never invent a finding, a measurement, a number, a diagnosis or a treatment. Do not add a diagnosis the report does not state. If the report says the X-ray is normal, say so.
- Do not copy medical jargon. If a medical word is needed, explain it in the same sentence.
- The English and the Chinese must say the same thing.
- Do not write the disclaimer. It is added for you.

English: simple words a person with no medical training understands. At most 100 words in total over the four parts.

Traditional Chinese: formal written Traditional Chinese (書面語), as used in Hong Kong government, legal and hospital documents. Use traditional characters only, never simplified. Never use spoken Cantonese (口語): do not write 唔係, 咗, 嘅, 咁, 嘢, 哋, 啲, 喺, 冇, 佢, 睇. Write 不是, 了, 的, 這樣, 沒有, 他/她, 在, 看 instead. At most 200 characters in total over the four parts.`;

// ---------------------------------------------------------------------------
// Checks on what the model returns
// ---------------------------------------------------------------------------

const wordsOf = (text) => String(text || '').trim().split(/\s+/).filter(Boolean);
const charsOf = (text) => String(text || '').replace(/\s+/g, '').length;
const joinParts = (obj) => PARTS.map((k) => obj[k]).join(' ');

// Words that belong to spoken Cantonese and not to written Chinese. 係 is spoken unless it is part of 關係 / 聯係.
const SPOKEN = /[唔咗嘅咁嘢哋啲喺嚟咩啫睇乜俾畀嗰噉冇佢哩囉㗎嘥]|(?<![關聯])係|點解|邊度|而家|呢個|呢啲|嗰個/u;
// Characters that exist only in simplified Chinese.
const SIMPLIFIED = /[这们为说没发医结诊现还对时会样来过问题应该关见观记报热气脏阴显处让请详细体检术须检气种个后东车长门问开间]/u;

function problemsWith(value, reportText) {
  const problems = [];
  const en = value?.english;
  const zh = value?.traditionalChinese;
  const missing = (obj, label) => PARTS.filter((k) => typeof obj?.[k] !== 'string' || !obj[k].trim()).map((k) => `${label}.${k} is missing`);
  problems.push(...missing(en, 'english'), ...missing(zh, 'traditionalChinese'));
  if (problems.length) return problems;

  const enText = joinParts(en);
  const zhText = joinParts(zh);
  if (wordsOf(enText).length > MAX_ENGLISH_WORDS) problems.push(`the English is ${wordsOf(enText).length} words; it must be under 120 (aim for 100)`);
  if (charsOf(zhText) > MAX_CHINESE_CHARS) problems.push(`the Chinese is ${charsOf(zhText)} characters; it must be under 250 (aim for 200)`);
  if (charsOf(zhText) < MIN_CHINESE_CHARS) problems.push('the Chinese is too short to be the four parts');
  if (/[\u4e00-\u9fff]/.test(enText)) problems.push('the English contains Chinese characters');
  if (SPOKEN.test(zhText)) problems.push(`the Chinese uses spoken Cantonese (${(zhText.match(SPOKEN) || [])[0]}); use formal written Chinese (書面語)`);
  if (SIMPLIFIED.test(zhText)) problems.push(`the Chinese uses a simplified character (${(zhText.match(SIMPLIFIED) || [])[0]}); use traditional characters`);
  // A number the report does not contain would be an invented measurement.
  const inReport = new Set((String(reportText).match(/\d+(?:\.\d+)?/g) || []));
  for (const n of new Set((`${enText} ${zhText}`).match(/\d+(?:\.\d+)?/g) || [])) {
    if (!inReport.has(n)) problems.push(`the number ${n} is not in the report`);
  }
  return problems;
}

function clean(obj) {
  const out = {};
  for (const k of PARTS) out[k] = String(obj[k]).replace(/\s+/g, ' ').trim();
  return out;
}

/**
 * Write the two summaries for one endorsed report.
 * @param {{ reportText: string }} input  the endorsed report text, and nothing else
 * @returns {Promise<{ english: object, traditionalChinese: object }>}
 */
async function generateLaySummary({ reportText } = {}, { chat = azureFindings.chatJson } = {}) {
  const text = azureFindings.clinicalReportText(reportText || '');
  if (!text) throw new Error('There is no report text to summarise.');

  let problems = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = `Endorsed report:\n${text}${problems.length ? `\n\nYour last answer broke these rules. Fix them:\n- ${problems.join('\n- ')}` : ''}`;
    const reply = await chat(PROMPT, user, 1200, 0.2);
    problems = problemsWith(reply, text);
    if (!problems.length) {
      return {
        english: { ...clean(reply.english), disclaimer: DISCLAIMER.english },
        traditionalChinese: { ...clean(reply.traditionalChinese), disclaimer: DISCLAIMER.traditionalChinese },
      };
    }
  }
  throw new Error(`The summary broke the rules and was not saved: ${problems.join('; ')}`);
}

// ---------------------------------------------------------------------------
// Running it for a case
// ---------------------------------------------------------------------------

const hashOf = (text) => crypto.createHash('sha1').update(text).digest('hex');
const endorsedText = (c) => azureFindings.clinicalReportText(c?.reportText || '');

async function runLaySummary(caseId, reportText, hash, userId, deps) {
  try {
    const summary = await generateLaySummary({ reportText }, deps);
    await Case.updateOne(
      { caseId, status: 'finalized' },
      { $set: { laySummary: summary, laySummaryState: 'done', laySummaryError: '', laySummaryAt: new Date(), laySummaryFor: hash } }
    );
    await addAuditLog(userId, 'LAY_SUMMARY', `Lay summary written for ${caseId}`, caseId, null, 'done');
    return 'done';
  } catch (err) {
    await Case.updateOne(
      { caseId, status: 'finalized' },
      { $set: { laySummaryState: 'failed', laySummaryError: String(err.message || 'failed').slice(0, 400), laySummaryAt: new Date() } }
    ).catch(() => {});
    await addAuditLog(userId, 'LAY_SUMMARY', `Lay summary failed for ${caseId}: ${err.message}`, caseId, null, 'failed');
    return 'failed';
  }
}

/**
 * Start the lay summary for an endorsed case. A draft case never gets one: it returns '' and does nothing.
 * A case that already has a finished summary for this same report is left alone unless `force`.
 * @param {object} c  Case document or plain object (caseId, status, reportText, laySummaryState, laySummaryFor)
 * @param {{ userId?: string, force?: boolean, wait?: boolean }} [opts]
 *   wait: resolve when the summary is written (the retry button); otherwise it runs in the background.
 * @returns {Promise<string>} the state the case is now in
 */
async function queueLaySummary(c, { userId, force = false, wait = false } = {}, deps = {}) {
  if (!c?.caseId || c.status !== 'finalized') return '';
  const text = endorsedText(c);
  if (!text) return c.laySummaryState || '';
  const hash = hashOf(text);
  if (!force && c.laySummaryState === 'done' && c.laySummaryFor === hash) return 'done';

  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_MS);
  if (!azureFindings.isConfigured() && !deps.chat) {
    await Case.updateOne(
      { caseId: c.caseId, status: 'finalized', laySummaryState: { $in: ['', null, 'unavailable'] } },
      { $set: { laySummaryState: 'unavailable' } }
    );
    return 'unavailable';
  }

  // Claimed in the database first, so two requests at once write it once.
  const claimable = [
    { laySummaryState: { $ne: 'running' } },
    { laySummaryState: 'running', laySummaryAt: { $lt: staleBefore } },
  ];
  const claim = await Case.updateOne(
    { caseId: c.caseId, status: 'finalized', $or: claimable },
    { $set: { laySummaryState: 'running', laySummaryAt: now, laySummaryError: '' } }
  );
  if (!claim.modifiedCount) return 'running';

  const job = runLaySummary(c.caseId, c.reportText, hash, userId, deps);
  if (wait) return job;
  job.catch((err) => console.error('[laySummary] could not save:', err.message));
  return 'running';
}

module.exports = {
  generateLaySummary,
  queueLaySummary,
  problemsWith,
  DISCLAIMER,
  PARTS,
  MAX_ENGLISH_WORDS,
  MAX_CHINESE_CHARS,
};
