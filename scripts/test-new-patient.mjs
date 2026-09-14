// scripts/test-new-patient.mjs
//
// Renders the new-patient page and checks that doctors can submit a chart.
//
//   node scripts/test-new-patient.mjs

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
globalThis.localStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};
globalThis.URL = URL;
try {
  window.location.href = "http://localhost:5173/";
} catch {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("http://localhost:5173/"),
  });
}

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
const { renderNewPatientPage } = await import("../src/components/newPatient.js");

api.listPatients = async () => ({ patients: [] });

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

function byPlaceholder(root, text) {
  return [...root.querySelectorAll("input, textarea")].find((n) => n.getAttribute("placeholder") === text);
}

console.log("\n=== new patient ===");

state.user = { role: "doctor", userId: "u1", name: "Dr Test" };
const root = document.getElementById("root");
await renderNewPatientPage({ target: root });

test("asks for first, middle and last name", () => {
  assert.ok(root.textContent.includes("New patient"));
  assert.ok(byPlaceholder(root, "First name"), "first name field missing");
  assert.ok(byPlaceholder(root, "Middle name (optional)"), "middle name field missing");
  assert.ok(byPlaceholder(root, "Last name"), "last name field missing");
  assert.ok(byPlaceholder(root, "Age"), "age field missing");
  assert.ok([...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Female"), "sex pills missing");
  assert.ok(byPlaceholder(root, "Patient ID (optional — assigned automatically)"), "optional ID field missing");
  assert.ok([...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Add patient"));
});

{
  let created = null;
  api.createPatient = async (payload) => {
    created = payload;
    return {
      patient: {
        patientId: payload.patientId || "PT-2026-0100",
        firstName: payload.firstName,
        middleName: payload.middleName,
        lastName: payload.lastName,
        name: [payload.firstName, payload.middleName, payload.lastName].filter(Boolean).join(" "),
        age: payload.age,
        sex: payload.sex,
        history: payload.history,
      },
    };
  };

  byPlaceholder(root, "First name").value = "Mei";
  byPlaceholder(root, "First name").dispatchEvent(new window.Event("input"));
  byPlaceholder(root, "Middle name (optional)").value = "Li";
  byPlaceholder(root, "Middle name (optional)").dispatchEvent(new window.Event("input"));
  byPlaceholder(root, "Last name").value = "Chen";
  byPlaceholder(root, "Last name").dispatchEvent(new window.Event("input"));
  byPlaceholder(root, "Age").value = "67";
  byPlaceholder(root, "Age").dispatchEvent(new window.Event("input"));
  const sexBtn = [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "Female");
  assert.ok(sexBtn, "sex pills missing");
  sexBtn.dispatchEvent(new window.Event("click"));
  byPlaceholder(root, "Clinical history (optional)").value = "Persistent cough";
  byPlaceholder(root, "Clinical history (optional)").dispatchEvent(new window.Event("input"));

  [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "Add patient")
    .dispatchEvent(new window.Event("click"));
  await new Promise((r) => setTimeout(r, 0));

  test("saving creates the patient and opens the chart", () => {
    assert.ok(created, "createPatient was not called");
    assert.equal(created.firstName, "Mei");
    assert.equal(created.middleName, "Li");
    assert.equal(created.lastName, "Chen");
    assert.equal(created.name, undefined);
    assert.equal(created.age, "67");
    assert.equal(created.sex, "Female");
    assert.equal(created.history, "Persistent cough");
    assert.equal(state.selectedPatientId, "PT-2026-0100");
  });
}

{
  state.user = { role: "nurse", userId: "n1", name: "Nurse" };
  await renderNewPatientPage({ target: root });
  test("nurses cannot add a patient", () => {
    assert.ok(root.textContent.includes("Nurses cannot add patients."));
    assert.ok(![...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Add patient"));
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
