// scripts/test-review-page.mjs
//
// Every control on the review page: inline report editing, box drawing,
// moving, resizing and deleting, Save draft,
// Save remarks, Endorse, Mark urgent, Re-run AI, Report popup, Word, PDF,
// Share, zoom, measure, Hide/Show boxes, draft log, patient link, back.
//
//   node scripts/test-review-page.mjs

import assert from "node:assert";
import { createRequire } from "node:module";
import { parseHTML } from "linkedom";

const require = createRequire(import.meta.url);
const { mergeFindingsFromReport } = require("../backend/utils/findingsMerge.js");

const { window, document } = parseHTML(
  "<!doctype html><html><body><div id='root'></div></body></html>"
);
globalThis.window = window;
globalThis.document = document;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const downloads = [];
URL.createObjectURL = (blob) => {
  downloads.push(blob);
  return "blob:test";
};
URL.revokeObjectURL = () => {};
let opened = null;
window.open = (url) => {
  opened = url;
  return {};
};
if (!window.location?.href) {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("http://localhost:5173/"),
  });
}
window.confirm = () => true;
globalThis.confirm = () => true;
let copied = null;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { clipboard: { writeText: async (t) => { copied = t; } } },
});

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

const REPORT = [
  "Findings:",
  "The lung volumes are low, with bibasilar atelectasis.",
  "",
  "Thinking:",
  "Low volumes favour atelectasis over pneumonia.",
  "",
  "Impression:",
  "Bibasilar atelectasis.",
].join("\n");

function box(label, severity = "significant") {
  return {
    _id: `az-${label}`, label, severity, bbox: [10, 60, 80, 20], source: "Azure",
    bboxSource: "vision", sentence: label, status: "pending", confidence: 0.7,
  };
}

let server;
const calls = [];
function resetServer(overrides = {}) {
  server = {
    caseId: "CASE-RV-1",
    patientId: "PT-RV-1",
    firstName: "Pat",
    lastName: "Review",
    age: "60",
    sex: "Male",
    status: "pending_approve",
    analysisState: "done",
    boxesState: "done",
    reportText: REPORT,
    remarks: "",
    diagnosis: "Bibasilar atelectasis",
    imageId: "img-1",
    findings: [box("Bibasilar atelectasis"), box("Normal heart size", "normal")],
    editLog: [{ _id: "log-1", kind: "ai", userName: "CURV", summary: "AI generated draft report.", at: "2026-10-14T08:00:00Z", changes: [] }],
    ...overrides,
  };
  calls.length = 0;
}

api.getCase = async () => ({ case: structuredClone(server) });
api.listCases = async () => ({ cases: [structuredClone(server)] });
api.fetchImage = async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
api.updateCase = async (_id, payload) => {
  calls.push(["update", payload]);
  server = { ...server, ...payload };
  if (payload.reportText !== undefined) {
    server.editLog = [...server.editLog, { _id: `log-${server.editLog.length + 1}`, kind: "manual", userName: "Dr Test", summary: "Edited report", changes: [{ action: "edited", label: "Report", before: "a", after: "b" }] }];
  }
  return { case: structuredClone(server) };
};
let serverIds = 0;
api.updateCase = ((inner) => async (id, payload) => {
  if (Array.isArray(payload.findings)) {
    payload = {
      ...payload,
      findings: payload.findings.map((f) => (f._id ? f : { ...f, _id: `srv-${++serverIds}` })),
    };
  }
  return inner(id, payload);
})(api.updateCase);
api.summariseFindings = async () => {
  calls.push(["summarise"]);
  const extra = /effusion/i.test(server.reportText) ? [box("Right pleural effusion")] : [];
  const fresh = [box("Bibasilar atelectasis"), ...extra].map((f) => ({ ...f, _id: `fresh-${++serverIds}` }));
  server = { ...server, findings: mergeFindingsFromReport(server.findings, fresh), boxesState: "done" };
  return { case: structuredClone(server) };
};
api.analyzeCase = async () => {
  calls.push(["analyze"]);
  server = { ...server, status: "pending", analysisState: "running", diagnosis: "Generating report…" };
  return { case: structuredClone(server) };
};
api.finalizeCase = async () => {
  calls.push(["finalize"]);
  server = { ...server, status: "finalized" };
  return { case: structuredClone(server) };
};
api.shareCase = async () => {
  calls.push(["share"]);
  server = { ...server, shareToken: "tok-1", shared: true };
  return { case: structuredClone(server), token: "tok-1" };
};

