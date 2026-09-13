// scripts/test-auto-summarise.mjs
//
// Drives the real review page (src/components/review.js) through a linkedom
// DOM to check that opening a case summarises its findings automatically —
// Azure first, falling back to the local parser — with no button click.
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

// linkedom exposes select.value as getter-only; real browsers let you assign
// it, which is what dom.js does when building the pattern dropdown.
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
    status: "completed",
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
  };
}

// Run one full render pass for a case + role + api.summariseFindings mock,
// returning how many times Azure was called and the resulting case.
async function runScenario({ role, testCase, azureImpl }) {
  const root = document.getElementById("root");
  root.innerHTML = "";

  let azureCalls = 0;
  api.getCase = async () => ({ case: structuredClone(testCase) });
  api.fetchImage = async () => { throw new Error("no image in test"); };
  api.summariseFindings = async (...args) => {
    azureCalls++;
    return azureImpl(...args);
  };

  state.user = { role, userId: "u1", name: "Test User" };
  state.cases = [structuredClone(testCase)];
  state.selectedCaseId = testCase.caseId;

  await renderReviewPage({ target: root });
  // autoPopulateFindings resolves before the final render() in the current
  // implementation, but wait a tick in case a future change makes any part
  // of it fire-and-forget.
  await new Promise((r) => setTimeout(r, 0));

  return { root, azureCalls, cachedCase: state.cases[0] };
}

console.log("\n=== automatic findings summarisation on page open ===");

await testAsync("doctor opening a fresh case triggers Azure with no button click", async () => {
  const testCase = makeCase();
  const { root, azureCalls, cachedCase } = await runScenario({
    role: "doctor",
    testCase,
    azureImpl: async () => ({
      added: 2,
      kept: 0,
      case: { ...structuredClone(testCase), findings: [azureFinding("Clear lung fields"), azureFinding("Normal heart size")] },
    }),
  });
  assert.equal(azureCalls, 1, "expected exactly one automatic Azure call");
  assert.ok(root.textContent.includes("Clear lung fields"), "Azure finding not shown");
  assert.equal(cachedCase.findings.length, 2, "state.cases cache was not updated with Azure results");
});

await testAsync("Azure failure falls back to the local parser automatically", async () => {
  const testCase = makeCase();
  const { root, azureCalls } = await runScenario({
    role: "doctor",
    testCase,
    azureImpl: async () => { throw new Error("Azure OpenAI is not configured."); },
  });
  assert.equal(azureCalls, 1, "expected Azure to be attempted once");
  // The local parser derives cards from REPORT_TEXT — confirm something
  // landed in the carousel rather than leaving an empty state.
  assert.ok(
    root.querySelector("article"),
    `expected a fallback finding card, got: ${root.textContent.slice(0, 200)}`
  );
});

await testAsync("nurses never trigger the Azure call (read-only role)", async () => {
  const testCase = makeCase();
  const { azureCalls } = await runScenario({
    role: "nurse",
    testCase,
    azureImpl: async () => { throw new Error("should not be called for a nurse"); },
  });
  assert.equal(azureCalls, 0, "Azure should not be called for a nurse");
});

await testAsync("finalized cases never trigger the Azure call", async () => {
  const testCase = makeCase({ status: "finalized" });
  const { azureCalls } = await runScenario({
    role: "doctor",
    testCase,
    azureImpl: async () => { throw new Error("should not be called for a finalized case"); },
  });
  assert.equal(azureCalls, 0, "Azure should not be called once a case is finalized");
});

await testAsync("Azure findings that already have a bboxSource are not re-summarised", async () => {
  const existing = { ...azureFinding("Existing finding"), bboxSource: "vision", confidenceSource: "calibrated" };
  const testCase = makeCase({ findings: [existing] });
  const { root, azureCalls } = await runScenario({
    role: "doctor",
    testCase,
    azureImpl: async () => { throw new Error("should not be called again"); },
  });
  assert.equal(azureCalls, 0, "Azure should not be called when vision boxes already exist");
  assert.ok(root.textContent.includes("Existing finding"), "existing finding should still be shown");
});

await testAsync("Azure vision boxes without a calibrated score are upgraded once", async () => {
  const testCase = makeCase({
    findings: [{ ...azureFinding("Old 100% card"), bboxSource: "vision" }],
  });
  const { azureCalls } = await runScenario({
    role: "doctor",
    testCase,
    azureImpl: async () => ({
      added: 1,
      kept: 0,
      case: { ...structuredClone(testCase), findings: [{ ...azureFinding("Clear lung fields"), bboxSource: "vision", confidenceSource: "calibrated" }] },
    }),
  });
  assert.equal(azureCalls, 1, "expected a one-shot upgrade of uncalibrated scores");
});

await testAsync("legacy Azure findings without bboxSource are upgraded once", async () => {
  const testCase = makeCase({ findings: [azureFinding("Old placeholder")] });
  const { azureCalls } = await runScenario({
    role: "doctor",
    testCase,
    azureImpl: async () => ({
      added: 1,
      kept: 0,
      case: { ...structuredClone(testCase), findings: [{ ...azureFinding("Clear lung fields"), bboxSource: "vision" }] },
    }),
  });
  assert.equal(azureCalls, 1, "expected a one-shot upgrade of placeholder boxes");
});

await testAsync("local-parser AI findings are replaced by Azure on page open", async () => {
  const testCase = makeCase({
    findings: [{
      _id: "ai-1", label: "Prior local finding", confidence: 0.5, bbox: [10, 10, 20, 20],
      location: "", size: "", pattern: "Other", sentence: "Prior local finding",
      status: "pending", source: "AI",
    }],
  });
  const { azureCalls, root } = await runScenario({
    role: "doctor",
    testCase,
    azureImpl: async () => ({
      added: 1,
      kept: 0,
      case: { ...structuredClone(testCase), findings: [{ ...azureFinding("Clear lung fields"), bboxSource: "vision" }] },
    }),
  });
  assert.equal(azureCalls, 1, "Azure should upgrade local-parser cards");
  assert.ok(root.textContent.includes("Clear lung fields"));
});

await testAsync("the review page has no manual Summarise button", async () => {
  const testCase = makeCase();
  const { root } = await runScenario({
    role: "doctor",
    testCase,
    azureImpl: async () => ({
      added: 1,
      kept: 0,
      case: { ...structuredClone(testCase), findings: [{ ...azureFinding("Clear lung fields"), bboxSource: "vision" }] },
    }),
  });
  const btn = [...root.querySelectorAll("button")].find((b) => /Summarise with Azure AI/.test(b.textContent));
  assert.equal(btn, undefined, "manual button should not be rendered");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
