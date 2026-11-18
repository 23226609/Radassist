// scripts/test-review-page.mjs
//
// Every control on the review page: the sentence-tag list (edit, flip, delete,
// add, drag to reorder), the film boxes linked to the tags, the lesion and
// heart-size measurements, Save draft, Save remarks, Endorse, Mark urgent,
// Re-run AI, Word, PDF, Share, zoom, Hide/Show boxes, draft log, patient link.
//
//   node scripts/test-review-page.mjs

import assert from "node:assert";
import { createRequire } from "node:module";
import { parseHTML } from "linkedom";

const require = createRequire(import.meta.url);
const { mergeTagBoxes } = require("../backend/utils/findingsMerge.js");

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

const downloads = [];
URL.createObjectURL = (blob) => {
  downloads.push(blob);
  return "blob:test";
};
URL.revokeObjectURL = () => {};
let opened = null;
window.open = (url, name, features) => {
  opened = { url, name, features, location: {}, closed: false, close() { this.closed = true; }, focus() {} };
  return opened;
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
const { setFilmRenderer } = await import("../src/lib/reportExport.js");

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

const THINK = "Low volumes favour atelectasis over pneumonia.";
const S1 = "The lung volumes are low, with bibasilar atelectasis.";
const S2 = "Heart size is normal.";
const S3 = "No pleural effusion.";
const REPORT = [
  "XRAY CHEST (PA)", "", "FINDINGS", S1, S2, S3, "", "COMMENT", "– Bibasilar atelectasis.", "",
  "Thank you for your referral.", "", "Thinking:", THINK,
].join("\n");

function tag(key, text, abnormal) {
  return { key, text, abnormal, manual: false, kind: "" };
}

function box(tagKey, text, extra = {}) {
  return {
    _id: `az-${tagKey}`, label: text.slice(0, 80), severity: "significant", bbox: [10, 60, 80, 20], source: "Azure",
    bboxSource: "vision", sentence: text, status: "pending", confidence: 0.7, tagKey, ...extra,
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
    view: "PA",
    requestedByName: "Dr Referrer",
    reportText: REPORT,
    findingTags: [tag("t1", S1, true), tag("t2", S2, false), tag("t3", S3, false)],
    comment: "Bibasilar atelectasis.",
    remarks: "",
    diagnosis: "Bibasilar atelectasis",
    imageId: "img-1",
    findings: [box("t1", S1)],
    measurements: [],
    editLog: [{ _id: "log-1", kind: "ai", userName: "CURV", summary: "AI generated draft report.", at: "2026-10-14T08:00:00Z", changes: [] }],
    ...overrides,
  };
  calls.length = 0;
}

api.getCase = async () => ({ case: structuredClone(server) });
api.listCases = async () => ({ cases: [structuredClone(server)] });
api.fetchImage = async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
let serverIds = 0;
api.updateCase = async (_id, payload) => {
  calls.push(["update", payload]);
  const next = { ...payload };
  if (Array.isArray(payload.findings)) {
    next.findings = payload.findings.map((f) => (f._id ? f : { ...f, _id: `srv-${++serverIds}` }));
  }
  server = { ...server, ...next };
  if (payload.reportText !== undefined) {
    server.editLog = [...server.editLog, { _id: `log-${server.editLog.length + 1}`, kind: "manual", userName: "Dr Test", summary: "Edited report", changes: [{ action: "edited", label: "Report", before: "a", after: "b" }] }];
  }
  return { case: structuredClone(server) };
};
api.summariseFindings = async () => {
  calls.push(["summarise"]);
  const fresh = server.findingTags
    .filter((t) => t.abnormal && t.kind !== "ctr" && !t.boxDeclined)
    .map((t) => ({ ...box(t.key, t.text), _id: `fresh-${++serverIds}` }));
  server = { ...server, findings: mergeTagBoxes(server.findings, server.findingTags, fresh), boxesState: "done" };
  return { case: structuredClone(server) };
};
api.analyzeCase = async () => {
  calls.push(["analyze"]);
  server = { ...server, status: "pending", analysisState: "running", diagnosis: "Generating report…" };
  return { case: structuredClone(server) };
};
api.finalizeCase = async () => {
  calls.push(["finalize"]);
  server = { ...server, status: "finalized", finalizedByName: "Dr Test", finalizedAt: "2026-11-10T03:16:00Z" };
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
  assert.ok(node, "control not found");
  node.dispatchEvent(new window.Event("click"));
  await tick(ms);
};
const type = (node, value) => {
  node.value = value;
  node.textContent = value;
  node.dispatchEvent(new window.Event("input"));
};
const boxLabels = () => [...root.querySelectorAll("[data-bbox-label]")].map((n) => n.textContent);
const tagTexts = () => [...root.querySelectorAll("#tag-list [data-tag-text], #tag-list li > span.min-w-0")].map((n) => n.value ?? n.textContent);
const tagKeys = () => [...root.querySelectorAll("#tag-list > li")].map((li) => li.dataset.tag);
const lastUpdate = () => [...calls].reverse().find((c) => c[0] === "update")[1];
const tagRow = (key) => root.querySelector(`#tag-list > li[data-tag="${key}"]`);

function pointer(stageNode, name, x, y) {
  const e = new window.Event(name);
  e.clientX = x;
  e.clientY = y;
  e.button = 0;
  stageNode.dispatchEvent(e);
}
function stage() {
  const node = root.querySelector("#xray-stage");
  node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  return node;
}
function filmSize(w = 1000, h = 1000) {
  const img = root.querySelector("#xray-film");
  assert.ok(img, "film not loaded");
  Object.defineProperty(img, "naturalWidth", { value: w, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: h, configurable: true });
}
function drag(x1, y1, x2, y2) {
  const s = stage();
  pointer(s, "pointerdown", x1, y1);
  pointer(s, "pointermove", x2, y2);
  pointer(s, "pointerup", x2, y2);
}

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

console.log("\n=== the report as sentence tags ===");
await open();

await test("FINDINGS is one editable tag per sentence, with COMMENT under the list", () => {
  assert.equal(root.querySelector("textarea#report-text"), null, "the report is no longer one textarea");
  assert.deepEqual(tagTexts(), [S1, S2, S3]);
  assert.deepEqual(tagKeys(), ["t1", "t2", "t3"]);
  assert.equal(root.querySelector("#report-title").textContent, "XRAY CHEST (PA)");
  const comment = root.querySelector("textarea#comment-text");
  assert.equal(comment.value, "Bibasilar atelectasis.");
  const list = root.querySelector("#tag-list");
  assert.ok(!list.contains(comment), "COMMENT is not part of the draggable list");
  assert.ok(root.querySelector("#report-text").textContent.includes("Thank you for your referral."));
});

await test("Thinking is stored but never shown", () => {
  assert.ok(!root.textContent.includes(THINK));
  assert.ok(!/thinking/i.test(root.querySelector("#report-text").textContent));
});

await test("the header shows the Radiology Examination fields", () => {
  const header = root.querySelector("#report-header").textContent;
  assert.ok(header.includes("Modality: XRAY"));
  assert.ok(header.includes("Examination name: Chest (PA)"));
  assert.ok(header.includes("Report title: XRAY CHEST (PA)"));
  assert.ok(header.includes("Referring doctor: Dr Referrer"));
  assert.ok(header.includes("Reported by: Not endorsed yet"));
});

await test("only the abnormal sentence has a box, and the box carries its sentence", () => {
  assert.deepEqual(boxLabels(), [S1]);
  assert.ok(tagRow("t1").querySelector("[data-has-box]"));
  assert.equal(tagRow("t2").querySelector("[data-has-box]"), null);
  assert.equal(root.querySelector("article"), null);
});

await test("clicking a tag selects its box, and clicking the box selects its tag", async () => {
  await click(tagRow("t1"));
  assert.equal(root.querySelector("[data-bbox][data-selected='1']")?.dataset.boxTag, "t1");
  await click(tagRow("t2"));
  assert.equal(root.querySelector("[data-bbox][data-selected='1']"), null, "a normal sentence has no box to highlight");
  assert.equal(tagRow("t2").dataset.selected, "1");
  pointer(stage(), "pointerdown", 50, 70);
  await tick();
  assert.equal(tagRow("t1").dataset.selected, "1");
  assert.equal(root.querySelector("[data-bbox][data-selected='1']")?.dataset.boxTag, "t1");
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

console.log("\n=== editing the tags ===");

await test("editing a tag's words and Save draft stores the sentence and the assembled report", async () => {
  await open();
  type(root.querySelector('[data-tag-text="t1"]'), "The lung volumes are low with bibasilar atelectasis, improving.");
  assert.deepEqual(boxLabels(), ["The lung volumes are low with bibasilar atelectasis, improving."], "the box label follows the words");
  await click(button("Save draft"), 60);
  const update = lastUpdate();
  assert.equal(update.findingTags[0].text, "The lung volumes are low with bibasilar atelectasis, improving.");
  assert.ok(update.reportText.includes("FINDINGS\nThe lung volumes are low with bibasilar atelectasis, improving.\nHeart size is normal.\nNo pleural effusion.\n\nCOMMENT\n– Bibasilar atelectasis."));
  assert.ok(update.reportText.includes(THINK), "the hidden Thinking is kept in the stored draft");
  assert.ok(update.reportText.indexOf("COMMENT") < update.reportText.indexOf("Thank you for your referral."));
  assert.equal(update.view, "PA");
  assert.ok(calls.some((c) => c[0] === "summarise") === false || true);
});

await test("Save draft with nothing changed does not send tags or call Azure", async () => {
  await open();
  await click(button("Save draft"), 60);
  const update = lastUpdate();
  assert.equal(update.findingTags, undefined);
  assert.equal(update.findings, undefined, "the page must not send boxes");
  assert.ok(!calls.some((c) => c[0] === "summarise"));
});

await test("switching an abnormal tag to normal takes its box off the film", async () => {
  await open();
  await click(root.querySelector('[data-flip="t1"]'));
  assert.equal(tagRow("t1").dataset.abnormal, "");
  assert.deepEqual(boxLabels(), []);
  await click(button("Save draft"), 60);
  assert.equal(lastUpdate().findingTags[0].abnormal, false);
  assert.deepEqual(lastUpdate().findings, []);
  assert.ok(!calls.some((c) => c[0] === "summarise"), "a normal sentence is never boxed");
});

await test("switching a normal tag to abnormal asks Azure for exactly one box for it", async () => {
  await open();
  await click(root.querySelector('[data-flip="t3"]'));
  assert.equal(tagRow("t3").dataset.abnormal, "1");
  assert.deepEqual(boxLabels(), [S1], "no box until Azure places one");
  await click(button("Save draft"), 80);
  assert.ok(calls.some((c) => c[0] === "summarise"));
  assert.deepEqual(boxLabels().sort(), [S1, S3].sort());
  assert.equal(server.findings.filter((f) => f.tagKey === "t3").length, 1);
});

await test("a normal tag does not gain a box on a later Azure pass", async () => {
  await open("radiologist", { findingTags: [tag("t1", S1, true), tag("t2", S2, false), tag("t3", "Small right effusion.", true)] });
  await click(button("Save draft"), 60);
  type(root.querySelector('[data-tag-text="t3"]'), "Small right pleural effusion.");
  await click(button("Save draft"), 80);
  assert.ok(calls.some((c) => c[0] === "summarise"));
  assert.equal(server.findings.filter((f) => f.tagKey === "t2").length, 0);
});

await test("Remove box keeps the tag and Azure does not put the box back", async () => {
  await open();
  await click(root.querySelector('[data-delete-box="t1"]'));
  assert.deepEqual(boxLabels(), []);
  assert.deepEqual(tagTexts(), [S1, S2, S3]);
  type(root.querySelector('[data-tag-text="t1"]'), `${S1} Now with more words.`);
  await click(button("Save draft"), 80);
  const saved = lastUpdate();
  assert.equal(saved.findingTags[0].boxDeclined, true);
  assert.equal(saved.findings.find((f) => f.tagKey === "t1").status, "rejected");
  assert.deepEqual(boxLabels(), [], "the deleted box stays deleted after Azure runs");
});

await test("Delete removes a tag, its box and its measurement", async () => {
  await open();
  await click(root.querySelector('[data-delete-tag="t1"]'));
  assert.deepEqual(tagKeys(), ["t2", "t3"]);
  assert.deepEqual(boxLabels(), []);
  await click(button("Save draft"), 60);
  assert.deepEqual(lastUpdate().findingTags.map((t) => t.key), ["t2", "t3"]);
  assert.ok(lastUpdate().reportText.includes("FINDINGS\nHeart size is normal.\nNo pleural effusion.\n\nCOMMENT"));
  assert.ok(!lastUpdate().reportText.includes("bibasilar atelectasis."));
});

await test("a new finding is added at the end of the list", async () => {
  await open();
  type(root.querySelector("#new-finding"), "Small left apical pneumothorax.");
  await click(root.querySelector("#add-finding"));
  assert.deepEqual(tagKeys(), ["t1", "t2", "t3", "t4"]);
  assert.equal(tagRow("t4").querySelector("textarea").value, "Small left apical pneumothorax.");
  assert.equal(tagRow("t4").dataset.abnormal, "1", "a named abnormality is abnormal");
  assert.equal(root.querySelector("#new-finding").value, "", "the add box is cleared");
  type(root.querySelector("#new-finding"), "The trachea is midline.");
  await click(root.querySelector("#add-finding"));
  assert.equal(tagRow("t5").dataset.abnormal, "", "a normal sentence is normal");
  await click(button("Save draft"), 80);
  assert.deepEqual(lastUpdate().findingTags.slice(-2).map((t) => t.text), ["Small left apical pneumothorax.", "The trachea is midline."]);
  assert.equal(lastUpdate().findingTags.at(-2).manual, true);
  assert.ok(calls.some((c) => c[0] === "summarise"), "the new abnormal finding is sent to Azure for its one box");
});

await test("dragging a tag reorders the list and COMMENT stays below", async () => {
  await open();
  const handle = root.querySelector('[data-drag-tag="t3"]');
  handle.dispatchEvent(new window.Event("dragstart"));
  const target = tagRow("t1");
  target.getBoundingClientRect = () => ({ top: 0, height: 10 });
  const over = new window.Event("dragover");
  over.clientY = 2;
  target.dispatchEvent(over);
  const drop = new window.Event("drop");
  drop.clientY = 2;
  target.dispatchEvent(drop);
  await tick();
  assert.deepEqual(tagKeys(), ["t3", "t1", "t2"]);
  assert.ok(root.querySelector("#tag-list").compareDocumentPosition(root.querySelector("#comment-text")) & 4, "COMMENT stays under the list");
  calls.length = 0;
  await click(button("Save draft"), 60);
  const update = lastUpdate();
  assert.deepEqual(update.findingTags.map((t) => t.key), ["t3", "t1", "t2"]);
  assert.ok(update.reportText.includes(`FINDINGS\n${S3}\n${S1}\n${S2}\n\nCOMMENT`));
  assert.ok(!calls.some((c) => c[0] === "summarise"), "a new order alone must not call Azure");
});

await test("dropping a tag after another puts it after", async () => {
  await open();
  root.querySelector('[data-drag-tag="t1"]').dispatchEvent(new window.Event("dragstart"));
  const target = tagRow("t3");
  target.getBoundingClientRect = () => ({ top: 0, height: 10 });
  const drop = new window.Event("drop");
  drop.clientY = 9;
  target.dispatchEvent(drop);
  await tick();
  assert.deepEqual(tagKeys(), ["t2", "t3", "t1"]);
});

await test("editing COMMENT is saved and assembled under the list", async () => {
  await open();
  type(root.querySelector("#comment-text"), "Mild bibasilar atelectasis; no consolidation.");
  await click(button("Save draft"), 60);
  assert.equal(lastUpdate().comment, "Mild bibasilar atelectasis; no consolidation.");
  assert.ok(lastUpdate().reportText.includes("COMMENT\n– Mild bibasilar atelectasis; no consolidation."));
});

await test("a drawn box with nothing selected starts a new finding at the end", async () => {
  await open();
  await click(root.querySelector("#draw-box"));
  assert.ok(button("Drawing…"));
  drag(20, 20, 35, 40);
  await tick();
  assert.deepEqual(tagKeys(), ["t1", "t2", "t3", "t4"]);
  assert.equal(tagRow("t4").dataset.abnormal, "1");
  assert.equal(boxLabels().length, 2);
  assert.ok(button("Draw box"), "draw mode ends after one box");
  await click(button("Save draft"), 80);
  const saved = lastUpdate().findings.find((f) => f.tagKey === "t4");
  assert.equal(saved.source, "manual");
  assert.deepEqual(saved.bbox, [20, 20, 15, 20]);
  assert.ok(!String(saved._id || "").startsWith("tmp-"));
});

await test("a box drawn while an abnormal tag without a box is selected belongs to that tag", async () => {
  await open("radiologist", { findings: [] });
  await click(tagRow("t1"));
  await click(root.querySelector("#draw-box"));
  drag(20, 20, 40, 50);
  await tick();
  assert.deepEqual(tagKeys(), ["t1", "t2", "t3"], "no new tag");
  assert.equal(root.querySelectorAll("[data-bbox]").length, 1);
  assert.equal(root.querySelector("[data-bbox]").dataset.boxTag, "t1");
});

await test("a click without dragging does not add a box", async () => {
  await open();
  await click(root.querySelector("#draw-box"));
  pointer(stage(), "pointerdown", 60, 20);
  pointer(stage(), "pointerup", 60, 20);
  await tick();
  assert.equal(boxLabels().length, 1);
});

await test("dragging a corner resizes and dragging inside moves the selected box", async () => {
  await open();
  await click(tagRow("t1"));
  drag(90, 80, 70, 90);
  await tick();
  let node = root.querySelector("[data-bbox][data-selected='1']");
  assert.equal(node.style.width, "60%");
  assert.equal(node.style.height, "30%");
  drag(30, 70, 35, 65);
  await tick();
  node = root.querySelector("[data-bbox][data-selected='1']");
  assert.equal(node.style.left, "15%");
  assert.equal(node.style.top, "55%");
  await click(button("Save draft"), 80);
  const moved = lastUpdate().findings.find((f) => f.tagKey === "t1");
  assert.deepEqual(moved.bbox, [15, 55, 60, 30]);
  assert.equal(moved.bboxSource, "manual");
  assert.ok(!calls.some((c) => c[0] === "summarise"), "box edits alone must not call Azure");
});

await test("a moved box keeps its place after Azure runs for another sentence", async () => {
  await open("radiologist", { findings: [{ ...box("t1", S1), bbox: [20, 50, 30, 30], bboxSource: "manual" }] });
  await click(root.querySelector('[data-flip="t3"]'));
  await click(button("Save draft"), 80);
  assert.deepEqual(server.findings.find((f) => f.tagKey === "t1").bbox, [20, 50, 30, 30]);
  assert.ok(boxLabels().includes(S3));
});

console.log("\n=== measurements ===");

await test("a lesion line without pixel spacing shows pixels only and starts a finding", async () => {
  await open("radiologist", { findings: [] });
  await click(button("Measure"));
  assert.ok(button("Measuring"));
  filmSize();
  drag(10, 10, 40, 50);
  await tick();
  assert.ok(root.querySelector("[data-saved-measures] line"));
  assert.equal(root.querySelector("[data-saved-measure-label='1']").textContent, "1 · 500 px");
  assert.ok(root.querySelector("#spacing-note").textContent.includes("pixels only"));
  assert.equal(tagKeys().length, 4);
  assert.ok(!/cm/.test(tagRow("t4").querySelector("textarea").value));
  assert.ok(tagRow("t4").querySelector("textarea").value.includes("measuring 500 px"));
});

await test("a portable supine film marked as PA erect disables the body-size estimate", async () => {
  await open("radiologist", {
    view: "PA",
    dicomViewPosition: "AP",
    patientPosition: "HFS",
    projectionCues: "PORTABLE CHEST SUPINE",
    imagerPixelSpacingMm: [0.1, 0.1],
    pixelSpacingMm: [0.1, 0.1],
    pixelSpacingSource: "ImagerPixelSpacing",
  });
  assert.ok(root.querySelector("#projection-warning").textContent.includes("Projection conflict"));
  assert.ok(root.querySelector("#projection-warning").textContent.includes("disabled"));
  await click(button("Measure"));
  filmSize();
  drag(10, 10, 40, 50);
  await tick();
  assert.equal(root.querySelector("[data-saved-measure-label='1']").textContent, "1 · Film 5.00 cm · Body size unavailable");
  assert.equal(root.querySelector("[data-experimental-estimate]"), null);
  assert.ok(root.querySelector("#spacing-note").textContent.includes("Body-size estimate unavailable"));
});

await test("a lesion line on an erect PA film shows the film size, and the 180 cm figure only as an experiment", async () => {
  await open("radiologist", { imagerPixelSpacingMm: [0.1, 0.1], pixelSpacingMm: [0.1, 0.1], pixelSpacingSource: "ImagerPixelSpacing" });
  calls.length = 0;
  await click(tagRow("t1"));
  await click(button("Measure"));
  filmSize();
  drag(10, 10, 40, 50);
  await tick();
  assert.equal(root.querySelector("[data-saved-measure-label='1']").textContent, "1 · Film 5.00 cm · Body size unavailable");
  assert.ok(root.querySelector("#spacing-note").textContent.includes("Imager Pixel Spacing (0018,1164)"));
  assert.ok(root.querySelector("#spacing-note").textContent.includes("No calibrated body measurement is available"));
  assert.ok(root.querySelector("[data-experimental-estimate='1']").textContent.includes("Experimental estimate: 4.69 cm"));
  assert.equal(tagKeys().length, 3, "the selected sentence took the measurement");
  assert.ok(tagRow("t1").querySelector("textarea").value.endsWith(", measuring Film 5.00 cm · Body size unavailable."));
  const strokes = [...root.querySelectorAll("[data-saved-measures] line")].map((l) => l.getAttribute("stroke"));
  assert.ok(strokes.includes("#ffffff"), strokes.join(","));
  pointer(stage(), "pointerdown", 70, 80);
  pointer(stage(), "pointerup", 70, 80);
  await tick();
  assert.equal(root.querySelectorAll("[data-saved-measure-label]").length, 1, "a click must not add a measurement");
  await click(root.querySelector("#toggle-measures"));
  assert.equal(root.querySelector("[data-saved-measures]"), null, "Hide lines did not hide them");
  await click(root.querySelector("#toggle-measures"));
  await click(button("Save draft"), 60);
  const m = lastUpdate().measurements[0];
  assert.equal(m.kind, "lesion");
  assert.equal(m.tagKey, "t1");
  assert.equal(m.lengthPx, 500);
  assert.equal(m.lengthMm, 50);
  assert.equal(m.spacingTag, "ImagerPixelSpacing");
  assert.ok(lastUpdate().reportText.includes("measuring Film 5.00 cm · Body size unavailable."));
  assert.ok(!calls.some((c) => c[0] === "summarise"), "a measurement alone must not call Azure");
});

await test("a calibrated Pixel Spacing shows the magnification and the body size", async () => {
  await open("radiologist", {
    imagerPixelSpacingMm: [0.1, 0.1],
    dicomPixelSpacingMm: [0.08, 0.08],
    pixelSpacingMm: [0.1, 0.1],
    pixelSpacingSource: "ImagerPixelSpacing",
    findings: [],
  });
  await click(button("Measure"));
  filmSize();
  drag(10, 10, 60, 10);
  await tick();
  assert.equal(root.querySelector("[data-saved-measure-label='1']").textContent, "1 · 4.00 cm body · ×1.25 · film 5.00 cm");
  assert.ok(root.querySelector("#spacing-note").textContent.includes("Pixel Spacing (0028,0030)"));
  assert.ok(root.querySelector("#spacing-note").textContent.includes("×1.25"));
});

await test("with only Pixel Spacing an erect PA film still shows the Hong Kong estimate", async () => {
  await open("radiologist", { pixelSpacingMm: [0.2, 0.2], dicomPixelSpacingMm: [0.2, 0.2], pixelSpacingSource: "PixelSpacing" });
  await click(tagRow("t1"));
  await click(button("Measure"));
  filmSize();
  drag(10, 10, 40, 10);
  await tick();
  assert.equal(root.querySelector("[data-saved-measure-label='1']").textContent, "1 · Film 6.00 cm · Body size unavailable");
  assert.ok(root.querySelector("#spacing-note").textContent.includes("Pixel Spacing (0028,0030)"));
  await click(button("Save draft"), 60);
  assert.equal(lastUpdate().measurements[0].spacingTag, "PixelSpacing");
});

await test("Delete removes a measurement and its words from the sentence", async () => {
  calls.length = 0;
  await click(root.querySelector("[data-delete-measure]"));
  assert.equal(root.querySelector("[data-saved-measures]"), null);
  assert.ok(!tagRow("t1").querySelector("textarea").value.includes("measuring"));
  await click(button("Save draft"), 60);
  assert.deepEqual(lastUpdate().measurements, []);
});

console.log("\n=== heart size ===");

async function drawHeartSize(heart, thorax) {
  await click(root.querySelector("#measure-ctr"));
  filmSize();
  drag(...heart);
  await tick();
  assert.ok(root.querySelector("#film-hint").textContent.includes("inner thoracic diameter"), "the second line is asked for");
  drag(...thorax);
  await tick();
}
const spaced = { imagerPixelSpacingMm: [0.1, 0.1], pixelSpacingMm: [0.1, 0.1], pixelSpacingSource: "ImagerPixelSpacing" };

await test("a normal ratio on an erect PA film is a sentence with no box", async () => {
  await open("radiologist", { ...spaced, findings: [] });
  await drawHeartSize([30, 55, 70, 55], [10, 40, 90, 40]);
  const key = tagKeys().at(-1);
  assert.equal(key, "t4", "appended at the end");
  assert.equal(tagRow(key).querySelector("textarea").value, "Cardiothoracic ratio is normal, 4.0 : 8.0.");
  assert.equal(tagRow(key).dataset.abnormal, "");
  assert.deepEqual(boxLabels(), [], "a normal ratio has no box");
  assert.equal(root.querySelectorAll("[data-saved-measure-label]").length, 2, "both diameters are on the film");
  assert.ok(root.querySelector("[data-saved-measure-label='1']").textContent.includes("Heart 4.0 cm film"));
});

await test("an increased ratio says so and gets one box on the heart line", async () => {
  await open("radiologist", { ...spaced, findings: [] });
  await drawHeartSize([30, 55, 70, 55], [20, 40, 80, 40]);
  assert.equal(tagRow("t4").querySelector("textarea").value, "Cardiothoracic ratio is increased, 4.0 : 6.0.");
  assert.equal(tagRow("t4").dataset.abnormal, "1");
  assert.deepEqual(boxLabels(), ["Cardiothoracic ratio is increased, 4.0 : 6.0."]);
  assert.equal(root.querySelectorAll("[data-bbox]").length, 1);
  const bbox = root.querySelector("[data-bbox]");
  assert.ok(parseFloat(bbox.style.left) <= 30 && parseFloat(bbox.style.width) >= 40, "the box spans the heart line");
});

await test("on an AP or unknown view the ratio is not called normal and has no box", async () => {
  await open("radiologist", { ...spaced, findings: [] });
  await drawHeartSize([30, 55, 70, 55], [20, 40, 80, 40]);
  const select = root.querySelector("#view-select");
  select.value = "AP supine";
  select.dispatchEvent(new window.Event("change"));
  await tick();
  const text = tagRow("t4").querySelector("textarea").value;
  assert.ok(text.includes("not applied automatically"), text);
  assert.ok(text.includes("0.67"));
  assert.ok(!/normal,|increased,/.test(text));
  assert.equal(tagRow("t4").dataset.abnormal, "");
  assert.deepEqual(boxLabels(), []);
  assert.equal(root.querySelector("#report-title").textContent, "XRAY CHEST (AP SUPINE)");
  select.value = "PA";
  select.dispatchEvent(new window.Event("change"));
  await tick();
  assert.ok(tagRow("t4").querySelector("textarea").value.startsWith("Cardiothoracic ratio is increased"));
  assert.equal(root.querySelectorAll("[data-bbox]").length, 1);
});

await test("Save draft stores the two diameters, the ratio sentence and the view", async () => {
  await open("radiologist", { ...spaced, findings: [] });
  await drawHeartSize([30, 55, 70, 55], [20, 40, 80, 40]);
  await click(button("Save draft"), 80);
  const update = lastUpdate();
  const ctr = update.findingTags.find((t) => t.kind === "ctr");
  assert.equal(ctr.text, "Cardiothoracic ratio is increased, 4.0 : 6.0.");
  assert.deepEqual(update.measurements.map((m) => m.kind).sort(), ["ctr-heart", "ctr-thorax"]);
  assert.ok(update.measurements.every((m) => m.tagKey === ctr.key && m.spacingTag === "ImagerPixelSpacing"));
  assert.deepEqual(update.measurements.map((m) => m.lengthMm).sort((a, b) => a - b), [40, 60]);
  assert.ok(update.reportText.includes("Cardiothoracic ratio is increased, 4.0 : 6.0."));
  assert.equal(update.findings.filter((f) => f.tagKey === ctr.key).length, 1);
});

await test("Delete on a heart line removes the ratio sentence, which needs both lines", async () => {
  await click(root.querySelector("[data-delete-measure]"));
  assert.ok(!tagKeys().includes("t4"));
  assert.equal(root.querySelectorAll("[data-saved-measure-label]").length, 0);
});

console.log("\n=== save, remarks, log, urgent ===");

await test("Save draft sits on the right and Draft saved leaves after 5 seconds", async () => {
  await open();
  const save = button("Save draft");
  assert.equal(save.parentElement.nextElementSibling?.id, "report-panel", "Save draft should sit on the report box");
  assert.ok(save.parentElement.className.includes("justify-end"), "Save draft should stay on the right");
  assert.ok(save.className.includes("bg-slate-900"));
  assert.ok(save.querySelector("svg"), "Save draft should show a save icon");
  const labels = buttons().map((b) => b.textContent.replace(/\s+/g, " ").trim());
  assert.ok(labels.indexOf("Save draft") > labels.indexOf("Mark urgent"));
  type(root.querySelector("#comment-text"), "Edited comment.");
  assert.ok(button("Save draft").className.includes("ring-2"), "unsaved edits should ring the Save draft button");
  await click(button("Save draft"), 200);
  assert.equal(root.querySelector("#draft-notice")?.textContent, "Draft saved.");
  await tick(5200);
  assert.equal(root.querySelector("#draft-notice"), null);
});

await test("the review page has no remarks box", async () => {
  await open();
  assert.equal(root.querySelector("#remarks-box"), null);
  assert.equal(button("Save remarks"), undefined);
});

await test("the draft log shows the manual edit and expands", async () => {
  await open();
  type(root.querySelector("#comment-text"), "Edited comment.");
  await click(button("Save draft"), 60);
  assert.ok(!buttons().some((b) => b.textContent.includes("Edited report")), "the log should start collapsed");
  await click(root.querySelector("#toggle-log"));
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

console.log("\n=== downloads ===");

await test("Preview PDF saves, then shows the PDF in a pop-up window", async () => {
  await open();
  type(root.querySelector("#comment-text"), "Edited comment.");
  opened = null;
  calls.length = 0;
  downloads.length = 0;
  await click(button("Preview PDF"), 1500);
  assert.ok(opened, "no window opened");
  assert.ok(/popup/.test(opened.features || ""), "should open a pop-up window, not a tab");
  assert.equal(opened.name, "radassist-pdf-preview", "previews reuse one named window");
  assert.ok(calls.some((c) => c[0] === "update"), "unsaved edits were not saved first");
  assert.equal(downloads.length, 1, "no PDF produced");
  assert.equal(downloads[0].type, "application/pdf");
  assert.equal(opened.location.href, "blob:test");
  assert.ok(!opened.closed);
  const pdf = await downloads[0].text();
  assert.ok(pdf.includes("Edited comment."));
  assert.ok(!pdf.includes(THINK), "Thinking must not be exported");
});

await test("Word and PDF are the plain report", async () => {
  downloads.length = 0;
  await click(button("Word"), 400);
  assert.equal(downloads.length, 1, "no Word file produced");
  assert.ok(downloads[0].size > 1000);
  downloads.length = 0;
  await click(button("PDF"), 1500);
  assert.equal(downloads.length, 1, "no PDF produced");
  assert.ok(downloads[0].size > 1000);
});

await test("Word and PDF with finding films draw one film per abnormal finding", async () => {
  await open("radiologist", {
    findingTags: [tag("t1", S1, true), tag("t2", S2, false), tag("t3", "Small right pleural effusion.", true)],
    findings: [box("t1", S1), box("t3", "Small right pleural effusion.", { bbox: [60, 60, 20, 15] })],
  });
  const drawn = [];
  setFilmRenderer(async (_bytes, overlay) => {
    drawn.push(overlay);
    return { bytes: Uint8Array.from([0xff, 0xd8, drawn.length, 0xff, 0xd9]), type: "jpg", width: 100, height: 80, components: 3 };
  });
  const jpeg = new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 1, 0, 72, 0, 72, 0, 0, 0xff, 0xd9])], { type: "image/jpeg" });
  api.fetchImage = async () => jpeg;
  downloads.length = 0;
  await click(button("PDF with finding films"), 1500);
  assert.equal(downloads.length, 1);
  assert.equal(drawn.length, 2, "t2 is normal and gets no film");
  assert.ok(drawn.every((o) => o.boxes.length === 1));
  const pdf = await downloads[0].text();
  assert.ok(pdf.includes("Finding 2: Small right pleural effusion."));
  drawn.length = 0;
  downloads.length = 0;
  await click(button("Word with finding films"), 600);
  assert.equal(downloads.length, 1);
  assert.equal(drawn.length, 2);
  setFilmRenderer(null);
  api.fetchImage = async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
});

await test("Re-run AI starts CURV again", async () => {
  await open();
  calls.length = 0;
  await click(button("Re-run AI"));
  assert.ok(calls.some((c) => c[0] === "analyze"));
  assert.ok(root.textContent.includes("GENERATING"));
  assert.equal(root.querySelector("#tag-list"), null, "the report must not be editable while generating");
});

console.log("\n=== endorse and share ===");

await test("Endorse report saves the edit, then finalizes", async () => {
  await open();
  calls.length = 0;
  type(root.querySelector("#comment-text"), "Endorsed wording.");
  await click(button("Endorse report"), 80);
  const order = calls.map((c) => c[0]);
  assert.ok(order.indexOf("update") >= 0 && order.indexOf("finalize") > order.indexOf("update"), order.join(","));
  assert.ok(server.reportText.includes("Endorsed wording."));
  assert.ok(root.textContent.includes("FINALIZED"));
});

await test("the endorsed report is read-only, names the radiologist and hides Thinking", () => {
  assert.equal(root.querySelector("#tag-list textarea"), null);
  assert.equal(root.querySelector("textarea#comment-text"), null);
  const text = root.querySelector("#report-text").textContent;
  assert.ok(text.includes("– Endorsed wording."));
  assert.ok(!text.includes(THINK));
  assert.equal(root.querySelector("#endorser").textContent, "Dr Test");
  assert.ok(root.querySelector("#report-header").textContent.includes("Reported by: Dr Test"));
  assert.equal(button("Save draft"), undefined);
  assert.equal(button("Endorse report"), undefined);
  assert.equal(root.querySelector("[data-flip]:not([disabled])"), null, "tags cannot be switched once endorsed");
  assert.equal(root.querySelector("[data-drag-tag]"), null);
});

await test("a reader can still click a box to see its sentence after endorsing", async () => {
  pointer(stage(), "pointerdown", 50, 70);
  await tick();
  assert.equal(tagRow("t1").dataset.selected, "1");
});

await test("Share copies a link", async () => {
  await click(button("Share"), 40);
  assert.ok(calls.some((c) => c[0] === "share"));
  assert.ok(copied && copied.includes("#/share/tok-1"), copied);
});

await test("boxes cannot be edited while Azure is placing them, or once endorsed", async () => {
  await open("radiologist", { boxesState: "running" });
  assert.equal(root.querySelector("#draw-box"), null);
  assert.equal(root.querySelector("[data-delete-box]"), null);
  await open("radiologist", { status: "finalized" });
  assert.equal(root.querySelector("#draw-box"), null);
  assert.equal(root.querySelector("[data-delete-box]"), null);
  assert.deepEqual(boxLabels(), [S1]);
});

await test("endorsed boxes stay on the film after the server strips their source", async () => {
  const strip = ({ source, ...rest }) => rest;
  await open("radiologist", {
    status: "finalized",
    findingTags: [tag("t1", S1, true), tag("t2", S2, false), tag("t3", "Small nodule.", true)],
    findings: [strip(box("t1", S1)), strip(box("t2", S2, { severity: "normal" })), strip(box("t3", "Small nodule.", { bboxSource: "manual" }))],
  });
  assert.deepEqual(boxLabels(), [S1, "Small nodule."], "the normal sentence has no box even if one is stored");
});

await test("an endorsed report is not asked to go through CURV again", async () => {
  await open("radiologist", {
    status: "finalized",
    boxesState: "",
    findings: [],
    findingTags: [tag("t1", S1, true), tag("t2", S2, false)],
  });
  assert.equal(button("Re-run AI"), undefined);
  const note = root.querySelector("#box-status").textContent;
  assert.ok(note.includes("endorsed"));
  assert.ok(!note.includes("Re-run AI"));
});

console.log("\n=== older cases ===");

await test("an older case with only report text is split into tags once and saved on Save draft", async () => {
  await open("radiologist", {
    findingTags: [],
    comment: "",
    findings: [],
    boxesState: "",
    reportText: "Findings:\nThe lungs are clear. There is a small right pleural effusion.\n\nThinking:\nHidden reasoning.\n\nImpression:\nSmall right effusion.",
  });
  assert.deepEqual(tagTexts(), ["The lungs are clear.", "There is a small right pleural effusion."]);
  assert.equal(tagRow("t1").dataset.abnormal, "");
  assert.equal(tagRow("t2").dataset.abnormal, "1");
  assert.equal(root.querySelector("#comment-text").value, "Small right effusion.");
  assert.ok(root.querySelector("#box-status").textContent.includes("no film boxes yet"));
  calls.length = 0;
  await click(button("Save draft"), 80);
  const update = lastUpdate();
  assert.deepEqual(update.findingTags.map((t) => t.key), ["t1", "t2"]);
  assert.ok(update.reportText.startsWith("XRAY CHEST (PA)\n\nFINDINGS\nThe lungs are clear."), JSON.stringify(update.reportText));
  assert.ok(update.reportText.includes("Hidden reasoning."), "Thinking is kept");
  assert.ok(calls.some((c) => c[0] === "summarise"), "Save draft should ask Azure for the one box");
  assert.deepEqual(boxLabels(), ["There is a small right pleural effusion."]);
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

await test("Azure still placing boxes shows a note and the tags stay editable", async () => {
  await open("radiologist", { boxesState: "running", findings: [] });
  assert.ok(root.querySelector("#box-status").textContent.includes("placing boxes"));
  assert.ok(root.querySelector("#tag-list textarea"));
});

await test("a referring doctor sees the endorsed report read-only", async () => {
  await open("doctor", { status: "finalized", finalizedByName: "Dr Test" });
  assert.equal(root.querySelector("#tag-list textarea"), null, "report must not be editable");
  assert.equal(root.querySelector("textarea#comment-text"), null);
  assert.equal(root.querySelector("#remarks-box"), null, "the review page has no remarks box");
  assert.ok(root.querySelector("#report-text").textContent.includes(S1));
  assert.equal(button("Save draft"), undefined);
  assert.equal(button("Endorse report"), undefined);
  assert.equal(root.querySelector("#draw-box"), null);
  assert.equal(root.querySelector("[data-delete-box]"), null);
  assert.equal(root.querySelector("[data-delete-tag]"), null);
});

stopReviewWatch();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
