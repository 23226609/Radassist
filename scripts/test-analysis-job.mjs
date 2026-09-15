// scripts/test-analysis-job.mjs
// Overlay + poll until the case leaves `pending`.

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

const { api } = await import("../src/api.js");
const { state } = await import("../src/state.js");
const { caseStatus, statusLabel, isGenerating, isAwaitingApprove } = await import("../src/lib/caseStatus.js");
const { startAnalysisWatch, stopAnalysisWatch, CASES_CHANGED } = await import("../src/lib/analysisJob.js");

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

console.log("\n=== analysis job ===");

test("maps completed to pending approve", () => {
  assert.equal(caseStatus("completed"), "pending_approve");
  assert.equal(statusLabel("completed"), "Pending approve");
  assert.equal(statusLabel("pending"), "Generating");
  assert.equal(statusLabel("finalized"), "Finalized");
  assert.equal(isGenerating({ status: "pending" }), true);
  assert.equal(isAwaitingApprove({ status: "completed" }), true);
});

{
  let calls = 0;
  api.getCase = async () => {
    calls += 1;
    return {
      case: {
        caseId: "CASE-JOB-1",
        status: calls === 1 ? "pending" : "pending_approve",
      },
    };
  };
  let event = null;
  window.addEventListener(CASES_CHANGED, (e) => { event = e.detail; });

  startAnalysisWatch({ caseId: "CASE-JOB-1", patientName: "Ada Wong" });
  await new Promise((r) => setTimeout(r, 0));
  const overlay = document.getElementById("radassist-analysis");
  test("shows a centered overlay while pending", () => {
    assert.ok(overlay);
    assert.equal(overlay.hidden, false);
    assert.ok(overlay.classList.contains("flex"), "open overlay must use flex, not a hidden+flex fight");
    assert.ok(!overlay.classList.contains("hidden"));
    assert.ok(overlay.textContent.includes("Generating the report"));
    assert.ok(overlay.textContent.includes("Ada Wong"));
  });

  await new Promise((r) => setTimeout(r, 2100));

  test("hides the overlay once the draft is pending approve", () => {
    assert.equal(overlay.hidden, true);
    assert.ok(overlay.classList.contains("hidden"), "closed overlay must use Tailwind hidden");
    assert.ok(!overlay.classList.contains("flex"), "flex must be removed or Tailwind keeps it on screen");
    assert.equal(event?.ok, true);
    assert.equal(state.page, "review");
    assert.equal(state.selectedCaseId, "CASE-JOB-1");
  });
}

stopAnalysisWatch();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
