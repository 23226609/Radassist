// utils/agent.js
//
// RadAssist's reasoning agent. It helps a radiologist and never finalises a
// report. It runs after the Second Reader.
//
// Two parts, kept apart on purpose:
//
//   Part A, the framework. WHAT the agent may do: its role, exactly three tools
//   and the rules for them. The rules are in ROLE (told to the model) and in
//   `check()` (enforced here in code, so a wrong model answer cannot get round them).
//
//   Part B, LangGraph. HOW the loop runs: reason -> tools -> reason -> finish.
//   The graph only moves between the steps. It decides nothing about what is allowed.
//
// The searches use the Second Reader's diagnosis (Case.fusionResult.diagnosis), never CURV's
// findings. A saved search belongs to the diagnosis it was made for.
//
// The three tools (agentTools.js):
//   search_similar_cases  at most once per Second Reader diagnosis
//   search_guideline      at most once per Second Reader diagnosis
//   notify                once, only after the report is endorsed, and never for a report
//                         endorsed before the email service was ready
//                         (offered only to a run that is asked to notify; the review panel's run is not)
//
// Every tool call, run or refused, is written to the audit log with its input
// and output. A tool that finds nothing is reported as such; nothing is made up.
// The agent never edits the CURV report: it returns suggestions and notes and
// saves them, with the tool results, on Case.agentResult.

const { StateGraph, Annotation, START, END } = require('@langchain/langgraph');
const Case = require('../models/Case');
const addAuditLog = require('./auditLogger');
const azureFindings = require('./azureFindings');
const embeddings = require('./embeddings');
const agentTools = require('./agentTools');
const evidence = require('./agentEvidence');
const { historyText } = require('./historyReasoning');

const TOOL_NAMES = ['search_similar_cases', 'search_guideline', 'notify'];
const SEARCH_TOOLS = ['search_similar_cases', 'search_guideline'];
// Bumped when what a saved search holds changes, so an older saved search is searched again, not reused.
const INPUT_VERSION = 2;
const NO_ABNORMALITY = /^\s*(no\s+(acute|significant|active|abnormal|definite|focal|evidence)|normal|unremarkable|nil)\b/i;
const MAX_TURNS = 4; // reason steps in one run; a run needs 2 (tools, then answer)
const MAX_CALLS_PER_TURN = 3;
const MAX_SUGGESTIONS = 5;
const AUDIT_ACTION = 'AGENT_TOOL_CALL';
const AUDIT_MAX = 6000;

// Part A: the role and the rules, as the model is told them.
const ROLE = `You are RadAssist's reasoning agent. You help a radiologist think about a chest X-ray case that an AI has already drafted a report for. You never finalise a report. You never edit the CURV report. You only return suggestions for the radiologist to review. Only a radiologist can endorse a report.

You have exactly three tools:
- search_similar_cases: finds imported cases with a similar official report. Input: {}. It searches for the Second Reader's diagnosis, which is chosen for you.
- search_guideline: finds a short checklist (what to look for, what to rule out, what to do next) from StatPearls, NICE or Radiopaedia. Input: {}. It searches for the Second Reader's diagnosis and the patient's context, which are chosen for you.
- notify: emails the referring doctor that the report is endorsed. Input: {}. The message is written for you. It is only offered in a run that is allowed to notify.

Rules:
1. Call search_similar_cases at most once and search_guideline at most once for this Second Reader diagnosis. A tool marked "already used" or "not available" must not be called again.
2. Call notify at most once, and only when the report is endorsed. If it is not endorsed, never call it.
3. If a tool returns nothing useful, say so in your summary and carry on with what you have. Never invent a guideline, a passage or a similar case. Only mention a case or a guideline that a tool returned, and name it in "sources" (the case id or the page url).
4. Do not suggest a final diagnosis as fact. Write suggestions as things for the radiologist to check.
5. Use search_similar_cases once when it is available and the report is a draft. If it is marked available and the report is a draft, your reply must be that call, not a final answer.
6. Use search_guideline once as well when it is available and the Second Reader's diagnosis names an abnormality. If it is marked available, your reply must be that call, not a final answer, unless the diagnosis is a normal study.

Reply with JSON only.
To use tools: {"calls":[{"tool":"search_similar_cases","input":{}}]}
When you are finished: {"summary":"2 or 3 sentences","suggestions":[{"text":"one short suggestion for the radiologist","sources":["CASE-ID or url, only if a tool returned it"]}]}
Give at most 5 suggestions. If you have no tool left to use, give the final answer.`;