const root = document.getElementById("root");
const buttons = () => [...root.querySelectorAll("button")];
const button = (label) => buttons().find((b) => b.textContent.replace(/\s+/g, " ").trim() === label);
const click = async (node, ms = 30) => {
  assert.ok(node, "button not found");
  node.dispatchEvent(new window.Event("click"));
  await tick(ms);
};
const type = (node, value) => {
  node.value = value;
  node.textContent = value;
  node.dispatchEvent(new window.Event("input"));
};
const boxLabels = () => [...root.querySelectorAll("[data-bbox-label]")].map((n) => n.textContent);

async function open(role = "radiologist", overrides = {}) {
  stopReviewWatch();
  resetServer(overrides);
  state.user = { role, userId: "u1", name: "Dr Test" };
  state.cases = [structuredClone(server)];
  state.selectedCaseId = server.caseId;
  state.page = "review";
  root.innerHTML = "";
  await renderReviewPage({ target: root });
  await tick();
}

console.log("\n=== report and film ===");
await open();

await test("the report box shows CURV's report and is editable", () => {
  const area = root.querySelector("textarea#report-text");
  assert.ok(area, "report textarea missing");
  assert.ok(area.value.includes("bibasilar atelectasis"));
  assert.ok(!area.disabled && !area.hasAttribute("readonly"));
});

await test("no finding cards, and only abnormal Azure boxes on the film", () => {
  assert.equal(root.querySelector("article"), null);
  assert.deepEqual(boxLabels(), ["Bibasilar atelectasis"]);
});

await test("Hide boxes / Show boxes", async () => {
  await click(root.querySelector("#toggle-bboxes"));
  assert.equal(boxLabels().length, 0);
  await click(root.querySelector("#toggle-bboxes"));
  assert.equal(boxLabels().length, 1);
});

await test("Zoom in and Zoom out change the film size", async () => {
  const width = () => root.querySelector("#xray-stage").style.width;
  assert.equal(width(), "100%");
  await click(button("Zoom in"));
  assert.equal(width(), "125%");
  await click(button("Zoom out"));
  assert.equal(width(), "100%");
});

await test("Measure draws a line and shows its length", async () => {
  await click(button("Measure"));
  assert.ok(button("Measuring"), "measure mode not on");
  filmSize();
  const stage = root.querySelector("#xray-stage");
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  const ev = (name, x, y) => {
    const e = new window.Event(name);
    e.clientX = x;
    e.clientY = y;
    e.button = 0;
    stage.dispatchEvent(e);
  };
  ev("pointerdown", 10, 10);
  ev("pointermove", 40, 50);
  ev("pointerup", 40, 50);
  await tick();
  assert.ok(root.querySelector("[data-saved-measures] line"), "no measure line");
  assert.ok(root.querySelector("[data-saved-measure-label='1']").textContent.endsWith("px"));
  await click(button("Measuring"));
  assert.ok(button("Measure"));
});

console.log("\n=== editing ===");

await test("typing in the report box and Save draft saves it and re-places the boxes", async () => {
  type(root.querySelector("#report-text"), REPORT.replace("Impression:", "Impression:\nSmall right pleural effusion."));
  await click(button("Save draft"), 60);
  const update = calls.find((c) => c[0] === "update");
  assert.ok(update, "updateCase not called");
  assert.ok(update[1].reportText.includes("Small right pleural effusion."));
  assert.equal(update[1].findings, undefined, "the page must not send boxes");
  assert.ok(calls.some((c) => c[0] === "summarise"), "Azure was not asked to re-place boxes");
  assert.deepEqual(boxLabels(), ["Bibasilar atelectasis", "Right pleural effusion"]);
  assert.ok(root.querySelector("#report-text").value.includes("Small right pleural effusion."));
});

await test("Save draft with no report change does not call Azure", async () => {
  calls.length = 0;
  await click(button("Save draft"), 60);
  assert.ok(calls.some((c) => c[0] === "update"));
  assert.ok(!calls.some((c) => c[0] === "summarise"));
});

