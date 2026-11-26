// scripts/test-lay-summary-ui.mjs
//
// Phase 4 on screen: the patient's page (endorsed report first, then the plain-language summary with an
// English / 繁體中文 toggle and the disclaimer under each), and the clinician's small Patient view preview,
// which is closed by default.
//
//   node scripts/test-lay-summary-ui.mjs

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

const { state, subscribe } = await import("../src/state.js");
const { api } = await import("../src/api.js");
const { renderReviewPage, stopReviewWatch } = await import("../src/components/review.js");
const { renderMyReportsPage } = await import("../src/components/myReports.js");
const { Shell } = await import("../src/components/header.js");
const roles = await import("../src/lib/roles.js");

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

const REPORT = ["XRAY CHEST (PA)", "", "FINDINGS", "Right lower zone consolidation.", "Heart size is normal.", "", "COMMENT", "– Consolidation."].join("\n");
const LAY = {
  english: {
    found: "The X-ray shows a cloudy area in the lower right lung.",
    meaning: "This can happen when the lung is infected.",
    next: "Your doctor will go through the report with you.",
    help: "See a doctor if you have trouble breathing.",
    disclaimer: "This is an explanation aid, not a diagnosis. If you are worried, speak to your doctor.",
  },
  traditionalChinese: {
    found: "胸部X光顯示右肺下部有一片模糊的陰影。",
    meaning: "這可能是肺部受到感染所致。",
    next: "醫生會與您一同檢視這份報告。",
    help: "如出現呼吸困難，請盡快求醫。",
    disclaimer: "本摘要僅供參考，並非診斷。如有擔心，請諮詢醫生。",
  },
};
const finalCase = (extra = {}) => ({
  caseId: "CASE-LAY-1", patientId: "PT-1", firstName: "Mei", lastName: "Chen", age: "67", sex: "Female",
  status: "finalized", finalizedByName: "Dr Rad", finalizedAt: "2026-11-20T09:00:00.000Z", view: "PA",
  reportText: REPORT, laySummary: structuredClone(LAY), laySummaryState: "done", ...extra,
});

const root = document.getElementById("root");
const click = async (node, ms = 30) => {
  assert.ok(node, "control not found");
  node.dispatchEvent(new window.Event("click"));
  await tick(ms);
};
const text = (n) => (n?.textContent || "").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- the patient's page
let listed = [];
let listError = null;
api.listCases = async () => {
  if (listError) throw listError;
  return { cases: structuredClone(listed) };
};
// main.js draws the page again on every state change; do the same here.
let pageTarget = null;
subscribe(() => { if (pageTarget && state.page === "my-reports") renderMyReportsPage({ target: pageTarget }); });
async function openPatient(cases) {
  listed = cases;
  state.user = { role: "patient", userId: "p1", name: "Mei Chen", patientId: "PT-1" };
  state.selectedCaseId = null;
  state.patientBrowse = false;
  state.page = "my-reports";
  root.innerHTML = "";
  pageTarget = root;
  renderMyReportsPage({ target: root });
  await tick(30);
}

console.log("\n=== the patient's page ===");
await openPatient([finalCase()]);

await test("two columns on one screen: the plain-language summary on the left, the report on the right", () => {
  const report = root.querySelector("#endorsed-report");
  const lay = root.querySelector("#lay-summary");
  assert.ok(report && lay);
  assert.ok(lay.compareDocumentPosition(report) & 4, "the summary comes first (left), the report second (right)");
  assert.equal(lay.parentNode, report.parentNode, "both are in the same grid");
  assert.match(root.querySelector("#patient-report-view").className, /md:grid-cols-2/);
  assert.match(root.querySelector("#my-reports").className, /md:overflow-hidden/, "the page itself does not scroll on a laptop");
  assert.ok(!/CASE-LAY-1/.test(text(report)), "the report header shows the date, not the case ID");
  assert.match(text(root.querySelector("#endorsed-report-meta")), /^2026\/11\/20 · endorsed by Dr Rad$/);
  assert.match(text(root.querySelector("#endorsed-report-text")), /Right lower zone consolidation\./);
  assert.match(text(report), /endorsed by Dr Rad/);
});

