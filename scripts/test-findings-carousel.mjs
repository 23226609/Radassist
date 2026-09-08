// scripts/test-findings-carousel.mjs
//
// Renders the real review page into a linkedom DOM and drives the findings
// carousel, so this exercises src/components/review.js itself rather than a
// copy of its logic.
//
//   npm install --no-save linkedom
//   node scripts/test-findings-carousel.mjs

import assert from "node:assert";
import { parseHTML } from "linkedom";

const { window, document } = parseHTML(
  "<!doctype html><html><body><div id='root'></div></body></html>"
);

// review.js and its imports expect a browser environment.
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

// linkedom exposes select.value as getter-only; real browsers let you assign
// it, which is what dom.js does when building the pattern dropdown.
const selectProto = window.HTMLSelectElement?.prototype;
if (selectProto && !Object.getOwnPropertyDescriptor(selectProto, "value")?.set) {
  Object.defineProperty(selectProto, "value", {
    configurable: true,
    get() {
      return this.getAttribute("value") ?? "";
    },
    set(v) {
      this.setAttribute("value", String(v));
    },
  });
}

const { state } = await import("../src/state.js");
const { api } = await import("../src/api.js");
const { renderReviewPage } = await import("../src/components/review.js");

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

function makeFinding(label, confidence, status = "pending") {
  return {
    _id: `ai-${label}`,
    label,
    confidence,
    bbox: [10, 10, 20, 20],
    location: "",
    size: "",
    pattern: "Other",
    sentence: label,
    status,
    source: "AI",
  };
}

const testCase = {
  caseId: "CASE-CAROUSEL-1",
  patientId: "PT-0001",
  age: "29",
  sex: "Female",
  status: "completed",
  reportText: "Chest X-Ray Report\n\n1. Lungs:\n   - The lungs are clear.",
  imageId: null,
  findings: [
    makeFinding("Heart size normal", 0.9, "accepted"),
    makeFinding("Lungs clear", 0.6),
    makeFinding("Low confidence item", 0.2, "rejected"),
  ],
};

state.user = { role: "doctor", userId: "u1", name: "Dr Test" };
state.cases = [testCase];
state.selectedCaseId = testCase.caseId;
api.getCase = async () => ({ case: structuredClone(testCase) });
api.fetchImage = async () => {
  throw new Error("no image in test");
};

const root = document.getElementById("root");
await renderReviewPage({ target: root });

const text = () => root.textContent.replace(/\s+/g, " ");
const cards = () => root.querySelectorAll("article");
const byTitle = (t) => root.querySelector(`[title="${t}"]`);
const dots = () =>
  [...root.querySelectorAll("button")].filter((b) => /^\d+\. /.test(b.getAttribute("title") || ""));

console.log("\n=== findings carousel ===");

test("renders exactly one finding card at a time", () => {
  assert.equal(cards().length, 1, `expected 1 card, saw ${cards().length}`);
});

test("shows a position counter for the three findings", () => {
  assert.ok(text().includes("1 of 3"), `counter missing in: ${text().slice(0, 200)}`);
});

test("shows the first finding first", () => {
  assert.ok(text().includes("Heart size normal"));
});

test("renders one navigation dot per finding", () => {
  assert.equal(dots().length, 3, `expected 3 dots, saw ${dots().length}`);
});

test("next button advances to the second finding", () => {
  byTitle("Next finding").dispatchEvent(new window.Event("click"));
  assert.ok(text().includes("2 of 3"), "counter did not advance");
  assert.ok(text().includes("Lungs clear"), "second finding not shown");
  assert.equal(cards().length, 1, "more than one card after advancing");
});

test("previous button goes back", () => {
  byTitle("Previous finding").dispatchEvent(new window.Event("click"));
  assert.ok(text().includes("1 of 3"), "counter did not go back");
  assert.ok(text().includes("Heart size normal"));
});

test("previous from the first finding wraps to the last", () => {
  byTitle("Previous finding").dispatchEvent(new window.Event("click"));
  assert.ok(text().includes("3 of 3"), `expected wrap to 3 of 3, got: ${text().slice(0, 120)}`);
  assert.ok(text().includes("Low confidence item"));
});

test("next from the last finding wraps to the first", () => {
  byTitle("Next finding").dispatchEvent(new window.Event("click"));
  assert.ok(text().includes("1 of 3"), "did not wrap back to the first finding");
});

test("clicking a dot jumps straight to that finding", () => {
  dots()[2].dispatchEvent(new window.Event("click"));
  assert.ok(text().includes("3 of 3"));
  assert.ok(text().includes("Low confidence item"));
});

test("offers the Azure summarise action alongside the carousel", () => {
  const btn = [...root.querySelectorAll("button")].find((b) =>
    /Summarise with Azure AI/.test(b.textContent)
  );
  assert.ok(btn, "Azure summarise button is missing");
  assert.ok(!btn.disabled, "button should be enabled when the case has report text");
});

test("raising the threshold drops filtered findings and clamps the index", () => {
  // Currently parked on finding 3 (confidence 0.2). A 50% threshold removes
  // it, so the carousel must fall back to a valid index instead of blanking.
  const slider = root.querySelector('input[type="range"]');
  slider.value = "50";
  slider.dispatchEvent(new window.Event("input"));
  assert.ok(text().includes("of 2"), `expected 2 remaining findings, got: ${text().slice(0, 160)}`);
  assert.equal(cards().length, 1, "expected a single card after filtering");
  assert.ok(!text().includes("Low confidence item"), "filtered finding still visible");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
