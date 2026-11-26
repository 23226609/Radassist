// scripts/test-patient-portal-ui.mjs
//
// The patient portal on screen: two modules in the sidebar, My appointments, My reports (choose a report
// first, then see it in two columns, with Back and Download PDF), and the PDF itself (the doctor's endorsed report).
//
//   node scripts/test-patient-portal-ui.mjs

import assert from "node:assert";
import { parseHTML } from "linkedom";

const { window, document } = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
globalThis.window = window;
globalThis.document = document;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
let lastBlob = null;
URL.createObjectURL = (blob) => { lastBlob = blob; return "blob:test"; };
URL.revokeObjectURL = () => {};
if (!window.location?.href) {
  Object.defineProperty(window, "location", { configurable: true, value: new URL("http://localhost:5173/") });
}

const { state, subscribe, setPage } = await import("../src/state.js");
const { api } = await import("../src/api.js");
const { renderMyReportsPage } = await import("../src/components/myReports.js");
const { renderMyAppointmentsPage } = await import("../src/components/myAppointments.js");
const { Shell } = await import("../src/components/header.js");
const pdf = await import("../src/lib/patientReportPdf.js");
const raster = await import("../src/lib/pdfRaster.js");

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
const root = document.getElementById("root");
const text = (n) => (n?.textContent || "").replace(/\s+/g, " ").trim();
const click = async (node, ms = 40) => {
  assert.ok(node, "control not found");
  node.dispatchEvent(new window.Event("click"));
  await tick(ms);
};

const REPORT = ["XRAY CHEST (AP)", "", "FINDINGS", "The heart is normal in size.", "The lungs are clear.", "", "COMMENT", "– Normal chest X-ray.", "", "Thank you for your referral."].join("\n");
const LAY = {
  english: { found: "Your chest X-ray looks normal.", meaning: "Your heart and lungs look healthy.", next: "Your doctor will go through the report.", help: "See a doctor if you cannot breathe.", disclaimer: "This is an explanation aid, not a diagnosis. If you are worried, speak to your doctor." },
  traditionalChinese: { found: "您的胸部X光看起來正常。", meaning: "您的心臟和肺部看起來健康。", next: "醫生會向您講解這份報告。", help: "如呼吸困難，請盡快求醫。", disclaimer: "本摘要僅供參考，並非診斷。如有擔心，請諮詢醫生。" },
};
const mkCase = (extra = {}) => ({
  caseId: "CASE-SECRET-1", patientId: "PT-1", patientName: "Mei Chen", firstName: "Mei", lastName: "Chen", age: "67", sex: "Female",
  status: "finalized", view: "AP", finalizedByName: "Dr. Priya Nair", finalizedAt: "2026-11-26T08:44:00.000Z",
  reportText: REPORT, laySummary: structuredClone(LAY), laySummaryState: "done", ...extra,
});
const NEW = (x = {}) => mkCase({ caseId: "CASE-NEW", finalizedAt: "2026-11-26T08:44:00.000Z", reportText: REPORT.replace("lungs are clear", "lungs are clear NEWEST"), ...x });
const OLD = (x = {}) => mkCase({ caseId: "CASE-OLD", finalizedAt: "2026-10-27T09:00:00.000Z", view: "PA", reportText: REPORT.replace("lungs are clear", "lungs are clear OLDEST"), ...x });

let listed = [];
let appointments = [];
let apptError = null;
api.listCases = async () => ({ cases: structuredClone(listed) });
api.listAppointments = async () => {
  if (apptError) throw apptError;
  return { appointments: structuredClone(appointments) };
};

let pageTarget = null;
subscribe(() => {
  if (!pageTarget) return;
  if (state.page === "my-reports") renderMyReportsPage({ target: pageTarget });
  if (state.page === "my-appointments") renderMyAppointmentsPage({ target: pageTarget });
});
function asPatient(extra = {}) {
  state.user = { role: "patient", userId: "p1", name: "Mei Chen", patientId: "PT-1", ...extra };
  state.selectedCaseId = null;
  state.patientBrowse = false;
}
async function openReports(cases) {
  listed = cases;
  asPatient();
  state.page = "my-reports";
  root.innerHTML = "";
  pageTarget = root;
  renderMyReportsPage({ target: root });
  await tick(30);
}
async function openAppointments(rows) {
  appointments = rows;
  asPatient();
  state.page = "my-appointments";
  root.innerHTML = "";
  pageTarget = root;
  renderMyAppointmentsPage({ target: root });
  await tick(30);
}
const choices = () => [...root.querySelectorAll("#report-choice-list button")];