await test("English shows by default with the four parts, and the disclaimer under it", () => {
  const parts = [...root.querySelectorAll("#lay-summary [data-lay-part]")].map((p) => p.dataset.layPart);
  assert.deepEqual(parts, ["found", "meaning", "next", "help"]);
  assert.match(text(root.querySelector("#lay-summary-body")), /The X-ray shows a cloudy area/);
  assert.equal(text(root.querySelector("#lay-summary-disclaimer")), LAY.english.disclaimer);
  const headings = [...root.querySelectorAll("#lay-summary h3")].map(text);
  assert.deepEqual(headings, ["What we found", "What it means in plain words", "What happens next", "When to seek help sooner"]);
  assert.equal(root.querySelector("#lay-lang-en").getAttribute("aria-pressed"), "true");
});

await test("the 繁體中文 toggle switches to the Chinese version, with its own disclaimer, and back", async () => {
  assert.equal(text(root.querySelector("#lay-lang-zh")), "繁體中文");
  await click(root.querySelector("#lay-lang-zh"));
  assert.match(text(root.querySelector("#lay-summary-body")), /胸部X光顯示右肺下部有一片模糊的陰影/);
  assert.equal(root.querySelector("#lay-summary-body").getAttribute("lang"), "zh-Hant");
  assert.equal(text(root.querySelector("#lay-summary-disclaimer")), LAY.traditionalChinese.disclaimer);
  assert.deepEqual([...root.querySelectorAll("#lay-summary h3")].map(text), ["檢查發現", "這代表甚麼", "接下來會怎樣", "何時應及早求醫"]);
  assert.ok(!/cloudy area/.test(text(root.querySelector("#lay-summary-body"))), "only one language at a time");
  assert.ok(text(root.querySelector("#endorsed-report")).includes("Right lower zone"), "the report stays");
  await click(root.querySelector("#lay-lang-en"));
  assert.match(text(root.querySelector("#lay-summary-body")), /cloudy area/);
});

await test("a patient can only read: no edit, endorse or AI control, no field, and only the language buttons", () => {
  assert.equal(root.querySelectorAll("textarea, input, select, [contenteditable]").length, 0);
  // Besides the language buttons there is only navigation (Back) and the PDF download.
  assert.deepEqual([...root.querySelectorAll("button")].map(text).sort(), ["Back to all reports", "Download PDF", "English", "繁體中文"]);
  assert.ok(!/second reader|agent|curv|audit|endorse report|run again/i.test(text(root)));
});

await test("a summary that is still being written says so and offers to check again; a missing one says it is not available", async () => {
  await openPatient([finalCase({ laySummary: null, laySummaryState: "running" })]);
  assert.match(text(root.querySelector("#lay-summary-pending")), /being prepared/);
  assert.ok(root.querySelector("#lay-summary-refresh"));
  assert.equal(root.querySelector("#lay-summary-body"), null);
  assert.ok(root.querySelector("#endorsed-report-text"), "the report is still shown");
  await openPatient([finalCase({ laySummary: null, laySummaryState: "failed" })]);
  assert.match(text(root.querySelector("#lay-summary-missing")), /not available/);
  assert.equal(root.querySelector("#lay-summary-rewrite"), null, "a patient cannot ask for one to be written");
});

await test("no reports, a load error, and several reports are each handled", async () => {
  await openPatient([]);
  assert.match(text(root), /You have no reports yet/);
  listError = new Error("Session expired");
  await openPatient([]);
  assert.match(text(root.querySelector("#my-reports-error")), /Session expired/);
  listError = null;
  await openPatient([finalCase(), finalCase({ caseId: "CASE-LAY-2", reportText: "SECOND REPORT TEXT" })]);
  assert.equal(root.querySelectorAll("#report-choice-list button").length, 2, "several reports: the list comes first");
  assert.equal(root.querySelector("#endorsed-report"), null, "no report is open until one is chosen");
  await click(root.querySelectorAll("#report-choice-list button")[1]);
  assert.match(text(root.querySelector("#endorsed-report-text")), /SECOND REPORT TEXT/);
});

