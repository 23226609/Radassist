// scripts/test-second-opinion-panel.mjs
//
// The Second Reader panel (the second-opinion AI) on the review page: the summary, the diagnosis, the
// differentials and the suggested next step, as plain reference text. It has no
// Accept and no Edit, it never changes a sentence tag, a film box or the
// report, and it runs only when the radiologist asks, on a saved draft.
//
//   node scripts/test-second-opinion-panel.mjs

import assert from "node:assert";
import { parseHTML } from "linkedom";

const { window, document } = parseHTML(
  "<!doctype html><html><body><div id='root'></div></body></html>"
);
globalThis.window = window;
globalThis.document = document;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const selectProto = window.HTMLSelectElement?.prototype;
if (selectProto && !Object.getOwnPropertyDescriptor(selectProto, "value")?.set) {
  Object.defineProperty(selectProto, "value", {
    configurable: true,
    get() { return this.getAttribute("value") ?? ""; },
    set(v) { this.setAttribute("value", String(v)); },
  });
}
URL.createObjectURL = () => "blob:test";
URL.revokeObjectURL = () => {};
window.confirm = () => true;
globalThis.confirm = () => true;
if (!window.location?.href) {
  Object.defineProperty(window, "location", { configurable: true, value: new URL("http://localhost:5173/") });
}

const { state } = await import("../src/state.js");
const { api } = await import("../src/api.js");
const { renderReviewPage, stopReviewWatch } = await import("../src/components/review.js");

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
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const S1 = "Right lower zone consolidation.";
const S2 = "Heart size is normal.";
const S3 = "No pleural effusion.";
const REPORT = ["XRAY CHEST (PA)", "", "FINDINGS", S1, S2, S3, "", "COMMENT", "– Consolidation.", ].join("\n");

const tag = (key, text, abnormal) => ({ key, text, abnormal, manual: false, kind: "" });
const box = (tagKey, text) => ({
  _id: `az-${tagKey}`, label: text, severity: "significant", bbox: [10, 60, 80, 20], source: "Azure",
  bboxSource: "vision", sentence: text, status: "pending", confidence: 0.7, tagKey,
});

const OPINION = {
  summary: "The film and the history together suggest a right lower zone infection.",
  diagnosis: "Right lower lobe pneumonia",
  differentials: [
    { diagnosis: "Pneumonia", supporting: ["Fever", "Cough"], against: ["No sputum result"], confidence: "high" },
    { diagnosis: "Atelectasis", supporting: ["Volume loss"], against: [], confidence: "low" },
  ],
  suggested_next_step: "Compare with the earlier film. Ask for a sputum culture.",
  generatedAt: "2026-11-20T09:00:00.000Z",
};
// What an old Fusion run left in the same field.
const OLD_FUSION = {
  agreed: [{ tagKey: "t1", reason: "old merge row" }], conflicts: [], missing_info: ["old missing row"],
  recommendation: "old recommendation", final_sentences: [], review: { agreed: [{ status: "pending", text: "" }] },
};

let server;
const calls = [];
function resetServer(overrides = {}) {
  server = {
    caseId: "CASE-SO-1", patientId: "PT-SO-1", firstName: "Pat", lastName: "Second", age: "60", sex: "Male",
    status: "pending_approve", analysisState: "done", boxesState: "done", view: "PA",
    reportText: REPORT,
    findingTags: [tag("t1", S1, true), tag("t2", S2, false), tag("t3", S3, false)],
    comment: "Consolidation.", remarks: "", diagnosis: "Consolidation", imageId: "img-1",
    findings: [box("t1", S1)], measurements: [], editLog: [],
    historyAnalysis: null, fusionResult: null,
    ...overrides,
  };
  calls.length = 0;
}