console.log("\n=== the sidebar ===");
await test("a patient's MODULES list shows two items, My appointments and My reports, and the current one is light blue", () => {
  asPatient();
  state.page = "my-reports";
  let shell = Shell({ onLogout() {} });
  assert.deepEqual([...shell.root.querySelectorAll("#app-modules nav button")].map(text), ["My appointments", "My reports"]);
  const [appt, rep] = [...shell.root.querySelectorAll("#app-modules nav button")];
  assert.match(rep.className, /bg-blue-100/);
  assert.ok(!/bg-blue-100/.test(appt.className));
  state.page = "my-appointments";
  shell = Shell({ onLogout() {} });
  const [a2, r2] = [...shell.root.querySelectorAll("#app-modules nav button")];
  assert.match(a2.className, /bg-blue-100/);
  assert.ok(!/bg-blue-100/.test(r2.className));
  assert.equal(shell.root.querySelector("#patient-report-list"), null, "no date list in the sidebar any more");
});

await test("pressing a module switches the page; My reports always opens at the list", async () => {
  asPatient();
  state.page = "my-appointments";
  const shell = Shell({ onLogout() {} });
  const [appt, rep] = [...shell.root.querySelectorAll("#app-modules nav button")];
  state.selectedCaseId = "CASE-OLD";
  state.patientBrowse = true;
  await click(rep);
  assert.equal(state.page, "my-reports");
  assert.equal(state.selectedCaseId, null);
  assert.equal(state.patientBrowse, false);
  await click(appt);
  assert.equal(state.page, "my-appointments");
});

console.log("\n=== My appointments ===");
await test("each appointment shows the date, time, exam type and status", async () => {
  await openAppointments([
    { scheduledAt: "2026-12-01T01:30:00Z", date: "2026/12/01", time: "09:30", view: "", status: "booked" },
    { scheduledAt: "2026-10-27T02:00:00Z", date: "2026/10/27", time: "10:00", view: "AP", status: "completed" },
  ]);
  const rows = [...root.querySelectorAll("#my-appointments-list tbody tr")].map((r) => [...r.children].map(text));
  assert.deepEqual(rows, [["2026/12/01", "09:30", "XRAY CHEST", "booked"], ["2026/10/27", "10:00", "XRAY CHEST (AP)", "completed"]]);
  assert.deepEqual([...root.querySelectorAll("#my-appointments-list th")].map(text), ["Date", "Time", "Exam", "Status"]);
});

await test("no appointments says: No appointments yet.", async () => {
  await openAppointments([]);
  assert.equal(text(root.querySelector("#my-appointments-empty")), "No appointments yet.");
  assert.equal(root.querySelector("#my-appointments-list"), null);
});

await test("a load error is shown, and the page has no edit controls", async () => {
  apptError = new Error("Session expired");
  await openAppointments([]);
  apptError = null;
  assert.match(text(root.querySelector("#my-appointments-error")), /Session expired/);
  assert.equal(root.querySelectorAll("button, input, select, textarea").length, 0);
});

console.log("\n=== My reports: choose first, then show ===");
await test("several reports: the list comes first, newest first, date as the name, exam type under it, no case ID, no report yet", async () => {
  await openReports([OLD(), NEW()]);
  const items = choices();
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((b) => text(b.children[0])), ["2026/11/26", "2026/10/27"]);
  assert.deepEqual(items.map((b) => text(b.children[1])), ["XRAY CHEST (AP)", "XRAY CHEST (PA)"]);
  assert.match(items[0].children[1].className, /text-gray-500/);
  assert.ok(!/CASE-/.test(text(root)), "no case ID anywhere on the page");
  assert.equal(root.querySelector("#endorsed-report"), null);
  assert.equal(root.querySelector("#lay-summary"), null);
  assert.equal(root.querySelector("#download-pdf"), null, "no PDF button on the list");
});

