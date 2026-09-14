// scripts/test-patient-page.mjs
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
const { renderPatientsPage, renderPatientPage } = await import("../src/components/patients.js");

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

console.log("\n=== patient page ===");

const chart = {
  patient: {
    patientId: "PT-2026-0018",
    name: "Mei Chen",
    age: "61",
    sex: "Male",
    history: "Cough for two weeks.",
    remarks: "",
    lastDiagnosis: "Mild cardiomegaly",
    urgent: true,
  },
  cases: [
    {
      caseId: "CASE-1",
      status: "completed",
      urgent: true,
      diagnosis: "Mild cardiomegaly",
      createdAt: "2026-09-01T00:00:00.000Z",
      findings: [
        { label: "Enlarged heart", location: "Cardiac silhouette", pattern: "Other", sentence: "The heart is mildly enlarged." },
      ],
    },
  ],
};

state.user = { role: "doctor", userId: "u1", name: "Dr Test" };
state.selectedPatientId = "PT-2026-0018";
api.listPatients = async () => ({
  patients: [{
    patientId: "PT-2026-0018",
    name: "Mei Chen",
    age: "61",
    sex: "Male",
    lastDiagnosis: "Mild cardiomegaly",
    caseCount: 1,
    lastCaseAt: "2026-09-01T00:00:00.000Z",
    urgent: true,
  }],
});
api.getPatient = async () => structuredClone(chart);
let saved = null;
api.updatePatient = async (_id, payload) => {
  saved = payload;
  return {
    patient: { ...chart.patient, ...payload },
    cases: chart.cases,
  };
};

const listRoot = document.createElement("div");
document.body.appendChild(listRoot);
await renderPatientsPage({ target: listRoot });

test("patients list shows the chart", () => {
  assert.ok(listRoot.textContent.includes("PT-2026-0018"));
  assert.ok(listRoot.textContent.includes("Mei Chen"));
  assert.ok(listRoot.textContent.includes("Mild cardiomegaly"));
  assert.ok(listRoot.textContent.includes("Urgent"), "urgent tag missing on a patient with an urgent case");
  assert.ok([...listRoot.querySelectorAll("button")].some((b) => b.textContent.trim() === "New patient"));
  assert.ok(![...listRoot.querySelectorAll("button")].some((b) => b.textContent.trim() === "Delete"),
    "doctors should not delete patients from the list");
});

const root = document.getElementById("root");
await renderPatientPage({ target: root });

test("patient chart shows history, diagnosis, findings and remarks", () => {
  assert.ok(root.textContent.includes("Clinical history"));
  assert.ok(root.textContent.includes("Cough for two weeks."));
  assert.ok(root.textContent.includes("Mild cardiomegaly"));
  assert.ok(root.textContent.includes("Mei Chen"));
  assert.ok(root.textContent.includes("Urgent"));
  assert.ok(root.textContent.includes("Enlarged heart"));
  assert.ok(root.querySelector("#patient-remarks"), "remarks box missing");
  assert.ok([...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Save notes"));
  assert.ok([...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "New case"));
});

const box = root.querySelector("#patient-remarks");
box.value = "Known hypertensive. Compare with old films.";
box.dispatchEvent(new window.Event("input"));
[...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save notes")
  .dispatchEvent(new window.Event("click"));
await new Promise((r) => setTimeout(r, 0));

test("saving patient remarks does not send a report", () => {
  assert.ok(saved, "updatePatient was not called");
  assert.equal(saved.remarks, "Known hypertensive. Compare with old films.");
  assert.equal(saved.reportText, undefined);
});

state.user = { role: "nurse", userId: "n1", name: "Nurse" };
await renderPatientPage({ target: root });

test("nurses cannot edit patient remarks", () => {
  assert.equal(root.querySelector("textarea#patient-remarks"), null);
  assert.ok(![...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Save notes"));
  assert.ok(![...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "New case"));
  assert.ok(![...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Delete"));
});

await renderPatientsPage({ target: listRoot });
test("nurses cannot add patients from the list", () => {
  assert.ok(![...listRoot.querySelectorAll("button")].some((b) => b.textContent.trim() === "New patient"));
});

{
  window.confirm = () => true;
  let deleted = null;
  api.deletePatients = async (ids) => { deleted = ids; return { success: true, deleted: ids.length }; };
  api.listPatients = async () => ({
    patients: [
      {
        patientId: "PT-2026-0018",
        age: "61",
        sex: "Male",
        lastDiagnosis: "Mild cardiomegaly",
        caseCount: 1,
        lastCaseAt: "2026-09-01T00:00:00.000Z",
      },
      {
        patientId: "PT-2026-0019",
        age: "44",
        sex: "Female",
        lastDiagnosis: "Clear lungs",
        caseCount: 1,
        lastCaseAt: "2026-09-02T00:00:00.000Z",
      },
    ],
  });
  state.user = { role: "admin", userId: "a1", name: "System Admin" };
  await renderPatientsPage({ target: listRoot });
  await renderPatientPage({ target: root });

  test("admins tick rows and use one Delete button on the patients list", () => {
    assert.ok([...listRoot.querySelectorAll("button")].some((b) => b.textContent.trim() === "Delete"));
    assert.ok([...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Delete"));
    const boxes = [...listRoot.querySelectorAll('input[type="checkbox"][aria-label="Select row"]')];
    assert.equal(boxes.length, 2, "each patient row should have a checkbox");
  });

  for (let i = 0; i < 2; i++) {
    const boxes = [...listRoot.querySelectorAll('input[type="checkbox"][aria-label="Select row"]')];
    boxes[i].checked = true;
    boxes[i].dispatchEvent(new window.Event("change"));
  }
  const del = [...listRoot.querySelectorAll("button")].find((b) => /Delete/.test(b.textContent));
  assert.ok(del && del.textContent.includes("2"), `expected Delete (2), got ${del?.textContent}`);
  del.dispatchEvent(new window.Event("click"));
  await new Promise((r) => setTimeout(r, 0));

  test("admin bulk delete on the patients list sends every selected id", () => {
    assert.deepEqual(deleted, ["PT-2026-0018", "PT-2026-0019"]);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
