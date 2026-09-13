// scripts/test-report-view.mjs
//
// Renders the report popup so doctors can edit the stored report and remarks.

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
globalThis.localStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};
globalThis.URL = URL;
try {
  window.location.href = "http://localhost:5173/?view=report&caseId=CASE-RPT-1";
} catch {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("http://localhost:5173/?view=report&caseId=CASE-RPT-1"),
  });
}
window.close = () => {};

const { state } = await import("../src/state.js");
const { api } = await import("../src/api.js");
const { renderReportViewPage } = await import("../src/components/reportView.js");

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

const testCase = {
  caseId: "CASE-RPT-1",
  patientId: "PT-0009",
  age: "44",
  sex: "Male",
  status: "completed",
  reportText: "The lungs are clear.\n\nRadiologist remarks\nCheck old films.",
  remarks: "Check old films.",
};

state.user = { role: "doctor", userId: "u1", name: "Dr Test" };
api.getCase = async () => ({ case: structuredClone(testCase) });
let saved = null;
api.updateCase = async (_id, payload) => {
  saved = payload;
  return { case: { ...structuredClone(testCase), ...payload } };
};

const root = document.getElementById("root");
await renderReportViewPage({ target: root });

const text = () => root.textContent.replace(/\s+/g, " ");
const areas = () => [...root.querySelectorAll("textarea")];

console.log("\n=== report popup ===");

test("doctors can edit the report and remarks", () => {
  assert.equal(areas().length, 2, `expected report + remarks editors, saw ${areas().length}`);
  assert.ok(areas()[0].value.includes("The lungs are clear."));
  assert.equal(areas()[1].value, "Check old films.");
  assert.ok(areas().every((a) => !a.disabled && !a.hasAttribute("readonly")),
    "report textareas must accept typing");
  assert.ok([...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Save report"));
});

areas()[0].value = "Heart size is normal.";
areas()[0].dispatchEvent(new window.Event("input"));
areas()[1].value = "No old films available.";
areas()[1].dispatchEvent(new window.Event("input"));
const saveBtn = [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save report");
saveBtn.dispatchEvent(new window.Event("click"));
await new Promise((r) => setTimeout(r, 0));

test("saving writes the edited report and remarks to MongoDB", () => {
  assert.ok(saved, "updateCase was not called");
  assert.ok(saved.reportText.includes("Heart size is normal."));
  assert.ok(saved.reportText.includes("Radiologist remarks"));
  assert.ok(saved.reportText.includes("No old films available."));
  assert.equal(saved.remarks, "No old films available.");
});

state.user = { role: "doctor", userId: "u1", name: "Dr Test" };
const finalizedCase = { ...testCase, status: "finalized" };
api.getCase = async () => ({ case: structuredClone(finalizedCase) });
saved = null;
api.updateCase = async (_id, payload) => {
  saved = payload;
  return { case: { ...structuredClone(finalizedCase), ...payload } };
};
await renderReportViewPage({ target: root });

test("finalized popup locks the report but still lets doctors write remarks", () => {
  assert.equal(root.querySelectorAll("#report-body").length, 0, "finalized report body should be read-only");
  assert.ok(text().includes("The lungs are clear."));
  const remarksBox = root.querySelector("#report-remarks");
  assert.ok(remarksBox, "remarks editor missing on finalized report");
  assert.ok(!remarksBox.hasAttribute("readonly") && !remarksBox.disabled);
  assert.ok([...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Save remarks"));
  assert.ok(![...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Save report"));
});

const finalizedRemarks = root.querySelector("#report-remarks");
finalizedRemarks.value = "Seen in clinic.";
finalizedRemarks.dispatchEvent(new window.Event("input"));
[...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save remarks")
  .dispatchEvent(new window.Event("click"));
await new Promise((r) => setTimeout(r, 0));

test("finalized popup remarks do not rewrite the report", () => {
  assert.ok(saved, "updateCase was not called");
  assert.equal(saved.remarks, "Seen in clinic.");
  assert.equal(saved.reportText, undefined, "finalized report text must stay locked");
});

state.user = { role: "nurse", userId: "n1", name: "Nurse Test" };
saved = null;
api.getCase = async () => ({ case: structuredClone(testCase) });
await renderReportViewPage({ target: root });

test("nurses see a read-only report", () => {
  assert.equal(root.querySelectorAll("textarea").length, 0, "nurses should not edit the report");
  assert.ok(text().includes("The lungs are clear."));
  assert.ok(text().includes("Check old films."));
  assert.ok(![...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Save report"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