await test("Save remarks adds them to the report and keeps the report edit", async () => {
  calls.length = 0;
  type(root.querySelector("#remarks-box"), "Compare with old films.");
  await click(button("Save remarks"), 60);
  const update = calls.find((c) => c[0] === "update");
  assert.equal(update[1].remarks, "Compare with old films.");
  assert.ok(update[1].reportText.includes("Radiologist remarks"));
  assert.ok(update[1].reportText.includes("Small right pleural effusion."));
  assert.ok(!calls.some((c) => c[0] === "summarise"), "remarks alone must not move the boxes");
});

await test("the draft log shows the manual edit and expands", async () => {
  const entry = buttons().find((b) => b.textContent.includes("Edited report"));
  assert.ok(entry, "manual edit missing from the log");
  await click(entry);
  assert.ok(root.textContent.includes("Edited · Report"));
});

await test("Mark urgent / Remove urgent", async () => {
  calls.length = 0;
  await click(button("Mark urgent"));
  assert.deepEqual(calls.find((c) => c[0] === "update")[1], { urgent: true });
  assert.ok(button("Remove urgent"));
  await click(button("Remove urgent"));
  assert.ok(button("Mark urgent"));
});

await test("Report opens the popup after saving", async () => {
  opened = null;
  await click(button("Report"), 60);
  assert.ok(opened && opened.includes("CASE-RV-1"), `popup url: ${opened}`);
});

await test("Open report in the report panel opens the same popup", async () => {
  opened = null;
  await click(button("Open report"), 60);
  assert.ok(opened && opened.includes("CASE-RV-1"));
});

await test("Word download", async () => {
  downloads.length = 0;
  await click(button("Word"), 400);
  assert.equal(downloads.length, 1, "no Word file produced");
  assert.ok(downloads[0].size > 1000);
});

await test("PDF download", async () => {
  downloads.length = 0;
  await click(button("PDF"), 1500);
  assert.equal(downloads.length, 1, "no PDF produced");
  assert.ok(downloads[0].size > 1000);
});

await test("Re-run AI starts CURV again", async () => {
  calls.length = 0;
  await click(button("Re-run AI"));
  assert.ok(calls.some((c) => c[0] === "analyze"));
  assert.ok(root.textContent.includes("GENERATING"));
  assert.equal(root.querySelector("textarea#report-text"), null, "report must not be editable while generating");
});

console.log("\n=== endorse and share ===");
await open();

await test("Endorse report saves the typed edit, then finalizes", async () => {
  calls.length = 0;
  type(root.querySelector("#report-text"), REPORT + "\nEndorsed wording.");
  await click(button("Endorse report"), 80);
  const order = calls.map((c) => c[0]);
  assert.ok(order.indexOf("update") >= 0 && order.indexOf("finalize") > order.indexOf("update"), order.join(","));
  assert.ok(server.reportText.includes("Endorsed wording."));
  assert.ok(root.textContent.includes("FINALIZED"));
});

await test("the endorsed report is read-only and hides Thinking", () => {
  assert.equal(root.querySelector("textarea#report-text"), null);
  const text = root.querySelector("#report-text").textContent;
  assert.ok(text.includes("Endorsed wording."));
  assert.ok(!text.includes("Low volumes favour atelectasis"), "Thinking should be hidden after endorsing");
  assert.equal(button("Save draft"), undefined);
  assert.equal(button("Endorse report"), undefined);
});

await test("Share copies a link", async () => {
  await click(button("Share"), 40);
  assert.ok(calls.some((c) => c[0] === "share"));
  assert.ok(copied && copied.includes("#/share/tok-1"), copied);
});

await test("remarks still save on an endorsed report without changing it", async () => {
  calls.length = 0;
  const before = server.reportText;
  type(root.querySelector("#remarks-box"), "Seen in clinic.");
  await click(button("Save remarks"), 60);
  assert.deepEqual(calls.find((c) => c[0] === "update")[1], { remarks: "Seen in clinic." });
  assert.equal(server.reportText, before);
});

console.log("\n=== drawing, resizing and deleting boxes ===");