const squash = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isEndorsed = (c) => c?.status === 'finalized';

// ---------------------------------------------------------------------------
// Part A: the rules, enforced in code
// ---------------------------------------------------------------------------

/**
 * Whether a tool may run now. Returns '' when it may, else the reason it may not.
 * A reason from the first group is a rule (the call is refused and counts as used up);
 * `unavailable` ones are about this server's setup and do not use the call up.
 */
function check(tool, tools, ctx) {
  if (!TOOL_NAMES.includes(tool)) return { ok: false, reason: `"${tool}" is not one of the three tools.` };
  if (tools[tool]) return { ok: false, reason: `${tool} was already used for this ${tool === 'notify' ? 'case' : 'Second Reader diagnosis'}.` };
  if (SEARCH_TOOLS.includes(tool) && !ctx.diagnosis) {
    return { ok: false, reason: `${tool} is not available: the Second Reader has not given a diagnosis yet, and the searches use it.`, unavailable: true };
  }
  if (tool === 'search_guideline' && NO_ABNORMALITY.test(ctx.diagnosis)) {
    return { ok: false, reason: 'search_guideline is not available: the Second Reader found no abnormality, so there is nothing to look up.', unavailable: true };
  }
  if (tool === 'notify' && !isEndorsed(ctx.caseDoc)) {
    return { ok: false, reason: 'notify is only allowed after the report is endorsed, and this one is not.' };
  }
  if (tool === 'search_similar_cases' && !ctx.deps.similarReady()) {
    return { ok: false, reason: 'search_similar_cases is not available: embeddings are not set up.', unavailable: true };
  }
  if (tool === 'notify' && ctx.notifyBlock) {
    return { ok: false, reason: ctx.notifyBlock.reason, unavailable: ctx.notifyBlock.unavailable };
  }
  return { ok: true };
}

const allowedNow = (tools, ctx) => TOOL_NAMES.filter((t) => check(t, tools, ctx).ok);

// ---------------------------------------------------------------------------
// What the model reads
// ---------------------------------------------------------------------------