await test("report text is shown as text, never as markup", async () => {
  await openPatient([finalCase({ reportText: "<img src=x onerror=alert(1)>", laySummary: { ...structuredClone(LAY), english: { ...LAY.english, found: "<b>bold</b>" } } })]);
  assert.equal(root.querySelector("img"), null);
  assert.ok(text(root).includes("<img src=x onerror=alert(1)>") && text(root).includes("<b>bold</b>"));
});

console.log("\n=== the patient's shell and role helpers ===");
await test("a patient's menu has two modules, My appointments and My reports, and the role helpers treat patient as read-only", () => {
  state.user = { role: "patient", userId: "p1", name: "Mei Chen" };
  state.page = "my-reports";
  const shell = Shell({ onLogout() {} });
  const labels = [...shell.root.querySelectorAll("#app-modules nav button")].map(text);
  assert.deepEqual(labels, ["My appointments", "My reports"]);
  assert.equal(roles.isPatient(state.user), true);
  assert.equal(roles.isPatient({ role: "doctor" }), false);
  for (const fn of ["canEditReport", "canRunAi", "canExport", "canUpload", "canEditPatient", "canSeeAudit", "canRequestExam", "isAdmin"]) {
    assert.equal(roles[fn](state.user), false, `${fn} must be false for a patient`);
  }
  assert.match(text(shell.root.querySelector("header")), /Dept: PT/);
});

// ---------------------------------------------------------------- the clinician's preview
let server;
const patientRecord = { patientId: "PT-1", heartRate: "76 bpm", observations: [] };
api.getPatient = async () => ({ patient: structuredClone(patientRecord) });
api.getCase = async () => ({ case: structuredClone(server) });
api.listCases = async () => ({ cases: [structuredClone(server)] });
api.fetchImage = async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
let rewriteCalls = 0;
api.writeLaySummary = async () => {
  rewriteCalls++;
  server = { ...server, laySummary: structuredClone(LAY), laySummaryState: "done" };
  return { state: "done", case: structuredClone(server) };
};
async function openReview(role, overrides = {}) {
  stopReviewWatch();
  server = {
    caseId: "CASE-LAY-1", patientId: "PT-1", firstName: "Mei", lastName: "Chen", age: "67", sex: "Female",
    status: "finalized", analysisState: "done", boxesState: "done", view: "PA", finalizedByName: "Dr Rad",
    reportText: REPORT, findingTags: [], comment: "", remarks: "", diagnosis: "x", imageId: "img-1",
    findings: [], measurements: [], editLog: [], laySummary: structuredClone(LAY), laySummaryState: "done", ...overrides,
  };
  state.user = { role, userId: "u1", name: "Dr Test" };
  state.cases = [structuredClone(server)];
  state.selectedCaseId = server.caseId;
  state.page = "review";
  root.innerHTML = "";
  await renderReviewPage({ target: root });
  await tick();
}
const toggle = () => root.querySelector("#patient-view-toggle");
const preview = () => root.querySelector("#patient-view-preview");

console.log("\n=== the radiologist and doctor view ===");
await test("the lay summary is not shown by default; a small Patient view button is there on an endorsed report", async () => {
  await openReview("radiologist");
  assert.ok(toggle());
  assert.equal(text(toggle()), "Patient view");
  assert.equal(preview(), null);
  assert.equal(root.querySelector("#lay-summary"), null);
  assert.ok(!text(root).includes("cloudy area") && !text(root).includes("explanation aid"));
});