let patient;
api.getPatient = async (id) => {
  calls.push(["patient", id]);
  if (patient instanceof Error) throw patient;
  return { patient: structuredClone(patient) };
};
api.getCase = async () => ({ case: structuredClone(server) });
api.listCases = async () => ({ cases: [structuredClone(server)] });
api.fetchImage = async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
api.updateCase = async (_id, payload) => {
  calls.push(["update", payload]);
  server = { ...server, ...payload };
  return { case: structuredClone(server) };
};
let opinionReply;
let opinionDelay = 0;
api.secondOpinion = async (id, sepsisScreen) => {
  calls.push(["second-opinion", id, sepsisScreen]);
  if (opinionDelay) await tick(opinionDelay);
  const reply = typeof opinionReply === "function" ? opinionReply() : opinionReply;
  if (reply instanceof Error) throw reply;
  server = { ...server, fusionResult: reply };
  return { success: true, secondOpinion: reply, case: structuredClone(server) };
};
// The agent's saved search results, for a diagnosis. What the server stores on Case.agentResult.
const agentFor = (diagnosis) => ({
  tools: {
    search_similar_cases: { at: "2026-11-20T09:00:05.000Z", input: { v: 2, diagnosis, context: "67-year-old female, persistent cough" }, error: null, output: { compared: 358, note: "", results: [
      { caseId: "CASE-MIMIC-111", similarity: 0.6401, diagnosisMatch: "same", whySimilar: "left lower lobe + pneumonia", outcome: "Course on the report: Pneumonia has improved compared with the prior study.", line: "Probable left lower lobe pneumonia.", officialReport: "FINAL REPORT FINDINGS: x IMPRESSION: Probable left lower lobe pneumonia.", source: "MIMIC-CXR" },
      { caseId: "CASE-MIMIC-222", similarity: 0.5, diagnosisMatch: "related", whySimilar: "lower lobe consolidation", outcome: "", line: "Left lower lobe consolidation compatible with pneumonia.", officialReport: "r2", source: "MIMIC-CXR" },
      { caseId: "CASE-MIMIC-333", similarity: 0.55, diagnosisMatch: "different", whySimilar: "", outcome: "", line: "Left lower lobe pneumonia.", officialReport: "r3", source: "MIMIC-CXR" },
    ] } },
    search_guideline: { at: "2026-11-20T09:00:06.000Z", input: { v: 2, diagnosis, query: "Right lower lobe pneumonia", context: "67-year-old female, persistent cough" }, error: null, output: { note: "", sourceErrors: [], results: [
      { source: "Radiopaedia", title: "Lobar pneumonia", url: "https://radiopaedia.org/articles/lobar-pneumonia", bullets: { lookFor: "Homogeneous consolidation with air bronchograms.", ruleOut: "Pulmonary oedema and infarction.", next: "Repeat the film after treatment." } },
      { source: "NICE", title: "NICE QS110", url: "https://www.nice.org.uk/guidance/qs110", bullets: { lookFor: "Lobar consolidation on the chest X-ray.", ruleOut: "", next: "Follow-up film if symptoms persist." } },
    ] } },
  },
  summary: "The agent's own summary is not shown in the panel.", suggestions: [{ text: "Not shown either.", sources: [] }], notes: [],
});
const NONE_FOUND = (diagnosis) => ({
  tools: {
    search_similar_cases: { at: "x", input: { v: 2, diagnosis, context: "" }, error: null, output: { compared: 358, note: "No imported case was similar enough (cut-off 0.5).", results: [] } },
    search_guideline: { at: "x", input: { v: 2, diagnosis, query: "Right lower lobe pneumonia", context: "" }, error: null, output: { note: "none", sourceErrors: [], results: [] } },
  },
});
let agentReply;
let agentDelay = 0;
const realRunAgent = api.runAgent;
api.runAgent = async (id) => {
  calls.push(["agent", id]);
  if (agentDelay) await tick(agentDelay);
  const reply = typeof agentReply === "function" ? agentReply(server.fusionResult?.diagnosis) : agentReply;
  if (reply instanceof Error) throw reply;
  server = { ...server, agentResult: reply };
  return { success: true, agent: reply, case: structuredClone(server) };
};
api.finalizeCase = async () => {
  calls.push(["finalize"]);
  server = { ...server, status: "finalized", finalizedByName: "Dr Test" };
  return { case: structuredClone(server) };
};

const root = document.getElementById("root");
const click = async (node, ms = 30) => {
  assert.ok(node, "control not found");
  node.dispatchEvent(new window.Event("click"));
  await tick(ms);
};
const button = (label) => [...root.querySelectorAll("button")].find((b) => b.textContent.replace(/\s+/g, " ").trim() === label);
const panel = () => root.querySelector("#second-opinion-panel");
const run = () => root.querySelector("#run-second-opinion");
const toggle = () => root.querySelector("#toggle-second-opinion");
const callsTo = (name) => calls.filter((c) => c[0] === name);

