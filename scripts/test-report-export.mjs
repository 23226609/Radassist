// scripts/test-report-export.mjs
import assert from "node:assert";
import { buildReportSections, buildReportPdfBytes, applyRemarksToReport, splitReportAndRemarks, composeReportText, MANUAL_FINDINGS_HEADING, parseImageMeta, fitImageBox } from "../src/lib/reportExport.js";

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

test("writes hand-added findings into the report before remarks", () => {
  const findings = [
    { label: "Heart size normal", source: "Azure" },
    { label: "Possible old fracture", location: "Left ribs", size: "2 cm", pattern: "Linear", source: "manual" },
  ];
  const out = composeReportText("The lungs are clear.", {
    remarks: "Check old films.",
    findings,
  });
  assert.ok(out.reportText.includes(MANUAL_FINDINGS_HEADING));
  assert.ok(out.reportText.includes("Possible old fracture"));
  assert.ok(out.reportText.includes("Location: Left ribs"));
  assert.ok(out.reportText.includes("Size: 2 cm"));
  assert.ok(out.reportText.includes("Pattern: Linear"));
  assert.ok(!out.reportText.includes("Heart size normal"), "AI findings stay in the structured list, not the clinician-added block");
  assert.ok(out.reportText.endsWith("Check old films."));
  assert.ok(out.reportText.indexOf(MANUAL_FINDINGS_HEADING) < out.reportText.indexOf("Radiologist remarks"));
});

test("replaces the clinician-added block instead of stacking copies", () => {
  const first = composeReportText("The lungs are clear.", {
    findings: [{ label: "Old note", source: "manual" }],
  });
  const second = composeReportText(first.reportText, {
    findings: [{ label: "New note", location: "Right apex", source: "manual" }],
  });
  assert.equal(second.reportText.match(/Clinician-added findings/g).length, 1);
  assert.ok(second.reportText.includes("New note"));
  assert.ok(second.reportText.includes("Location: Right apex"));
  assert.ok(!second.reportText.includes("Old note"));
});

test("clears the clinician-added block when every manual finding is removed", () => {
  const withManual = composeReportText("Heart size normal.", {
    findings: [{ label: "Extra opacity", source: "manual" }],
  });
  const cleared = composeReportText(withManual.reportText, { findings: [] });
  assert.equal(cleared.reportText, "Heart size normal.");
});

test("export sections include size and pattern for each finding", () => {
  const s = buildReportSections({
    findings: [{ label: "Nodule", sentence: "A small nodule.", location: "RUL", size: "8 mm", pattern: "Nodular", confidence: 0.8 }],
  });
  assert.equal(s.findings[0].size, "8 mm");
  assert.equal(s.findings[0].pattern, "Nodular");
});

test("PDF export is the CURV report and does not dump Azure finding cards", () => {
  const bytes = buildReportPdfBytes({
    caseId: "CASE-1",
    patientId: "PT-1",
    reportText: "The lungs are clear.\nHeart size is normal.",
    findings: [
      { label: "Azure-only card title", sentence: "Azure rewrite of the film.", location: "both lungs", source: "azure" },
    ],
  });
  const text = new TextDecoder("latin1").decode(bytes);
  assert.ok(text.includes("The lungs are clear."));
  assert.ok(text.includes("Heart size is normal."));
  assert.ok(!text.includes("Azure-only card title"), "Azure carousel cards must not appear in the download");
  assert.ok(!text.includes("Azure rewrite of the film."));
});

function tinyJpeg() {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
    0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x03, 0x02, 0x02, 0x02, 0x02, 0x02, 0x03,
    0x02, 0x02, 0x02, 0x03, 0x03, 0x03, 0x03, 0x04, 0x06, 0x04, 0x04, 0x04, 0x04, 0x04, 0x08, 0x06,
    0x06, 0x05, 0x06, 0x09, 0x08, 0x0a, 0x0a, 0x09, 0x08, 0x09, 0x09, 0x0a, 0x0c, 0x0f, 0x0c, 0x0a,
    0x0b, 0x0e, 0x0b, 0x09, 0x09, 0x0d, 0x11, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x11, 0x10, 0x0a, 0x0c,
    0x12, 0x13, 0x12, 0x10, 0x13, 0x0f, 0x10, 0x10, 0x10, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x02,
    0x00, 0x03, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x09, 0xff, 0xda, 0x00, 0x08,
    0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x54, 0x05, 0x1f, 0xff, 0xd9,
  ]);
}

test("reads JPEG width and height from the SOF marker", () => {
  const meta = parseImageMeta(tinyJpeg());
  assert.equal(meta.type, "jpg");
  assert.equal(meta.width, 3);
  assert.equal(meta.height, 2);
});

test("scales a large film down to the report box", () => {
  const box = fitImageBox(2000, 1000, 500, 400);
  assert.equal(box.width, 500);
  assert.equal(box.height, 250);
});

test("PDF export embeds the uploaded X-ray", () => {
  const jpeg = tinyJpeg();
  const bytes = buildReportPdfBytes(
    { caseId: "CASE-1", patientId: "PT-1", reportText: "The lungs are clear." },
    { type: "jpg", bytes: jpeg, width: 3, height: 2, components: 1 }
  );
  const text = new TextDecoder("latin1").decode(bytes);
  assert.ok(text.startsWith("%PDF-1.4"), "missing PDF header");
  assert.ok(text.includes("/Subtype /Image"), "image XObject missing");
  assert.ok(text.includes("/DCTDecode"), "JPEG stream missing");
  assert.ok(text.includes("/Im1 Do"), "image is not drawn on the page");
  assert.ok(text.includes("The lungs are clear."));
  const plain = new TextDecoder("latin1").decode(buildReportPdfBytes({
    caseId: "CASE-1",
    patientId: "PT-1",
    reportText: "The lungs are clear.",
  }));
  assert.ok(!plain.includes("/DCTDecode"), "text-only PDF should not embed an image");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
