// scripts/test-lay-summary.cjs
//
// Phase 4: the lay summary and the patient role.
//
//   - the lay summary is written only after endorsement, from the endorsed report text only, in English and
//     formal written Traditional Chinese, and a summary that breaks a rule is never saved;
//   - a patient account can read its own endorsed cases and their summaries, and nothing else.
//
// Real routes and a throwaway in-memory MongoDB. Azure is faked here, so nothing leaves this machine and it
// never reads backend/.env.
//
//   node scripts/test-lay-summary.cjs

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
  app.use('/api/users', backend('routes/users'));
  app.use('/api/cases', backend('routes/cases'));
  app.use('/api/patients', backend('routes/patients'));
  app.use('/api/images', backend('routes/images'));
  app.use('/api/audit-logs', backend('routes/auditLogs'));
  app.use('/api/stats', backend('routes/stats'));
  app.use('*', (req, res, next) => next(backend('utils/ApiError').notFound(`Route ${req.originalUrl} not found`)));
  app.use(backend('middleware/errorHandler'));
  return app;
}

// ---------------------------------------------------------------- the fake model

const chatCalls = [];
let replies = []; // what the model says next; when empty it gives GOOD
const GOOD = () => ({
  english: {
    found: 'The X-ray shows a cloudy area in the lower part of the right lung.',
    meaning: 'This can happen when the lung is irritated or infected, for example by germs.',
    next: 'Your doctor will go through this report with you and decide if you need more tests or treatment.',
    help: 'See a doctor or go to the emergency department if you have trouble breathing, chest pain, a high fever, or feel much worse.',
  },
  traditionalChinese: {
    found: '胸部X光顯示右肺下部有一片模糊的陰影。',
    meaning: '這可能是肺部受到刺激或受到細菌等感染所致。',
    next: '醫生會與您一同檢視這份報告，並決定是否需要進一步檢查或治療。',
    help: '如出現呼吸困難、胸痛、高燒，或感到病情明顯加重，請盡快求醫或前往急症室。',
  },
});
const withZh = (patch) => { const g = GOOD(); g.traditionalChinese = { ...g.traditionalChinese, ...patch }; return g; };
const withEn = (patch) => { const g = GOOD(); g.english = { ...g.english, ...patch }; return g; };
let azureOff = false;

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('openai.azure.com')) {
    const body = JSON.parse(init.body);
    // The chart-findings step that runs on endorsement is not what is tested here.
    if (!body.messages[0].content.includes('plain-language summary')) return json({ choices: [{ message: { content: JSON.stringify({ findings: [] }) } }] });
    chatCalls.push(body);
    const reply = replies.length ? replies.shift() : GOOD();
    return json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
  }
  return realFetch(url, init);
};
const settings = {
  azure: (on) => {
    for (const key of ['ENDPOINT', 'KEY', 'DEPLOYMENT']) {
      if (on) process.env[`AZURE_OPENAI_${key}`] = key === 'ENDPOINT' ? 'https://fake.openai.azure.com' : 'test';
      else delete process.env[`AZURE_OPENAI_${key}`];
    }
  },
};

// ---------------------------------------------------------------- run