function findingsOf(caseDoc) {
  return azureFindings.clinicalReportText(caseDoc.reportText || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

// What the two searches look for: the Second Reader's diagnosis, never CURV's findings.
const diagnosisOf = (fusion) => (fusion && typeof fusion.diagnosis === 'string' ? squash(fusion.diagnosis, 200) : '');

// A saved search belongs to the diagnosis it was made for. After the Second Reader gives a new
// diagnosis the old results are not reused and the searches may run once for the new one.
const isCurrent = (name, rec, diagnosis) => name === 'notify'
  || (Boolean(diagnosis) && rec?.input?.diagnosis === diagnosis && rec?.input?.v === INPUT_VERSION);

function secondReaderText(fusion) {
  if (!fusion || typeof fusion !== 'object') return 'Not run.';
  const diff = Array.isArray(fusion.differentials) ? fusion.differentials.map((d) => squash(d?.diagnosis || d?.name || (typeof d === 'string' ? d : ''), 80)).filter(Boolean).join('; ') : '';
  return [
    `Summary: ${squash(fusion.summary, 400) || '-'}`,
    `Diagnosis: ${squash(fusion.diagnosis, 200) || '-'}`,
    `Differentials: ${diff || '-'}`,
    `Suggested next step: ${squash(fusion.suggested_next_step, 300) || '-'}`,
  ].join('\n');
}

function toolStateText(tools, ctx) {
  const allowed = allowedNow(tools, ctx);
  const lines = TOOL_NAMES.map((name) => {
    const rec = tools[name];
    if (rec) {
      const out = rec.output;
      if (!out && !rec.error) return `${name}: already used, but its result was not saved. Treat as nothing useful.`;
      if (rec.error) return `${name}: already used, it failed (${squash(rec.error, 200)}). Treat as nothing useful.`;
      const n = Array.isArray(out?.results) ? out.results.length : null;
      if (name === 'notify') return `${name}: already used. ${out?.sent ? 'Email sent.' : 'Not sent.'}`;
      return `${name}: already used, ${n === 0 ? `returned nothing useful (${squash(out?.note, 200)})` : `returned ${n} result(s)`}.`;
    }
    const verdict = check(name, tools, ctx);
    return `${name}: ${verdict.ok ? 'available' : `not available (${verdict.reason})`}`;
  });
  return { text: lines.join('\n'), allowed };
}

function resultsText(tools) {
  const parts = [];
  const sim = tools.search_similar_cases?.output?.results;
  if (sim?.length) {
    parts.push('Similar cases returned:\n' + sim.map((r) => `- ${r.caseId} (similarity ${r.similarity}${r.diagnosisMatch && r.diagnosisMatch !== 'unknown' ? `, ${r.diagnosisMatch} diagnosis` : ''}): ${squash(r.line || r.officialReport, 300)}${r.whySimilar ? ` Why similar: ${r.whySimilar}.` : ''}`).join('\n'));
  }
  const gl = tools.search_guideline?.output?.results;
  if (gl?.length) {
    const lines = (b) => [['lookFor', 'Look for'], ['ruleOut', 'Rule out'], ['next', 'Next']].filter(([k]) => b?.[k]).map(([k, label]) => `${label}: ${squash(b[k], 200)}`).join(' | ');
    parts.push('Guideline checklists returned:\n' + gl.map((r) => `- ${r.source}, ${r.url}: ${lines(r.bullets)}`).join('\n'));
  }
  return parts.join('\n\n') || 'No tool results yet.';
}

function userContent(ctx, state) {
  const { text } = toolStateText(state.used, ctx);
  const c = ctx.caseDoc;
  return [
    `Report status: ${isEndorsed(c) ? 'ENDORSED by a radiologist' : 'NOT endorsed (draft)'}`,
    `Patient history: ${historyText(c)}`,
    `CURV report (read only, never edit):\n${findingsOf(c) || 'No report text.'}`,
    `Second Reader (an AI that did not see the report):\n${secondReaderText(c.fusionResult)}`,
    `Tools:\n${text}`,
    state.notes.length ? `Notes from the last step:\n${state.notes.join('\n')}` : '',
    `Tool results:\n${resultsText(state.used)}`,
  ].filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------------------
// Reading the model's answer
// ---------------------------------------------------------------------------

function parseCalls(parsed) {
  if (!Array.isArray(parsed?.calls)) return [];
  return parsed.calls
    .filter((c) => c && typeof c.tool === 'string')
    .slice(0, MAX_CALLS_PER_TURN)
    .map((c) => ({ tool: c.tool.trim(), input: c.input && typeof c.input === 'object' && !Array.isArray(c.input) ? c.input : {} }));
}

// Sources the model names must be ones a tool really returned.
function knownSources(tools) {
  const set = new Set();
  for (const r of tools.search_similar_cases?.output?.results || []) set.add(r.caseId);
  for (const r of tools.search_guideline?.output?.results || []) set.add(r.url);
  return set;
}

function parseFinal(parsed, tools) {
  const known = knownSources(tools);
  const suggestions = (Array.isArray(parsed?.suggestions) ? parsed.suggestions : [])
    .map((s) => ({
      text: squash(typeof s === 'string' ? s : s?.text, 400),
      sources: [...new Set((Array.isArray(s?.sources) ? s.sources : []).map((x) => String(x).trim()).filter((x) => known.has(x)))],
    }))
    .filter((s) => s.text)
    .slice(0, MAX_SUGGESTIONS);
  return {
    summary: squash(parsed?.summary, 800) || 'The agent gave no summary. Use the tool results below.',
    suggestions,
  };
}

// What the tools found or did not find, written by code, not by the model.
function toolNotes(tools) {
  const notes = [];
  for (const name of TOOL_NAMES) {
    const rec = tools[name];
    if (!rec) continue;
    if (!rec.output && !rec.error) notes.push(`${name} was used earlier, but its result was not saved. Nothing from it is used.`);
    else if (rec.error) notes.push(`${name} failed: ${squash(rec.error, 200)}. Nothing from it is used.`);
    else if (name === 'notify') notes.push(rec.output?.sent ? `Email sent to the referring doctor.` : 'No email was sent.');
    else if (!rec.output?.results?.length) notes.push(`${name} returned nothing useful${rec.output?.note ? `: ${squash(rec.output.note, 200)}` : '.'}`);
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Doing one tool call: claim it, run it, record it, write the audit row
// ---------------------------------------------------------------------------

const clip = (value) => {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return s.length > AUDIT_MAX ? `${s.slice(0, AUDIT_MAX)}…[cut]` : s;
};

async function audit(ctx, tool, input, output, status) {
  await ctx.deps.audit(
    ctx.userId,
    AUDIT_ACTION,
    `Agent tool ${tool} ${status} for ${ctx.caseDoc.caseId}`,
    ctx.caseDoc.caseId,
    clip(input),
    clip(output)
  );
}

// What a notify call is recorded with: the case and the endorsement it is for. What the model wrote is not used.
const notifyInput = (caseDoc) => ({
  caseId: caseDoc.caseId,
  endorsedAt: caseDoc.finalizedAt ? new Date(caseDoc.finalizedAt).toISOString() : null,
});

// What a call is recorded with, for the saved result and the audit log. It is worked out from the case,
// never from what the model wrote: a search is for the Second Reader's diagnosis, notify for the endorsement.
function inputFor(tool, ctx) {
  const context = ctx.contextText || '';
  if (tool === 'search_similar_cases') return { v: INPUT_VERSION, diagnosis: ctx.diagnosis, context };
  if (tool === 'search_guideline') return { v: INPUT_VERSION, diagnosis: ctx.diagnosis, query: agentTools.cleanGuidelineQuery(ctx.diagnosis), context };
  if (tool === 'notify') return notifyInput(ctx.caseDoc);
  return null;
}

// Age, sex, main symptoms and abnormal labs of this case, worked out once per run and only if a search will use them.
// If they cannot be read the searches still run, on the diagnosis alone.
async function ensureContext(ctx) {
  if (ctx.contextDone) return;
  ctx.contextDone = true;
  try {
    const c = await ctx.deps.patientContext(ctx.caseDoc);
    ctx.contextText = String(c?.text || '');
  } catch {
    ctx.contextText = '';
  }
}

async function runTool(tool, ctx) {
  const { deps, caseDoc } = ctx;
  const input = inputFor(tool, ctx);
  if (tool === 'search_similar_cases') {
    // What "why similar" is checked against: the diagnosis, the Second Reader's own summary and the patient context. Never CURV's report.
    const newCaseText = [`Diagnosis: ${input.diagnosis}`, caseDoc.fusionResult?.summary ? `Second Reader summary: ${squash(caseDoc.fusionResult.summary, 600)}` : '', input.context ? `Patient: ${input.context}` : '']
      .filter(Boolean).join('\n');
    return { input, output: await deps.tools.searchSimilarCases({ caseId: caseDoc.caseId, findingsText: input.diagnosis, newCaseText }) };
  }
  if (tool === 'search_guideline') {
    return { input, output: await deps.tools.searchGuideline({ query: input.query, context: input.context }) };
  }
  // notify: the recipient is the referring doctor and the text is fixed (see agentTools.notify),
  // so nothing the model wrote reaches the email.
  return { input, output: await deps.tools.notify({ caseDoc }) };
}

// ---------------------------------------------------------------------------
// Part B: the LangGraph loop
// ---------------------------------------------------------------------------

const replace = (_, next) => next;
const AgentState = Annotation.Root({
  turns: Annotation({ reducer: replace, default: () => 0 }),
  used: Annotation({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }), // recorded calls, by tool name
  pending: Annotation({ reducer: replace, default: () => [] }), // calls the model asked for
  notes: Annotation({ reducer: replace, default: () => [] }), // what the last tools step refused
  final: Annotation({ reducer: replace, default: () => null }),
  ran: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }), // calls handled in this run
});

function buildGraph(ctx) {
  async function reason(state) {
    const { allowed } = toolStateText(state.used, ctx);
    if (state.turns >= MAX_TURNS) return { turns: state.turns, pending: [], final: null };
    const parsed = await ctx.deps.chat(ROLE, userContent(ctx, state), 900, 0);
    const calls = allowed.length ? parseCalls(parsed) : [];
    if (calls.length) return { turns: state.turns + 1, pending: calls, final: null, notes: [] };
    return { turns: state.turns + 1, pending: [], final: parseFinal(parsed, state.used), notes: [] };
  }

  // Refused calls are recorded with the same input a run would have had, or what the model wrote for an unknown tool.
  const shown = (call) => (inputFor(call.tool, ctx) ?? call.input);

  async function tools(state) {
    const recorded = { ...state.used };
    const ran = [];
    const notes = [];
    for (const call of state.pending) {
      const verdict = check(call.tool, recorded, ctx);
      if (!verdict.ok) {
        notes.push(`Refused ${call.tool}: ${verdict.reason}`);
        ran.push({ tool: call.tool, input: shown(call), refused: verdict.reason });
        await audit(ctx, call.tool, shown(call), { refused: verdict.reason }, 'refused');
        continue;
      }
      if (SEARCH_TOOLS.includes(call.tool)) await ensureContext(ctx);
      if (!(await ctx.deps.claim(call.tool, SEARCH_TOOLS.includes(call.tool) ? { diagnosis: ctx.diagnosis, v: INPUT_VERSION } : null))) {
        // Another request already took this call for this case.
        const reason = `${call.tool} was already used for this ${call.tool === 'notify' ? 'case' : 'Second Reader diagnosis'}.`;
        recorded[call.tool] = recorded[call.tool] || { claimedElsewhere: true, at: new Date().toISOString(), input: null, output: null, error: null };
        notes.push(`Refused ${call.tool}: ${reason}`);
        ran.push({ tool: call.tool, input: shown(call), refused: reason });
        await audit(ctx, call.tool, shown(call), { refused: reason }, 'refused');
        continue;
      }
      const at = new Date().toISOString();
      let rec;
      try {
        const { input, output } = await runTool(call.tool, ctx);
        rec = { at, input, output, error: null };
      } catch (err) {
        rec = { at, input: inputFor(call.tool, ctx), output: null, error: err.message || 'failed' };
      }
      recorded[call.tool] = rec;
      await ctx.deps.record(call.tool, rec);
      ran.push({ tool: call.tool, ...rec });
      await audit(ctx, call.tool, rec.input, rec.error ? { error: rec.error } : rec.output, rec.error ? 'failed' : 'ran');
    }
    return { used: recorded, pending: [], notes, ran };
  }

  async function finish(state) {
    const answer = state.final || {
      summary: 'The agent stopped before it gave a final answer. Use the tool results below.',
      suggestions: [],
    };
    return { final: answer };
  }

  const route = (state) => (state.pending.length ? 'tools' : 'finish');

  return new StateGraph(AgentState)
    .addNode('reason', reason)
    .addNode('tools', tools)
    .addNode('finish', finish)
    .addEdge(START, 'reason')
    .addConditionalEdges('reason', route, { tools: 'tools', finish: 'finish' })
    .addEdge('tools', 'reason')
    .addEdge('finish', END)
    .compile();
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

function defaultDeps(caseDoc) {
  const caseId = caseDoc.caseId;
  return {
    chat: azureFindings.chatJson,
    tools: {
      searchSimilarCases: agentTools.searchSimilarCases,
      searchGuideline: agentTools.searchGuideline,
      notify: agentTools.notify,
    },
    audit: addAuditLog,
    similarReady: () => embeddings.isConfigured(),
    notifyBlocker: agentTools.notifyBlocker,
    patientContext: evidence.patientContext,
    // A tool is claimed in the database before it runs, so two requests at once cannot both run it.
    // A search claimed or saved for another diagnosis does not block the new one.
    claim: async (tool, key) => {
      await Case.updateOne({ caseId, agentResult: null }, { $set: { agentResult: { tools: {} } } });
      const path = `agentResult.tools.${tool}`;
      const free = [{ [path]: { $exists: false } }];
      if (key) free.push({ [`${path}.input.diagnosis`]: { $ne: key.diagnosis } }, { [`${path}.input.v`]: { $ne: key.v } });
      const res = await Case.updateOne(
        { caseId, $or: free },
        { $set: { [path]: { claimed: true, at: new Date().toISOString(), input: key ? { diagnosis: key.diagnosis, v: key.v } : null } } }
      );
      return res.modifiedCount === 1;
    },
    record: (tool, rec) => Case.updateOne({ caseId }, { $set: { [`agentResult.tools.${tool}`]: rec } }),
    saveFinal: async (fields) => {
      await Case.updateOne({ caseId, agentResult: null }, { $set: { agentResult: { tools: {} } } });
      await Case.updateOne({ caseId }, { $set: Object.fromEntries(Object.entries(fields).map(([k, v]) => [`agentResult.${k}`, v])) });
    },
  };
}

/**
 * Run the agent on one case.
 * @param {{ caseDoc: object, userId: string }} input  caseDoc is the case as a plain object
 * @param {object} [overrides]  replaces parts of the default deps (the tests do this)
 * @returns {Promise<{ agent: object, calls: object[], reused: string[] }>}
 */
async function runAgent({ caseDoc, userId, allowNotify = false } = {}, overrides = {}) {
  if (!caseDoc?.caseId) throw new Error('The agent needs a saved case.');
  const deps = { ...defaultDeps(caseDoc), ...overrides };
  const ctx = { caseDoc, userId, deps };
  // Whether notify may run is worked out once, up front: the model is told it, and check() enforces it.
  // notify is not part of the evidence run the review panel makes: it is offered only when the caller asks for it.
  ctx.notifyBlock = allowNotify
    ? await deps.notifyBlocker(caseDoc)
    : { reason: 'notify is not available: this run is for supporting evidence only.', unavailable: true };
  ctx.diagnosis = diagnosisOf(caseDoc.fusionResult);

  const stored = caseDoc.agentResult?.tools && typeof caseDoc.agentResult.tools === 'object' ? caseDoc.agentResult.tools : {};
  const startTools = {};
  for (const name of TOOL_NAMES) if (stored[name] && isCurrent(name, stored[name], ctx.diagnosis)) startTools[name] = stored[name];
  const reused = Object.keys(startTools);

  const graph = buildGraph(ctx);
  const end = await graph.invoke({ used: startTools }, { recursionLimit: 25 });

  const agent = {
    tools: end.used,
    summary: end.final.summary,
    suggestions: end.final.suggestions,
    notes: toolNotes(end.used),
    endorsedWhenRun: isEndorsed(caseDoc),
    generatedAt: new Date().toISOString(),
  };
  await deps.saveFinal({
    summary: agent.summary,
    suggestions: agent.suggestions,
    notes: agent.notes,
    endorsedWhenRun: agent.endorsedWhenRun,
    generatedAt: agent.generatedAt,
  });
  return { agent, calls: end.ran, reused };
}

module.exports = { runAgent, check, ROLE, TOOL_NAMES, AUDIT_ACTION };
