// scripts/test-azure-bbox.mjs
// Unit-tests clampBbox without calling Azure.

import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { clampBbox } = require("../backend/utils/azureFindings.js");

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

console.log("\n=== Azure bbox clamping ===");

test("keeps a normal percentage box", () => {
  assert.deepEqual(clampBbox([30, 46, 38, 32]), [30, 46, 38, 32]);
});

test("scales 0-1 fractions up to percentages", () => {
  assert.deepEqual(clampBbox([0.3, 0.4, 0.2, 0.15]), [30, 40, 20, 15]);
});

test("converts [x1,y1,x2,y2] when treating them as width would overflow", () => {
  assert.deepEqual(clampBbox([20, 30, 90, 95]), [20, 30, 70, 65]);
});

test("does not mis-read a wide xywh box as corners", () => {
  assert.deepEqual(clampBbox([6, 12, 88, 60]), [6, 12, 88, 60]);
});

test("enforces a minimum 8% size so tiny boxes stay clickable", () => {
  const [x, y, w, h] = clampBbox([40, 40, 2, 2]);
  assert.ok(w >= 8 && h >= 8, `got ${w}x${h}`);
  assert.equal(x, 40);
});

test("rejects unusable input", () => {
  assert.equal(clampBbox(null), null);
  assert.equal(clampBbox([1, 2, 3]), null);
  assert.equal(clampBbox(["a", "b", "c", "d"]), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
