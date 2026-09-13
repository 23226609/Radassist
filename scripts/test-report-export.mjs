// scripts/test-report-export.mjs
import assert from "node:assert";
import { buildReportSections, buildReportPdfBytes, applyRemarksToReport, splitReportAndRemarks } from "../src/lib/reportExport.js";

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

console.log("\n=== report export ===");

const sections = buildReportSections({
  caseId: "CASE-1",
  patientId: "PT-2026-002",
  age: "52",
  sex: "Male",
  history: "Cough",
  reportText: "The lungs are clear.\nHeart size is normal.",
  findings: [
    { label: "Clear lungs", sentence: "The lungs are clear.", location: "Both lungs", confidence: 0.7 },
  ],
});

test("includes patient header and report body", () => {
  assert.equal(sections.patientId, "PT-2026-002");
  assert.ok(sections.body.includes("The lungs are clear."));
  assert.equal(sections.findings[0].label, "Clear lungs");
  assert.equal(sections.findings[0].confidence, 70);
});

test("builds a safe download filename from the patient id", () => {
  assert.equal(sections.fileBase, "RadAssist-PT-2026-002");
});

test("sanitises odd characters in the filename", () => {
  const s = buildReportSections({ patientId: "PT 2026 / 002?" });
  assert.equal(s.fileBase, "RadAssist-PT_2026_002");
});

test("appends remarks to the report once, and replaces them on save", () => {
  const first = applyRemarksToReport("The lungs are clear.", "Check old films.");
  assert.ok(first.reportText.includes("Radiologist remarks"));
  assert.ok(first.reportText.endsWith("Check old films."));
  const second = applyRemarksToReport(first.reportText, "No old films available.");
  assert.equal(second.reportText.match(/Radiologist remarks/g).length, 1);
  assert.ok(second.reportText.includes("No old films available."));
  assert.ok(!second.reportText.includes("Check old films."));
  assert.equal(splitReportAndRemarks(second.reportText).body, "The lungs are clear.");
});

test("clearing remarks removes them from the stored report", () => {
  const withNote = applyRemarksToReport("Heart size normal.", "Follow up.");
  const cleared = applyRemarksToReport(withNote.reportText, "   ");
  assert.equal(cleared.reportText, "Heart size normal.");
  assert.equal(cleared.remarks, "");
});

test("writes a real PDF header and the report body", () => {
  const bytes = buildReportPdfBytes({
    caseId: "CASE-1",
    patientId: "PT-1",
    reportText: "The lungs are clear.",
  });
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.startsWith("%PDF-1.4"), "missing PDF header");
  assert.ok(text.includes("The lungs are clear."));
  assert.ok(text.trim().endsWith("%%EOF"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