await test("Patient view opens the preview of the summary with the language toggle and disclaimer, and Close hides it", async () => {
  await click(toggle());
  assert.ok(preview());
  assert.match(text(preview()), /Patient view \(preview\)/);
  assert.match(text(root.querySelector("#lay-summary-body")), /cloudy area/);
  assert.equal(text(root.querySelector("#lay-summary-disclaimer")), LAY.english.disclaimer);
  await click(root.querySelector("#lay-lang-zh"));
  assert.match(text(root.querySelector("#lay-summary-body")), /模糊的陰影/);
  assert.equal(text(root.querySelector("#lay-summary-disclaimer")), LAY.traditionalChinese.disclaimer);
  assert.ok(preview(), "still open after switching language");
  await click(root.querySelector("#patient-view-close"));
  assert.equal(preview(), null);
  assert.equal(root.querySelector("#lay-summary"), null);
});

await test("a referring doctor gets the same toggle; a draft report has none", async () => {
  await openReview("doctor");
  assert.ok(toggle());
  await openReview("radiologist", { status: "pending_approve", laySummary: null, laySummaryState: "" });
  assert.equal(toggle(), null, "nothing is written before endorsement, so nothing to preview");
  assert.equal(preview(), null);
});

await test("a radiologist can write a missing summary from the preview; a doctor cannot", async () => {
  await openReview("radiologist", { laySummary: null, laySummaryState: "failed" });
  await click(toggle());
  assert.match(text(root.querySelector("#lay-summary-missing")), /not available/);
  rewriteCalls = 0;
  await click(root.querySelector("#lay-summary-rewrite"), 80);
  assert.equal(rewriteCalls, 1);
  assert.match(text(root.querySelector("#lay-summary-body")), /cloudy area/);
  await openReview("doctor", { laySummary: null, laySummaryState: "failed" });
  await click(toggle());
  assert.equal(root.querySelector("#lay-summary-rewrite"), null);
});

console.log("\n=== getting to the pages ===");
await test("every page except My appointments and My reports sends a patient back to My reports; other roles are not redirected", () => {
  for (const page of ["dashboard", "cases", "case", "review", "patients", "patient", "audit", "users", "labs", "requests", "new", "share"]) {
    assert.equal(roles.allowedPage({ role: "patient" }, page), "my-reports", page);
  }
  assert.equal(roles.allowedPage({ role: "patient" }, "my-reports"), "my-reports");
  assert.equal(roles.allowedPage({ role: "patient" }, "my-appointments"), "my-appointments");
  for (const role of ["radiologist", "doctor", "admin", "technician"]) assert.equal(roles.allowedPage({ role }, "review"), "review");
  assert.equal(roles.allowedPage({ role: "patient" }, "my-reports"), "my-reports");
});

await test("the hash #/my-reports opens the patient page", async () => {
  const { parseHash, hashFor } = await import("../src/state.js");
  assert.deepEqual(parseHash("#/my-reports"), { page: "my-reports", selectedCaseId: null });
  assert.equal(parseHash("#/my-reports/CASE-1").selectedCaseId, "CASE-1");
  assert.equal(hashFor({ page: "my-reports", selectedCaseId: null }), "#/my-reports");
});

await test("the admin's Users page can add a patient account, and asks for the patient ID", async () => {
  const { renderUsersPage } = await import("../src/components/users.js");
  state.user = { role: "admin", userId: "a1", name: "Admin" };
  const sent = [];
  api.listUsers = async () => ({ users: [] });
  api.createUser = async (payload) => { sent.push(payload); return { user: { email: payload.email, username: "mei" }, temporaryPassword: "pw" }; };
  root.innerHTML = "";
  await renderUsersPage({ target: root });
  await tick();
  assert.equal(root.querySelector("#new-user-patient-id"), null, "no patient ID box for other roles");
  const select = [...root.querySelectorAll("select")].find((s) => [...s.querySelectorAll("option")].some((o) => o.textContent === "patient"));
  assert.ok(select, "patient is a role to choose");
  select.value = "patient";
  select.dispatchEvent(new window.Event("change"));
  await tick();
  assert.ok(root.querySelector("#new-user-patient-id"), "the patient ID box appears");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