await test("choosing a date opens that report in two columns: plain language left, report right", async () => {
  await openReports([OLD(), NEW()]);
  await click(choices()[1]);
  assert.match(text(root.querySelector("#endorsed-report-text")), /OLDEST/);
  const lay = root.querySelector("#lay-summary");
  const rep = root.querySelector("#endorsed-report");
  assert.ok(lay && rep && lay.compareDocumentPosition(rep) & 4);
  assert.match(root.querySelector("#patient-report-view").className, /md:grid-cols-2/);
  assert.match(text(root.querySelector("#endorsed-report-meta")), /^2026\/10\/27 · endorsed by Dr\. Priya Nair$/);
  assert.equal(root.querySelector("#report-choice-list"), null);
});

await test("← Back to all reports returns to the list so another date can be chosen", async () => {
  await openReports([OLD(), NEW()]);
  await click(choices()[0]);
  assert.match(text(root.querySelector("#endorsed-report-text")), /NEWEST/);
  assert.equal(text(root.querySelector("#back-to-reports")), "Back to all reports");
  await click(root.querySelector("#back-to-reports"));
  assert.equal(choices().length, 2);
  assert.equal(root.querySelector("#endorsed-report"), null);
  await click(choices()[1]);
  assert.match(text(root.querySelector("#endorsed-report-text")), /OLDEST/);
});

await test("one report: it opens by default, and Back still leads to a list of that one report", async () => {
  await openReports([NEW()]);
  assert.match(text(root.querySelector("#endorsed-report-text")), /NEWEST/);
  assert.ok(root.querySelector("#back-to-reports"));
  await click(root.querySelector("#back-to-reports"));
  assert.equal(choices().length, 1);
  assert.equal(text(choices()[0].children[0]), "2026/11/26");
  await click(choices()[0]);
  assert.match(text(root.querySelector("#endorsed-report-text")), /NEWEST/);
});

await test("no reports: an empty message and no list", async () => {
  await openReports([]);
  assert.match(text(root), /You have no reports yet/);
  assert.equal(choices().length, 0);
});

console.log("\n=== Download PDF ===");
const pdfText = async (blob) => Buffer.from(await blob.arrayBuffer()).toString("latin1");
const unescapePdf = (s) => s.replace(/\\([()\\])/g, "$1");

await test("an endorsed report has a Download PDF button; a report that is not endorsed does not", async () => {
  await openReports([NEW()]);
  assert.equal(text(root.querySelector("#download-pdf")), "Download PDF");
  await openReports([NEW({ status: "pending_approve" })]);
  assert.ok(root.querySelector("#endorsed-report"));
  assert.equal(root.querySelector("#download-pdf"), null);
});

await test("the button saves a real PDF file named by the date, laid out as the doctor's endorsed report", async () => {
  await openReports([NEW()]);
  lastBlob = null;
  await click(root.querySelector("#download-pdf"), 80);
  assert.ok(lastBlob, "a file was offered for download");
  assert.equal(lastBlob.type, "application/pdf");
  const raw = await pdfText(lastBlob);
  assert.ok(raw.startsWith("%PDF-1.4") && raw.trimEnd().endsWith("%%EOF"));
  const body = unescapePdf(raw);
  for (const want of ["Chest X-ray Report", "Patient name: Mei Chen", "Examination name: Chest (AP)", "Report title: XRAY CHEST (AP)", "Report date: 26 Nov 2026", "Reported by: Dr. Priya Nair", "FINDINGS", "The heart is normal in size.", "COMMENT", "Normal chest X-ray.", "Signature"]) {
    assert.ok(body.includes(want), `the PDF should contain "${want}"`);
  }
});

await test("the PDF has no In plain language part, no lay summary text and no Thank you for your referral", async () => {
  let saved;
  await pdf.downloadPatientReportPdf(NEW(), { save: (blob) => { saved = blob; } });
  const body = unescapePdf(await pdfText(saved));
  for (const gone of ["In plain language", "plain language", "What we found", "Your chest X-ray looks normal", "not a diagnosis", "Thank you for your referral", "Referring doctor"]) {
    assert.ok(!body.includes(gone), `"${gone}" must not be in the PDF`);
  }
});

