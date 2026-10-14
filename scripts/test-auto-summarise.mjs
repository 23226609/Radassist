// scripts/test-auto-summarise.mjs
//
// Azure film boxes are written after CURV stores its draft. Opening Review
// shows the report and those boxes, and must not call Azure again.
//
//   node scripts/test-auto-summarise.mjs

import assert from "node:assert";
import { parseHTML } from "linkedom";

function freshDom() {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>"
  );
  return { window, document };
}

const { window, document } = freshDom();
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

const { state } = await import("../src/state.js");
const { api } = await import("../src/api.js");
const { renderReviewPage } = await import("../src/components/review.js");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${name}\n      ${err.message}`);
    failed++;
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err) {
    console.log(`  \u2717 ${name}\n      ${err.stack || err.message}`);
    failed++;
  }
}

const REPORT_TEXT = [
  "Chest X-Ray Report",
  "",
  "1. Lungs:",
  "   - The lungs are clear bilaterally without focal consolidation.",
  "2. Heart:",
  "   - The heart size is within normal limits.",
].join("\n");

function makeCase(overrides = {}) {
  return {
    caseId: `CASE-AUTO-${Math.random().toString(16).slice(2, 8)}`,
    patientId: "PT-0001",
    age: "40",
    sex: "Male",
    status: "pending_approve",
    reportText: REPORT_TEXT,
    imageId: null,
    findings: [],
    ...overrides,
  };
}

function azureFinding(label) {
  return {
    _id: `az-${label}`,
    label,
    confidence: 0.8,
    bbox: [8, 6, 34, 18],
    location: "",
    size: "",
    pattern: "Other",
    sentence: label,
    status: "pending",
    source: "Azure",
    bboxSource: "vision",
    confidenceSource: "calibrated",
  };
}

async function runScenario({ role, testCase }) {
  const root = document.getElementById("root");
  root.innerHTML = "";

  let azureCalls = 0;
  api.getCase = async () => ({ case: structuredClone(testCase) });
  api.fetchImage = async () => { throw new Error("no image in test"); };
  api.summariseFindings = async () => {
    azureCalls++;
    throw new Error("Review must not summarise on page open");
  };

  state.user = { role, userId: "u1", name: "Test User" };
  state.cases = [structuredClone(testCase)];
  state.selectedCaseId = testCase.caseId;

  await renderReviewPage({ target: root });
  await new Promise((r) => setTimeout(r, 0));

  return { root, azureCalls, cachedCase: state.cases[0] };
}

console.log("\n=== findings are ready before pending approve ===");

await testAsync("opening Review shows stored Azure boxes and does not call Azure", async () => {
  const testCase = makeCase({
    findings: [azureFinding("Clear lung fields"), azureFinding("Normal heart size")],
  });
  const { root, azureCalls } = await runScenario({ role: "radiologist", testCase });
  assert.equal(azureCalls, 0, "Azure must already have run during generate");
  assert.ok(root.textContent.includes("Clear lung fields"), "stored Azure finding not shown");
  assert.ok(!root.textContent.includes("Summarising findings"), "must not start a summarise spinner on open");
});

await testAsync("a case with no boxes shows the CURV report and no finding cards", async () => {
  const testCase = makeCase();
  const { root, azureCalls } = await runScenario({ role: "radiologist", testCase });
  assert.equal(azureCalls, 0, "no boxes must not trigger Azure on Review");
  assert.equal(root.querySelector("article"), null, "finding cards should be gone");
  assert.equal(root.querySelectorAll("[data-bbox]").length, 0, "no local-parser boxes on the film");
  assert.ok(root.querySelector("#report-text")?.textContent.includes("The heart size is within normal limits."));
});

await testAsync("normal statements are not boxed on the film", async () => {
  const testCase = makeCase({
    findings: [{ ...azureFinding("Clear lung fields"), severity: "normal" }, azureFinding("Cardiomegaly")],
  });
  const { root } = await runScenario({ role: "radiologist", testCase });
  const labels = [...root.querySelectorAll("[data-bbox-label]")].map((n) => n.textContent);
  assert.deepEqual(labels, ["Cardiomegaly"]);
});

await testAsync("Hide boxes and Show boxes toggle the film overlays", async () => {
  const testCase = makeCase({ findings: [azureFinding("Cardiomegaly")] });
  const { root } = await runScenario({ role: "radiologist", testCase });
  assert.equal(root.querySelectorAll("[data-bbox]").length, 1);
  root.querySelector("#toggle-bboxes").dispatchEvent(new window.Event("click"));
  assert.equal(root.querySelectorAll("[data-bbox]").length, 0);
  root.querySelector("#toggle-bboxes").dispatchEvent(new window.Event("click"));
  assert.equal(root.querySelectorAll("[data-bbox]").length, 1);
});

await testAsync("Review says when Azure is still placing boxes", async () => {
  const testCase = makeCase({ boxesState: "running" });
  const { root } = await runScenario({ role: "radiologist", testCase });
  assert.ok(root.querySelector("#box-status")?.textContent.includes("placing boxes"));
});

await testAsync("technicians do not trigger Azure on Review", async () => {
  const testCase = makeCase({ findings: [azureFinding("Clear lung fields")] });
  const { azureCalls, root } = await runScenario({ role: "technician", testCase });
  assert.equal(azureCalls, 0);
  assert.ok(root.textContent.includes("Clear lung fields"));
});

await testAsync("the review page has no manual Summarise button", async () => {
  const testCase = makeCase({ findings: [azureFinding("Clear lung fields")] });
  const { root, azureCalls } = await runScenario({ role: "radiologist", testCase });
  assert.equal(azureCalls, 0);
  const btn = [...root.querySelectorAll("button")].find((b) => /Summarise with Azure AI/.test(b.textContent));
  assert.equal(btn, undefined, "manual button should not be rendered");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
