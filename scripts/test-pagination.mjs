// scripts/test-pagination.mjs
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

for (const Ctor of [window.HTMLSelectElement, window.HTMLInputElement, window.HTMLOptionElement, window.HTMLButtonElement]) {
  const proto = Ctor?.prototype;
  if (proto && !Object.getOwnPropertyDescriptor(proto, "value")?.set) {
    Object.defineProperty(proto, "value", {
      configurable: true,
      get() { return this.getAttribute("value") ?? ""; },
      set(v) { this.setAttribute("value", String(v)); },
    });
  }
}

const { paginate, PAGE_SIZE } = await import("../src/lib/pagination.js");
const { state } = await import("../src/state.js");
const { api } = await import("../src/api.js");
const { renderDashboardPage } = await import("../src/components/dashboard.js");

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

console.log("\n=== table pagination ===");

test("slices a page and clamps past the last page", () => {
  const items = Array.from({ length: 23 }, (_, i) => i + 1);
  const first = paginate(items, 1, 10);
  assert.deepEqual(first.items, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(first.from, 1);
  assert.equal(first.to, 10);
  assert.equal(first.pages, 3);
  const last = paginate(items, 99, 10);
  assert.deepEqual(last.items, [21, 22, 23]);
  assert.equal(last.page, 3);
  assert.equal(last.from, 21);
  assert.equal(last.to, 23);
});

test("empty lists stay on page 1", () => {
  const empty = paginate([], 4);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.page, 1);
  assert.equal(empty.total, 0);
  assert.equal(empty.from, 0);
});

const cases = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => ({
  caseId: `CASE-${String(i + 1).padStart(2, "0")}`,
  patientId: `PT-${String(i + 1).padStart(2, "0")}`,
  status: "pending",
  createdAt: "2026-09-13T00:00:00.000Z",
  diagnosis: `Finding ${i + 1}`,
}));

state.user = { role: "doctor", userId: "u1", name: "Dr Test" };
api.listCases = async () => ({ cases: structuredClone(cases) });
api.stats = async () => ({
  stats: { totalCases: cases.length, finalizedCases: 0, pendingCases: cases.length },
});
api.summariseDiagnosis = async () => ({ case: null });

const root = document.getElementById("root");
await renderDashboardPage({ target: root });

test("dashboard table shows one page of rows", () => {
  const rows = root.querySelectorAll("tbody tr");
  assert.equal(rows.length, PAGE_SIZE);
  assert.ok(root.textContent.includes("PT-01"));
  assert.ok(root.textContent.includes("Finding 1"));
  assert.ok(!root.textContent.includes("PT-11"));
  assert.ok(root.textContent.includes(`1–${PAGE_SIZE} of ${cases.length}`));
  assert.ok(root.textContent.includes("Page 1 of 2"));
});

const next = [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "Next");
assert.ok(next, "Next button should exist");
next.dispatchEvent(new window.Event("click"));

test("next page shows the remaining rows", () => {
  const rows = root.querySelectorAll("tbody tr");
  assert.equal(rows.length, 1);
  assert.ok(root.textContent.includes("PT-11"));
  assert.ok(root.textContent.includes("Finding 11"));
  assert.ok(!root.textContent.includes("PT-01"));
  assert.ok(root.textContent.includes(`11–11 of ${cases.length}`));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
