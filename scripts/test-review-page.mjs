// scripts/test-review-page.mjs
//
// Every control on the review page: inline report editing, Save draft,
// Save remarks, Endorse, Mark urgent, Re-run AI, Report popup, Word, PDF,
// Share, zoom, measure, Hide/Show boxes, draft log, patient link, back.
//
//   node scripts/test-review-page.mjs

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
api.summariseFindings = async () => {
  calls.push(["summarise"]);
  const extra = /effusion/i.test(server.reportText) ? [box("Right pleural effusion")] : [];
  server = { ...server, findings: [box("Bibasilar atelectasis"), ...extra], boxesState: "done" };
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
  assert.ok(root.querySelector("[data-measure] line"), "no measure line");
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
});

stopReviewWatch();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
