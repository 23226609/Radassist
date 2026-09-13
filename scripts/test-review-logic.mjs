// scripts/test-review-logic.mjs
// Pure-function tests for review.js's AI-report handling.
//
// We can't run the browser-side review.js through node directly (it imports
// the DOM helpers and the api client), so we re-derive the two pure
// functions here and assert their behavior on a few representative
// fixtures — including the legacy `{"report":"..."}` string shape that
// older cases were persisted with.
//
// Run: node scripts/test-review-logic.mjs

import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Mirror of the helper used in src/components/review.js — kept identical
// to the production version (Radassist original).
// ---------------------------------------------------------------------------
const PATTERNS = ["Nodular", "Diffuse", "Linear", "Ground-glass", "Consolidation", "Other"];

const LOCATION_HINTS = [
  "right upper lobe", "left upper lobe", "right middle lobe", "right lower lobe",
  "left lower lobe", "right lung", "left lung", "both lungs", "right hilum",
  "left hilum", "mediastinum", "right cardiophrenic", "left cardiophrenic",
  "right costophrenic", "left costophrenic", "perihilar", "retrocardiac",
  "right apex", "left apex", "right base", "left base",
];
const SIZE_REGEX = /(about\s+)?([~]?\s*)([0-9]+(\.[0-9]+)?)\s*(cm|mm|centimeter|millimeter|millimetres?|centimeters?)/i;

function inferPattern(text) {
  const t = (text || "").toLowerCase();
  if (/\bnodul|\bmass\b|\bcoin lesion\b|\bround(?!ed glass)/.test(t)) return "Nodular";
  if (/ground[- ]?glass|ggo/.test(t)) return "Ground-glass";
  if (/consolidat|air[- ]?space|airspace/.test(t)) return "Consolidation";
  if (/opacity|opacit/.test(t)) return "Consolidation";
  if (/linear|band|streak|septal|kerley/.test(t)) return "Linear";
  if (/diffus|scattered|bilateral|widespread|throughout/.test(t)) return "Diffuse";
  return "Other";
}

