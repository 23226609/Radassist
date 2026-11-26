// scripts/test-report-layout.mjs
// The report layout, its header, and the two downloads (Word and PDF).
import assert from "node:assert";
import JSZip from "jszip";
import {
  buildReportSections, buildReportBlocks, buildReportPdfBytes, buildReportDocxBlob,
  prepareFilms, setFilmRenderer, reportHeaderFields,
} from "../src/lib/reportExport.js";
import { buildLine, spacingOf, ctrSentence } from "../src/lib/measure.js";

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

console.log("\n=== report layout and downloads ===");

const base = {
  caseId: "CASE-1",
  patientId: "PT-1",
  age: "60",
  sex: "Male",
  history: "Cough",
  status: "finalized",
  finalizedByName: "Dr. Priya Nair",
  finalizedAt: "2026-11-10T03:16:00.000Z",
  requestedByName: "Dr. Lee",
  view: "PA",
  examinedAt: "2026-11-09T08:30:00.000Z",
  imagerPixelSpacingMm: [0.2, 0.2],
  pixelSpacingSource: "ImagerPixelSpacing",
};
const spacing = spacingOf(base);
const lesion = buildLine({ x1: 62, y1: 70, x2: 72, y2: 70 }, { width: 1000, height: 1000, spacing, kind: "lesion", tagKey: "t2" });
const heart = buildLine({ x1: 30, y1: 55, x2: 70, y2: 55 }, { width: 1000, height: 1000, spacing, kind: "ctr-heart", tagKey: "t3" });
const thorax = buildLine({ x1: 20, y1: 40, x2: 80, y2: 40 }, { width: 1000, height: 1000, spacing, kind: "ctr-thorax", tagKey: "t3" });
const ctr = ctrSentence(heart, thorax, "PA");

const sample = {
  ...base,
  reportText: "Findings:\nThe lungs are clear.\n\nThinking:\nSECRET MODEL REASONING\n\nImpression:\nSmall right effusion.",
  findingTags: [
    { key: "t1", text: "The lungs are clear.", abnormal: false, kind: "" },
    { key: "t2", text: "Small right pleural effusion.", abnormal: true, kind: "" },
    { key: "t3", text: ctr.text, abnormal: true, kind: "ctr" },
    { key: "t4", text: "No pneumothorax.", abnormal: false, kind: "" },
  ],
  comment: "Small right pleural effusion with cardiomegaly.",
  findings: [
    { label: "Effusion", bbox: [60, 62, 20, 15], tagKey: "t2", status: "accepted" },
    { label: "Heart", bbox: [27, 40, 46, 25], tagKey: "t3", status: "accepted" },
  ],
  measurements: [lesion, heart, thorax],
};

await test("the report reads XRAY CHEST / FINDINGS / sentences / COMMENT / endorser", () => {
  const body = buildReportSections(sample).body;
  assert.equal(body, [
    "XRAY CHEST (PA)", "", "FINDINGS", "The lungs are clear.", "Small right pleural effusion.", ctr.text, "No pneumothorax.",
    "", "COMMENT", "– Small right pleural effusion with cardiomegaly.", "", "Dr. Priya Nair",
  ].join("\n"));
  assert.ok(!body.includes("SECRET MODEL REASONING"), "Thinking stays hidden");
});

await test("the CTR sentence is worded with the two film diameters", () => {
  assert.equal(ctr.text, "Cardiothoracic ratio is increased, 8.0 : 12.0.");
});

await test("the header carries the examination fields this demo can fill", () => {
  const h = Object.fromEntries(reportHeaderFields(sample).map((f) => [f.label, f.value]));
  assert.equal(h.Modality, "XRAY");
  assert.equal(h["Examination name"], "Chest (PA)");
  assert.equal(h["Report title"], "XRAY CHEST (PA)");
  assert.ok(h["Examination date/time"].includes("2026"));
  assert.ok(h["Report date"].includes("2026"));
  assert.equal(h["Reported by"], "Dr. Priya Nair");
  assert.equal(h["Referring doctor"], "Dr. Lee");
  const draft = Object.fromEntries(reportHeaderFields({ ...sample, status: "pending_approve", examinedAt: null }).map((f) => [f.label, f.value]));
  assert.equal(draft["Reported by"], "Not endorsed yet");
  assert.equal(draft["Examination date/time"], "Not recorded");
  const shifted = Object.fromEntries(reportHeaderFields({ ...sample, examinedAt: "2148-05-03T21:20:00.000Z" }).map((f) => [f.label, f.value]));
  assert.equal(shifted["Examination date/time"], "Shifted dataset date");
  assert.equal(shifted["Report date"].includes("2148"), false);
});

