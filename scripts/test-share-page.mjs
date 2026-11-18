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
    requestedByName: "Dr Referrer",
    age: "40",
    sex: "Female",
    status: "finalized",
    finalizedByName: "Dr. Priya Nair",
    finalizedAt: "2026-11-10T03:16:00Z",
    view: "PA",
    reportText: [
      "XRAY CHEST (PA)", "", "FINDINGS", "Heart size is normal.", "Small right pleural effusion.", "",
      "COMMENT", "– Small right pleural effusion.", "", "Thank you for your referral.", "", "Thinking:", "Hidden reasoning.",
    ].join("\n"),
    findingTags: [
      { key: "t1", text: "Heart size is normal.", abnormal: false },
      { key: "t2", text: "Small right pleural effusion.", abnormal: true },
    ],
    comment: "Small right pleural effusion.",
    findings: [{ label: "Small right pleural effusion.", sentence: "Small right pleural effusion.", status: "pending", tagKey: "t2", bbox: [60, 60, 20, 15] }],
  },
});

const root = document.getElementById("root");
await renderSharePage({ target: root });

test("shows the film report without asking to log in", () => {
  assert.ok(root.textContent.includes("Shared report"));
  assert.ok(root.textContent.includes("Ada Wong"));
  const body = root.querySelector("#report-body").textContent;
  assert.ok(body.includes("FINDINGS\nHeart size is normal.\nSmall right pleural effusion.\n\nCOMMENT\n– Small right pleural effusion."));
  assert.ok(body.includes("Thank you for your referral."));
});

test("never shows the hidden Thinking", () => {
  assert.ok(!root.textContent.includes("Hidden reasoning."));
});

test("shows the Radiology Examination header fields", () => {
  const header = root.querySelector("#report-header").textContent;
  assert.ok(header.includes("Modality: XRAY"));
  assert.ok(header.includes("Report title: XRAY CHEST (PA)"));
  assert.ok(header.includes("Reported by: Dr. Priya Nair"));
  assert.ok(header.includes("Referring doctor: Dr Referrer"));
});

test("shows the doctor in charge", () => {
  assert.ok(root.textContent.includes("Doctor in charge"));
  assert.ok(root.textContent.includes("Dr. Priya Nair"));
});

test("sentences are in the report, not a second findings list", () => {
  const headings = [...root.querySelectorAll("h2")].map((h) => h.textContent.trim());
  assert.ok(!headings.includes("Findings"));
  assert.ok(headings.includes("Report"));
  const reportCard = [...root.querySelectorAll("section")].find((s) => s.textContent.includes("Heart size is normal."));
  assert.ok(reportCard, "report card missing");
  assert.ok(!reportCard.querySelector("img"), "report should not sit in the film column");
});

test("offers the plain and the finding-films downloads", () => {
  const labels = [...root.querySelectorAll("button")].map((b) => b.textContent.replace(/\s+/g, " ").trim());
  for (const want of ["Word", "PDF", "Word with finding films", "PDF with finding films"]) {
    assert.ok(labels.includes(want), `${want} missing: ${labels.join("|")}`);
  }
});

console.log("\n=== an older shared report ===");

api.getSharedCase = async () => ({
  case: {
    caseId: "CASE-SHARE-2",
    patientId: "PT-8",
    age: "50",
    sex: "Male",
    status: "finalized",
    reportText: "Heart size is normal.\nThe lungs are clear.",
    findings: [],
  },
});
await renderSharePage({ target: root });

test("an older report is split into sentence lines once", () => {
  const body = root.querySelector("#report-body").textContent;
  assert.ok(body.includes("FINDINGS\nHeart size is normal.\nThe lungs are clear."));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
