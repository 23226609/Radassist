// Inpatient modules in the COMP4126 CMS layout.
// Patient identity and X-ray cases stay on the existing API.
// Ward, vitals, labs, medicines, and care notes are stored on the patient chart.

import { el, mount } from "../dom.js";
import { api } from "../api.js";
import { state, setPage, toast } from "../state.js";
import { patientDisplayName } from "../lib/tags.js";
import { canEditPatient } from "../lib/roles.js";

const BEDS = ["4A-01", "4A-02", "4A-03", "4A-04", "4B-01", "4B-02", "4B-03", "4B-04"];
const INPUT = "w-full rounded border border-gray-400 bg-white px-2 py-1.5 text-sm outline-none focus:border-ha-blue focus:ring-2 focus:ring-blue-200 disabled:bg-gray-100";
const BTN = "rounded bg-ha-blue px-3 py-2 text-xs font-bold text-white hover:bg-[#074f85] disabled:opacity-40";

function cmsWindow(title, ...body) {
  return el("div", { class: "flex h-full min-h-[70vh] flex-col p-2" },
    el("div", { class: "relative flex h-full flex-col border-2 border-white border-b-gray-500 border-r-gray-500 bg-[#d4d0c8] p-2 shadow-sm" },
      el("div", { class: "flex items-center gap-2 bg-ha-blue px-2 py-1 text-sm font-bold text-white" }, title),
      ...body
    )
  );
}

function activePatientBar(patient) {
  if (!patient) return null;
  const where = [patient.ward, patient.bed].filter(Boolean).join(" ");
  return el("div", { class: "my-2 flex justify-between border border-gray-400 bg-[#ffffcc] p-2 text-sm font-bold" },
    el("span", {}, `Active Patient: ${patientDisplayName(patient) || patient.patientId} (${patient.patientId})`),
    el("span", {}, where ? `Location: ${where}` : "Location: not admitted")
  );
}

const BEVEL = "border border-gray-400 border-b-gray-600 border-r-gray-600 bg-[#ece9d8] px-3 py-1 text-xs font-bold hover:bg-gray-200 disabled:opacity-50";

function frame(title, ...body) {
  return cmsWindow(title, el("div", { class: "mt-2 border-2 border-gray-500 bg-white p-3" }, ...body));
}

function wardOf(bed) {
  return String(bed || "").startsWith("4B") ? "4B" : String(bed || "").startsWith("4A") ? "4A" : "";
}

