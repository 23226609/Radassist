// scripts/test-share-page.mjs
// Public finalized-report view, no login.

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
globalThis.URL = URL;
try {
  window.location.href = "http://localhost:5173/#/share/tok123";
} catch {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("http://localhost:5173/#/share/tok123"),
  });
}

const { state } = await import("../src/state.js");
const { api } = await import("../src/api.js");
const { parseHash } = await import("../src/state.js");
const { renderSharePage } = await import("../src/components/shareView.js");

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

console.log("\n=== share page ===");

test("hash /share/token is a public route", () => {
  const route = parseHash("#/share/abc_token");
  assert.equal(route.page, "share");
  assert.equal(route.shareToken, "abc_token");
});

state.shareToken = "tok123";
state.user = null;
api.getSharedCase = async () => ({
  case: {
    caseId: "CASE-SHARE-1",
    patientId: "PT-9",
    patientName: "Ada Wong",
    createdByName: "Dr. Priya Nair",
    age: "40",
    sex: "Female",
    status: "finalized",
    reportText: "Heart size is normal.\nThe lungs are clear.",
    findings: [{ label: "Clear lungs", sentence: "The lungs are clear.", status: "accepted" }],
  },
});

const root = document.getElementById("root");
await renderSharePage({ target: root });

test("shows the film report without asking to log in", () => {
  assert.ok(root.textContent.includes("Shared report"));
  assert.ok(root.textContent.includes("Ada Wong"));
  assert.ok(root.textContent.includes("Heart size is normal."));
  assert.ok(root.textContent.includes("Clear lungs"));
});

test("shows the doctor in charge", () => {
  assert.ok(root.textContent.includes("Doctor in charge"));
  assert.ok(root.textContent.includes("Dr. Priya Nair"));
});

test("keeps the report in its own full-width card under the film", () => {
  const headings = [...root.querySelectorAll("h2")].map((h) => h.textContent.trim());
  assert.ok(headings.includes("Findings"));
  assert.ok(headings.includes("Report"));
  const reportCard = [...root.querySelectorAll("section")].find((s) => s.textContent.includes("Heart size is normal."));
  assert.ok(reportCard, "report card missing");
  assert.ok(!reportCard.querySelector("img"), "report should not sit in the film column");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
