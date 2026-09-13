// scripts/test-confidence.mjs
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { scoreLanguage, scoreConfidence } = require("../backend/utils/confidence.js");

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

console.log("\n=== calibrated confidence ===");

test("hedged wording scores lower than a definite negative", () => {
  const hedged = scoreLanguage("Possible subtle opacity; cannot exclude infection");
  const definite = scoreLanguage("There is no evidence of focal consolidation. Lungs are clear.");
  assert.ok(definite > hedged + 0.15, `definite ${definite} vs hedged ${hedged}`);
});

test("does not treat the model's 1.0 as the final score", () => {
  const scored = scoreConfidence({
    label: "Clear lung fields",
    detail: "The lungs are clear bilaterally without consolidation.",
    severity: "normal",
    imageSupport: 1,
  });
  assert.equal(scored.confidenceSource, "calibrated");
  assert.ok(scored.confidence < 0.9, `expected well below 90%, got ${scored.confidence}`);
  assert.ok(scored.imageSupport <= 0.82, "normal image support should be capped");
});

test("a measured significant finding with clear image support ranks highest", () => {
  const weak = scoreConfidence({
    label: "Possible opacity",
    detail: "A faint opacity cannot be excluded in the right lower zone.",
    severity: "minor",
    imageSupport: 0.4,
  });
  const strong = scoreConfidence({
    label: "Right lower-zone consolidation",
    detail: "There is a 3.1 cm opacity in the right lower zone.",
    severity: "significant",
    imageSupport: 0.8,
    size: "3.1 cm",
    location: "Right lower lobe",
  });
  assert.ok(strong.confidence > weak.confidence + 0.15, `${strong.confidence} vs ${weak.confidence}`);
  assert.ok(strong.confidence >= 0.7 && strong.confidence <= 0.94);
});

test("without an image, wording alone still spreads the scores", () => {
  const a = scoreConfidence({ detail: "Possible interstitial change, recommend further evaluation." });
  const b = scoreConfidence({ detail: "No evidence of pneumothorax. The lungs are clear." });
  assert.ok(b.confidence > a.confidence, `${b.confidence} should beat ${a.confidence}`);
  assert.equal(a.imageSupport, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
