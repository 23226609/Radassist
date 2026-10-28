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
    medicines: "Metformin 500 mg twice daily",
    medOrders: [{
      at: "2026-09-20T02:00:00.000Z",
      drug: "Amoxicillin · 500 mg capsule",
      dose: "1",
      route: "Oral",
      frequency: "TDS",
      prescribedBy: "Dr. Alex Wong",
      status: "active",
    }],
    remarks: "",
    lastDiagnosis: "Mild cardiomegaly",
    urgent: true,
  },
  cases: [
    {
      caseId: "CASE-1",
      status: "finalized",
      urgent: true,
      diagnosis: "Mild cardiomegaly",
      createdAt: "2026-09-01T00:00:00.000Z",
      finalizedAt: "2026-09-02T00:00:00.000Z",
      finalizedByName: "Dr. Priya Nair",
      chartFindingsState: "done",
      chartFindings: [
        { label: "Enlarged heart", location: "Cardiac silhouette", severity: "minor", detail: "The heart is mildly enlarged." },
      ],
    },
    {
      caseId: "CASE-2",
      status: "pending_approve",
      diagnosis: "Draft only",
      createdAt: "2026-09-05T00:00:00.000Z",
      chartFindings: [],
      chartFindingsState: "",
    },
  ],
};

state.user = { role: "technician", userId: "u1", name: "Jamie Lee" };
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
  assert.ok([...listRoot.querySelectorAll("button")].some((b) => b.textContent.trim() === "Add Patient"));
  assert.ok(![...listRoot.querySelectorAll("button")].some((b) => b.textContent.trim() === "Delete"),
    "doctors should not delete patients from the list");
});

const root = document.getElementById("root");
await renderPatientPage({ target: root });