const QUIET_PATIENT = { patientId: "PT-SO-1", heartRate: "76 bpm", observations: [
  { at: "2026-11-20T04:00:00.000Z", hr: "76", rr: "16", sbp: "118", spo2: "98", temp: "36.6", wbc: "7.2", lactate: "0.9", crp: "4" },
] };
const URGENT_PATIENT = { patientId: "PT-SO-1", heartRate: "118 bpm", observations: [
  { at: "2026-11-20T03:00:00.000Z", hr: "100", rr: "20", sbp: "110", spo2: "95", temp: "37.2" },
  { at: "2026-11-20T04:00:00.000Z", hr: "118", rr: "28", sbp: "98", spo2: "89", temp: "38.4", wbc: "15", lactate: "3.1", crp: "64" },
] };

// The panel opens closed. Most tests want the text, so open() opens it when a result exists.
async function open(role = "radiologist", overrides = {}, { expand = true } = {}) {
  stopReviewWatch();
  resetServer(overrides);
  patient = structuredClone(QUIET_PATIENT);
  opinionReply = structuredClone(OPINION);
  opinionDelay = 0;
  agentReply = (d) => agentFor(d);
  agentDelay = 0;
  state.user = { role, userId: "u1", name: "Dr Test" };
  state.cases = [structuredClone(server)];
  state.selectedCaseId = server.caseId;
  state.page = "review";
  root.innerHTML = "";
  await renderReviewPage({ target: root });
  await tick();
  if (expand && toggle()?.getAttribute("aria-expanded") === "false") await click(toggle());
}
const tagsBefore = () => JSON.stringify(server.findingTags);
const boxesBefore = () => JSON.stringify(server.findings);

console.log("\n=== before the second opinion has run ===");
await open("radiologist");

await test("a radiologist sees a Second Reader panel with a Run button, and no old Fusion panel", () => {
  assert.ok(panel());
  assert.equal(panel().querySelector("h2").textContent.trim(), "Second Reader");
  assert.ok(!/AI [Ss]uggestion/.test(root.textContent), "the words AI Suggestion are not shown");
  assert.ok(run());
  assert.match(panel().textContent, /Not run yet/);
  assert.equal(toggle(), null, "nothing to open yet");
  assert.equal(root.querySelector("#fusion-panel"), null);
  assert.equal(root.querySelector("#run-fusion"), null);
  const old = root.textContent.match(/.{0,30}\b(fusion|agreed|missing info|reviewed)\b.{0,30}/i);
  assert.ok(!old, `no trace of the old Fusion wording: ${old && old[0]}`);
});

await test("the History-and-Fusion client call is gone from the frontend", () => {
  assert.equal(api.reasonCase, undefined);
});

await test("Run Second Reader calls the new route once, and shows the four parts as plain text", async () => {
  await click(run(), 80);
  assert.equal(callsTo("second-opinion").length, 1);
  assert.equal(callsTo("second-opinion")[0][1], "CASE-SO-1");
  assert.match(root.querySelector("#so-summary").textContent, /right lower zone infection/);
  assert.match(root.querySelector("#so-diagnosis").textContent, /Diagnosis: Right lower lobe pneumonia/);
  const list = root.querySelector("#so-differentials");
  assert.ok(list.textContent.includes("Pneumonia (high confidence)"));
  assert.ok(list.textContent.includes("For: Fever; Cough") && list.textContent.includes("Against: No sputum result"));
  assert.ok(list.textContent.includes("Atelectasis (low confidence)"));
  assert.match(root.querySelector("#so-next-step").textContent, /Suggested next step: Compare with the earlier film/);
});

await test("the panel is reference only: no Accept, no Edit, no field to type in", () => {
  const p = panel();
  assert.deepEqual([...p.querySelectorAll("button")].map((b) => b.textContent.trim()).sort(), ["Hide", "Run again"]);
  assert.equal(p.querySelectorAll("textarea, input, select, [contenteditable]").length, 0);
  assert.ok(!/\b(accept|edit|undo)\b/i.test(p.textContent.replace(/Edit the report in Findings above/, "")));
  assert.ok(p.textContent.includes("Reference only. An AI that has not seen the report wrote this. Edit the report in Findings above; only a radiologist endorses it."));
  assert.equal(run().textContent.trim(), "Run again");
  assert.equal(toggle().textContent.trim(), "Hide");
});