(async () => {
  const db = await startTestDb();
  const User = backend('models/User');
  const Patient = backend('models/Patient');
  const Case = backend('models/Case');
  const AuditLog = backend('models/AuditLog');
  const lay = backend('utils/laySummary');
  const { toPublicCase } = backend('utils/caseStatus');
  await db.ensureIndexes();
  settings.azure(true);

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

  const tokens = {};
  const passwords = {};
  async function makeUser(key, fields) {
    const password = crypto.randomBytes(9).toString('base64url');
    await User.create({ userId: `${key.toUpperCase()}-L`, username: `lay-${key}`, email: `lay-${key}@radassist.test`, name: `Test ${key}`, password, ...fields });
    passwords[key] = password;
    const res = await api('POST', '/api/auth/login', { body: { username: `lay-${key}`, password } });
    assert.strictEqual(res.status, 200, `could not log in as ${key}`);
    tokens[key] = res.body.token;
    return res.body.user;
  }
  for (const role of ['admin', 'radiologist', 'technician', 'doctor']) await makeUser(role, { role });
  await Patient.create({ patientId: 'PT-1', firstName: 'Mei', lastName: 'Chen', name: 'Mei Chen', age: '67', sex: 'Female' });
  await Patient.create({ patientId: 'PT-2', firstName: 'Other', lastName: 'Person', name: 'Other Person' });
  const patientUser = await makeUser('patient', { role: 'patient', patientId: 'PT-1' });
  await makeUser('patient2', { role: 'patient', patientId: 'PT-2' });

  const IMAGE_ID = '507f1f77bcf86cd799439011';
  const REPORT = 'XRAY CHEST (PA)\n\nFINDINGS\nRight lower zone consolidation suggesting pneumonia.\nHeart size is normal.\n\nCOMMENT\n– Clinical correlation advised.\n\nThinking:\nSECRET-THINKING-TEXT about a zebra.';
  const SECRETS = ['SECRET-THINKING-TEXT', 'ZEBRA-DIAGNOSIS', 'AGENT-EVIDENCE-MARKER', 'HISTORY-MARKER', 'Mei Chen', 'CURV-DRAFT-MARKER'];
  const mkCase = (caseId, extra = {}) => Case.create({
    caseId, patientId: 'PT-1', firstName: 'Mei', lastName: 'Chen', patientName: 'Mei Chen', age: '67', sex: 'Female',
    status: 'pending_approve', analysisState: 'done', history: 'HISTORY-MARKER cough', imageId: IMAGE_ID, view: 'PA',
    reportText: REPORT, remarks: 'CURV-DRAFT-MARKER remark',
    findingTags: [{ key: 't1', text: 'Right lower zone consolidation suggesting pneumonia.', abnormal: true }],
    findings: [{ label: 'Consolidation', bbox: [1, 2, 3, 4], tagKey: 't1', status: 'pending', source: 'Azure' }],
    fusionResult: { summary: 'S', diagnosis: 'ZEBRA-DIAGNOSIS', differentials: [], suggested_next_step: 'N' },
    agentResult: { tools: { search_guideline: { output: 'AGENT-EVIDENCE-MARKER' } }, summary: 'AGENT-EVIDENCE-MARKER' },
    historyAnalysis: { note: 'HISTORY-MARKER' },
    sourceReport: { text: 'SOURCE-REPORT-MARKER' },
    shareToken: `tok-secret-${caseId}`,
    requestedBy: 'DOCTOR-L',
    ...extra,
  });
  const stored = (id) => Case.findOne({ caseId: id }).lean();
  const waitDone = async (id) => {
    for (let i = 0; i < 100; i++) {
      const c = await stored(id);
      if (c.laySummaryState && c.laySummaryState !== 'running') return c;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the lay summary did not finish');
  };
  const rad = () => ({ token: tokens.radiologist });
  const wordsOf = (o) => ['found', 'meaning', 'next', 'help'].map((k) => o[k]).join(' ').trim().split(/\s+/).length;
  const charsOf = (o) => ['found', 'meaning', 'next', 'help'].map((k) => o[k]).join('').replace(/\s+/g, '').length;

  console.log('\n=== not before endorsement ===');
  await mkCase('CASE-LAY-DRAFT');
  await test('a draft report gets no lay summary: nothing is called, saved or refused silently', async () => {
    chatCalls.length = 0;
    assert.strictEqual(await lay.queueLaySummary(await stored('CASE-LAY-DRAFT'), {}), '', 'the util does nothing for a draft');
    const res = await api('POST', '/api/cases/CASE-LAY-DRAFT/lay-summary', rad());
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /only after the report is endorsed/);
    const put = await api('PUT', '/api/cases/CASE-LAY-DRAFT', { ...rad(), body: { remarks: 'edited' } });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(chatCalls.length, 0);
    const c = await stored('CASE-LAY-DRAFT');
    assert.strictEqual(c.laySummary, null);
    assert.strictEqual(c.laySummaryState, '');
  });

  console.log('\n=== after endorsement ===');
  let endorsed;
  await test('endorsing writes the lay summary in the background: { english, traditionalChinese }, four parts and the disclaimer in each', async () => {
    chatCalls.length = 0;
    const res = await api('POST', '/api/cases/CASE-LAY-DRAFT/finalize', { ...rad(), body: {} });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.case.status, 'finalized');
    endorsed = await waitDone('CASE-LAY-DRAFT');
    assert.strictEqual(endorsed.laySummaryState, 'done');
    assert.deepStrictEqual(Object.keys(endorsed.laySummary).sort(), ['english', 'traditionalChinese']);
    for (const lang of ['english', 'traditionalChinese']) {
      for (const part of ['found', 'meaning', 'next', 'help']) assert.ok(endorsed.laySummary[lang][part].length > 5, `${lang}.${part}`);
    }
    assert.strictEqual(endorsed.laySummary.english.disclaimer, 'This is an explanation aid, not a diagnosis. If you are worried, speak to your doctor.');
    assert.strictEqual(endorsed.laySummary.traditionalChinese.disclaimer, '本摘要僅供參考，並非診斷。如有擔心，請諮詢醫生。');
    assert.ok(wordsOf(endorsed.laySummary.english) < 120, `${wordsOf(endorsed.laySummary.english)} English words`);
    assert.ok(charsOf(endorsed.laySummary.traditionalChinese) < 250, `${charsOf(endorsed.laySummary.traditionalChinese)} Chinese characters`);
    assert.strictEqual(chatCalls.length, 1);
    const audit = await AuditLog.find({ action: 'LAY_SUMMARY', affectedCaseId: 'CASE-LAY-DRAFT' }).lean();
    assert.strictEqual(audit.length, 1);
  });

  await test('the model reads the endorsed report text and nothing else: no thinking, Second Reader, agent, history or name', async () => {
    const sent = JSON.stringify(chatCalls[0].messages);
    assert.match(chatCalls[0].messages[1].content, /Right lower zone consolidation suggesting pneumonia\./);
    assert.match(chatCalls[0].messages[1].content, /Clinical correlation advised/);
    for (const secret of SECRETS) assert.ok(!sent.includes(secret), `${secret} must not reach the model`);
    assert.ok(!sent.includes(IMAGE_ID) && !sent.includes('tok-secret-') && !sent.includes('SOURCE-REPORT-MARKER'));
  });

  await test('the prompt asks for plain words, formal written Chinese, no spoken Cantonese and no invented findings', async () => {
    const system = chatCalls[0].messages[0].content;
    for (const piece of [/Never invent a finding/, /書面語/, /never simplified/, /唔係/, /不是, 了, 的, 這樣/, /Do not write the disclaimer/, /explain it in the same sentence/, /four parts/]) {
      assert.match(system, piece);
    }
  });

  await test('endorsing the same report again does not write it again; the retry button writes it once more', async () => {
    chatCalls.length = 0;
    await api('POST', '/api/cases/CASE-LAY-DRAFT/finalize', { ...rad(), body: {} });
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(chatCalls.length, 0);
    const res = await api('POST', '/api/cases/CASE-LAY-DRAFT/lay-summary', { ...rad(), body: {} });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.state, 'done');
    assert.strictEqual(chatCalls.length, 1);
    assert.ok(res.body.case.laySummary.english);
    assert.strictEqual((await api('POST', '/api/cases/CASE-LAY-DRAFT/lay-summary', { token: tokens.doctor, body: {} })).status, 403);
    assert.strictEqual((await api('POST', '/api/cases/CASE-LAY-DRAFT/lay-summary', { token: tokens.patient, body: {} })).status, 403);
  });

  console.log('\n=== a summary that breaks a rule is never saved ===');
  const attempt = async (id, first, second) => {
    await mkCase(id, { status: 'finalized', finalizedAt: new Date() });
    replies = second === undefined ? [first] : [first, second];
    chatCalls.length = 0;
    const res = await api('POST', `/api/cases/${id}/lay-summary`, { ...rad(), body: {} });
    return { res, saved: await stored(id) };
  };
  const long = withEn({ found: Array.from({ length: 130 }, (_, i) => `word${i}`).join(' ') });

  await test('too long: the model is told what was wrong and tries again; the second good answer is saved', async () => {
    const { res, saved } = await attempt('CASE-LAY-LONG', long, GOOD());
    assert.strictEqual(res.body.state, 'done');
    assert.strictEqual(chatCalls.length, 2);
    assert.match(chatCalls[1].messages[1].content, /broke these rules/);
    assert.match(chatCalls[1].messages[1].content, /English is \d+ words; it must be under 120/);
    assert.strictEqual(saved.laySummaryState, 'done');
  });

  await test('two bad answers in a row: nothing is saved, the state is failed and says why', async () => {
    const { res, saved } = await attempt('CASE-LAY-LONG2', long, long);
    assert.strictEqual(res.body.state, 'failed');
    assert.strictEqual(saved.laySummary, null);
    assert.strictEqual(saved.laySummaryState, 'failed');
    assert.match(saved.laySummaryError, /not saved/);
    assert.strictEqual(res.body.case.laySummary, null);
  });

  await test('Chinese over 249 characters, a missing part, and a Chinese answer with no Chinese are all refused', async () => {
    const tooLongZh = withZh({ found: '胸'.repeat(260) });
    assert.match(lay.problemsWith(tooLongZh, REPORT).join(' '), /Chinese is \d+ characters/);
    const g = GOOD(); delete g.english.next;
    assert.match(lay.problemsWith(g, REPORT).join(' '), /english\.next is missing/);
    assert.ok(lay.problemsWith(GOOD(), REPORT).length === 0);
    assert.ok(lay.problemsWith(withZh({ found: 'x', meaning: 'y', next: 'z', help: 'w' }), REPORT).some((p) => /too short/.test(p)));
  });

  await test('spoken Cantonese (口語) is refused, written Chinese (書面語) is accepted, and 關係 is not mistaken for 係', async () => {
    for (const bad of ['這不係問題', '佢嘅肺部有陰影', '醫生睇咗報告', '呢個結果唔係診斷', '咁樣可能需要檢查']) {
      const problems = lay.problemsWith(withZh({ found: `${bad}，請與醫生討論這份報告的內容，並按醫生的建議跟進。` }), REPORT);
      assert.ok(problems.some((p) => /spoken Cantonese/.test(p)), `${bad} should be refused`);
    }
    const ok = withZh({ meaning: '這與肺部的關係密切，是了解病情的重要資料，並不是診斷。' });
    assert.deepStrictEqual(lay.problemsWith(ok, REPORT), []);
    const { saved } = await attempt('CASE-LAY-KOU', withZh({ found: '你的肺部有陰影，唔係好嚴重，嘅確需要跟進。' }), GOOD());
    assert.doesNotMatch(JSON.stringify(saved.laySummary), /唔|嘅|咗|咁/);
    assert.strictEqual(saved.laySummaryState, 'done', 'the second, written answer is the one saved');
  });

  await test('simplified characters are refused: the Chinese must be Traditional', () => {
    const problems = lay.problemsWith(withZh({ found: '这张胸部X光显示右肺下部有一片阴影，请与医生讨论。' }), REPORT);
    assert.ok(problems.some((p) => /simplified/.test(p)));
  });

  await test('a number that is not in the report is refused (an invented measurement); one that is in it is fine', () => {
    assert.ok(lay.problemsWith(withEn({ found: 'The shadow is 5 cm wide.' }), REPORT).some((p) => /number 5 is not in the report/.test(p)));
    assert.deepStrictEqual(lay.problemsWith(withEn({ found: 'The shadow is 5 cm wide.' }), `${REPORT}\nA 5 cm opacity.`), []);
  });

  await test('the disclaimers are added by the code, so a model that writes its own is overwritten', async () => {
    const g = GOOD(); g.english.disclaimer = 'You are fine!'; g.traditionalChinese.disclaimer = '你沒事';
    const { saved } = await attempt('CASE-LAY-DISC', g);
    assert.strictEqual(saved.laySummary.english.disclaimer, lay.DISCLAIMER.english);
    assert.strictEqual(saved.laySummary.traditionalChinese.disclaimer, lay.DISCLAIMER.traditionalChinese);
  });

  await test('Azure not set up at endorsement: the state is unavailable, nothing is written, and the retry says so', async () => {
    settings.azure(false);
    await mkCase('CASE-LAY-OFF', { status: 'pending_approve' });
    chatCalls.length = 0;
    const fin = await api('POST', '/api/cases/CASE-LAY-OFF/finalize', { ...rad(), body: {} });
    assert.strictEqual(fin.status, 200);
    assert.strictEqual((await stored('CASE-LAY-OFF')).laySummaryState, 'unavailable');
    assert.strictEqual(chatCalls.length, 0);
    assert.match((await api('POST', '/api/cases/CASE-LAY-OFF/lay-summary', { ...rad(), body: {} })).body.error, /not configured/);
    settings.azure(true);
  });

  console.log('\n=== the patient role ===');
  await mkCase('CASE-P1-FINAL', { status: 'finalized', finalizedAt: new Date(), finalizedByName: 'Dr Rad', laySummary: { english: { found: 'a' }, traditionalChinese: { found: 'b' } }, laySummaryState: 'done' });
  await mkCase('CASE-P1-DRAFT', { status: 'pending_approve' });
  await mkCase('CASE-P2-FINAL', { patientId: 'PT-2', patientName: 'Other Person', firstName: 'Other', lastName: 'Person', status: 'finalized', finalizedAt: new Date() });
  const P = () => ({ token: tokens.patient });
  const allowedKeys = ['caseId', 'patientId', 'patientName', 'firstName', 'middleName', 'lastName', 'age', 'sex', 'status', 'view', 'examinedAt', 'finalizedAt', 'finalizedByName', 'reportText', 'laySummary', 'laySummaryState'];

  await test('"patient" is the fifth role, a patient account needs a patient ID, and login returns it', async () => {
    assert.deepStrictEqual(backend('utils/roles').ROLES, ['technician', 'radiologist', 'doctor', 'admin', 'patient']);
    assert.strictEqual(patientUser.role, 'patient');
    assert.strictEqual(patientUser.patientId, 'PT-1');
    await assert.rejects(User.create({ userId: 'P-X', username: 'p-x', email: 'p-x@radassist.test', name: 'X', password: 'secret1', role: 'patient' }), /needs a patient ID/);
    const me = await api('GET', '/api/auth/me', P());
    assert.strictEqual(me.body.user.patientId, 'PT-1');
  });

  await test('an admin adds a patient account only for a patient that exists', async () => {
    const bad = await api('POST', '/api/users', { token: tokens.admin, body: { name: 'N', email: 'n@radassist.test', role: 'patient', patientId: 'PT-NONE' } });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.body.error, /no patient with ID PT-NONE/);
    assert.strictEqual((await api('POST', '/api/users', { token: tokens.admin, body: { name: 'N', email: 'n@radassist.test', role: 'patient' } })).status, 400);
    const ok = await api('POST', '/api/users', { token: tokens.admin, body: { name: 'N', email: 'n@radassist.test', role: 'patient', patientId: 'PT-2' } });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
    assert.strictEqual(ok.body.user.patientId, 'PT-2');
    assert.strictEqual((await api('POST', '/api/users', { token: tokens.radiologist, body: { name: 'N', email: 'n2@radassist.test', role: 'patient', patientId: 'PT-1' } })).status, 403);
  });

  await test('the case list holds only this patient\'s endorsed cases, and no query string can widen it', async () => {
    const ids = (r) => r.body.cases.map((c) => c.caseId).sort();
    const plain = await api('GET', '/api/cases', P());
    assert.strictEqual(plain.status, 200);
    assert.ok(ids(plain).includes('CASE-P1-FINAL'));
    assert.ok(ids(plain).every((id) => id !== 'CASE-P1-DRAFT' && id !== 'CASE-P2-FINAL'), ids(plain).join());
    for (const q of ['?patientId=PT-2', '?patientId=PT', '?status=pending_approve', '?status=all', '?q=Other', '?patientId=.*&status=finalized', '?status[$ne]=x']) {
      const r = await api('GET', `/api/cases${q}`, P());
      assert.ok(r.body.cases.every((c) => c.patientId === 'PT-1' && c.status === 'finalized'), `${q} widened the list`);
    }
    const other = await api('GET', '/api/cases', { token: tokens.patient2 });
    assert.deepStrictEqual(ids(other), ['CASE-P2-FINAL']);
  });

  await test('a patient opens their own endorsed case: the report and the lay summary, and only those fields', async () => {
    const res = await api('GET', '/api/cases/CASE-P1-FINAL', P());
    assert.strictEqual(res.status, 200);
    const c = res.body.case;
    assert.deepStrictEqual(Object.keys(c).filter((k) => c[k] !== undefined).every((k) => allowedKeys.includes(k)), true, JSON.stringify(Object.keys(c)));
    assert.match(c.reportText, /Right lower zone consolidation/);
    assert.doesNotMatch(c.reportText, /SECRET-THINKING-TEXT|Thinking/);
    assert.strictEqual(c.laySummary.english.found, 'a');
    assert.strictEqual(c.laySummary.traditionalChinese.found, 'b');
    for (const secret of ['ZEBRA-DIAGNOSIS', 'AGENT-EVIDENCE-MARKER', 'HISTORY-MARKER', 'CURV-DRAFT-MARKER', 'SOURCE-REPORT-MARKER', 'tok-secret-CASE-P1-FINAL', IMAGE_ID]) {
      assert.ok(!JSON.stringify(res.body).includes(secret), `${secret} reached the patient`);
    }
    for (const field of ['fusionResult', 'agentResult', 'historyAnalysis', 'findings', 'findingTags', 'editLog', 'shareToken', 'imageId', 'imageUrl', 'remarks', 'history', 'sourceReport', 'diagnosis']) {
      assert.strictEqual(c[field], undefined, field);
    }
    const list = await api('GET', '/api/cases', P());
    assert.ok(!/ZEBRA-DIAGNOSIS|AGENT-EVIDENCE-MARKER|tok-secret-/.test(JSON.stringify(list.body)));
  });

  await test('another patient\'s case and an own case that is not endorsed look like they do not exist', async () => {
    for (const id of ['CASE-P2-FINAL', 'CASE-P1-DRAFT', 'CASE-NONE']) {
      assert.strictEqual((await api('GET', `/api/cases/${id}`, P())).status, 404, id);
    }
    assert.strictEqual((await api('GET', '/api/cases/CASE-P1-FINAL', { token: tokens.patient2 })).status, 404);
  });

  await test('a patient cannot edit, endorse, share, delete, request, upload or run any AI', async () => {
    const before = JSON.stringify(await stored('CASE-P1-FINAL'));
    chatCalls.length = 0;
    const attempts = [
      ['PUT', '/api/cases/CASE-P1-FINAL', { remarks: 'x' }], ['POST', '/api/cases/CASE-P1-DRAFT/finalize', {}],
      ['POST', '/api/cases/CASE-P1-FINAL/analyze', {}], ['POST', '/api/cases/CASE-P1-FINAL/second-opinion', {}],
      ['POST', '/api/cases/CASE-P1-FINAL/agent', {}], ['POST', '/api/cases/CASE-P1-FINAL/reason', {}],
      ['POST', '/api/cases/CASE-P1-FINAL/lay-summary', {}], ['POST', '/api/cases/CASE-P1-FINAL/share', {}],
      ['POST', '/api/cases/CASE-P1-FINAL/summarise-findings', {}], ['POST', '/api/cases/CASE-P1-FINAL/summarise-diagnosis', {}],
      ['POST', '/api/cases/CASE-P1-FINAL/chart-findings', {}], ['DELETE', '/api/cases/CASE-P1-FINAL', undefined],
      ['POST', '/api/cases/bulk-delete', { ids: ['CASE-P1-FINAL'] }], ['POST', '/api/cases/request', {}],
      ['POST', '/api/cases', {}], ['POST', '/api/cases/CASE-P1-FINAL/arrive', {}], ['GET', '/api/cases/availability?from=2026-01-01&to=2026-01-02', undefined],
    ];
    for (const [method, url, body] of attempts) {
      const res = await api(method, url, { ...P(), body });
      assert.strictEqual(res.status, 403, `${method} ${url} -> ${res.status}`);
    }
    assert.strictEqual(JSON.stringify(await stored('CASE-P1-FINAL')), before);
    assert.strictEqual(chatCalls.length, 0, 'no AI ran');
  });

  await test('a patient cannot see other patients, the audit log, users, stats or the film', async () => {
    const denied = [
      ['GET', '/api/patients'], ['GET', '/api/patients/PT-1'], ['GET', '/api/patients/PT-2'], ['PUT', '/api/patients/PT-1'], ['POST', '/api/patients'],
      ['GET', '/api/audit-logs'], ['DELETE', '/api/audit-logs/x'], ['GET', '/api/users'], ['POST', '/api/users'], ['GET', '/api/stats'], ['GET', '/api/images/507f1f77bcf86cd799439011'],
    ];
    for (const [method, url] of denied) {
      const res = await api(method, url, { ...P(), body: method === 'GET' || method === 'DELETE' ? undefined : {} });
      assert.strictEqual(res.status, 403, `${method} ${url} -> ${res.status}`);
    }
    assert.strictEqual((await api('GET', '/api/patients')).status, 401);
  });

  await test('caseStatus hides agentResult, fusionResult and the rest from a patient, even when handed a full document', async () => {
    const full = await stored('CASE-P1-FINAL');
    const out = toPublicCase(full, { patientView: true });
    assert.deepStrictEqual(Object.keys(out).filter((k) => out[k] !== undefined).every((k) => allowedKeys.includes(k)), true);
    assert.strictEqual(out.agentResult, undefined);
    assert.strictEqual(out.fusionResult, undefined);
    assert.ok(!('patientView' in out));
  });

  await test('a referring doctor still sees the lay summary in the case (for the Patient view preview) but not the Second Reader or the agent', async () => {
    const res = await api('GET', '/api/cases/CASE-P1-FINAL', { token: tokens.doctor });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.case.laySummary.english);
    assert.strictEqual(res.body.case.fusionResult, undefined);
    assert.strictEqual(res.body.case.agentResult, undefined);
    const radRes = await api('GET', '/api/cases/CASE-P1-FINAL', rad());
    assert.ok(radRes.body.case.laySummary.english);
    assert.ok(radRes.body.case.fusionResult, 'a radiologist keeps the Second Reader');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  await db.stop();
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