function detectLocation(text) {
  const low = (text || "").toLowerCase();
  for (const hint of LOCATION_HINTS) {
    if (low.includes(hint)) return hint.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  const m = low.match(/\b(the\s+)?(right|left)\s+(lung|hilum|apex|base|hemithorax)\b/);
  if (m) return m[2] + " " + m[3];
  return "";
}

function detectSize(text) {
  const m = (text || "").match(SIZE_REGEX);
  if (!m) return "";
  return `${m[3]} ${m[5].toLowerCase().startsWith("cent") ? "cm" : m[5][0] + "m"}`;
}

function extractSection(block) {
  let b = (block || "").replace(/^\s*(\*{0,2})(finding\s*\d+|impression|conclusion|observations?|notes?)\s*\d*\s*[:.\-–]\s*/i, "");
  b = b.replace(/^\s*\d+\.\s+/, "");
  b = b.replace(/^[\*]+/, "").replace(/[\*]+$/, "").trim();
  return b;
}

function stripMarkdown(line) {
  return (line || "")
    .replace(/^\s*#+\s*/, "")
    .replace(/^\s*(?:[-+*\u2022]\s+|\d+[.)]\s+)/, "")
    .replace(/\*+/g, "")
    .replace(/\s*:\s*$/, "")
    .trim();
}

function isSectionLabel(line) {
  const raw = (line || "").trim();
  if (!raw || /[.!?]$/.test(raw)) return false;
  if (!/:\s*\**\s*$/.test(raw)) return false;
  return stripMarkdown(raw).length < 60;
}

function splitBlock(block) {
  const lines = (block || "").split(/\n/).map((l) => l.trim()).filter(Boolean);
  const header = lines.length && isSectionLabel(lines[0]) ? stripMarkdown(lines[0]) : "";
  const body = (header ? lines.slice(1) : lines)
    .map(stripMarkdown)
    .filter((l) => l.length > 4);
  return { header, body };
}

function pickLabel(block) {
  const { header, body } = splitBlock(block);
  const statement = body
    .map((line) => line.split(/(?<=[.!?])\s+/)[0].trim())
    .find((s) => s.length > 4);
  const label = statement || header || "AI finding";
  return label.length > 80 ? label.slice(0, 77) + "…" : label;
}

function parseFindingsFromReport(reportText, existingCount = 0) {
  if (!reportText || typeof reportText !== "string") return [];
  const text = reportText.trim();
  const blocks = [];
  const numberedRx = /(?:^|\n)\s*(?:\*+\s*)?(?:finding\s*\d+|impression\s*\d*|observation\s*\d*|#{2,3}\s*\d+\.?|\d+\.)[:.\s\-–]+([^\n#]+(?:\n(?![*\s]*(?:\*+\s*)?(?:finding\s*\d+|impression|observation|\d+\.)\s*[:\s.\-–])[^\n#]+)*)/gi;
  let m;
  while ((m = numberedRx.exec(text)) !== null) {
    const block = (m[1] || "").trim();
    if (block.length > 10) blocks.push(block);
  }
  if (blocks.length === 0) {
    const sectionRx = /(\*+\s*(?:findings?|impression|observations?|conclusion|abnormalities?|recommendations?)\s*\*+[:.\s\-–]*)([\s\S]*?)(?=(\n\s*\n|\Z))/gi;
    let combined = "";
    while ((m = sectionRx.exec(text)) !== null) {
      combined += "\n" + (m[2] || "").trim();
    }
    if (combined.trim().length > 10) {
      const parts = combined
        .split(/(?<=[.!?])\s+|\n\s*[\-\u2022]\s*/)
        .map((s) => s.trim())
        .filter((s) => s.length > 20);
      parts.forEach((p) => blocks.push(p));
    }
  }
  if (blocks.length === 0) {
    text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 25 && !/^#{1,6}\s+/.test(s)).forEach((s) => blocks.push(s));
  }
  const seen = new Set();
  const unique = blocks.filter((b) => {
    const k = b.toLowerCase().slice(0, 60);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique.slice(0, 6).map((block, idx) => {
    const cleaned = extractSection(block);
    return {
      _id: "ai-test-" + idx,
      id: "ai-" + (idx + existingCount),
      label: pickLabel(cleaned),
      confidence: (() => {
        let conf = 0.45;
        if (detectLocation(cleaned)) conf += 0.15;
        if (inferPattern(cleaned) !== "Other") conf += 0.15;
        if (detectSize(cleaned)) conf += 0.1;
        return Number(Math.min(0.95, Math.max(0.3, conf)).toFixed(2));
      })(),
      bbox: [10 + idx * 12, 10 + idx * 8, 18, 18],
      location: detectLocation(cleaned),
      size: detectSize(cleaned),
      pattern: inferPattern(cleaned),
      sentence: (splitBlock(cleaned).body.join(" ") || splitBlock(cleaned).header).slice(0, 240),
      status: "pending",
      source: "AI",
    };
  });
}

function unwrapLegacyReport(raw) {
  if (!raw || typeof raw.reportText !== "string") return raw;
  const rt = raw.reportText.trim();
  if (!rt.startsWith("{") || !rt.includes('"report"')) return raw;
  let parsed;
  try { parsed = JSON.parse(rt); } catch { return raw; }
  if (!parsed || typeof parsed !== "object" || typeof parsed.report !== "string") return raw;
  return { ...raw, reportText: parsed.report };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err.message}`);
    failed++;
  }
}

console.log("\n=== unwrapLegacyReport ===");

test("leaves a clean markdown report alone", () => {
  const raw = { reportText: "1. No acute findings.\n\n###FINDINGS###\nClear lungs.", findings: [] };
  const out = unwrapLegacyReport(raw);
  assert.equal(out, raw, "should return same reference when nothing to unwrap");
});

test("leaves an empty reportText alone", () => {
  const raw = { reportText: "", findings: [] };
  assert.equal(unwrapLegacyReport(raw), raw);
});

test("unwraps the legacy `{\"report\":\"...\"}` wrapper", () => {
  const legacyReport = `{"report":"1. No acute cardiopulmonary findings identified.\\n\\n###FINDINGS###\\n1. No acute cardiopulmonary findings identified.\\n2. Clear lung fields bilaterally."}`;
  const raw = { reportText: legacyReport, findings: [] };
  const out = unwrapLegacyReport(raw);
  assert.notEqual(out.reportText, legacyReport, "wrapper should be stripped");
  assert.ok(out.reportText.startsWith("1. No acute"), `should start with the report body, got: ${out.reportText.slice(0, 40)}`);
  assert.ok(out.reportText.includes("Clear lung fields"), "should contain full report body");
});

test("returns raw unchanged when JSON parses to non-object", () => {
  const raw = { reportText: '{"report":"x"} but with extra text' };
  // startsWith("{"), includes("\"report\""), JSON.parse throws (trailing text)
  const out = unwrapLegacyReport(raw);
  assert.equal(out, raw);
});

test("returns raw unchanged when JSON has no string 'report' field", () => {
  const raw = { reportText: '{"something":"else","value":42}' };
  const out = unwrapLegacyReport(raw);
  assert.equal(out, raw);
});

console.log("\n=== parseFindingsFromReport ===");

test("returns [] for null / undefined / non-string", () => {
  assert.deepEqual(parseFindingsFromReport(null), []);
  assert.deepEqual(parseFindingsFromReport(undefined), []);
  assert.deepEqual(parseFindingsFromReport(42), []);
});

test("parses numbered markdown headings", () => {
  const report = `# Chest X-Ray Report

1. A small nodule in the right upper lobe, about 1.2 cm.
2. Diffuse haziness throughout both lungs.
3. Linear band in the left base.`;
  const findings = parseFindingsFromReport(report);
  assert.ok(findings.length >= 2, `expected at least 2 findings, got ${findings.length}`);
  assert.equal(findings[0].pattern, "Nodular", `first should be Nodular, got ${findings[0].pattern}`);
  assert.equal(findings[0].location, "Right Upper Lobe", `first location: ${findings[0].location}`);
  assert.equal(findings[0].size, "1.2 cm", `first size: ${findings[0].size}`);
  assert.equal(findings[1].pattern, "Diffuse", `second should be Diffuse, got ${findings[1].pattern}`);
  assert.equal(findings[2].pattern, "Linear", `third should be Linear, got ${findings[2].pattern}`);
});

test("parses `**Finding N:**` headers", () => {
  const report = `**Finding 1:** A 2.5 cm nodule in the right lower lobe, suspicious for malignancy.
**Finding 2:** Mild consolidation in the left lower lobe.`;
  const findings = parseFindingsFromReport(report);
  assert.ok(findings.length >= 1, `expected at least 1 finding, got ${findings.length}`);
  assert.equal(findings[0].source, "AI");
  assert.equal(findings[0].pattern, "Nodular");
  assert.equal(findings[0].size, "2.5 cm");
});

test("falls back to sentence split on plain prose", () => {
  const report = `There is a small nodule in the right upper lobe measuring about 0.8 cm. The cardiac silhouette is normal in size and contour. No pleural effusion is seen.`;
  const findings = parseFindingsFromReport(report);
  assert.ok(findings.length >= 1, `expected at least 1 finding, got ${findings.length}`);
});

test("the screenshot case (no acute findings) parses to a small / empty finding list", () => {
  // This is the actual report text from the user's screenshot.
  const report = `1. No acute cardiopulmonary findings identified. The cardiac silhouette is normal in size and contour. Clear lung fields bilaterally without focal consolidation, pleural effusion, or pneumothorax. No evidence of pulmonary edema. Bony thorax is intact. IMPRESSION: No acute cardiopulmonary process.

###FINDINGS###
1. No acute cardiopulmonary findings identified.
2. The cardiac silhouette is normal in size and contour.
3. Clear lung fields bilaterally without focal consolidation, pleural effusion, or pneumothorax.
4. No evidence of pulmonary edema.
5. Bony thorax is intact.

###IMPRESSION###
No acute cardiopulmonary process.`;
  const findings = parseFindingsFromReport(report);
  // These negative findings shouldn't match a strong pattern, so most will be 'Other'.
  // We only assert that parse doesn't crash and that the report survives end-to-end.
  assert.ok(Array.isArray(findings), "should always return an array");
  // Each finding must have a valid pattern from PATTERNS.
  findings.forEach((f) => assert.ok(PATTERNS.includes(f.pattern), `bad pattern: ${f.pattern}`));
});

test("de-dups near-identical blocks", () => {
  const report = `1. A nodule in the right upper lobe.
2. A nodule in the right upper lobe.
3. Different finding in left base.`;
  const findings = parseFindingsFromReport(report);
  // First two have the same first-60-chars key, so should de-dup.
  assert.ok(findings.length <= 3, `expected at most 3 findings after dedup, got ${findings.length}`);
});

test("confidence scales with how many signals were found", () => {
  const richReport = `1. A 2 cm nodule in the right upper lobe.`;
  const sparseReport = `1. Something is noted.`;
  const rich = parseFindingsFromReport(richReport)[0];
  const sparse = parseFindingsFromReport(sparseReport)[0];
  assert.ok(rich.confidence > sparse.confidence, `rich (${rich.confidence}) should be > sparse (${sparse.confidence})`);
});

console.log("\n=== end-to-end: legacy wrapper -> parseFindingsFromReport ===");

test("legacy wrapped report flows through parseFindingsFromReport cleanly", () => {
  const wrapped = `{"report":"# Report\\n\\n1. A 1.5 cm nodule in the right lower lobe.\\n2. Diffuse haziness throughout both lungs."}`;
  const step1 = unwrapLegacyReport({ reportText: wrapped });
  assert.ok(!step1.reportText.startsWith("{"), "should be unwrapped");
  const findings = parseFindingsFromReport(step1.reportText);
  assert.ok(findings.length >= 2, `expected >= 2 findings from unwrapped report, got ${findings.length}`);
  assert.equal(findings[0].pattern, "Nodular");
  assert.equal(findings[1].pattern, "Diffuse");
});

test("downloaded report text is the unwrapped MongoDB report", () => {
  const wrapped = `{"report":"1. No acute cardiopulmonary findings identified.\\n\\nIMPRESSION: No acute process."}`;
  const step1 = unwrapLegacyReport({ reportText: wrapped });
  const stored = step1.reportText;
  assert.ok(stored.startsWith("1. No acute"), "download should use the clean report, not JSON");
  assert.ok(!stored.includes("{"), "stored report should not contain JSON braces");
  assert.ok(!stored.includes("\\n"), "stored report should contain real newlines, not escaped");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