function num(value) {
  const n = parseFloat(String(value ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function monitorAlert(obs = {}, heartRate = "") {
  const hr = num(obs.hr ?? heartRate);
  const spo2 = num(obs.spo2);
  const lactate = num(obs.lactate);
  const reasons = [];
  if (hr != null && hr >= 110) reasons.push(`Heart rate ${hr}`);
  if (spo2 != null && spo2 < 94) reasons.push(`SpO2 ${spo2}%`);
  if (lactate != null && lactate >= 2) reasons.push(`Lactate ${lactate}`);
  return reasons;
}

function latestObs(patient) {
  const rows = patient?.observations || [];
  return rows[rows.length - 1] || null;
}

async function loadPatients() {
  const data = await api.listPatients();
  return data.patients || [];
}

async function loadPatient(id) {
  if (!id) return null;
  const data = await api.getPatient(id);
  return data.patient || null;
}

function patientPicker(patients, selectedId, onChange) {
  return el("select", {
    class: INPUT,
    value: selectedId || "",
    onChange: (e) => onChange(e.target.value),
  },
    el("option", { value: "" }, "Select patient"),
    ...patients.map((p) => el("option", { value: p.patientId }, `${patientDisplayName(p) || p.patientId} · ${p.patientId}`))
  );
}

function openChart(id) {
  state.selectedPatientId = id;
  setPage("patient");
}

export async function renderBedsPage({ target }) {
  let patients = [];
  let error = "";
  let busy = false;
  let patientId = state.selectedPatientId || "";
  let bed = "";
  const canEdit = canEditPatient(state.user);

  async function refresh() {
    patients = await loadPatients();
    if (!patientId && patients[0]) patientId = patients[0].patientId;
    paint();
  }

  async function assign(status) {
    if (!canEdit || !patientId || !bed) {
      toast("Choose a patient and a bed.");
      return;
    }
    const taken = patients.find((p) => p.bed === bed && p.patientId !== patientId && p.admissionStatus !== "discharged");
    if (taken && status !== "discharged") {
      toast(`${bed} is already assigned to ${patientDisplayName(taken) || taken.patientId}.`);
      return;
    }
    busy = true;
    paint();
    try {
      await api.updatePatient(patientId, {
        bed: status === "discharged" ? "" : bed,
        ward: status === "discharged" ? "" : wardOf(bed),
        admissionStatus: status,
      });
      state.selectedPatientId = patientId;
      toast(status === "discharged" ? "Patient discharged from the bed." : `Bed ${bed} updated.`);
      await refresh();
    } catch (err) {
      toast(err.message || "Could not update the bed.");
    } finally {
      busy = false;
      paint();
    }
  }

  function paint() {
    const byBed = new Map(patients.filter((p) => p.bed).map((p) => [p.bed, p]));
    mount(target, el("div", { class: "space-y-2" },
      error ? el("p", { class: "bg-red-100 p-3 text-red-900" }, error) : null,
      frame("Bed Management & Inpatient Admission",
        el("p", { class: "text-sm text-gray-600" }, "Admit, reserve, transfer, or discharge. The X-ray worklist is unchanged."),
        canEdit ? el("div", { class: "mt-3 grid gap-2 md:grid-cols-[1fr_10rem_auto_auto_auto]" },
          patientPicker(patients, patientId, (id) => { patientId = id; state.selectedPatientId = id; }),
          el("select", { class: INPUT, value: bed, onChange: (e) => { bed = e.target.value; } },
            el("option", { value: "" }, "Select bed"),
            ...BEDS.map((id) => el("option", { value: id }, id))
          ),
          el("button", { class: BTN, disabled: busy, onClick: () => assign("admitted") }, "Confirm admission"),
          el("button", { class: "rounded border border-gray-400 bg-white px-3 py-2 text-xs font-bold", disabled: busy, onClick: () => assign("reserved") }, "Reserve"),
          el("button", { class: "rounded border border-red-300 bg-white px-3 py-2 text-xs font-bold text-red-800", disabled: busy, onClick: () => assign("discharged") }, "Discharge")
        ) : el("p", { class: "mt-2 text-sm text-gray-500" }, "This account can view the bed board only."),
        el("div", { class: "mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4" },
          ...BEDS.map((id) => {
            const person = byBed.get(id);
            const occupied = person && person.admissionStatus !== "discharged";
            return el("button", {
              type: "button",
              class: `border p-3 text-left ${occupied ? "border-ha-blue bg-blue-50" : "border-gray-300 bg-gray-50"}`,
              onClick: () => {
                bed = id;
                if (person) {
                  patientId = person.patientId;
                  state.selectedPatientId = person.patientId;
                }
                paint();
              },
            },
              el("div", { class: "text-xs font-bold text-gray-500" }, wardOf(id), " · ", id),
              el("div", { class: "mt-1 font-semibold text-slate-900" }, occupied ? (patientDisplayName(person) || person.patientId) : "Available"),
              el("div", { class: "text-xs capitalize text-gray-600" }, occupied ? person.admissionStatus : "Empty")
            );
          })
        )
      )
    ));
  }

  try { await refresh(); }
  catch (err) { error = err.message; paint(); }
}

export async function renderMonitorPage({ target }) {
  let patients = [];
  let selected = null;
  let error = "";
  let busy = false;
  const form = { hr: "", rr: "", sbp: "", spo2: "", temp: "", wbc: "", lactate: "", crp: "" };
  const canEdit = canEditPatient(state.user);

  async function choose(id) {
    state.selectedPatientId = id;
    selected = await loadPatient(id);
    const obs = latestObs(selected);
    form.hr = obs?.hr || String(selected?.heartRate || "").replace(/[^\d.]/g, "");
    form.rr = obs?.rr || "";
    form.sbp = obs?.sbp || "";
    form.spo2 = obs?.spo2 || "";
    form.temp = obs?.temp || "";
    form.wbc = obs?.wbc || "";
    form.lactate = obs?.lactate || "";
    form.crp = obs?.crp || "";
    paint();
  }

  async function saveVitals() {
    if (!canEdit || !selected) return;
    busy = true;
    paint();
    try {
      const row = { ...form, at: new Date().toISOString(), by: state.user?.name || "" };
      const observations = [...(selected.observations || []), row];
      const data = await api.updatePatient(selected.patientId, {
        observations,
        heartRate: form.hr ? `${form.hr} bpm` : selected.heartRate,
      });
      selected = data.patient;
      toast("Vitals recorded.");
    } catch (err) {
      toast(err.message || "Could not record vitals.");
    } finally {
      busy = false;
      paint();
    }
  }

  function paint() {
    const admitted = patients.filter((p) => p.admissionStatus === "admitted" || p.bed);
    const list = (admitted.length ? admitted : patients);
    const obsRows = (selected?.observations || []).slice().reverse();
    mount(target, cmsWindow("Inpatient Observations & Sepsis Screening (Teaching)",
      error ? el("p", { class: "mt-2 bg-red-100 p-2 text-sm text-red-900" }, error) : null,
      activePatientBar(selected),
      el("section", { class: "my-3 rounded border border-slate-300 bg-white", "aria-label": "Ward patient worklist" },
        el("div", { class: "flex flex-wrap justify-between gap-2 rounded-t bg-slate-800 px-3 py-2 text-white" },
          el("h2", { class: "font-bold" }, "Ward patient worklist"),
          el("span", { class: "text-xs" }, `${list.length} patients`)
        ),
        el("div", { class: "max-h-80 overflow-auto" },
          el("table", { class: "w-full min-w-[680px] text-left text-xs" },
            el("thead", { class: "sticky top-0 bg-slate-100" },
              el("tr", {}, ["Ward / bed", "Patient identity", "Latest observations", "Review", "Action"].map((h) =>
                el("th", { class: "p-2" }, h)
              ))
            ),
            el("tbody", {},
              ...list.map((p) => {
                const obs = latestObs(p) || {};
                const reasons = monitorAlert(obs, p.heartRate);
                const urgent = reasons.length > 0;
                const selectedRow = selected?.patientId === p.patientId;
                return el("tr", {
                  class: `border-t ${urgent ? "bg-amber-50" : ""} ${selectedRow ? "outline outline-2 -outline-offset-2 outline-blue-600" : ""}`,
                  "aria-selected": selectedRow ? "true" : "false",
                },
                  el("td", { class: "p-2 font-semibold" }, p.ward || "—", el("br"), p.bed || "No bed"),
                  el("td", { class: "p-2" },
                    el("strong", {}, `${p.patientId} · ${patientDisplayName(p) || ""}`),
                    el("br"),
                    [p.age && `${p.age}y`, p.sex].filter(Boolean).join(" · ")
                  ),
                  el("td", { class: "p-2" }, p.heartRate || (obs.hr ? `HR ${obs.hr}` : "No observations")),
                  el("td", { class: "p-2" }, el("strong", {}, urgent ? "Abnormal observations — review" : "No configured trigger")),
                  el("td", { class: "p-2" },
                    el("button", {
                      class: "rounded border border-blue-600 bg-white px-2 py-2 font-semibold text-blue-800",
                      onClick: () => choose(p.patientId),
                    }, "Open assessment")
                  )
                );
              })
            )
          )
        )
      ),
      selected && el("div", { class: "flex flex-1 flex-col gap-4 overflow-hidden lg:flex-row" },
        el("div", { class: "flex w-full flex-col overflow-auto border border-gray-400 bg-[#e4e4e4] p-3 lg:w-1/3" },
          el("h3", { class: "mb-3 flex items-center justify-between border-b border-gray-400 pb-1 font-bold text-ha-blue" },
            el("span", {}, "Enter / Update Vitals"),
            el("span", { class: "rounded bg-blue-100 px-1.5 py-0.5 text-xs font-normal text-blue-800" }, "New assessment")
          ),
          el("div", { class: "flex flex-col gap-3" },
            ...[
              ["hr", "Heart Rate (bpm)"],
              ["rr", "Respiratory Rate (breaths/min)"],
              ["sbp", "Systolic BP (mmHg)"],
              ["spo2", "SpO2 (%)"],
              ["temp", "Temperature (°C)"],
              ["wbc", "WBC"],
              ["lactate", "Lactate (mmol/L)"],
              ["crp", "CRP Level (mg/L)"],
            ].map(([key, label]) => el("div", { class: "flex items-center justify-between gap-2" },
              el("label", { class: "text-xs font-bold" }, label),
              el("input", {
                class: "w-24 border border-gray-500 bg-white px-2 py-1 text-right",
                disabled: !canEdit,
                value: form[key],
                onInput: (e) => { form[key] = e.target.value; },
              })
            )),
            canEdit && el("button", { class: `${BEVEL} mt-2 px-4 py-2`, disabled: busy, onClick: saveVitals }, "Record Vitals & Run Clinical Evaluation")
          )
        ),
        el("div", { class: "flex flex-1 flex-col overflow-auto border border-gray-400 bg-white" },
          el("div", { class: "flex justify-between bg-[#008080] px-2 py-1 text-xs font-bold text-white" },
            el("span", {}, "Vitals Flowsheet & Alert Audit Log"),
            el("span", {}, `Total Evaluations: ${obsRows.length}`)
          ),
          obsRows.length
            ? el("table", { class: "w-full border-collapse text-center text-xs" },
                el("thead", {},
                  el("tr", { class: "border-b border-gray-400 bg-gray-200" },
                    ["Time", "HR", "RR", "BP", "SpO2", "Temp", "WBC", "Lactate", "CRP", "Alert"].map((h) =>
                      el("th", { class: "border-r border-gray-400 p-1.5" }, h)
                    )
                  )
                ),
                el("tbody", {},
                  ...obsRows.map((row) => {
                    const reasons = monitorAlert(row, row.hr);
                    return el("tr", { class: `border-b border-gray-300 ${reasons.length ? "bg-amber-50 text-amber-900" : ""}` },
                      el("td", { class: "border-r border-gray-400 p-1.5" }, row.at ? new Date(row.at).toLocaleString() : "—"),
                      el("td", { class: "border-r border-gray-400 p-1.5" }, row.hr || "—"),
                      el("td", { class: "border-r border-gray-400 p-1.5" }, row.rr || "—"),
                      el("td", { class: "border-r border-gray-400 p-1.5" }, row.sbp || "—"),
                      el("td", { class: "border-r border-gray-400 p-1.5" }, row.spo2 ? `${row.spo2}%` : "—"),
                      el("td", { class: "border-r p-1.5" }, row.temp || "—"),
                      el("td", { class: "border-r p-1.5" }, row.wbc || "—"),
                      el("td", { class: "border-r p-1.5" }, row.lactate || "—"),
                      el("td", { class: "border-r p-1.5" }, row.crp || "—"),
                      el("td", { class: "p-1.5" }, reasons.length ? "Review" : "—")
                    );
                  })
                )
              )
            : el("p", { class: "p-4 text-sm text-gray-500" }, "No saved observations for this patient.")
        )
      )
    ));
  }

  try {
    patients = await loadPatients();
    if (state.selectedPatientId) await choose(state.selectedPatientId);
    else paint();
  } catch (err) {
    error = err.message;
    paint();
  }
}

export async function renderLabsPage({ target }) {
  await renderListModule(target, {
    title: "Lab Orders & Results",
    formTitle: "New Lab Order",
    saveLabel: "Place Lab Order",
    listTitle: "Current Patient Worklist",
    hint: "Orders stay on the chart. The latest result is also shown as the patient lab summary.",
    field: "labOrders",
    empty: "No lab orders for this patient.",
    columns: [
      ["panel", "Test"],
      ["priority", "Priority"],
      ["status", "Status"],
      ["result", "Result"],
    ],
    build(form) {
      return {
        at: new Date().toISOString(),
        panel: form.panel,
        priority: form.priority,
        notes: form.notes,
        status: form.result ? "resulted" : "ordered",
        result: form.result,
      };
    },
    extraPatch(rows) {
      const last = [...rows].reverse().find((row) => row.result);
      return last ? { labResults: `${last.panel}: ${last.result}` } : {};
    },
    formFields: [
      ["panel", "Test panel", "select", ["CBC", "CRP", "Lactate", "Renal panel"]],
      ["priority", "Priority", "select", ["Routine", "Urgent", "STAT"]],
      ["notes", "Clinical notes", "text"],
      ["result", "Result", "text"],
    ],
  });
}

export async function renderMedsPage({ target }) {
  await renderListModule(target, {
    title: "Medication Chart (eMAR)",
    formTitle: "New Prescription",
    saveLabel: "Add to chart",
    listTitle: "Current prescriptions",
    hint: "Inpatient medicines for this person. Giving a dose updates the prior-medicines summary used on the patient page.",
    field: "medOrders",
    empty: "No prescriptions for this patient.",
    columns: [
      ["drug", "Medicine"],
      ["dose", "Dose"],
      ["route", "Route"],
      ["frequency", "Frequency"],
      ["status", "Status"],
    ],
    build(form) {
      return {
        at: new Date().toISOString(),
        drug: form.drug,
        dose: form.dose,
        route: form.route,
        frequency: form.frequency,
        status: "active",
      };
    },
    extraPatch(rows, patient) {
      const text = rows.map((row) => [row.drug, row.dose, row.frequency].filter(Boolean).join(" ")).join("; ");
      return { medicines: text || patient.medicines || "" };
    },
    formFields: [
      ["drug", "Medicine", "text"],
      ["dose", "Dose", "text"],
      ["route", "Route", "select", ["Oral", "IV", "Inhaled", "Topical"]],
      ["frequency", "Frequency", "text"],
    ],
  });
}

export async function renderNotesPage({ target }) {
  await renderListModule(target, {
    title: "Nursing / Care Notes",
    formTitle: "New Progress Note",
    saveLabel: "Add Note to Chart",
    listTitle: "Current Patient Notes",
    hint: "Progress notes stay on the chart. They are not copied into an X-ray report.",
    field: "careNotes",
    empty: "No progress notes recorded for this patient.",
    columns: [
      ["category", "Category"],
      ["author", "Author"],
      ["note", "Note"],
    ],
    build(form) {
      return {
        at: new Date().toISOString(),
        author: state.user?.name || "",
        role: state.user?.role || "",
        category: form.category,
        note: form.note,
      };
    },
    extraPatch(rows) {
      const last = rows[rows.length - 1];
      return last ? { remarks: last.note } : {};
    },
    formFields: [
      ["category", "Category", "select", ["General", "Handover", "Incident", "Pain Assessment", "Wound Care"]],
      ["note", "Note", "textarea"],
    ],
  });
}

async function renderListModule(target, spec) {
  let patients = [];
  let selected = null;
  let error = "";
  let busy = false;
  const form = {};
  for (const [key, , kind, options] of spec.formFields) {
    form[key] = kind === "select" ? options[0] : "";
  }
  const canEdit = canEditPatient(state.user);

  async function choose(id) {
    state.selectedPatientId = id;
    selected = id ? await loadPatient(id) : null;
    paint();
  }

  async function addRow() {
    if (!canEdit || !selected) return;
    const row = spec.build(form);
    const missing = spec.formFields.some(([key, , kind]) => (
      kind === "text" && key !== "result" && key !== "notes" && !String(form[key] || "").trim()
    ));
    if (missing) {
      toast("Complete the form before saving.");
      return;
    }
    busy = true;
    paint();
    try {
      const rows = [...(selected[spec.field] || []), row];
      const data = await api.updatePatient(selected.patientId, {
        [spec.field]: rows,
        ...spec.extraPatch(rows, selected),
      });
      selected = data.patient;
      toast("Saved on the patient chart.");
    } catch (err) {
      toast(err.message || "Could not save.");
    } finally {
      busy = false;
      paint();
    }
  }

  function paint() {
    const rows = selected?.[spec.field] || [];
    mount(target, cmsWindow(spec.title,
      error ? el("p", { class: "mt-2 bg-red-100 p-2 text-sm" }, error) : null,
      activePatientBar(selected),
      el("div", { class: "mb-2 flex flex-wrap items-center gap-2 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-800" },
        el("span", {}, "Select inpatient record:"),
        el("div", { class: "min-w-[16rem] flex-1" }, patientPicker(patients, selected?.patientId || "", choose))
      ),
      el("div", { class: "flex flex-1 flex-col gap-3 overflow-hidden lg:flex-row" },
        canEdit && el("div", { class: "flex w-full flex-col overflow-auto border border-gray-400 bg-[#e4e4e4] p-3 lg:w-1/3" },
          el("h3", { class: "mb-3 border-b border-gray-400 pb-1 font-bold text-ha-blue" }, spec.formTitle || "New entry"),
          el("div", { class: "flex flex-col gap-2" },
            ...spec.formFields.map(([key, label, kind, options]) => el("label", { class: "text-xs font-bold" },
              label,
              kind === "select"
                ? el("select", { class: "mt-1 w-full rounded border border-gray-400 bg-white px-2 py-1 text-xs", value: form[key], onChange: (e) => { form[key] = e.target.value; } },
                    ...options.map((option) => el("option", { value: option }, option)))
                : kind === "textarea"
                  ? el("textarea", { class: "mt-1 h-28 w-full rounded border border-gray-400 bg-white px-2 py-1 text-xs", onInput: (e) => { form[key] = e.target.value; } }, form[key])
                  : el("input", { class: "mt-1 w-full rounded border border-gray-400 bg-white px-2 py-1 text-xs", value: form[key], onInput: (e) => { form[key] = e.target.value; } })
            )),
            el("button", { class: `${BEVEL} mt-2 flex items-center justify-center px-4 py-2`, disabled: busy, onClick: addRow }, busy ? "Saving…" : (spec.saveLabel || "Save"))
          ),
          el("p", { class: "mt-2 border border-gray-400 bg-gray-200 p-2 text-[11px] leading-tight text-gray-700" }, spec.hint)
        ),
        el("div", { class: "flex flex-1 flex-col overflow-auto border border-gray-400 bg-white" },
          el("div", { class: "bg-[#008080] px-2 py-1 text-xs font-bold text-white" }, `${spec.listTitle || "Current records"} (${rows.length})`),
          rows.length
            ? el("div", { class: "divide-y divide-gray-200" },
                ...rows.slice().reverse().map((row) => el("div", { class: "p-2 text-xs" },
                  spec.columns.map(([key, label]) => el("div", {},
                    el("span", { class: "font-bold text-gray-500" }, label, ": "),
                    row[key] || "—"
                  ))
                ))
              )
            : el("div", { class: "p-8 text-center text-sm text-gray-500" }, spec.empty)
        )
      )
    ));
  }

  try {
    patients = await loadPatients();
    await choose(state.selectedPatientId || patients[0]?.patientId || "");
  } catch (err) {
    error = err.message;
    paint();
  }
}