test("patient chart shows history, diagnosis and remarks", () => {
  assert.ok(root.textContent.includes("Clinical history"));
  assert.ok(root.textContent.includes("Cough for two weeks."));
  assert.ok(root.textContent.includes("Mild cardiomegaly"));
  assert.ok(root.textContent.includes("Mei Chen"));
  assert.ok(root.textContent.includes("Urgent"));
  assert.ok(root.querySelector("#patient-remarks"), "remarks box missing");
  assert.ok([...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Save notes"));
  assert.ok([...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "New case"));
});

test("patient chart lists medicines taken before and given in hospital", () => {
  assert.ok(root.textContent.includes("Taken before"));
  assert.ok(root.textContent.includes("Metformin 500 mg twice daily"));
  assert.ok(root.textContent.includes("Given in hospital"));
  assert.ok(root.textContent.includes("Amoxicillin · 500 mg capsule"));
  assert.ok(root.textContent.includes("three times a day"));
  assert.ok(root.textContent.includes("Dr. Alex Wong"));
});

test("technicians do not see report findings on the chart", () => {
  assert.equal(root.querySelector("#patient-findings"), null);
  assert.ok(!root.textContent.includes("Enlarged heart"));
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

state.user = { role: "doctor", userId: "n1", name: "Doctor" };
await renderPatientPage({ target: root });

test("doctors cannot edit patient remarks", () => {
  assert.equal(root.querySelector("textarea#patient-remarks"), null);
  assert.ok(![...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Save notes"));
  assert.ok(![...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "New case"));
  assert.ok(![...root.querySelectorAll("button")].some((b) => b.textContent.trim() === "Delete"));
});

await renderPatientsPage({ target: listRoot });
test("doctors cannot add patients from the list", () => {
  assert.ok(![...listRoot.querySelectorAll("button")].some((b) => b.textContent.trim() === "New patient"));
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const buttonNamed = (scope, text) => [...scope.querySelectorAll("button")].find((b) => b.textContent.trim() === text);

state.user = { role: "radiologist", userId: "r1", name: "Dr. Priya Nair" };
await renderPatientPage({ target: root });

test("findings come from Azure on endorsed reports only", () => {
  const section = root.querySelector("#patient-findings");
  assert.ok(section, "findings section missing");
  assert.ok(section.textContent.includes("Enlarged heart"));
  assert.ok(section.textContent.includes("The heart is mildly enlarged."));
  assert.ok(section.textContent.includes("Endorsed by Dr. Priya Nair"));
  assert.ok(!section.textContent.includes("CASE-2"), "a draft case must not appear under findings");
});

test("no care notes section when the patient has none", () => {
  assert.equal(root.querySelector("#patient-care-notes"), null);
});

{
  const withNotes = structuredClone(chart);
  withNotes.patient.careNotes = [
    { at: "2026-09-01T01:00:00.000Z", author: "RN Lam", role: "RN (Registered Nurse)", category: "General", note: "First note." },
    { at: "2026-09-01T02:00:00.000Z", author: "RN Lam", role: "RN (Registered Nurse)", category: "Handover", note: "Second note." },
    { at: "2026-09-01T03:00:00.000Z", author: "Dr Wong", role: "Doctor", category: "General", note: "Third note." },
    { at: "2026-09-01T04:00:00.000Z", author: "RN Chan", role: "RN (Registered Nurse)", category: "Pain Assessment", note: "Pain 3/10, settled." },
  ];
  api.getPatient = async () => structuredClone(withNotes);
  await renderPatientPage({ target: root });
  const section = () => root.querySelector("#patient-care-notes");
  test("care notes show on the chart, newest first", () => {
    assert.ok(section(), "care notes section missing");
    assert.ok(section().textContent.includes("Care notes (4)"));
    const items = [...section().querySelectorAll("li")];
    assert.equal(items.length, 3, "only the latest notes at first");
    assert.ok(items[0].textContent.includes("Pain 3/10, settled."));
    assert.ok(items[0].textContent.includes("RN Chan · RN (Registered Nurse)"));
    assert.ok(items[0].textContent.includes("Pain Assessment"));
    assert.ok(!section().textContent.includes("First note."));
  });
  buttonNamed(section(), "Show all 4 notes").dispatchEvent(new window.Event("click"));
  test("show all lists every care note", () => {
    assert.equal(section().querySelectorAll("li").length, 4);
    assert.ok(section().textContent.includes("First note."));
  });
  api.getPatient = async () => structuredClone(chart);
}

{
  const draftOnly = structuredClone(chart);
  draftOnly.cases = draftOnly.cases.filter((c) => c.status !== "finalized");
  api.getPatient = async () => structuredClone(draftOnly);
  await renderPatientPage({ target: root });
  test("chart explains findings wait for endorsement", () => {
    assert.ok(root.querySelector("#patient-findings").textContent.includes("after a radiologist endorses a report"));
  });
}

{
  const failed = structuredClone(chart);
  failed.cases[0].chartFindingsState = "failed";
  failed.cases[0].chartFindings = [];
  api.getPatient = async () => structuredClone(failed);
  let retried = null;
  api.rewriteChartFindings = async (id) => { retried = id; return { success: true, chartFindingsState: "running" }; };
  await renderPatientPage({ target: root });
  test("a failed Azure run offers Retry to the radiologist", () => {
    assert.ok(root.textContent.includes("Azure AI could not write findings"));
    assert.ok(buttonNamed(root, "Retry Azure AI"));
  });
  buttonNamed(root, "Retry Azure AI").dispatchEvent(new window.Event("click"));
  await tick();
  test("retry asks the server again and shows Azure is reading", () => {
    assert.equal(retried, "CASE-1");
    assert.ok(root.textContent.includes("Azure AI is reading the endorsed report"));
  });
}

Object.defineProperty(window, "location", {
  configurable: true,
  value: { href: "http://localhost:5173/#/patients/PT-2026-0018", origin: "http://localhost:5173", search: "" },
});
const sepsis = await import("../src/lib/chartWindow.js");

{
  api.getPatient = async () => structuredClone(chart);
  const opened = [];
  window.open = (url, name, features) => { opened.push({ url, name, features }); return { focus() {} }; };
  await renderPatientPage({ target: root });
  buttonNamed(root, "Sepsis monitor").dispatchEvent(new window.Event("click"));
  buttonNamed(root, "Sepsis monitor").dispatchEvent(new window.Event("click"));

  test("Sepsis monitor opens that patient in its own browser window", () => {
    assert.equal(opened.length, 2);
    const url = new URL(opened[0].url);
    assert.equal(url.searchParams.get("view"), "sepsis");
    assert.equal(url.searchParams.get("patientId"), "PT-2026-0018");
    assert.equal(url.hash, "");
    assert.ok(/popup/.test(opened[0].features), "should ask for a popup window, not a tab");
    assert.equal(opened[0].name, opened[1].name, "a second click reuses the same window");
    assert.equal(document.getElementById("sepsis-popup"), null, "no in-page panel when the window opened");
  });

  const message = new window.Event("message");
  Object.defineProperty(message, "data", {
    value: { type: sepsis.PATIENT_UPDATED, patient: { ...chart.patient, heartRate: "131 bpm", observations: [{ hr: "131" }] } },
  });
  Object.defineProperty(message, "origin", { value: "http://localhost:5173" });
  window.dispatchEvent(message);
  test("vitals saved in the separate window update the chart", () => {
    assert.ok(root.textContent.includes("131 bpm"));
  });

  const winRoot = document.createElement("div");
  document.body.appendChild(winRoot);
  window.location.search = "?view=sepsis&patientId=PT-2026-0018&name=Mei%20Chen";
  assert.ok(sepsis.isChartWindow());
  sepsis.renderChartWindow({ target: winRoot });
  await tick();
  await tick();
  test("the separate window shows only that patient's monitor", () => {
    assert.ok(winRoot.textContent.includes("Sepsis Monitor · Mei Chen (PT-2026-0018)"));
    assert.ok(winRoot.textContent.includes("Enter / Update Vitals"));
    assert.ok(!winRoot.textContent.includes("Ward patient worklist"));
  });
  winRoot.remove();
  window.location.search = "";

  {
    const noteChart = structuredClone(chart);
    noteChart.patient.careNotes = [
      { at: "2026-09-01T01:00:00.000Z", author: "RN Lam", role: "RN (Registered Nurse)", category: "General", note: "Ate breakfast." },
    ];
    api.getPatient = async () => structuredClone(noteChart);
    state.page = "patient";
    await renderPatientPage({ target: root });
    opened.length = 0;
    buttonNamed(root, "Care notes").dispatchEvent(new window.Event("click"));
    buttonNamed(root.querySelector("#patient-care-notes"), "Open Nursing / Care Notes").dispatchEvent(new window.Event("click"));
    test("care notes open that patient in their own window", () => {
      assert.equal(opened.length, 2);
      for (const o of opened) {
        const url = new URL(o.url);
        assert.equal(url.searchParams.get("view"), "notes");
        assert.equal(url.searchParams.get("patientId"), "PT-2026-0018");
        assert.ok(/popup/.test(o.features));
      }
      assert.equal(state.page, "patient", "the chart stays open");
    });

    buttonNamed(root, "Sepsis monitor").dispatchEvent(new window.Event("click"));
    test("care notes and the sepsis monitor use separate windows", () => {
      assert.notEqual(opened[2].name, opened[0].name);
    });

    const note = new window.Event("message");
    Object.defineProperty(note, "data", {
      value: {
        type: sepsis.PATIENT_UPDATED,
        patient: { ...noteChart.patient, careNotes: [...noteChart.patient.careNotes, { at: "2026-09-01T05:00:00.000Z", author: "RN Chan", role: "RN (Registered Nurse)", category: "Handover", note: "Family visited." }] },
      },
    });
    Object.defineProperty(note, "origin", { value: "http://localhost:5173" });
    window.dispatchEvent(note);
    test("a note added in the window appears on the chart", () => {
      const section = root.querySelector("#patient-care-notes");
      assert.ok(section.textContent.includes("Care notes (2)"));
      assert.ok(section.querySelector("li").textContent.includes("Family visited."));
    });

    let notesSaved = null;
    api.updatePatient = async (_id, payload) => {
      notesSaved = payload;
      return { patient: { ...noteChart.patient, ...payload }, cases: chart.cases };
    };
    const posted = [];
    window.opener = { postMessage: (msg) => posted.push(msg) };
    const winRoot = document.createElement("div");
    document.body.appendChild(winRoot);
    window.location.search = "?view=notes&patientId=PT-2026-0018&name=Mei%20Chen";
    sepsis.renderChartWindow({ target: winRoot });
    await tick();
    await tick();
    test("the notes window shows only that patient's notes", () => {
      assert.ok(winRoot.textContent.includes("Nursing / Care Notes · Mei Chen (PT-2026-0018)"));
      assert.ok(winRoot.textContent.includes("Ate breakfast."));
      assert.ok(!winRoot.textContent.includes("Select inpatient record"), "no patient picker in the window");
    });
    const text = winRoot.querySelector("textarea");
    text.value = "Mobilised to chair.";
    text.dispatchEvent(new window.Event("input"));
    buttonNamed(winRoot, "+ Add Note to Chart").dispatchEvent(new window.Event("click"));
    await tick();
    await tick();
    test("saving a note in the window tells the chart that opened it", () => {
      assert.equal(notesSaved?.careNotes?.at(-1)?.note, "Mobilised to chair.");
      assert.equal(posted[0]?.type, sepsis.PATIENT_UPDATED);
      assert.equal(posted[0]?.patient?.careNotes?.at(-1)?.note, "Mobilised to chair.");
    });
    winRoot.remove();
    window.location.search = "";
    delete window.opener;
    api.getPatient = async () => structuredClone(chart);
  }

  await renderPatientsPage({ target: listRoot });
  state.page = "patients";
  buttonNamed(listRoot, "View All Patients (1)")?.dispatchEvent(new window.Event("click"));
  opened.length = 0;
  buttonNamed(listRoot, "Sepsis").dispatchEvent(new window.Event("click"));
  buttonNamed(listRoot, "Notes").dispatchEvent(new window.Event("click"));
  test("each Master Index row opens that patient's monitor and notes windows without leaving the list", () => {
    assert.equal(opened.length, 2);
    assert.deepEqual(opened.map((o) => new URL(o.url).searchParams.get("view")), ["sepsis", "notes"]);
    assert.equal(new URL(opened[1].url).searchParams.get("patientId"), "PT-2026-0018");
    assert.equal(state.page, "patients");
  });
}

{
  window.open = () => null;
  api.getPatient = async () => structuredClone(chart);
  let vitalsSaved = null;
  api.updatePatient = async (_id, payload) => {
    vitalsSaved = payload;
    return { patient: { ...chart.patient, ...payload }, cases: chart.cases };
  };
  await renderPatientPage({ target: root });
  buttonNamed(root, "Sepsis monitor").dispatchEvent(new window.Event("click"));
  await tick();
  await tick();
  const popup = document.getElementById("sepsis-popup");

  test("if pop-ups are blocked, the monitor falls back to a panel beside the chart", () => {
    assert.ok(popup, "popup missing");
    assert.equal(popup.getAttribute("aria-modal"), "false");
    assert.ok(popup.textContent.includes("PT-2026-0018"));
    assert.ok(popup.textContent.includes("Enter / Update Vitals"));
    assert.ok(!popup.textContent.includes("Ward patient worklist"), "popup should show one patient only");
    assert.ok(root.querySelector("#patient-findings"), "chart must stay on screen");
  });

  const hr = popup.querySelector("#sepsis-hr");
  hr.value = "128";
  hr.dispatchEvent(new window.Event("input"));
  buttonNamed(popup, "Record Vitals & Run Clinical Evaluation").dispatchEvent(new window.Event("click"));
  await tick();
  await tick();
  test("vitals recorded in the popup update the chart behind it", () => {
    assert.ok(vitalsSaved?.observations?.length, "observations were not saved");
    assert.ok(root.textContent.includes("128 bpm"));
  });

  buttonNamed(popup, "✕").dispatchEvent(new window.Event("click"));
  test("closing the popup removes it", () => {
    assert.equal(document.getElementById("sepsis-popup"), null);
  });

  const { setPage } = await import("../src/state.js");
  state.page = "patient";
  buttonNamed(root, "Sepsis monitor").dispatchEvent(new window.Event("click"));
  await tick();
  setPage("dashboard");
  test("leaving the Patient Master closes the popup", () => {
    assert.equal(document.getElementById("sepsis-popup"), null);
  });
}
sepsis.closeChartPanel();

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