await test("the PDF holds none of CURV's draft, the Second Reader, agent evidence, the audit log, the case ID or another patient", async () => {
  const dirty = NEW({
    fusionResult: { diagnosis: "ZEBRA-DIAGNOSIS" }, agentResult: { summary: "AGENT-EVIDENCE-MARKER" }, historyAnalysis: { note: "HISTORY-MARKER" },
    findings: [{ label: "CURV-DRAFT-MARKER" }], editLog: [{ note: "AUDIT-MARKER" }], remarks: "REMARK-MARKER", sourceReport: { text: "SOURCE-MARKER" },
    shareToken: "TOKEN-MARKER", history: "HISTORY-MARKER",
  });
  let saved;
  await pdf.downloadPatientReportPdf(dirty, { save: (blob) => { saved = blob; } });
  const body = unescapePdf(await pdfText(saved));
  for (const secret of ["ZEBRA-DIAGNOSIS", "AGENT-EVIDENCE-MARKER", "HISTORY-MARKER", "CURV", "AUDIT-MARKER", "REMARK-MARKER", "SOURCE-MARKER", "TOKEN-MARKER", "CASE-", "Second Reader", "Agent", "Audit", "Other Person"]) {
    assert.ok(!body.includes(secret), `"${secret}" must not be in the PDF`);
  }
});

await test("it is the same content as the doctor's download: the doctor's blocks, minus the case ID and the Referring doctor row, plus the patient's name", async () => {
  const { buildReportBlocks } = await import("../src/lib/reportExport.js");
  const c = NEW();
  const doctor = buildReportBlocks(c, "plain").filter((b) => !(b.type === "line" && /^Case\b/.test(b.text || "")) && !(b.type === "field" && b.label === "Referring doctor"));
  const mine = pdf.buildPatientReportBlocks(c).filter((b) => !(b.type === "field" && b.label === "Patient name"));
  assert.deepEqual(mine, doctor);
  assert.ok(pdf.buildPatientReportBlocks(c).some((b) => b.type === "field" && b.label === "Patient name" && b.value === "Mei Chen"));
  const lines = pdf.buildPatientReportBlocks(c).filter((b) => b.type === "line" || b.type === "section").map((b) => b.text);
  assert.ok(!lines.includes("Thank you for your referral."));
  assert.equal(pdf.patientPdfName(c), "RadAssist-Report-2026-11-26.pdf");
});

await test("a report that is not endorsed gets no PDF", async () => {
  await assert.rejects(pdf.downloadPatientReportPdf(NEW({ status: "pending_approve" }), { save() {} }), /Only an endorsed report/);
});

console.log("\n=== drawing Chinese for the PDF ===");
await test("needsRaster is true only for text the PDF's own font cannot draw", () => {
  assert.equal(raster.needsRaster("Mei Chen – 67 “ok” •"), false);
  assert.equal(raster.needsRaster("é"), false);
  assert.equal(raster.needsRaster("陳美玲"), true);
  assert.equal(raster.needsRaster("Name: 陳"), true);
});

await test("lines wrap between Chinese characters, keep English words whole and do not start a line with 。", () => {
  const fits = (s) => [...s].length <= 6;
  const lines = raster.wrapLines("這是一個很長的句子。你好", fits);
  assert.ok(lines.every((l) => [...l].length <= 7), JSON.stringify(lines));
  assert.ok(lines.every((l) => !l.startsWith("。")));
  assert.equal(lines.join(""), "這是一個很長的句子。你好");
  assert.deepEqual(raster.wrapLines("hello wonderful world", (s) => s.length <= 15), ["hello wonderful", "world"]);
});

await test("a Chinese patient name is drawn too, so it is not turned into question marks", async () => {
  const drawn = [];
  const fakeRaster = async (t) => { drawn.push(t); return [{ film: { bytes: new Uint8Array([0xff, 0xd8]), width: 9, height: 9, components: 3 }, w: 495, h: 16 }]; };
  let saved;
  await pdf.downloadPatientReportPdf(NEW({ patientName: "陳美玲" }), { raster: fakeRaster, save: (b) => { saved = b; } });
  assert.ok(drawn.includes("Patient name: 陳美玲"));
  assert.ok(!(await pdfText(saved)).includes("陳"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
