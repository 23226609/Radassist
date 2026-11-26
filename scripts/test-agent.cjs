// scripts/test-agent.cjs
//
// The reasoning agent: POST /api/cases/:id/agent, the three tools and the rules
// that limit them (at most one search of each kind per case, notify once and only
// after the report is endorsed, every call in the audit log, nothing invented,
// the CURV report never edited).
//
// Real routes, real LangGraph loop and a throwaway in-memory MongoDB. Azure,
// NCBI and the email service are faked here, so nothing leaves this machine and
// no email is sent. It never reads backend/.env.
//
//   node scripts/test-agent.cjs

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { startTestDb } = require('./lib/test-db.cjs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(24).toString('hex');
for (const key of Object.keys(process.env)) {
  if (/^(AZURE_OPENAI|ACS_|NCBI_|AGENT_)/.test(key)) delete process.env[key];
}

const BACKEND = path.join(__dirname, '..', 'backend');
const backend = (p) => require(path.join(BACKEND, p));
const express = backend('node_modules/express');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${name}\n      ${err.message}`);
    failed++;
  }
}

function buildApp() {
  const app = express();
  app.set('etag', false);
  app.use(backend('config/cors').corsMiddleware());
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/auth', backend('routes/auth'));
  app.use('/api/cases', backend('routes/cases'));
  app.use('*', (req, res, next) => next(backend('utils/ApiError').notFound(`Route ${req.originalUrl} not found`)));
  app.use(backend('middleware/errorHandler'));
  return app;
}

// ---------------------------------------------------------------- fakes

const calls = { chat: [], helper: [], embeddings: [], esearch: [], efetch: [], web: [] };
const resetCalls = () => { for (const k of Object.keys(calls)) calls[k].length = 0; };

// What the model says, one reply per reasoning step. When the list runs out it gives a plain answer.
let script = [];
const FINAL = { summary: 'Nothing more to add.', suggestions: [] };

// Texts become vectors by counting a few words, so "similar" is exact and predictable.
const WORDS = [/pneumonia|consolidation/i, /effusion/i, /pneumothorax/i, /normal|clear/i, /lobe/i, /left/i];
const vectorOf = (text) => [...WORDS.map((re) => (String(text).match(new RegExp(re.source, 'gi')) || []).length), 0.05];
let embeddingsFail = false;

let esearchIds = ['111'];
let webReply = null; // a function (n) => response body, set per test

// A StatPearls abstract that only defines the disease, and one that says what to look for, rule out and do next.
const DEFINITION_ONLY = 'Pneumonia is an infection of the lung parenchyma. It is a common cause of illness worldwide. It is caused by bacteria, viruses and fungi.';
const CHECKLIST_ABSTRACT = 'Pneumonia is an infection of the lung. Consolidation with air bronchograms is seen on a chest X-ray. The differential diagnosis includes pulmonary oedema and lung cancer. A follow up chest film is advised six weeks after treatment.';
let abstract = CHECKLIST_ABSTRACT;
const titleOf = (id) => (id === '999' ? 'Eosinophilic Pneumonia' : `Pneumonia ${id}`);
const efetchXml = (ids) => `<?xml version="1.0" ?><PubmedArticleSet>${ids.map((id) => `<PubmedBookArticle><BookDocument><PMID Version="1">${id}</PMID><ArticleTitle book="statpearls">${titleOf(id)}</ArticleTitle><Abstract><AbstractText>${abstract}</AbstractText></Abstract></BookDocument></PubmedBookArticle>`).join('')}</PubmedArticleSet>`;

const NICE_URL = 'https://www.nice.org.uk/guidance/qs110/chapter/Quality-statement-2';
function niceBody() {
  // First a block that cites another site (dropped), then the NICE block: three lines, then its citation.
  const off = '[Other](https://example.com/page)';
  const link = '[NICE quality statement](' + NICE_URL + ')';
  const text = `LOOK FOR: Something an off-site page said about the film. ${off}\n`
    + 'LOOK FOR: Air bronchograms and lobar consolidation on the chest X-ray.\n'
    + 'RULE OUT: Pulmonary oedema and pulmonary embolism with infarction.\n'
    + 'NEXT: Repeat the chest X-ray after treatment to confirm resolution.\n'
    + `SOURCE: ${link}`;
  const at = (needle) => text.indexOf(needle);
  return {
    output: [{ type: 'message', content: [{ type: 'output_text', text, annotations: [
      { type: 'url_citation', start_index: at(off), end_index: at(off) + off.length, title: 'Other', url: 'https://example.com/page' },
      { type: 'url_citation', start_index: at(link), end_index: at(link) + link.length, title: 'NICE quality statement 2', url: `${NICE_URL}?x=1` },
    ] }] }],
  };
}

// The model for the three checking steps (which patient facts, which cases, which lines). It also offers
// things that are NOT in the texts, so each test can see that they are thrown away.
const CTX_DEFAULT = 'cough, fever';
let explainOverride = null; // (cases) => rows, to force a diagnosis match in a test
const helperReply = (system, user) => {
  if (system.includes('pick out what matters')) {
    const history = (user.match(/History:\n([\s\S]*?)\n\nLab results:/) || [])[1] || '';
    const labs = (user.match(/Lab results:\n([\s\S]*)$/) || [])[1] || '';
    return {
      symptoms: [...['cough', 'fever', 'dyspnoea'].filter((w) => history.toLowerCase().includes(w)), 'chest pain', 'night sweats'],
      abnormalLabs: [...[...labs.matchAll(/([A-Za-z]+): [\d.]+ [^;\n]*\(HIGH\)/g)].map((m) => ({ name: m[1], direction: 'high' })), { name: 'Troponin', direction: 'high' }],
    };
  }
  if (system.includes('compare a new chest X-ray case')) {
    const { newCase, earlierCases } = JSON.parse(user);
    if (explainOverride) return { cases: explainOverride(earlierCases) };
    const dx = newCase.diagnosis.toLowerCase();
    return { cases: earlierCases.map((c) => {
      const rep = c.report.toLowerCase();
      const word = ['pneumonia', 'effusion', 'pneumothorax'].find((w) => dx.includes(w));
      const same = word && rep.includes(word);
      return {
        caseId: c.caseId,
        diagnosisMatch: same ? 'same' : 'different',
        caseDiagnosis: same ? word : 'normal',
        shared: [...['lobe', 'pneumonia', 'effusion'].filter((w) => newCase.text.toLowerCase().includes(w) && rep.includes(w)).map((w) => ({ feature: w, newCaseQuote: w, caseQuote: w })),
          { feature: 'cavitation', newCaseQuote: 'cavitation', caseQuote: 'cavitation' }],
      };
    }) };
  }
  if (system.includes('read short source texts')) {
    const { sources } = JSON.parse(user);
    const sentence = (text, re) => (text.match(/[^.]+\./g) || []).map((x) => x.trim()).find((x) => re.test(x)) || '';
    return { items: sources.map((s, i) => ({
      id: s.id,
      lookFor: sentence(s.text, /chest X-ray/i) || (i === 0 ? 'A sentence the source never wrote' : ''),
      ruleOut: sentence(s.text, /differential/i),
      next: sentence(s.text, /follow up/i),
    })) };
  }
  return null;
};

const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('openai.azure.com')) {
    const body = JSON.parse(init.body);
    if (u.includes('/embeddings')) {
      calls.embeddings.push({ url: u, input: body.input });
      if (embeddingsFail) return json({ error: { message: 'embedding service down' } }, 500);
      return json({ data: body.input.map((t, i) => ({ index: i, embedding: vectorOf(t) })).reverse() });
    }
    if (u.includes('/openai/v1/responses')) {
      calls.web.push(body);
      return json(webReply ? webReply(calls.web.length) : niceBody());
    }
    const helper = helperReply(body.messages[0].content, body.messages[1].content);
    if (helper) { calls.helper.push(body); return json({ choices: [{ message: { content: JSON.stringify(helper) } }] }); }
    calls.chat.push(body);
    const reply = script.length ? script.shift() : FINAL;
    return json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
  }
  if (u.includes('eutils.ncbi.nlm.nih.gov')) {
    if (u.includes('esearch')) { calls.esearch.push(u); return json({ esearchresult: { idlist: esearchIds } }); }
    calls.efetch.push(u);
    return new Response(efetchXml(esearchIds), { status: 200 });
  }
  return realFetch(url, init);
};

const emails = [];
let emailFails = false;
backend('utils/agentTools')._setEmailClientFactory(() => ({
  beginSend: async (message) => {
    if (emailFails) throw new Error('ACS refused the message');
    emails.push(message);
    return { pollUntilDone: async () => ({ id: 'acs-1', status: 'Succeeded' }) };
  },
}));

const settings = {
  azure: (on) => {
    for (const key of ['ENDPOINT', 'KEY', 'DEPLOYMENT']) {
      if (on) process.env[`AZURE_OPENAI_${key}`] = key === 'ENDPOINT' ? 'https://fake.openai.azure.com' : 'test';
      else delete process.env[`AZURE_OPENAI_${key}`];
    }
  },
  embeddings: (on) => { if (on) process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT = 'emb'; else delete process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT; },
  email: (on) => {
    if (on) process.env.ACS_CONNECTION_STRING = 'endpoint=https://fake/;accesskey=x';
    else delete process.env.ACS_CONNECTION_STRING;
  },
};

// ---------------------------------------------------------------- run

(async () => {
  const db = await startTestDb();
  const User = backend('models/User');
  const Case = backend('models/Case');
  const CaseEmbedding = backend('models/CaseEmbedding');
  const AuditLog = backend('models/AuditLog');
  const { toPublicCase } = backend('utils/caseStatus');
  const agentTools = backend('utils/agentTools');
  await db.ensureIndexes();

  const server = http.createServer(buildApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(method, url, { token, body } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let out = null;
    try { out = await res.json(); } catch { /* an empty body */ }
    return { status: res.status, body: out };
  }

  const accounts = {};
  const tokens = {};
  for (const role of ['admin', 'radiologist', 'technician', 'doctor']) {
    const password = crypto.randomBytes(9).toString('base64url');
    await User.create({ userId: `${role.toUpperCase()}-API`, username: `api-${role}`, email: `api-${role}@radassist.test`, name: `Test ${role}`, role, password });
    accounts[role] = password;
    const res = await api('POST', '/api/auth/login', { body: { username: `api-${role}`, password } });
    assert.strictEqual(res.status, 200, `could not log in as ${role}`);
    tokens[role] = res.body.token;
  }

  const runAs = (id, role = 'radiologist', body) => api('POST', `/api/cases/${id}/agent`, { token: tokens[role], body });
const NOTIFY = { notify: true }; // only a run that asks for it is offered notify; the review panel never does
  const stored = (id) => Case.findOne({ caseId: id }).lean();
  const auditRows = (id) => AuditLog.find({ action: 'AGENT_TOOL_CALL', affectedCaseId: id }).sort({ timestamp: 1 }).lean();
  const ask = (...tools) => ({ calls: tools.map((t) => (typeof t === 'string' ? { tool: t, input: t === 'search_guideline' ? { query: 'pneumonia' } : {} } : t)) });

  // The imported cases the search compares with.
  const mimicReports = {
    A: 'FINDINGS: Right lower lobe pneumonia with consolidation and more pneumonia.\nIMPRESSION: Pneumonia.',
    B: 'FINDINGS: Consolidation in the left base.\nIMPRESSION: Pneumonia, consolidation.',
    C: 'FINDINGS: Small right pleural effusion.\nIMPRESSION: Effusion.',
    D: 'FINDINGS: Lungs are clear. Normal heart size.\nIMPRESSION: Normal.',
    E: 'FINDINGS: Pneumonia, consolidation, pneumonia.\nIMPRESSION: Pneumonia.',
  };
  for (const [k, text] of Object.entries(mimicReports)) {
    await Case.create({ caseId: `CASE-MIMIC-${k}`, patientId: `PT-MIMIC-${k}`, status: 'finalized', reportText: 'FINDINGS\nx', sourceReport: { label: 'MIMIC', source: 'MIMIC-CXR', text } });
  }

  const DRAFT = 'FINDINGS\nRight lower zone consolidation suggesting pneumonia.\n\nCOMMENT\n– Clinical correlation advised.';
  const mkCase = (caseId, extra = {}) => Case.create({
    caseId, patientId: 'PT-API-A', status: 'pending_approve', analysisState: 'done', history: 'Cough and fever', requestedBy: 'DOCTOR-API',
    reportText: DRAFT,
    findingTags: [{ key: 't1', text: 'Right lower zone consolidation suggesting pneumonia.', abnormal: true }],
    findings: [{ label: 'Consolidation', bbox: [11.5, 52.25, 31.75, 22.5], tagKey: 't1', status: 'pending', source: 'Azure' }],
    fusionResult: { summary: 'Looks like infection.', diagnosis: 'Right lower lobe pneumonia', differentials: [], suggested_next_step: 'Compare.' },
    ...extra,
  });
  const beforeReset = () => { script = []; resetCalls(); emails.length = 0; embeddingsFail = false; emailFails = false; esearchIds = ['111']; webReply = null; abstract = CHECKLIST_ABSTRACT; explainOverride = null; };

  console.log('\n=== who may run it, and what it needs ===');
  settings.azure(true); settings.embeddings(true); settings.email(true);
  await agentTools.syncNotifyReady(); // the server does this at start; only later endorsements are emailed
  await mkCase('CASE-AG-1');

  await test('technician and doctor get 403, anonymous 401, and nothing is called or saved', async () => {
    beforeReset();
    for (const role of ['technician', 'doctor']) assert.strictEqual((await runAs('CASE-AG-1', role)).status, 403, role);
    assert.strictEqual((await api('POST', '/api/cases/CASE-AG-1/agent')).status, 401);
    assert.strictEqual(calls.chat.length, 0);
    assert.strictEqual((await stored('CASE-AG-1')).agentResult, null);
    assert.strictEqual(await AuditLog.countDocuments({ action: 'AGENT_TOOL_CALL' }), 0);
  });

  await test('without Azure it is a 400; an unknown case is 404; no saved draft is 400', async () => {
    beforeReset();
    settings.azure(false);
    assert.match((await runAs('CASE-AG-1')).body.error, /not configured/i);
    settings.azure(true);
    assert.strictEqual((await runAs('CASE-AG-NONE')).status, 404);
    await mkCase('CASE-AG-EMPTY', { reportText: '', findingTags: [] });
    assert.match((await runAs('CASE-AG-EMPTY')).body.error, /no saved draft/i);
    assert.strictEqual(calls.chat.length, 0);
  });

  console.log('\n=== a draft report: the searches run, notify is refused, the report is untouched ===');
  const fullBefore = JSON.stringify(await stored('CASE-AG-1'));
  let draftRun;
  await test('both searches run once, notify is refused, and the answer comes back with the tool results', async () => {
    beforeReset();
    script = [
      ask('search_similar_cases', 'search_guideline', 'notify'),
      { summary: 'Two similar cases and a NICE page back the draft.', suggestions: [
        { text: 'Compare with CASE-MIMIC-A, which reads the same.', sources: ['CASE-MIMIC-A', 'CASE-INVENTED-9'] },
        { text: 'NICE advises a chest X-ray to confirm.', sources: ['https://www.nice.org.uk/guidance/qs110/chapter/Quality-statement-2', 'https://made-up.example/guideline'] },
        { text: '' },
      ], report: 'REWRITTEN REPORT', reportText: 'must not be saved' },
    ];
    const res = await runAs('CASE-AG-1');
    draftRun = res;
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.chat.length, 2, 'reason, tools, reason, finish is two model steps');
    const ran = res.body.toolCalls.map((c) => [c.tool, c.refused ? 'refused' : 'ran']);
    assert.deepStrictEqual(ran, [['search_similar_cases', 'ran'], ['search_guideline', 'ran'], ['notify', 'refused']]);
    assert.match(res.body.toolCalls[2].refused, /after the report is endorsed/);
    assert.strictEqual(emails.length, 0);
    const a = res.body.agent;
    assert.deepStrictEqual(Object.keys(a.tools).sort(), ['search_guideline', 'search_similar_cases']);
    assert.strictEqual(a.suggestions.length, 2, 'the empty suggestion is dropped');
    assert.deepStrictEqual(a.suggestions[0].sources, ['CASE-MIMIC-A'], 'a case no tool returned is not kept as a source');
    assert.deepStrictEqual(a.suggestions[1].sources, ['https://www.nice.org.uk/guidance/qs110/chapter/Quality-statement-2'], 'a page no tool returned is not kept');
    assert.strictEqual(a.report, undefined);
    assert.ok(!('reportText' in a));
  });

  await test('the model is told its role and every rule, and that the report is a draft', async () => {
    const system = calls.chat[0].messages[0].content;
    for (const piece of [/never finalise a report/i, /never edit the CURV report/i, /only a radiologist can endorse/i, /exactly three tools/i,
      /search_similar_cases/, /search_guideline/, /notify/, /at most once/i, /Never invent a guideline/i]) {
      assert.match(system, piece);
    }
    assert.match(calls.chat[0].messages[1].content, /NOT endorsed/);
    assert.match(calls.chat[0].messages[1].content, /Second Reader/);
  });

  await test('the CURV report, the findings and the boxes are exactly as they were (only agentResult is added)', async () => {
    const after = await stored('CASE-AG-1');
    const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); delete c.agentResult; delete c.updatedAt; return JSON.stringify(c); };
    assert.strictEqual(strip(after), strip(JSON.parse(fullBefore)));
    assert.strictEqual(after.reportText, DRAFT);
    assert.strictEqual(after.findingTags.length, 1);
    assert.deepStrictEqual(after.findings[0].bbox, [11.5, 52.25, 31.75, 22.5]);
    assert.strictEqual(after.status, 'pending_approve');
    assert.ok(after.agentResult.tools.search_similar_cases.output);
    assert.ok(after.agentResult.summary);
  });

  await test('similar cases: the top matches by meaning, with their official reports, and not the case itself', async () => {
    const out = draftRun.body.agent.tools.search_similar_cases.output;
    assert.strictEqual(out.results.length, 3);
    assert.strictEqual(out.results[0].caseId, 'CASE-MIMIC-A', 'the right lower lobe pneumonia is the closest');
    assert.deepStrictEqual(out.results.map((r) => r.caseId).sort(), ['CASE-MIMIC-A', 'CASE-MIMIC-B', 'CASE-MIMIC-E']);
    assert.ok(out.results[0].similarity >= out.results[1].similarity && out.results[1].similarity >= out.results[2].similarity);
    assert.strictEqual(out.results[0].officialReport, mimicReports.A);
    assert.strictEqual(out.compared, 5);
    assert.ok(!JSON.stringify(out).includes('CASE-AG-1'));
    assert.ok(out.results.every((r) => !/effusion|normal/i.test(r.officialReport)), 'dissimilar cases are left out');
  });

  await test('guideline: at most 2 sources, each with its link and checklist lines the source itself gave, and an off-site page is dropped', async () => {
    const out = draftRun.body.agent.tools.search_guideline.output;
    assert.strictEqual(out.results.length, 2);
    assert.deepStrictEqual(out.results.map((r) => r.source).sort(), ['NICE', 'StatPearls']);
    const nice = out.results.find((r) => r.source === 'NICE');
    const sp = out.results.find((r) => r.source === 'StatPearls');
    assert.strictEqual(nice.url, NICE_URL);
    assert.deepStrictEqual(nice.bullets, {
      lookFor: 'Air bronchograms and lobar consolidation on the chest X-ray.',
      ruleOut: 'Pulmonary oedema and pulmonary embolism with infarction.',
      next: 'Repeat the chest X-ray after treatment to confirm resolution.',
    });
    assert.deepStrictEqual(sp.bullets, {
      lookFor: 'Consolidation with air bronchograms is seen on a chest X-ray.',
      ruleOut: 'The differential diagnosis includes pulmonary oedema and lung cancer.',
      next: 'A follow up chest film is advised six weeks after treatment.',
    });
    assert.match(sp.url, /^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/$/);
    assert.ok(out.results.every((r) => !('passage' in r)), 'no passage text, only the checklist');
    assert.ok(!JSON.stringify(out).includes('example.com') && !/off-site/i.test(JSON.stringify(out)));
    assert.ok(!/infection of the lung\.\s/.test(JSON.stringify(out)), 'the definition sentence is not used');
  });

  await test('every call is in the audit log with its input and its output, and the refused one says why', async () => {
    const rows = await auditRows('CASE-AG-1');
    assert.deepStrictEqual(rows.map((r) => r.details.split(' ')[2] + ' ' + r.details.split(' ')[3]), ['search_similar_cases ran', 'search_guideline ran', 'notify refused']);
    assert.ok(rows.every((r) => r.userId === 'RADIOLOGIST-API'));
    const sim = rows[0];
    assert.deepStrictEqual(JSON.parse(sim.oldValue), { v: 2, diagnosis: 'Right lower lobe pneumonia', context: CTX_DEFAULT });
    assert.match(sim.newValue, /CASE-MIMIC-A/);
    assert.deepStrictEqual(JSON.parse(rows[1].oldValue), { v: 2, diagnosis: 'Right lower lobe pneumonia', query: 'Right lower lobe pneumonia', context: CTX_DEFAULT });
    assert.match(rows[1].newValue, /nice\.org\.uk/);
    assert.match(rows[2].newValue, /only allowed after the report is endorsed/);
  });

  console.log('\n=== run it again: nothing is searched twice ===');
  await test('the stored results are reused, a repeat request for a search is refused, and no outside call is made', async () => {
    const embedded = calls.embeddings.length; const eutils = calls.esearch.length; const web = calls.web.length;
    script = [ask('search_similar_cases', 'search_guideline'), { summary: 'Same as before.', suggestions: [] }];
    // The model asks again, but both are used up, so it is not even offered them.
    const res = await runAs('CASE-AG-1');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.reusedTools.sort(), ['search_guideline', 'search_similar_cases']);
    assert.strictEqual(calls.embeddings.length, embedded);
    assert.strictEqual(calls.esearch.length, eutils);
    assert.strictEqual(calls.web.length, web);
    assert.strictEqual(res.body.agent.tools.search_similar_cases.at, draftRun.body.agent.tools.search_similar_cases.at);
    assert.match(calls.chat.at(-1).messages[1].content, /search_guideline: already used/);
    assert.ok(res.body.toolCalls.every((c) => c.refused || false) || res.body.toolCalls.length === 0);
  });

  await test('if the model keeps asking for used tools, the loop stops at its limit and says so', async () => {
    beforeReset();
    await mkCase('CASE-AG-LOOP');
    script = Array.from({ length: 10 }, () => ask({ tool: 'edit_report', input: {} }));
    const res = await runAs('CASE-AG-LOOP');
    assert.strictEqual(res.status, 200);
    assert.ok(calls.chat.length <= 4, `ran ${calls.chat.length} model steps`);
    assert.match(res.body.agent.summary, /stopped before it gave a final answer/);
  });

  console.log('\n=== after the report is endorsed: notify, once ===');
  await mkCase('CASE-AG-2', { status: 'finalized', finalizedBy: 'RADIOLOGIST-API', finalizedByName: 'Test radiologist', finalizedAt: new Date() });
  await test('notify sends one real email to the referring doctor, with no patient details, and a second run cannot send another', async () => {
    beforeReset();
    script = [ask('notify'), { summary: 'The referring doctor was told.', suggestions: [] }];
    const res = await runAs('CASE-AG-2', 'radiologist', NOTIFY);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(emails.length, 1);
    const mail = emails[0];
    assert.deepStrictEqual(mail.recipients.to, [{ address: 'api-doctor@radassist.test' }]);
    assert.strictEqual(mail.senderAddress, 'DoNotReply@bea841cf-6a1c-4660-8978-566871702bb6.azurecomm.net');
    assert.match(mail.content.subject, /CASE-AG-2/);
    const body = JSON.stringify(mail);
    assert.ok(!/cough|fever|pneumonia|consolidation/i.test(body), 'no clinical text in the email');
    assert.strictEqual(res.body.agent.tools.notify.output.sent, true);
    assert.strictEqual(res.body.agent.endorsedWhenRun, true);
    const rows = await auditRows('CASE-AG-2');
    assert.strictEqual(rows.length, 1);
    assert.match(rows[0].details, /notify ran/);
    assert.deepStrictEqual(Object.keys(JSON.parse(rows[0].oldValue)), ['caseId', 'endorsedAt']);
    const out = JSON.parse(rows[0].newValue);
    assert.strictEqual(out.sent, true);
    assert.strictEqual(out.to, 'api-doctor@radassist.test');
    assert.strictEqual(calls.embeddings.length, 0, 'it was not asked to search');

    script = [ask('notify'), { summary: 'Done.', suggestions: [] }];
    const again = await runAs('CASE-AG-2', 'radiologist', NOTIFY);
    assert.strictEqual(again.status, 200);
    assert.strictEqual(emails.length, 1, 'notify is once per case');
    assert.deepStrictEqual(again.body.reusedTools, ['notify']);
  });

  await test('the model cannot choose the recipient or the words: input it gives notify is ignored', async () => {
    beforeReset();
    await mkCase('CASE-AG-3', { status: 'finalized', finalizedAt: new Date() });
    script = [ask({ tool: 'notify', input: { to: 'someone-else@evil.test', subject: 'x', text: 'secret clinical text' } }), FINAL];
    await runAs('CASE-AG-3', 'radiologist', NOTIFY);
    assert.strictEqual(emails.length, 1);
    assert.deepStrictEqual(emails[0].recipients.to, [{ address: 'api-doctor@radassist.test' }]);
    assert.ok(!JSON.stringify(emails[0]).includes('secret clinical text'));
  });

  await test('no referring doctor email on file: notify is refused, not used up, and a later run can send it', async () => {
    beforeReset();
    await mkCase('CASE-AG-4', { status: 'finalized', finalizedAt: new Date(), requestedBy: '' });
    script = [ask('notify'), FINAL];
    const first = await runAs('CASE-AG-4', 'radiologist', NOTIFY);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(emails.length, 0);
    assert.match(first.body.toolCalls[0].refused, /no email address on file/);
    assert.strictEqual((await stored('CASE-AG-4')).agentResult.tools.notify, undefined);
    await Case.updateOne({ caseId: 'CASE-AG-4' }, { $set: { requestedBy: 'DOCTOR-API' } });
    script = [ask('notify'), FINAL];
    await runAs('CASE-AG-4', 'radiologist', NOTIFY);
    assert.strictEqual(emails.length, 1);
  });

  await test('when the email service refuses, the run still finishes, the failure is recorded, and the call is not retried', async () => {
    beforeReset();
    emailFails = true;
    await mkCase('CASE-AG-5', { status: 'finalized', finalizedAt: new Date() });
    script = [ask('notify'), FINAL];
    const res = await runAs('CASE-AG-5', 'radiologist', NOTIFY);
    assert.strictEqual(res.status, 200);
    assert.match(res.body.agent.tools.notify.error, /ACS refused/);
    emailFails = false;
    script = [ask('notify'), FINAL];
    await runAs('CASE-AG-5', 'radiologist', NOTIFY);
    assert.strictEqual(emails.length, 0);
    const rows = await auditRows('CASE-AG-5');
    assert.ok(rows.some((r) => /notify failed/.test(r.details) && /ACS refused/.test(r.newValue)));
  });

  await test('email not set up: notify is refused as not available, and is not used up', async () => {
    beforeReset();
    settings.email(false);
    await mkCase('CASE-AG-6', { status: 'finalized', finalizedAt: new Date() });
    script = [ask('notify'), FINAL];
    const res = await runAs('CASE-AG-6', 'radiologist', NOTIFY);
    assert.strictEqual(res.status, 200);
    assert.match(res.body.toolCalls[0].refused, /email service is not set up/);
    assert.strictEqual((await stored('CASE-AG-6')).agentResult.tools.notify, undefined);
    settings.email(true);
    script = [ask('notify'), FINAL];
    await runAs('CASE-AG-6', 'radiologist', NOTIFY);
    assert.strictEqual(emails.length, 1);
  });

  console.log('\n=== no catch-up email for an endorsement before the email service was ready ===');
  await test('email not set up at the endorsement: turning it on later sends nothing for that report, and the refusal is audited', async () => {
    beforeReset();
    settings.email(false);
    await agentTools.syncNotifyReady(); // server start with no email: any earlier ready time is forgotten
    assert.strictEqual(await backend('models/AgentSetting').countDocuments({ key: 'notifyReadyAt' }), 0);
    await mkCase('CASE-AG-OLD', { status: 'finalized', finalizedAt: new Date() }); // endorsed while email was off
    script = [ask('notify'), FINAL];
    const off = await runAs('CASE-AG-OLD', 'radiologist', NOTIFY);
    assert.match(off.body.toolCalls[0].refused, /email service is not set up/);
    await new Promise((r) => setTimeout(r, 25));
    settings.email(true);
    const readyAt = await agentTools.syncNotifyReady(); // server restarted with email set up
    assert.ok(readyAt > (await stored('CASE-AG-OLD')).finalizedAt);
    for (let i = 0; i < 2; i++) {
      script = [ask('notify'), FINAL];
      const res = await runAs('CASE-AG-OLD', 'radiologist', NOTIFY);
      assert.strictEqual(res.status, 200);
      assert.match(res.body.toolCalls[0].refused, /endorsed before the email service was ready/);
    }
    assert.strictEqual(emails.length, 0, 'no catch-up email');
    assert.strictEqual((await stored('CASE-AG-OLD')).agentResult.tools.notify, undefined);
    const rows = await auditRows('CASE-AG-OLD');
    assert.strictEqual(rows.length, 3);
    assert.ok(rows.every((r) => /notify refused/.test(r.details) && r.oldValue && JSON.parse(r.newValue).refused));
    assert.deepStrictEqual(Object.keys(JSON.parse(rows[2].oldValue)), ['caseId', 'endorsedAt']);
  });

  await test('an endorsement after the email service is ready is emailed once, even with an older one waiting', async () => {
    beforeReset();
    await new Promise((r) => setTimeout(r, 25));
    await mkCase('CASE-AG-NEW', { status: 'finalized', finalizedAt: new Date() });
    for (let i = 0; i < 3; i++) {
      script = [ask('notify'), FINAL];
      await runAs('CASE-AG-NEW', 'radiologist', NOTIFY);
    }
    await runAs('CASE-AG-OLD', 'radiologist', NOTIFY);
    assert.strictEqual(emails.length, 1);
    assert.match(emails[0].content.subject, /CASE-AG-NEW/);
  });

  await test('an endorsement with no endorsement time cannot be shown to be after email was ready, so no email', async () => {
    beforeReset();
    await mkCase('CASE-AG-NODATE', { status: 'finalized', finalizedAt: null });
    script = [ask('notify'), FINAL];
    const res = await runAs('CASE-AG-NODATE', 'radiologist', NOTIFY);
    assert.match(res.body.toolCalls[0].refused, /endorsed before the email service was ready/);
    assert.strictEqual(emails.length, 0);
  });

  await test('the notify tool refuses on its own: a draft, an older endorsement, or a second send sends nothing', async () => {
    beforeReset();
    const draft = await stored('CASE-AG-3');
    await Case.updateOne({ caseId: 'CASE-AG-3' }, { $set: { status: 'pending_approve' } });
    await assert.rejects(agentTools.notify({ caseDoc: { ...draft, status: 'pending_approve' } }), /only allowed after the report is endorsed/);
    await assert.rejects(agentTools.notify({ caseDoc: await stored('CASE-AG-OLD') }), /endorsed before the email service was ready/);
    await assert.rejects(agentTools.notify({ caseDoc: await stored('CASE-AG-2') }), /already used/);
    await assert.rejects(agentTools.notify(), /only allowed after the report is endorsed/);
    assert.strictEqual(emails.length, 0);
  });

  await test('no connection string is ever guessed: with none set, the email client is never made', async () => {
    beforeReset();
    settings.email(false);
    let made = 0;
    agentTools._setEmailClientFactory(() => { made++; return { beginSend: async () => { throw new Error('no'); } }; });
    await assert.rejects(agentTools.notify({ caseDoc: await stored('CASE-AG-NEW') }), /already used|not set up/);
    await mkCase('CASE-AG-NOCS', { status: 'finalized', finalizedAt: new Date() });
    await assert.rejects(agentTools.notify({ caseDoc: await stored('CASE-AG-NOCS') }), /email service is not set up/);
    assert.strictEqual(made, 0);
    settings.email(true);
    agentTools._setEmailClientFactory(() => ({
      beginSend: async (message) => {
        if (emailFails) throw new Error('ACS refused the message');
        emails.push(message);
        return { pollUntilDone: async () => ({ id: 'acs-1', status: 'Succeeded' }) };
      },
    }));
  });

  console.log('\n=== nothing found: it says so and invents nothing ===');
  await test('no similar case and no passage: empty lists, a note for each, and no made-up source survives', async () => {
    beforeReset();
    process.env.AGENT_SIMILARITY_MIN = '0.999';
    esearchIds = [];
    webReply = () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'NONE', annotations: [] }] }] });
    await mkCase('CASE-AG-7');
    script = [ask('search_similar_cases', ask('search_guideline').calls[0]), { summary: 'Nothing similar was found.', suggestions: [{ text: 'Follow the NICE rule on this.', sources: ['https://www.nice.org.uk/guidance/ng0'] }] }];
    const res = await runAs('CASE-AG-7');
    delete process.env.AGENT_SIMILARITY_MIN;
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const t = res.body.agent.tools;
    assert.deepStrictEqual(t.search_similar_cases.output.results, []);
    assert.deepStrictEqual(t.search_guideline.output.results, []);
    const notes = res.body.agent.notes.join(' ');
    assert.match(notes, /search_similar_cases returned nothing useful/);
    assert.match(notes, /search_guideline returned nothing useful/);
    assert.deepStrictEqual(res.body.agent.suggestions[0].sources, []);
    assert.match(calls.chat[1].messages[1].content, /returned nothing useful/);
  });

  console.log('\n=== failures do not stop the run ===');
  await test('an embeddings error is recorded as nothing useful, the guideline search still runs, and the failed search is not retried', async () => {
    beforeReset();
    embeddingsFail = true;
    await mkCase('CASE-AG-8');
    script = [ask('search_similar_cases', 'search_guideline'), FINAL];
    const res = await runAs('CASE-AG-8');
    assert.strictEqual(res.status, 200);
    assert.match(res.body.agent.tools.search_similar_cases.error, /embedding service down/);
    assert.ok(res.body.agent.tools.search_guideline.output.results.length);
    assert.match(res.body.agent.notes.join(' '), /search_similar_cases failed/);
    embeddingsFail = false;
    const before = calls.embeddings.length;
    script = [ask('search_similar_cases'), FINAL];
    await runAs('CASE-AG-8');
    assert.strictEqual(calls.embeddings.length, before);
  });

  await test('embeddings not set up: the search is refused as not available and is not used up', async () => {
    beforeReset();
    settings.embeddings(false);
    await mkCase('CASE-AG-9');
    script = [ask('search_similar_cases'), FINAL];
    const res = await runAs('CASE-AG-9');
    assert.match(res.body.toolCalls[0].refused, /embeddings are not set up/);
    assert.strictEqual((await stored('CASE-AG-9')).agentResult.tools.search_similar_cases, undefined);
    assert.strictEqual(calls.embeddings.length, 0);
    settings.embeddings(true);
  });

  await test('a tool that is not one of the three is refused and logged', async () => {
    beforeReset();
    await mkCase('CASE-AG-10');
    script = [ask({ tool: 'edit_report', input: { text: 'new report' } }, { tool: 'delete_case', input: {} }), FINAL];
    const res = await runAs('CASE-AG-10');
    assert.deepStrictEqual(res.body.toolCalls.map((c) => !!c.refused), [true, true]);
    assert.match(res.body.toolCalls[0].refused, /not one of the three tools/);
    assert.strictEqual((await stored('CASE-AG-10')).reportText, DRAFT);
    assert.strictEqual((await auditRows('CASE-AG-10')).length, 2);
  });

  await test('two requests at the same moment cannot both run the same search', async () => {
    beforeReset();
    await mkCase('CASE-AG-11');
    script = [ask('search_guideline'), FINAL, ask('search_guideline'), FINAL];
    const [a, b] = await Promise.all([runAs('CASE-AG-11'), runAs('CASE-AG-11')]);
    assert.deepStrictEqual([a.status, b.status], [200, 200]);
    assert.strictEqual(calls.esearch.length, 1);
    assert.strictEqual(calls.web.length, 1);
  });

  console.log('\n=== the searches use the Second Reader diagnosis, not CURV\'s findings ===');
  const secondReader = (diagnosis) => ({ summary: 'S', diagnosis, differentials: [], suggested_next_step: 'N' });
  const CURV_NORMAL = 'FINDINGS\nHeart size is normal. The lungs are clear.\n\nCOMMENT\n– Nothing acute.';
  const plain = (url) => decodeURIComponent(String(url).replace(/\+/g, ' '));

  await test('both searches look for the Second Reader diagnosis, even when CURV wrote "normal" and the model suggests its own query', async () => {
    beforeReset();
    await mkCase('CASE-AG-SR', { reportText: CURV_NORMAL, findingTags: [], fusionResult: secondReader('Bilateral lower lobe pneumonia') });
    script = [ask('search_similar_cases', { tool: 'search_guideline', input: { query: 'something the model made up' } }), FINAL];
    const res = await runAs('CASE-AG-SR');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(calls.embeddings[0].input[0], 'Bilateral lower lobe pneumonia');
    assert.ok(!calls.embeddings.some((c) => c.input.some((t) => /Heart size|lungs are clear/i.test(t) && !/IMPRESSION|FINDINGS:/.test(t))), 'CURV\'s text was not searched');
    assert.match(plain(calls.esearch[0]), /Bilateral lower lobe pneumonia/);
    assert.ok(!/made up/.test(plain(calls.esearch[0])) && !/made up/.test(JSON.stringify(calls.web[0])));
    assert.match(calls.web[0].input, /Bilateral lower lobe pneumonia/);
    assert.ok(!/Heart size/.test(calls.web[0].input));
    const t = res.body.agent.tools;
    assert.deepStrictEqual(t.search_similar_cases.input, { v: 2, diagnosis: 'Bilateral lower lobe pneumonia', context: CTX_DEFAULT });
    assert.deepStrictEqual(t.search_guideline.input, { v: 2, diagnosis: 'Bilateral lower lobe pneumonia', query: 'Bilateral lower lobe pneumonia', context: CTX_DEFAULT });
    const first = t.search_similar_cases.output.results[0];
    assert.ok(first.line && first.line.length < 201 && !/\n/.test(first.line), 'one line of the official report');
    assert.ok(mimicReports[first.caseId.replace('CASE-MIMIC-', '')].includes(first.line.replace(/…$/, '').replace(/^(IMPRESSION|FINDINGS): ?/, '')), 'the line is the report\'s own words');
  });

  await test('the same diagnosis reuses the saved searches; a new Second Reader diagnosis allows each search once more', async () => {
    beforeReset();
    script = [ask('search_similar_cases', 'search_guideline'), FINAL];
    const same = await runAs('CASE-AG-SR');
    assert.deepStrictEqual(same.body.reusedTools.sort(), ['search_guideline', 'search_similar_cases']);
    assert.strictEqual(calls.esearch.length, 0);
    assert.strictEqual(calls.embeddings.length, 0);
    assert.ok(same.body.toolCalls.every((c) => c.refused), 'a repeat is refused, never run');

    await Case.updateOne({ caseId: 'CASE-AG-SR' }, { $set: { fusionResult: secondReader('Pleural effusion') } });
    script = [ask('search_similar_cases', 'search_guideline'), FINAL];
    const changed = await runAs('CASE-AG-SR');
    assert.deepStrictEqual(changed.body.reusedTools, []);
    assert.strictEqual(calls.embeddings[0].input[0], 'Pleural effusion');
    assert.match(plain(calls.esearch[0]), /Pleural effusion/);
    assert.deepStrictEqual(changed.body.agent.tools.search_similar_cases.input, { v: 2, diagnosis: 'Pleural effusion', context: CTX_DEFAULT });
    assert.strictEqual((await stored('CASE-AG-SR')).agentResult.tools.search_guideline.input.diagnosis, 'Pleural effusion');

    const before = calls.esearch.length;
    script = [ask('search_similar_cases', 'search_guideline'), FINAL];
    await runAs('CASE-AG-SR');
    assert.strictEqual(calls.esearch.length, before, 'once for this diagnosis');
    const rows = await auditRows('CASE-AG-SR');
    assert.strictEqual(rows.filter((r) => /ran/.test(r.details)).length, 4, 'every real call is in the audit log');
  });

  await test('with no Second Reader diagnosis the searches are not available, nothing is called, and nothing is used up', async () => {
    beforeReset();
    await mkCase('CASE-AG-NOSR', { fusionResult: null });
    script = [ask('search_similar_cases', 'search_guideline'), FINAL];
    const res = await runAs('CASE-AG-NOSR');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.toolCalls.every((c) => /Second Reader has not given a diagnosis/.test(c.refused)));
    assert.strictEqual(calls.embeddings.length + calls.esearch.length + calls.web.length, 0);
    assert.strictEqual((await stored('CASE-AG-NOSR')).agentResult.tools.search_similar_cases, undefined);
    assert.match(calls.chat[0].messages[1].content, /search_similar_cases: not available/);
    await Case.updateOne({ caseId: 'CASE-AG-NOSR' }, { $set: { fusionResult: secondReader('Pneumothorax') } });
    script = [ask('search_similar_cases', 'search_guideline'), FINAL];
    const later = await runAs('CASE-AG-NOSR');
    assert.ok(later.body.agent.tools.search_similar_cases.output);
    assert.ok(later.body.agent.tools.search_guideline.output);
  });

  await test('a Second Reader answer of "no acute abnormality": similar cases still run, the guideline search has nothing to look up', async () => {
    beforeReset();
    await mkCase('CASE-AG-NORM', { fusionResult: secondReader('No acute abnormality') });
    script = [ask('search_similar_cases', 'search_guideline'), FINAL];
    const res = await runAs('CASE-AG-NORM');
    assert.ok(res.body.agent.tools.search_similar_cases.output);
    assert.strictEqual(res.body.agent.tools.search_guideline, undefined);
    assert.match(res.body.toolCalls.find((c) => c.tool === 'search_guideline').refused, /found no abnormality/);
    assert.strictEqual(calls.esearch.length, 0);
  });

  await test('the role text tells the agent to use search_similar_cases once on a draft when it is available', () => {
    assert.match(calls.chat[0].messages[0].content, /Use search_similar_cases once when it is available and the report is a draft/);
  });

  console.log('\n=== the review panel\'s run never sends notify ===');
  await test('a run without {"notify": true} cannot send an email, even on an endorsed report and even if the model asks', async () => {
    beforeReset();
    await new Promise((r) => setTimeout(r, 25));
    await mkCase('CASE-AG-PANEL', { status: 'finalized', finalizedAt: new Date() });
    for (const body of [undefined, {}, { notify: false }, { notify: 'yes' }, { notify: 1 }]) {
      script = [ask('search_guideline', 'notify'), FINAL];
      const res = await runAs('CASE-AG-PANEL', 'radiologist', body);
      assert.strictEqual(res.status, 200);
      const n = res.body.toolCalls.find((c) => c.tool === 'notify');
      assert.match(n.refused, /supporting evidence only/);
    }
    assert.strictEqual(emails.length, 0);
    assert.strictEqual((await stored('CASE-AG-PANEL')).agentResult.tools.notify, undefined, 'notify was not used up');
    assert.match(calls.chat[0].messages[1].content, /notify: not available \(notify is not available: this run is for supporting evidence only/);
    const rows = await auditRows('CASE-AG-PANEL');
    assert.ok(rows.filter((r) => /notify refused/.test(r.details)).length === 5, 'each notify attempt is audited');
    script = [ask('notify'), FINAL];
    await runAs('CASE-AG-PANEL', 'radiologist', NOTIFY);
    assert.strictEqual(emails.length, 1, 'only an explicit notify run sends, once');
  });

  console.log('\n=== the tools on their own ===');
  await test('guideline queries lose names, numbers and dates before they leave the server', async () => {
    assert.strictEqual(agentTools.cleanGuidelineQuery('John Smith 12/03/1980 pleural effusion, MRN 99812'), 'John Smith pleural effusion MRN');
    assert.strictEqual(agentTools.cleanGuidelineQuery('1234'), '');
    beforeReset();
    await agentTools.searchGuideline({ query: 'pneumonia 1980-05-06 x' });
    assert.ok(calls.esearch[0].includes('pneumonia'));
    assert.ok(!/1980/.test(decodeURIComponent(calls.esearch[0])));
    assert.ok(!/1980/.test(JSON.stringify(calls.web[0])));
    const none = await agentTools.searchGuideline({ query: '123' });
    assert.deepStrictEqual(none.results, []);
  });

  await test('vectors are made once and kept: a later search only embeds the question', async () => {
    beforeReset();
    await CaseEmbedding.deleteMany({});
    await agentTools.searchSimilarCases({ caseId: 'X', findingsText: 'pneumonia consolidation' });
    assert.strictEqual(calls.embeddings.length, 1);
    assert.strictEqual(calls.embeddings[0].input.length, 1 + (await Case.countDocuments({ 'sourceReport.text': { $exists: true } })), 'the question and every official report');
    assert.strictEqual(await CaseEmbedding.countDocuments({}), 5);
    await agentTools.searchSimilarCases({ caseId: 'X', findingsText: 'pleural effusion' });
    assert.strictEqual(calls.embeddings[1].input.length, 1);
    await Case.updateOne({ caseId: 'CASE-MIMIC-C' }, { $set: { 'sourceReport.text': 'FINDINGS: A pneumothorax.\nIMPRESSION: Pneumothorax.' } });
    await agentTools.searchSimilarCases({ caseId: 'X', findingsText: 'pneumothorax' });
    assert.strictEqual(calls.embeddings[2].input.length, 2, 'an edited report is embedded again');
  });

  await test('no findings text means no search and an empty list', async () => {
    beforeReset();
    const out = await agentTools.searchSimilarCases({ caseId: 'X', findingsText: '   ' });
    assert.deepStrictEqual(out.results, []);
    assert.strictEqual(calls.embeddings.length, 0);
  });

  console.log('\n=== more useful evidence: why similar, outcome, ranking, checklists ===');
  const evidenceLib = backend('utils/agentEvidence');
  const explainBody = () => JSON.parse(calls.helper.find((b) => b.messages[0].content.includes('compare a new chest X-ray case')).messages[1].content);

  await test('every similar case says why it is similar, using only features both texts really contain', async () => {
    const out = draftRun.body.agent.tools.search_similar_cases.output;
    const byId = Object.fromEntries(out.results.map((r) => [r.caseId, r]));
    assert.strictEqual(byId['CASE-MIMIC-A'].whySimilar, 'lobe + pneumonia');
    assert.strictEqual(byId['CASE-MIMIC-B'].whySimilar, 'pneumonia');
    assert.strictEqual(byId['CASE-MIMIC-E'].whySimilar, 'pneumonia');
    assert.ok(out.results.every((r) => r.whySimilar && !/cavitation/.test(r.whySimilar)), 'a feature that is in neither text is thrown away');
  });

  await test('ranking: the same diagnosis at 0.60 beats a different diagnosis at 0.83', async () => {
    beforeReset();
    // E reads as almost pure "pneumonia" (very close to the question); B is further away.
    explainOverride = (cases) => cases.map((c) => ({
      caseId: c.caseId,
      diagnosisMatch: c.caseId === 'CASE-MIMIC-B' ? 'same' : 'different',
      caseDiagnosis: c.caseId === 'CASE-MIMIC-B' ? 'pneumonia' : 'something else',
      shared: [],
    }));
    const out = await agentTools.searchSimilarCases({ caseId: 'X', findingsText: 'Pneumonia', newCaseText: 'Diagnosis: Pneumonia' });
    const sim = (id) => out.results.find((r) => r.caseId === id).similarity;
    assert.ok(sim('CASE-MIMIC-E') > sim('CASE-MIMIC-B'), `E ${sim('CASE-MIMIC-E')} should be closer than B ${sim('CASE-MIMIC-B')}`);
    assert.strictEqual(out.results[0].caseId, 'CASE-MIMIC-B', 'the right diagnosis comes first although it is less similar');
    assert.strictEqual(out.results[0].diagnosisMatch, 'same');
    assert.ok(out.results.slice(1).every((r) => r.diagnosisMatch === 'different'));
    const rest = out.results.slice(1);
    assert.ok(rest[0].similarity >= rest[rest.length - 1].similarity, 'then by similarity');
  });

  await test('a diagnosis the model claims but the report does not contain does not count as a match', async () => {
    beforeReset();
    explainOverride = (cases) => cases.map((c) => ({ caseId: c.caseId, diagnosisMatch: 'same', caseDiagnosis: 'miliary tuberculosis', shared: [] }));
    const out = await agentTools.searchSimilarCases({ caseId: 'X', findingsText: 'Pneumonia', newCaseText: 'Diagnosis: Pneumonia' });
    assert.ok(out.results.length > 0 && out.results.every((r) => r.diagnosisMatch === 'unknown' && r.whySimilar === ''));
  });

  await test('if the comparison step fails, the cases still come back by similarity, with no reason and a note', async () => {
    beforeReset();
    const fetchBefore = globalThis.fetch;
    explainOverride = () => { throw new Error('model down'); };
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/chat/completions') && /compare a new chest X-ray case/.test(init.body)) return json({ error: { message: 'model down' } }, 500);
      return fetchBefore(url, init);
    };
    try {
      const out = await agentTools.searchSimilarCases({ caseId: 'X', findingsText: 'Pneumonia', newCaseText: 'Diagnosis: Pneumonia' });
      assert.ok(out.results.length > 0);
      assert.ok(out.results.every((r) => r.whySimilar === '' && r.diagnosisMatch === 'unknown'));
      assert.match(out.note, /Ranked by similarity only/);
    } finally { globalThis.fetch = fetchBefore; }
  });

  await test('the comparison reads the Second Reader diagnosis and summary, never the CURV report', async () => {
    beforeReset();
    await mkCase('CASE-AG-NOCURV', { reportText: 'FINDINGS\nCURV SAID SOMETHING UNIQUE ABOUT THE LEFT APEX.\n\nCOMMENT\n– x.', findingTags: [] });
    script = [ask('search_similar_cases'), FINAL];
    await runAs('CASE-AG-NOCURV');
    const body = explainBody();
    assert.strictEqual(body.newCase.diagnosis, 'Right lower lobe pneumonia');
    assert.match(body.newCase.text, /Second Reader summary: Looks like infection\./);
    assert.ok(!/CURV SAID/.test(JSON.stringify(calls.helper)), 'CURV\'s findings never reach a helper step');
  });

  await test('outcome: only what the record says. A course line or a later study of the same patient; otherwise nothing', async () => {
    const { outcomeOf } = evidenceLib;
    assert.strictEqual(outcomeOf({ text: 'FINDINGS: Left lower lobe consolidation.\nIMPRESSION: Pneumonia.' }), '', 'no outcome in the record: nothing is made up');
    assert.strictEqual(outcomeOf({ text: 'FINDINGS: Lungs clear.\nIMPRESSION: Normal chest.' }), '');
    assert.strictEqual(
      outcomeOf({ text: 'FINDINGS: Left lower lobe consolidation.\nIMPRESSION: Pneumonia has improved compared with the prior study.' }),
      'Course on the report: Pneumonia has improved compared with the prior study.'
    );
    assert.strictEqual(
      outcomeOf({ text: 'IMPRESSION: Pneumonia.' }, { sourceReport: { text: 'FINDINGS: Clear.\nIMPRESSION: Resolution of the pneumonia. No new opacity.' } }),
      'Later study: Resolution of the pneumonia.'
    );
    // The searches only return an outcome for a case that has one: none of the five test reports does.
    const out = draftRun.body.agent.tools.search_similar_cases.output;
    assert.ok(out.results.every((r) => r.outcome === ''));
    // A real outcome in the record shows up.
    await Case.create({ caseId: 'CASE-MIMIC-F', patientId: 'PT-MIMIC-F', status: 'finalized', reportText: 'FINDINGS\nx', sourceReport: { label: 'MIMIC', source: 'MIMIC-CXR', text: 'FINDINGS: Pneumonia, consolidation, pneumonia.\nIMPRESSION: Pneumonia, consolidation, now resolving compared with the prior film.' } });
    beforeReset();
    const found = await agentTools.searchSimilarCases({ caseId: 'X', findingsText: 'Pneumonia consolidation', newCaseText: 'Diagnosis: Pneumonia' });
    const f = found.results.find((r) => r.caseId === 'CASE-MIMIC-F');
    assert.match(f.outcome, /^Course on the report: .*resolving compared with the prior film/);
    await Case.deleteOne({ caseId: 'CASE-MIMIC-F' });
    await CaseEmbedding.deleteMany({ caseId: 'CASE-MIMIC-F' });
  });

  await test('patient context: age, sex, symptoms and abnormal labs from the chart, nothing the model made up, and no name', async () => {
    beforeReset();
    await backend('models/Patient').create({ patientId: 'PT-CTX', name: 'Mei Chen', age: '67', sex: 'Female', history: 'Persistent cough and mild dyspnoea', labResults: 'CRP: 48 mg/L (HIGH); WBC: 8.1 x10^9/L (normal)' });
    await mkCase('CASE-AG-CTX', { patientId: 'PT-CTX', history: 'Persistent cough and mild dyspnoea', fusionResult: secondReader('Bilateral lower lobe pneumonia') });
    script = [ask('search_similar_cases', 'search_guideline'), FINAL];
    const res = await runAs('CASE-AG-CTX');
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const want = '67-year-old female, cough, dyspnoea, CRP elevated';
    assert.strictEqual(res.body.agent.tools.search_guideline.input.context, want);
    assert.strictEqual(res.body.agent.tools.search_similar_cases.input.context, want);
    assert.ok(calls.web.every((w) => w.input.includes(want)), 'the web search carries the patient context');
    assert.match(calls.web[0].input, /Bilateral lower lobe pneumonia/);
    const everything = JSON.stringify([calls.web, calls.esearch.map(plain), calls.embeddings, calls.helper.slice(1), calls.chat]);
    assert.ok(!/Mei|Chen|PT-CTX|chest pain|night sweats|Troponin/.test(everything), 'no name, no id, nothing the chart does not say');
    assert.ok(calls.esearch.every((u) => !/67-year/.test(plain(u))), 'PubMed gets the diagnosis only');
  });

  await test('contextText keeps only plain words and one number (the age), whatever it is given', () => {
    const { contextText } = evidenceLib;
    assert.strictEqual(contextText({ age: 67, sex: 'Female', symptoms: ['persistent cough', 'dyspnoea'], abnormalLabs: [{ name: 'CRP', direction: 'high' }, { name: 'Na', direction: 'low' }] }), '67-year-old female, persistent cough, dyspnoea, CRP elevated, Na low');
    assert.strictEqual(contextText({ age: 200, sex: 'x', symptoms: ['MRN 99812 John 12/03/1980 cough'] }), 'mrn john cough');
    assert.strictEqual(contextText(null), '');
    assert.strictEqual(agentTools.cleanContextString('67-year-old female, cough <script>1980-05-06</script>'), '67-year-old female, cough script 1980-05-06 script');
  });

  await test('guideline: a source that only gives a definition is not used, and a more specific search is tried', async () => {
    beforeReset();
    abstract = DEFINITION_ONLY;
    webReply = () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'NONE', annotations: [] }] }] });
    const out = await agentTools.searchGuideline({ query: 'Right lower lobe pneumonia', context: 'cough' });
    assert.deepStrictEqual(out.results, []);
    assert.match(out.note, /with a checklist/);
    assert.ok(calls.esearch.length >= 2, `searched again with a more general term (${calls.esearch.length} searches)`);
    assert.ok(calls.web.length >= 1);
  });

  await test('guideline: a line the source never wrote is dropped, and a chapter for a different disease is not used', async () => {
    beforeReset();
    abstract = 'Pneumonia is an infection. The differential diagnosis includes pulmonary oedema.';
    webReply = () => ({ output: [] });
    const one = await agentTools.searchGuideline({ query: 'Pneumonia' });
    assert.strictEqual(one.results.length, 1);
    assert.deepStrictEqual(one.results[0].bullets, { lookFor: '', ruleOut: 'The differential diagnosis includes pulmonary oedema.', next: '' }, 'the invented "look for" line is thrown away');
    beforeReset();
    esearchIds = ['999'];
    webReply = () => ({ output: [] });
    const other = await agentTools.searchGuideline({ query: 'Pneumonia' });
    assert.deepStrictEqual(other.results, [], '"Eosinophilic Pneumonia" is not the chapter for "Pneumonia"');
  });

  await test('guideline: the lines of a web page are only kept with a citation from NICE or Radiopaedia', async () => {
    beforeReset();
    esearchIds = [];
    webReply = () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'LOOK FOR: A line with no citation at all.\nNEXT: A line from another site that is cited. [x](https://example.com/a)', annotations: [
      { type: 'url_citation', start_index: 78, end_index: 100, title: 'x', url: 'https://example.com/a' }] }] }] });
    const out = await agentTools.searchGuideline({ query: 'Pneumonia' });
    assert.deepStrictEqual(out.results, []);
  });

  await test('a search saved before this version is searched again, not reused', async () => {
    beforeReset();
    await mkCase('CASE-AG-OLDV');
    const old = { at: new Date().toISOString(), input: { diagnosis: 'Right lower lobe pneumonia' }, output: { results: [{ caseId: 'CASE-MIMIC-A', similarity: 0.9, line: 'old' }], compared: 5, note: '' } };
    await Case.updateOne({ caseId: 'CASE-AG-OLDV' }, { $set: { agentResult: { tools: { search_similar_cases: old } } } });
    script = [ask('search_similar_cases'), FINAL];
    const res = await runAs('CASE-AG-OLDV');
    assert.deepStrictEqual(res.body.reusedTools, []);
    assert.strictEqual(res.body.agent.tools.search_similar_cases.input.v, 2);
    assert.ok(res.body.agent.tools.search_similar_cases.output.results.every((r) => 'whySimilar' in r));
  });

  console.log('\n=== who sees the agent result ===');
  await test('a technician and a referring doctor never get agentResult; a radiologist does', async () => {
    const c = await stored('CASE-AG-1');
    assert.ok(toPublicCase(c).agentResult);
    assert.strictEqual(toPublicCase(c, { hideFilm: true }).agentResult, undefined);
    assert.strictEqual(toPublicCase(c, { hideReasoning: true }).agentResult, undefined);
    const tech = await api('GET', '/api/cases/CASE-AG-1', { token: tokens.technician });
    if (tech.status === 200) assert.strictEqual(tech.body.case.agentResult, undefined);
    const rad = await api('GET', '/api/cases/CASE-AG-1', { token: tokens.radiologist });
    assert.strictEqual(rad.status, 200);
    assert.ok(rad.body.case.agentResult.tools.search_guideline);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  await db.stop();
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