function pointer(stage, name, x, y) {
  const e = new window.Event(name);
  e.clientX = x;
  e.clientY = y;
  e.button = 0;
  stage.dispatchEvent(e);
}
function stage() {
  const node = root.querySelector("#xray-stage");
  node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  return node;
}
const rows = () => [...root.querySelectorAll("[data-box-row]")].map((li) => li.textContent.replace(/\s+/g, " ").trim());
const lastUpdate = () => [...calls].reverse().find((c) => c[0] === "update")[1];

await open();

await test("Draw box adds a named manual box", async () => {
  await click(root.querySelector("#draw-box"));
  assert.ok(button("Drawing…"), "draw mode not on");
  pointer(stage(), "pointerdown", 20, 20);
  pointer(stage(), "pointermove", 35, 40);
  pointer(stage(), "pointerup", 35, 40);
  await tick();
  assert.deepEqual(boxLabels(), ["Bibasilar atelectasis", "Marked area"]);
  assert.ok(button("Draw box"), "draw mode should end after one box");
  const name = root.querySelector("[data-box-name]");
  assert.ok(name, "no name field for the drawn box");
  type(name, "Nodule");
  assert.deepEqual(boxLabels(), ["Bibasilar atelectasis", "Nodule"]);
  assert.ok(rows()[1].includes("Manual"));
});

await test("a click without dragging does not add a box", async () => {
  await click(root.querySelector("#draw-box"));
  pointer(stage(), "pointerdown", 60, 20);
  pointer(stage(), "pointerup", 60, 20);
  await tick();
  assert.equal(boxLabels().length, 2);
  await click(root.querySelector("#draw-box"));
});

await test("clicking an AI box selects it and shows resize handles", async () => {
  pointer(stage(), "pointerdown", 50, 70);
  await tick();
  const selected = root.querySelector("[data-selected='1']");
  assert.ok(selected, "no box selected");
  assert.ok(selected.textContent.includes("Bibasilar atelectasis"));
  assert.equal(selected.querySelectorAll("[data-handle]").length, 4);
});

await test("dragging a corner resizes the AI box", async () => {
  pointer(stage(), "pointerdown", 90, 80);
  pointer(stage(), "pointermove", 70, 90);
  pointer(stage(), "pointerup", 70, 90);
  await tick();
  const node = root.querySelector("[data-selected='1']");
  assert.equal(node.style.width, "60%");
  assert.equal(node.style.height, "30%");
  assert.ok(rows()[0].includes("AI · adjusted"));
});

await test("dragging inside the box moves it", async () => {
  pointer(stage(), "pointerdown", 30, 70);
  pointer(stage(), "pointermove", 35, 65);
  pointer(stage(), "pointerup", 35, 65);
  await tick();
  const node = root.querySelector("[data-selected='1']");
  assert.equal(node.style.left, "15%");
  assert.equal(node.style.top, "55%");
});

await test("Save draft stores the drawn and resized boxes", async () => {
  calls.length = 0;
  await click(button("Save draft"), 80);
  const saved = lastUpdate().findings;
  assert.ok(Array.isArray(saved), "boxes were not sent");
  const drawn = saved.find((f) => f.source === "manual");
  assert.equal(drawn.label, "Nodule");
  assert.ok(!String(drawn._id || "").startsWith("tmp-"), "temporary id was sent");
  const ai = saved.find((f) => f.label === "Bibasilar atelectasis");
  assert.deepEqual(ai.bbox, [15, 55, 60, 30]);
  assert.equal(ai.bboxSource, "manual");
  assert.ok(!calls.some((c) => c[0] === "summarise"), "box edits alone must not call Azure");
});

await test("Delete hides an AI box and keeps it as rejected", async () => {
  calls.length = 0;
  const key = root.querySelector("[data-box-row]").dataset.boxRow;
  await click(root.querySelector(`[data-delete-box="${key}"]`));
  assert.deepEqual(boxLabels(), ["Nodule"]);
  await click(button("Save draft"), 80);
  const ai = lastUpdate().findings.find((f) => f.label === "Bibasilar atelectasis");
  assert.equal(ai.status, "rejected");
});