await test("the plain download has one clean film and no finding sections", () => {
  const blocks = buildReportBlocks(sample, "plain");
  const films = blocks.filter((b) => b.type === "film");
  assert.equal(films.length, 1);
  assert.equal(films[0].overlay, null);
  assert.ok(!blocks.some((b) => b.text === "Finding films"));
});

await test("the films download gives each abnormal finding a box film and a separate measurement film", () => {
  const blocks = buildReportBlocks(sample, "films");
  const films = blocks.filter((b) => b.type === "film");
  assert.equal(films.length, 4, "t1 and t4 are normal and get no film");
  assert.deepEqual(films.map((f) => f.tagKey), ["t2", "t2", "t3", "t3"]);
  assert.deepEqual(films[0].overlay.boxes, [[60, 62, 20, 15]]);
  assert.deepEqual(films[0].overlay.lines, []);
  assert.deepEqual(films[1].overlay.boxes, []);
  assert.deepEqual(films[1].overlay.lines.map((l) => l.kind), ["lesion"]);
  assert.equal(films[2].overlay.boxes.length, 1);
  assert.deepEqual(films[2].overlay.lines, []);
  assert.deepEqual(films[3].overlay.boxes, []);
  assert.deepEqual(films[3].overlay.lines.map((l) => l.kind).sort(), ["ctr-heart", "ctr-thorax"]);
  assert.ok(films[1].heading.startsWith("Finding 1 measurement"));
  const text = blocks.map((b) => b.text || "").join("\n");
  assert.ok(text.includes("Film-size length: 2.00 cm."));
  assert.ok(text.includes("Imager Pixel Spacing (0018,1164)"));
  assert.ok(text.includes("Body-size estimate unavailable"));
  assert.ok(text.includes("0.50"));
  assert.ok(text.includes("Body-size estimate unavailable") && text.includes("Greatest transverse cardiac diameter: 8.0 cm film size."));
});

await test("the report text is the same in both downloads", () => {
  const strip = (variant) => buildReportBlocks(sample, variant)
    .filter((b) => b.type !== "film")
    .map((b) => b.text || "")
    .join("\n")
    .split("Finding films")[0]
    .trimEnd();
  assert.equal(strip("plain"), strip("films"));
});

await test("a normal tag with a stray box still gets no film", () => {
  const withStray = { ...sample, findings: [...sample.findings, { label: "x", bbox: [1, 1, 5, 5], tagKey: "t1", status: "accepted" }] };
  const films = buildReportBlocks(withStray, "films").filter((b) => b.type === "film");
  assert.equal(films.length, 4);
});

await test("films are drawn from the one stored image with only that finding's overlay", async () => {
  const seen = [];
  setFilmRenderer(async (bytes, overlay) => {
    seen.push(overlay);
    return { bytes: Uint8Array.from([0xff, 0xd8, seen.length, 0xff, 0xd9]), type: "jpg", width: 100, height: 100, components: 3 };
  });
  const blocks = buildReportBlocks(sample, "films");
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 1, 0, 72, 0, 72, 0, 0, 0xff, 0xd9]);
  const images = await prepareFilms(sample, blocks, { pdf: true, loadBytes: async () => jpeg });
  assert.equal(images.length, 4);
  assert.equal(seen.length, 4);
  assert.equal(seen[0].boxes.length, 1);
  assert.equal(seen[0].lines.length, 0);
  assert.equal(seen[1].boxes.length, 0);
  assert.equal(seen[1].lines.length, 1);
  assert.equal(seen[2].lines.length, 0);
  assert.equal(seen[3].lines.length, 2);
  setFilmRenderer(null);
});