await test("running it changes no sentence, box or stored report, and saves nothing", () => {
  assert.equal(callsTo("update").length, 0);
  assert.equal(callsTo("finalize").length, 0);
  assert.equal(server.reportText, REPORT);
  assert.equal(server.status, "pending_approve");
  assert.equal(root.querySelectorAll("#tag-list > li[data-tag]").length, 3);
});

console.log("\n=== one merged panel: Second Reader, then the agent's supporting evidence ===");

await test("the Second Reader diagnosis and the agent's similar cases and guideline are in one panel, in the agreed order", async () => {
  await open("radiologist");
  await click(run(), 120);
  assert.equal(root.querySelectorAll("#second-opinion-panel").length, 1);
  assert.equal(root.querySelector("#agent-panel"), null, "no separate Agent panel");
  const p = panel();
  assert.ok(p.querySelector("#so-diagnosis") && p.querySelector("#agent-evidence"), "both are inside the one panel");
  const order = ["Second Reader", "A different AI from CURV.", "Diagnosis: Right lower lobe pneumonia", "Suggested next step", "Agent — Supporting evidence", "Similar cases (3)", "Guideline (up to 2)", "Reference only."]
    .map((t) => p.textContent.indexOf(t));
  assert.ok(order.every((n) => n >= 0), `a part is missing: ${order}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "heading, subtitle, Second Reader, evidence, disclaimer from top to bottom");
});

await test("the subtitle is the agreed text, and the disclaimer is last", () => {
  assert.equal(root.querySelector("#so-subtitle").textContent.trim(),
    "A different AI from CURV. CURV reads the image only — this reader also reads medical history, medicines, labs and sepsis screen. It has not seen CURV's report.");
  const text = panel().textContent.replace(/\s+/g, " ").trim();
  assert.ok(text.endsWith("Reference only. An AI that has not seen the report wrote this. Edit the report in Findings above; only a radiologist endorses it."));
});

await test("similar cases: id, similarity and one line of the official report for each of three", () => {
  const rows = [...root.querySelectorAll("#agent-similar-cases li")];
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.dataset.similarCase), ["CASE-MIMIC-111", "CASE-MIMIC-222", "CASE-MIMIC-333"]);
  assert.match(rows[0].textContent, /CASE-MIMIC-111/);
  assert.match(rows[0].textContent, /similarity 0\.64/);
  assert.match(rows[0].textContent, /Probable left lower lobe pneumonia\./);
  assert.match(rows[1].textContent, /similarity 0\.50/);
  assert.equal(root.querySelector("#agent-similar-empty"), null);
});

await test("similar cases: Why similar on each case that has features, Outcome only where the record has one", () => {
  const rows = [...root.querySelectorAll("#agent-similar-cases > ul > li")];
  assert.equal(rows.length, 3);
  assert.match(rows[0].querySelector("[data-why-similar]").textContent, /^Why similar: left lower lobe \+ pneumonia$/);
  assert.match(rows[1].querySelector("[data-why-similar]").textContent, /^Why similar: lower lobe consolidation$/);
  assert.match(rows[0].querySelector("[data-outcome]").textContent, /^Outcome: Course on the report: Pneumonia has improved/);
  assert.equal(rows[1].querySelector("[data-outcome]"), null, "no outcome in the record: no Outcome line");
  assert.equal(rows[2].querySelector("[data-outcome]"), null);
  assert.equal(rows[2].querySelector("[data-why-similar]"), null, "no checked shared feature: no Why similar line, nothing made up");
});

await test("guideline: source name and link, and the three checklist bullets the source gave", () => {
  const rows = [...root.querySelectorAll("#agent-guidelines > ul > li")];
  assert.deepEqual(rows.map((r) => r.dataset.guidelineSource), ["Radiopaedia", "NICE"]);
  const bullets = [...rows[0].querySelectorAll("li")].map((b) => b.textContent);
  assert.deepEqual(bullets, [
    "Look for: Homogeneous consolidation with air bronchograms.",
    "Rule out: Pulmonary oedema and infarction.",
    "Next: Repeat the film after treatment.",
  ]);
  assert.equal(rows[0].querySelector("a").textContent, "Lobar pneumonia");
  assert.equal(rows[0].querySelector("a").getAttribute("href"), "https://radiopaedia.org/articles/lobar-pneumonia");
  assert.deepEqual([...rows[1].querySelectorAll("li")].map((b) => b.dataset.checklist), ["Look for", "Next"], "a bullet the source did not give is left out");
  const link = rows[1].querySelector("a");
  assert.equal(link.getAttribute("href"), "https://www.nice.org.uk/guidance/qs110");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.match(link.getAttribute("rel"), /noopener/);
  assert.equal(root.querySelector("#agent-guideline-empty"), null);
});

await test("the agent's own summary and suggestions are not shown, and the panel has only Run again and Hide", () => {
  assert.ok(!/agent's own summary|Not shown either/.test(root.textContent));
  assert.deepEqual([...panel().querySelectorAll("button")].map((b) => b.textContent.trim()).sort(), ["Hide", "Run again"]);
});

await test("one Run runs the Second Reader first and then the agent, once each, and sends no notify", async () => {
  await open("radiologist");
  await click(run(), 150);
  assert.deepEqual(calls.filter((c) => ["second-opinion", "agent"].includes(c[0])).map((c) => c[0]), ["second-opinion", "agent"]);
  assert.equal(callsTo("agent")[0][1], "CASE-SO-1");
  await click(run(), 150);
  assert.deepEqual(calls.filter((c) => ["second-opinion", "agent"].includes(c[0])).map((c) => c[0]), ["second-opinion", "agent", "second-opinion", "agent"]);
  assert.equal(callsTo("finalize").length, 0);
});

await test("the real client call posts an empty body to the agent route: it never asks for notify", async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push([String(url), init.method, init.body]); return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }); };
  try { await realRunAgent("CASE-X/1"); } finally { globalThis.fetch = realFetch; }
  assert.equal(sent.length, 1);
  assert.match(sent[0][0], /\/cases\/CASE-X%2F1\/agent$/);
  assert.equal(sent[0][1], "POST");
  assert.ok(!/notify/i.test(String(sent[0][2])));
});

await test("one Hide hides the whole merged panel body, evidence included, and Show brings it back", async () => {
  await open("radiologist", { fusionResult: structuredClone(OPINION), agentResult: agentFor(OPINION.diagnosis) });
  assert.ok(root.querySelector("#agent-evidence"));
  await click(toggle());
  assert.equal(root.querySelector("#second-opinion-body"), null);
  assert.equal(root.querySelector("#agent-evidence"), null);
  assert.equal(root.querySelector("#so-subtitle"), null);
  await click(toggle());
  assert.ok(root.querySelector("#agent-evidence"));
});

await test("nothing found: it says so and shows no case and no passage", async () => {
  agentReply = (d) => NONE_FOUND(d);
  await open("radiologist");
  agentReply = (d) => NONE_FOUND(d);
  await click(run(), 150);
  assert.match(root.querySelector("#agent-similar-empty").textContent, /^No similar cases found$/);
  assert.match(root.querySelector("#agent-guideline-empty").textContent, /^No relevant guideline found$/);
  assert.equal(root.querySelectorAll("#agent-evidence li").length, 0);
  assert.ok(root.querySelector("#so-diagnosis"), "the Second Reader is still shown");
});

await test("if the agent fails the Second Reader stays, the reason is shown, and nothing is made up", async () => {
  await open("radiologist");
  agentReply = new Error("The agent is down");
  await click(run(), 150);
  assert.match(root.querySelector("#so-diagnosis").textContent, /Right lower lobe pneumonia/);
  assert.match(root.querySelector("#agent-similar-empty").textContent, /Not searched: The agent is down/);
  assert.equal(root.querySelectorAll("#agent-evidence li").length, 0);
  assert.equal(run().disabled, false);
  assert.match(root.textContent, /supporting evidence could not be fetched/);
});

await test("a search that errored says so instead of showing nothing", async () => {
  const bad = agentFor(OPINION.diagnosis);
  bad.tools.search_similar_cases = { at: "x", input: { v: 2, diagnosis: OPINION.diagnosis }, output: null, error: "embedding service down" };
  await open("radiologist", { fusionResult: structuredClone(OPINION), agentResult: bad });
  assert.match(root.querySelector("#agent-similar-empty").textContent, /did not run: embedding service down/);
  assert.equal(root.querySelectorAll("#agent-similar-cases li").length, 0);
  assert.equal(root.querySelectorAll("#agent-guidelines > ul > li").length, 2);
});

await test("evidence searched for another diagnosis is not shown under this one", async () => {
  await open("radiologist", { fusionResult: structuredClone(OPINION), agentResult: agentFor("Pleural effusion") });
  assert.equal(root.querySelectorAll("#agent-evidence li").length, 0);
  assert.match(root.querySelector("#agent-similar-empty").textContent, /Not searched for this diagnosis yet/);
  assert.match(root.querySelector("#agent-guideline-empty").textContent, /Not searched for this diagnosis yet/);
});

await test("a search saved by the older version (no v 2) is not shown, and a source with no checklist line is skipped", async () => {
  const old = agentFor(OPINION.diagnosis);
  delete old.tools.search_similar_cases.input.v;
  old.tools.search_guideline.output.results.push({ source: "StatPearls", title: "Pneumonia", url: "https://pubmed.ncbi.nlm.nih.gov/1/", bullets: { lookFor: "", ruleOut: "", next: "" } });
  old.tools.search_guideline.output.results.push({ source: "StatPearls", title: "Old", url: "https://pubmed.ncbi.nlm.nih.gov/2/", passage: "Pneumonia is an infection of the lung." });
  await open("radiologist", { fusionResult: structuredClone(OPINION), agentResult: old });
  assert.match(root.querySelector("#agent-similar-empty").textContent, /Not searched for this diagnosis yet/);
  assert.equal(root.querySelectorAll("#agent-similar-cases li").length, 0);
  const rows = [...root.querySelectorAll("#agent-guidelines > ul > li")];
  assert.deepEqual(rows.map((r) => r.dataset.guidelineSource), ["Radiopaedia", "NICE"], "a source with no lines, and an old passage, are not shown");
  assert.ok(!/infection of the lung/.test(root.textContent), "no definition is shown");
});

await test("while the agent looks things up the panel says so and shows Searching…, with the Second Reader already visible", async () => {
  await open("radiologist");
  agentDelay = 200;
  run().dispatchEvent(new window.Event("click"));
  await tick(120);
  assert.equal(run().disabled, true);
  assert.match(root.querySelector("#second-opinion-working").textContent, /Looking up similar cases and guidelines.*20 to 60 seconds/);
  assert.ok(root.querySelector("#so-diagnosis"), "the Second Reader shows before the evidence is ready");
  assert.match(root.querySelector("#agent-similar-empty").textContent, /^Searching…$/);
  await tick(300);
  assert.equal(root.querySelectorAll("#agent-similar-cases li").length, 3);
  assert.equal(root.querySelector("#second-opinion-working"), null);
});

await test("evidence text is shown as text, and a link that is not http(s) is not a link", async () => {
  const evil = agentFor(OPINION.diagnosis);
  evil.tools.search_similar_cases.output.results[0].line = "<img src=x onerror=alert(1)>";
  evil.tools.search_guideline.output.results[0].url = "javascript:alert(1)";
  evil.tools.search_guideline.output.results[0].bullets.lookFor = "<b>bold</b>";
  evil.tools.search_similar_cases.output.results[0].whySimilar = "<i>x</i>";
  await open("radiologist", { fusionResult: structuredClone(OPINION), agentResult: evil });
  assert.equal(panel().querySelector("img"), null);
  assert.equal(panel().querySelector("b + b, i"), null);
  assert.ok(panel().textContent.includes("<img src=x onerror=alert(1)>"));
  assert.ok(panel().textContent.includes("<b>bold</b>") && panel().textContent.includes("<i>x</i>"));
  const rows = [...root.querySelectorAll("#agent-guidelines > ul > li")];
  assert.equal(rows[0].querySelector("a"), null);
  assert.ok(rows[1].querySelector("a"));
});

await test("it changes no sentence, box or report, and a technician or referring doctor never see the evidence", async () => {
  for (const role of ["technician", "doctor"]) {
    await open(role, { fusionResult: structuredClone(OPINION), agentResult: agentFor(OPINION.diagnosis) });
    assert.equal(root.querySelector("#agent-evidence"), null, role);
    assert.ok(!/CASE-MIMIC-111/.test(root.textContent), role);
  }
  await open("radiologist");
  const before = [tagsBefore(), boxesBefore(), server.reportText];
  await click(run(), 150);
  assert.deepEqual([tagsBefore(), boxesBefore(), server.reportText], before);
  assert.equal(callsTo("update").length, 0);
});

console.log("\n=== the sepsis screen sent with the request ===");

await test("it is worked out from the patient's latest saved observations", async () => {
  await open("radiologist");
  patient = structuredClone(URGENT_PATIENT);
  await click(run(), 80);
  const [, , screen] = callsTo("second-opinion")[0];
  assert.deepEqual(callsTo("patient")[0], ["patient", "PT-SO-1"]);
  assert.equal(screen.level, "urgent");
  assert.equal(typeof screen.score, "number");
  assert.ok(screen.score >= 0 && screen.score <= 100);
  assert.ok(screen.reasons.some((r) => /respiratory rate/i.test(r)));
  assert.ok(!screen.reasons.includes("Unacknowledged alert"));
});

await test("a quiet chart sends level none", async () => {
  await open("radiologist");
  await click(run(), 80);
  assert.equal(callsTo("second-opinion")[0][2].level, "none");
});

await test("no observations, or a chart that cannot be read, sends no screen and still runs", async () => {
  await open("radiologist");
  patient = { patientId: "PT-SO-1", observations: [] };
  await click(run(), 80);
  assert.equal(callsTo("second-opinion")[0][2], null);
  await open("radiologist");
  patient = new Error("403 forbidden");
  await click(run(), 80);
  assert.equal(callsTo("second-opinion").length, 1);
  assert.equal(callsTo("second-opinion")[0][2], null);
  assert.ok(root.querySelector("#so-diagnosis"), "the opinion still appears");
});

console.log("\n=== it runs on a saved draft ===");

await test("with unsaved edits the Run button is off, and it says to save first", async () => {
  await open("radiologist");
  assert.equal(run().disabled, false);
  const del = [...root.querySelectorAll("#tag-list > li[data-tag='t3'] button")].find((b) => /delete/i.test(b.textContent));
  await click(del, 40);
  assert.equal(root.querySelectorAll("#tag-list > li[data-tag]").length, 2, "the edit took");
  assert.equal(run().disabled, true);
  assert.match(run().title, /Save draft first/);
  assert.match(root.querySelector("#second-opinion-save-first").textContent, /Save the draft/);
  await click(run(), 40);
  assert.equal(callsTo("second-opinion").length, 0, "no call while the draft is unsaved");
});

await test("after Save draft the button is on again and runs", async () => {
  await click(root.querySelector("#save-draft"), 80);
  assert.equal(callsTo("update").length, 1);
  assert.equal(run().disabled, false);
  assert.equal(root.querySelector("#second-opinion-save-first"), null);
  await click(run(), 80);
  assert.equal(callsTo("second-opinion").length, 1);
  assert.ok(callsTo("update").length === 1, "running it saved nothing more");
});

await test("it does not run by itself: opening the page, saving a draft and endorsing never call it", async () => {
  await open("radiologist");
  await click(root.querySelector("#save-draft"), 60);
  assert.equal(callsTo("second-opinion").length, 0);
  await click(button("Endorse report"), 80);
  assert.equal(callsTo("finalize").length, 1);
  assert.equal(callsTo("second-opinion").length, 0);
  assert.equal(callsTo("agent").length, 0, "the agent does not run by itself either");
});

console.log("\n=== the Working… state ===");

await test("it shows Working… and a status line, disables the button, and sends one request for a double click", async () => {
  await open("radiologist");
  opinionDelay = 150;
  run().dispatchEvent(new window.Event("click"));
  run().dispatchEvent(new window.Event("click"));
  await tick(40);
  assert.equal(run().textContent.trim(), "Working…");
  assert.equal(run().disabled, true);
  assert.match(root.querySelector("#second-opinion-working").textContent, /Reading the X-ray and the patient chart/);
  assert.equal(root.querySelector("#second-opinion-working").getAttribute("role"), "status");
  await tick(250);
  assert.equal(callsTo("second-opinion").length, 1);
  assert.equal(root.querySelector("#second-opinion-working"), null);
  assert.equal(run().textContent.trim(), "Run again");
});

await test("a failed run shows the reason, keeps the earlier opinion and turns the button back on", async () => {
  await open("radiologist", { fusionResult: structuredClone(OPINION) });
  opinionReply = new Error("Azure OpenAI 500 : upstream said no");
  await click(run(), 60);
  assert.match(root.textContent, /upstream said no/);
  assert.equal(run().disabled, false);
  assert.match(root.querySelector("#so-diagnosis").textContent, /Right lower lobe pneumonia/);
});

console.log("\n=== a stored opinion, and old data ===");

await test("a stored opinion loads closed, with the diagnosis in the header and Show to open it", async () => {
  await open("radiologist", { fusionResult: structuredClone(OPINION) }, { expand: false });
  assert.equal(root.querySelector("#second-opinion-body"), null);
  assert.match(panel().textContent, /Likely: Right lower lobe pneumonia/);
  assert.equal(toggle().textContent.trim(), "Show");
  await click(toggle());
  assert.ok(root.querySelector("#second-opinion-body"));
  assert.equal(toggle().textContent.trim(), "Hide");
  await click(toggle());
  assert.equal(root.querySelector("#second-opinion-body"), null);
});

await test("an old Fusion result (agreed / conflicts) is not shown, and the panel reads Not run yet", async () => {
  await open("radiologist", { fusionResult: structuredClone(OLD_FUSION) });
  assert.match(panel().textContent, /Not run yet/);
  assert.ok(!/old merge row|old missing row|old recommendation/.test(root.textContent));
  assert.equal(toggle(), null);
});

await test("malformed answers do not break the page", async () => {
  for (const bad of [{ diagnosis: "x" }, { diagnosis: "x", differentials: "no", summary: 5 }, { diagnosis: "x", differentials: [null, { diagnosis: "d" }, 3] }]) {
    await open("radiologist", { fusionResult: bad });
    assert.ok(root.querySelector("#so-diagnosis"), JSON.stringify(bad));
  }
});

await test("text from the model is shown as text, never as HTML", async () => {
  await open("radiologist", { fusionResult: { ...OPINION, diagnosis: "<img src=x onerror=alert(1)>", summary: "<b>bold</b>" } });
  assert.equal(panel().querySelector("img"), null);
  assert.equal(panel().querySelector("b + b"), null);
  assert.ok(panel().textContent.includes("<img src=x onerror=alert(1)>"));
});

console.log("\n=== who sees it ===");

await test("an admin gets the same panel", async () => {
  await open("admin");
  assert.ok(panel() && run());
});

await test("a technician and a referring doctor get no panel", async () => {
  for (const role of ["technician", "doctor"]) {
    await open(role, { fusionResult: structuredClone(OPINION) });
    assert.equal(panel(), null, role);
    assert.equal(run(), null, role);
  }
});

await test("on an endorsed report the opinion can still be read, but there is no Run button", async () => {
  await open("radiologist", { status: "finalized", finalizedByName: "Dr Test", fusionResult: structuredClone(OPINION) });
  assert.ok(panel());
  assert.equal(run(), null);
  assert.equal(callsTo("second-opinion").length, 0);
});

await test("an endorsed report with no opinion shows no panel", async () => {
  await open("radiologist", { status: "finalized", finalizedByName: "Dr Test" });
  assert.equal(panel(), null);
});

await test("while CURV is still writing the report there is no panel", async () => {
  await open("radiologist", { analysisState: "running", status: "pending" });
  assert.equal(panel(), null);
});

console.log("\n=== layout ===");

await test("closed it is only a header; open it is capped and the report keeps a minimum height", async () => {
  await open("radiologist", { fusionResult: structuredClone(OPINION) }, { expand: false });
  assert.ok(!/lg:max-h/.test(panel().className));
  assert.equal(root.querySelector("[class*='lg:min-h-[26rem]']"), null);
  await click(toggle());
  assert.match(panel().className, /lg:max-h-\[40vh\]/);
  assert.match(panel().className, /lg:overflow-y-auto/);
  assert.ok(root.querySelector("[class*='lg:min-h-[26rem]']"), "the report keeps a readable height");
});

await test("running it opens the panel", async () => {
  await open("radiologist", {}, { expand: false });
  await click(run(), 80);
  assert.ok(root.querySelector("#second-opinion-body"));
});

await test("it leaves the sentence tags and the boxes alone through a full run", async () => {
  await open("radiologist");
  const before = [tagsBefore(), boxesBefore()];
  await click(run(), 80);
  assert.deepEqual([tagsBefore(), boxesBefore()], before);
  assert.equal(root.querySelectorAll("#tag-list > li[data-tag]").length, 3);
});

stopReviewWatch();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