await test("a report edit adds Azure's new box but keeps the radiologist's boxes", async () => {
  type(root.querySelector("#report-text"), REPORT.replace("Impression:", "Impression:\nRight pleural effusion."));
  await click(button("Save draft"), 80);
  assert.ok(calls.some((c) => c[0] === "summarise"));
  assert.deepEqual(boxLabels().sort(), ["Nodule", "Right pleural effusion"]);
  assert.equal(server.findings.find((f) => f.label === "Bibasilar atelectasis").status, "rejected",
    "a deleted AI box must not come back");
});

await test("a resized AI box keeps its size after Azure re-places boxes", async () => {
  await open("radiologist", {
    findings: [{ ...box("Bibasilar atelectasis"), bbox: [20, 50, 30, 30], bboxSource: "manual" }],
  });
  type(root.querySelector("#report-text"), REPORT + "\nSmall right pleural effusion.");
  await click(button("Save draft"), 80);
  const kept = server.findings.find((f) => f.label === "Bibasilar atelectasis");
  assert.deepEqual(kept.bbox, [20, 50, 30, 30]);
  assert.ok(boxLabels().includes("Right pleural effusion"));
});

await test("Delete removes a drawn box completely", async () => {
  await open("radiologist", {
    findings: [box("Bibasilar atelectasis"), { ...box("Nodule"), _id: "m-1", source: "manual", bboxSource: "manual" }],
  });
  await click(root.querySelector('[data-delete-box="m-1"]'));
  await click(button("Save draft"), 80);
  assert.ok(!lastUpdate().findings.some((f) => f.label === "Nodule"));
});

await test("boxes cannot be edited while Azure is placing them, or once endorsed", async () => {
  await open("radiologist", { boxesState: "running" });
  assert.equal(root.querySelector("#draw-box"), null);
  assert.equal(root.querySelector("[data-delete-box]"), null);
  await open("radiologist", { status: "finalized" });
  assert.equal(root.querySelector("#draw-box"), null);
  assert.equal(root.querySelector("[data-delete-box]"), null);
  assert.deepEqual(boxLabels(), ["Bibasilar atelectasis"]);
});

console.log("\n=== Thinking and measurements ===");

function filmSize(w = 1000, h = 1000) {
  const img = root.querySelector("#xray-film");
  assert.ok(img, "film not loaded");
  Object.defineProperty(img, "naturalWidth", { value: w, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: h, configurable: true });
}

await test("the report box hides Thinking and has no Thinking note", async () => {
  await open();
  const area = root.querySelector("textarea#report-text");
  assert.ok(!/thinking/i.test(area.value), area.value);
  assert.ok(!area.value.includes("Low volumes favour atelectasis"));
  assert.ok(!root.textContent.includes("Thinking is on this draft"));
});

await test("editing the report keeps the hidden Thinking in the stored draft", async () => {
  calls.length = 0;
  const area = root.querySelector("textarea#report-text");
  type(area, area.value.replace("Bibasilar atelectasis.", "Bibasilar atelectasis, improving."));
  await click(button("Save draft"), 60);
  const saved = lastUpdate().reportText;
  assert.ok(saved.includes("improving"));
  assert.ok(saved.indexOf("Low volumes favour") > 0 && saved.indexOf("Low volumes favour") < saved.indexOf("Impression:"), saved);
  assert.ok(!/thinking/i.test(root.querySelector("textarea#report-text").value));
});