await test("finding films fail loudly when the film cannot be drawn", async () => {
  setFilmRenderer(async () => { throw new Error("no canvas"); });
  const blocks = buildReportBlocks(sample, "films");
  await assert.rejects(() => prepareFilms(sample, blocks, { loadBytes: async () => Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }), /no canvas/);
  setFilmRenderer(null);
});

function fakeJpeg(n) {
  return { bytes: Uint8Array.from([0xff, 0xd8, n, 0xff, 0xd9]), type: "jpg", width: 100, height: 80, components: 3 };
}

await test("the PDFs hold one image (plain) and one per abnormal finding (films)", () => {
  const plain = new TextDecoder("latin1").decode(buildReportPdfBytes(sample, fakeJpeg(1)));
  assert.equal((plain.match(/ Do Q/g) || []).length, 1);
  const films = new TextDecoder("latin1").decode(buildReportPdfBytes(sample, null, { variant: "films", images: [fakeJpeg(2), fakeJpeg(3), fakeJpeg(4), fakeJpeg(5)] }));
  assert.equal((films.match(/ Do Q/g) || []).length, 4);
  assert.ok(films.includes("Finding 1: Small right pleural effusion."));
  assert.ok(films.includes("Film-size length: 2.00 cm."));
  for (const pdf of [plain, films]) {
    assert.ok(pdf.includes("XRAY CHEST \\(PA\\)"), "title, with PDF-escaped brackets");
    assert.ok(pdf.includes("Dr. Priya Nair"));
    assert.ok(!pdf.includes("SECRET MODEL REASONING"));
    assert.ok(pdf.trim().endsWith("%%EOF"));
  }
});

await test("a dash in the report is written as a WinAnsi byte, not as noise", () => {
  const pdf = new TextDecoder("latin1").decode(buildReportPdfBytes(sample));
  assert.ok(pdf.includes("\\226 Small right pleural effusion"), "en dash escape");
});

await test("a long films report flows onto more pages without losing a film", () => {
  const many = { ...sample };
  const tags = [];
  const findings = [];
  for (let i = 0; i < 6; i++) {
    tags.push({ key: `a${i}`, text: `Opacity number ${i}.`, abnormal: true, kind: "" });
    findings.push({ label: `o${i}`, bbox: [10, 10, 10, 10], tagKey: `a${i}`, status: "accepted" });
  }
  many.findingTags = tags;
  many.findings = findings;
  many.measurements = [];
  const images = tags.map((_, i) => fakeJpeg(i + 1));
  const pdf = new TextDecoder("latin1").decode(buildReportPdfBytes(many, null, { variant: "films", images }));
  assert.equal((pdf.match(/ Do Q/g) || []).length, 6);
  assert.ok(Number(pdf.match(/\/Count (\d+)/)[1]) >= 3);
  assert.ok(pdf.includes("No measurement was drawn for this finding."));
});

await test("Word: one picture (plain) and one per abnormal finding (films)", async () => {
  const count = async (blob) => {
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file("word/document.xml").async("string");
    return { drawings: (xml.match(/<w:drawing>/g) || []).length, xml };
  };
  const plain = await count(await buildReportDocxBlob(sample, { variant: "plain", images: [fakeJpeg(1)] }));
  assert.equal(plain.drawings, 1);
  const films = await count(await buildReportDocxBlob(sample, { variant: "films", images: [fakeJpeg(2), fakeJpeg(3), fakeJpeg(4), fakeJpeg(5)] }));
  assert.equal(films.drawings, 4);
  for (const doc of [plain, films]) {
    assert.ok(doc.xml.includes("FINDINGS"));
    assert.ok(doc.xml.includes("Dr. Priya Nair"));
    assert.ok(!doc.xml.includes("SECRET MODEL REASONING"));
  }
});

await test("an older case with only report text is split into the same layout", () => {
  const old = {
    caseId: "OLD", patientId: "PT-9", status: "finalized", finalizedByName: "Dr. A",
    reportText: "Findings:\nThe lungs are clear. Heart size is normal.\n\nImpression:\nNo acute disease.",
  };
  const body = buildReportSections(old).body;
  assert.ok(body.includes("FINDINGS\nThe lungs are clear.\nHeart size is normal.\n"));
  assert.ok(body.includes("COMMENT\n– No acute disease."));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
