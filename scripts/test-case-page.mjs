// scripts/test-case-page.mjs
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

for (const Ctor of [window.HTMLSelectElement, window.HTMLInputElement, window.HTMLOptionElement, window.HTMLTextAreaElement]) {
  const proto = Ctor?.prototype;
  if (proto && !Object.getOwnPropertyDescriptor(proto, "value")?.set) {
    Object.defineProperty(proto, "value", {
      configurable: true,
      get() { return this.getAttribute("value") ?? this.textContent ?? ""; },
      set(v) { this.setAttribute("value", String(v)); },
    });
  }
}

const { state } = await import("../src/state.js");
const { api } = await import("../src/api.js");
const { renderCasesPage, renderCasePage } = await import("../src/components/cases.js");

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

console.log("\n=== case page ===");

const stored = {
  caseId: "CASE-1",
  patientId: "PT-2026-0018",
  age: "61",
  sex: "Male",
  status: "completed",
  history: "Cough for two weeks.",
  diagnosis: "Mild cardiomegaly",
  remarks: "",
  reportText: "The heart is mildly enlarged.",
  findings: [
    { label: "Enlarged heart", location: "Cardiac silhouette", pattern: "Other", sentence: "The heart is mildly enlarged." },
  ],
};

state.user = { role: "doctor", userId: "u1", name: "Dr Test" };
state.selectedCaseId = "CASE-1";
api.listCases = async () => ({ cases: [structuredClone(stored)] });
api.getCase = async () => ({ case: structuredClone(stored) });
let saved = null;
api.updateCase = async (_id, payload) => {
  saved = payload;
  return { case: { ...structuredClone(stored), ...payload } };
};

const listRoot = document.createElement("div");
document.body.appendChild(listRoot);
await renderCasesPage({ target: listRoot });

test("cases list shows the study", () => {
  assert.ok(listRoot.textContent.includes("CASE-1"));
  assert.ok(listRoot.textContent.includes("PT-2026-0018"));
  assert.ok(listRoot.textContent.includes("Mild cardiomegaly"));
});

const root = document.getElementById("root");
await renderCasePage({ target: root });

test("case record shows history, diagnosis, findings and remarks", () => {
  assert.ok(root.textContent.includes("Clinical history"));
  assert.ok(root.textContent.includes("Cough for two weeks."));
  assert.ok(root.textContent.includes("Mild cardiomegaly"));
  assert.ok(root.textContent.includes("Enlarged heart"));
  assert.ok(root.querySelector("#case-remarks"), "remarks box missing");
  assert.ok([...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Review X-ray"));
  assert.ok([...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Save remarks"));
});

const box = root.querySelector("#case-remarks");
box.value = "Compare with prior film.";
box.dispatchEvent(new window.Event("input"));
[...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save remarks")
  .dispatchEvent(new window.Event("click"));
await new Promise((r) => setTimeout(r, 0));

test("saving case remarks writes them into the report when not finalized", () => {
  assert.ok(saved, "updateCase was not called");
  assert.ok(saved.reportText.includes("Compare with prior film."));
  assert.equal(saved.remarks, "Compare with prior film.");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