await test("a measurement stays on the film in white and is saved with Save draft", async () => {
  await open("radiologist", { pixelSpacingMm: [0.1, 0.1] });
  calls.length = 0;
  await click(button("Measure"));
  filmSize();
  pointer(stage(), "pointerdown", 10, 10);
  pointer(stage(), "pointermove", 40, 50);
  pointer(stage(), "pointerup", 40, 50);
  await tick();
  assert.equal(root.querySelector("[data-saved-measure-label='1']")?.textContent, "1 · 5.00 cm");
  const strokes = [...root.querySelectorAll("[data-saved-measures] line")].map((l) => l.getAttribute("stroke"));
  assert.ok(strokes.includes("#ffffff"), strokes.join(","));
  assert.ok(!strokes.some((s) => /67e8f9|cyan/i.test(s)));
  pointer(stage(), "pointerdown", 70, 80);
  pointer(stage(), "pointerup", 70, 80);
  await tick();
  assert.equal(root.querySelectorAll("[data-saved-measure-label]").length, 1, "a click must not add a measurement");
  assert.equal(root.querySelector("[data-measure-label]"), null, "a click must not leave a dot on the film");
  await click(root.querySelector("#toggle-measures"));
  assert.equal(root.querySelector("[data-saved-measures]"), null, "Hide lines did not hide them");
  await click(root.querySelector("#toggle-measures"));
  assert.ok(root.querySelector("[data-saved-measures]"));
  type(root.querySelector("[data-measure-name]"), "Nodule");
  assert.equal(root.querySelector("[data-saved-measure-label='1']").textContent, "1 · Nodule 5.00 cm");
  await click(button("Save draft"), 60);
  const saved = lastUpdate().measurements;
  assert.deepEqual(saved, [{ x1: 10, y1: 10, x2: 40, y2: 50, text: "5.00 cm", label: "Nodule" }]);
  assert.ok(!calls.some((c) => c[0] === "summarise"), "a measurement alone must not call Azure");
});

await test("the measurement is in the Word and PDF report, without Thinking", async () => {
  const { buildReportSections } = await import("../src/lib/reportExport.js");
  const body = buildReportSections(server).body;
  assert.ok(body.includes("Measurements\n1. Nodule: 5.00 cm"), body);
  assert.ok(!body.includes("Low volumes favour"), "Thinking must not be exported");
  downloads.length = 0;
  await click(button("PDF"), 1500);
  const pdf = await downloads.find((b) => b.type === "application/pdf").text();
  assert.ok(pdf.includes("1. Nodule: 5.00 cm"), "PDF has no measurement");
  assert.ok(!pdf.includes("Low volumes favour"));
});

await test("Delete removes a measurement", async () => {
  calls.length = 0;
  await click(root.querySelector("[data-delete-measure]"));
  assert.equal(root.querySelector("[data-saved-measures]"), null);
  await click(button("Save draft"), 60);
  assert.deepEqual(lastUpdate().measurements, []);
});

console.log("\n=== navigation and roles ===");

await test("patient name opens the patient page", async () => {
  await open();
  await click(button("Pat Review"));
  assert.equal(state.page, "patient");
  assert.equal(state.selectedPatientId, "PT-RV-1");
});

await test("Work list goes back to the dashboard", async () => {
  await open();
  await click(button("Work list"));
  assert.equal(state.page, "dashboard");
});

await test("Azure still placing boxes shows a note and the report stays editable", async () => {
  await open("radiologist", { boxesState: "running", findings: [] });
  assert.ok(root.querySelector("#box-status").textContent.includes("placing boxes"));
  assert.ok(root.querySelector("textarea#report-text"));
});

await test("an older report with no boxes explains why and Save draft boxes it", async () => {
  await open("radiologist", { boxesState: "", findings: [], reportText: REPORT.replace("Impression:", "Impression:\nRight pleural effusion.") });
  assert.ok(root.querySelector("#box-status").textContent.includes("no film boxes yet"));
  calls.length = 0;
  await click(button("Save draft"), 60);
  assert.ok(calls.some((c) => c[0] === "summarise"), "Save draft should ask Azure for boxes");
  assert.deepEqual(boxLabels(), ["Bibasilar atelectasis", "Right pleural effusion"]);
});

await test("a referring doctor sees the endorsed report read-only", async () => {
  await open("doctor", { status: "finalized" });
  assert.equal(root.querySelector("textarea#report-text"), null, "report must not be editable");
  const remarks = root.querySelector("#remarks-box");
  assert.ok(!remarks || remarks.readOnly || remarks.hasAttribute("readonly") || remarks.hasAttribute("readOnly"),
    "remarks must be read-only");
  assert.ok(root.querySelector("#report-text").textContent.includes("Bibasilar atelectasis."));
  assert.equal(button("Save draft"), undefined);
  assert.equal(button("Endorse report"), undefined);
  assert.equal(root.querySelector("#draw-box"), null);
  assert.equal(root.querySelector("[data-delete-box]"), null);
});

stopReviewWatch();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
