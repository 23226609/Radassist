// src/components/patients.js
// Patient list and a chart page: history, diagnoses, findings, remarks.

import { el, mount } from "../dom.js";
import { state, setPage, toast } from "../state.js";
import { api } from "../api.js";
import { svgIcon } from "./icons.js";
import { paginate, paginationBar } from "../lib/pagination.js";
import { toggleSelected, togglePage, rowCheckbox, headerCheckbox, bulkDeleteButton } from "../lib/bulkSelect.js";
import { urgentBadge, patientDisplayName } from "../lib/tags.js";

function openPatient(patientId) {
  state.selectedPatientId = patientId;
  setPage("patient");
}

function openCase(caseId) {
  state.selectedCaseId = caseId;
  setPage("case");
}

export async function renderPatientsPage({ target }) {
  let q = "";
  let patients = [];
  let loading = true;
  let error = "";
  let page = 1;
  const selected = new Set();
  const isAdmin = () => state.user?.role === "admin";

  function deleteSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} selected ${ids.length === 1 ? "patient" : "patients"} and all of their studies? This cannot be undone.`)) return;
    api.deletePatients(ids)
      .then((data) => {
        selected.clear();
        toast(`Deleted ${data.deleted ?? ids.length} ${ids.length === 1 ? "patient" : "patients"}.`);
        refresh();
      })
      .catch((err) => toast(err.message || "Could not delete the selected patients."));
  }

  async function refresh() {
    loading = true;
    error = "";
    render();
    try {
      const data = await api.listPatients({ q });
      patients = data.patients || [];
      for (const id of [...selected]) {
        if (!patients.some((p) => p.patientId === id)) selected.delete(id);
      }
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
      render();
    }
  }

  function render() {
    const root = el(
      "main",
      { class: "mx-auto max-w-7xl px-5 py-8" },
      el("button", {
        class: "mb-4 inline-flex items-center gap-1 text-slate-700 hover:text-slate-900",
        onClick: () => setPage("dashboard"),
      }, svgIcon("arrow-left", { size: 16 }), "Dashboard"),
      el("div", { class: "flex flex-wrap items-end justify-between gap-3" },
        el("div", {},
          el("h1", { class: "text-3xl font-bold text-slate-900" }, "Patients"),
          el("p", { class: "mt-1 text-slate-500" }, "Open a chart to see history, diagnoses, and findings.")
        ),
        state.user?.role !== "nurse"
          ? el("button", {
              class: "inline-flex items-center gap-2 rounded-xl bg-cyan-600 px-4 py-2 font-semibold text-white hover:bg-cyan-700",
              onClick: () => setPage("new-patient"),
            }, svgIcon("user-plus", { size: 16 }), "New patient")
          : null
      ),
      el("section", { class: "card mt-6 p-0 overflow-hidden" },
        el("div", { class: "flex flex-wrap gap-3 border-b p-4" },
          el("div", { class: "relative flex-1 min-w-[200px]" },
            svgIcon("search", { size: 16, class: "absolute left-3 top-3 text-slate-400" }),
            el("input", {
              class: "w-full rounded-xl border border-slate-300 bg-white pl-10 pr-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100",
              placeholder: "Search name or patient ID…",
              value: q,
              onInput: (e) => { q = e.target.value; },
              onChange: () => { page = 1; selected.clear(); refresh(); },
            })
          ),
          isAdmin() && bulkDeleteButton({ count: selected.size, onClick: deleteSelected })
        ),
        error
          ? el("div", { class: "p-6 text-red-700" }, error)
          : loading
          ? el("div", { class: "p-10 text-center text-slate-400" }, "Loading patients…")
          : patients.length === 0
          ? el("div", { class: "p-10 text-center text-slate-400" }, "No patients yet.")
          : (() => {
              const paged = paginate(patients, page);
              page = paged.page;
              const pageIds = paged.items.map((p) => p.patientId);
              return el("div", {},
                el("div", { class: "overflow-x-auto" },
                  el("table", { class: "w-full min-w-[720px] text-left text-sm" },
                    el("thead", { class: "bg-slate-50 text-slate-600" },
                      el("tr", {},
                        isAdmin() ? headerCheckbox(pageIds, selected, (on) => { togglePage(selected, pageIds, on); render(); }) : null,
                        ["Name", "Patient ID", "Age / sex", "Last diagnosis", "Studies", "Updated"].map((h) =>
                          el("th", { class: "p-4" }, h)
                        )
                      )
                    ),
                    el("tbody", {},
                      ...paged.items.map((p) =>
                        el("tr", {
                          class: "border-t cursor-pointer hover:bg-slate-50",
                          onClick: () => openPatient(p.patientId),
                        },
                          isAdmin() ? rowCheckbox(p.patientId, selected, (id, on) => { toggleSelected(selected, id, on); render(); }) : null,
                          el("td", { class: "p-4" },
                            el("div", { class: "flex flex-wrap items-center gap-2" },
                              el("span", { class: "font-bold text-slate-900" }, patientDisplayName(p) || "—"),
                              p.urgent ? urgentBadge() : null
                            )
                          ),
                          el("td", { class: "font-mono text-xs text-slate-500" }, p.patientId),
                          el("td", { class: "text-slate-600" },
                            [p.age && `${p.age} years`, p.sex].filter(Boolean).join(" · ") || "—"
                          ),
                          el("td", { class: "max-w-md" }, p.lastDiagnosis || el("em", { class: "text-slate-400" }, "—")),
                          el("td", {}, String(p.caseCount || 0)),
                          el("td", { class: "text-slate-600" },
                            p.lastCaseAt ? new Date(p.lastCaseAt).toISOString().slice(0, 10) : "—"
                          )
                        )
                      )
                    )
                  )
                ),
                paginationBar({ ...paged, onPage: (n) => { page = n; render(); } })
              );
            })()
      )
    );
    mount(target, root);
  }

  await refresh();
}

export async function renderPatientPage({ target }) {
  const patientId = state.selectedPatientId;
  let patient = null;
  let cases = [];
  let error = "";
  let busy = false;
  let historyDraft = "";
  let remarksDraft = "";

  const canEdit = () => state.user?.role !== "nurse";
  const isAdmin = () => state.user?.role === "admin";

  async function load() {
    if (!patientId) {
      error = "No patient was selected.";
      return;
    }
    const data = await api.getPatient(patientId);
    patient = data.patient;
    cases = data.cases || [];
    historyDraft = patient.history || "";
    remarksDraft = patient.remarks || "";
    error = "";
  }

  try {
    await load();
  } catch (err) {
    error = err.message || "Could not load this patient.";
  }

  async function saveNotes() {
    if (!patient || !canEdit()) return;
    busy = true;
    paint();
    try {
      const data = await api.updatePatient(patient.patientId, {
        history: historyDraft,
        remarks: remarksDraft,
      });
      patient = data.patient || { ...patient, history: historyDraft, remarks: remarksDraft };
      cases = data.cases || cases;
      toast("Patient notes saved.");
    } catch (err) {
      toast(err.message || "Could not save notes.");
    } finally {
      busy = false;
      paint();
    }
  }

  async function deleteThis() {
    if (!patient || !isAdmin()) return;
    const id = patient.patientId;
    if (!confirm(`Delete patient ${id} and all of their studies? This cannot be undone.`)) return;
    busy = true;
    paint();
    try {
      await api.deletePatient(id);
      toast(`Deleted ${id}`);
      setPage("patients");
    } catch (err) {
      toast(err.message || "Could not delete this patient.");
      busy = false;
      paint();
    }
  }

  function paint() {
    const edit = canEdit();
    const findings = cases.flatMap((c) =>
      (c.findings || []).map((f) => ({ ...f, caseId: c.caseId, diagnosis: c.diagnosis, createdAt: c.createdAt }))
    );

    const root = el(
      "main",
      { class: "mx-auto max-w-5xl px-5 py-8" },
      el("button", {
        class: "mb-4 inline-flex items-center gap-1 text-slate-700 hover:text-slate-900",
        onClick: () => setPage("patients"),
      }, svgIcon("arrow-left", { size: 16 }), "Patients"),

      error
        ? el("p", { class: "rounded-xl bg-red-50 p-4 text-red-700" }, error)
        : el("div", {},
            el("div", { class: "flex flex-wrap items-start justify-between gap-3" },
              el("div", {},
                el("div", { class: "flex flex-wrap items-center gap-2" },
                  el("h1", { class: "text-3xl font-bold text-slate-900" },
                    patientDisplayName(patient) || patient?.patientId || "Patient"),
                  patient?.urgent ? urgentBadge() : null
                ),
                el("p", { class: "mt-1 text-slate-600" },
                  patientDisplayName(patient)
                    ? el("span", { class: "mr-2 font-mono text-xs text-slate-500" }, patient.patientId)
                    : null,
                  [patient?.age && `${patient.age} years`, patient?.sex].filter(Boolean).join(" · ") || "No demographics yet"
                )
              ),
              el("div", { class: "flex flex-wrap gap-2" },
                isAdmin() && el("button", {
                  class: "inline-flex items-center gap-1 rounded-xl border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50",
                  disabled: busy,
                  onClick: deleteThis,
                }, svgIcon("trash", { size: 16 }), "Delete"),
                edit && el("button", {
                  class: "inline-flex items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50",
                  disabled: busy,
                  onClick: () => setPage("new"),
                }, svgIcon("plus", { size: 16 }), "New case"),
                edit && el("button", {
                  class: "rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50",
                  disabled: busy,
                  onClick: saveNotes,
                }, busy ? "Saving…" : "Save notes")
              )
            ),

            el("div", { class: "mt-6 grid gap-5 lg:grid-cols-2" },
              el("section", { class: "card" },
                el("h2", { class: "text-lg font-bold text-slate-900" }, "Clinical history"),
                edit
                  ? el("textarea", {
                      id: "patient-history",
                      class: "input mt-3 min-h-[140px]",
                      rows: 6,
                      placeholder: "Relevant history for this patient…",
                      onInput: (e) => { historyDraft = e.target.value; },
                    }, historyDraft)
                  : el("p", { class: "mt-3 whitespace-pre-wrap text-sm text-slate-700" },
                      historyDraft || "No history recorded.")
              ),
              el("section", { class: "card" },
                el("h2", { class: "text-lg font-bold text-slate-900" }, "Diagnosis"),
                patient?.lastDiagnosis
                  ? el("p", { class: "mt-3 text-lg font-semibold text-slate-900" }, patient.lastDiagnosis)
                  : el("p", { class: "mt-3 text-slate-400" }, "No diagnosis yet."),
                cases.length > 1 && el("ul", { class: "mt-4 space-y-2 text-sm text-slate-600" },
                  ...cases.map((c) =>
                    el("li", {},
                      el("button", {
                        class: "text-left hover:text-cyan-700",
                        onClick: () => openCase(c.caseId),
                      },
                        c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : "Study",
                        " · ",
                        c.diagnosis || "No diagnosis",
                        el("span", { class: "ml-2 capitalize text-slate-400" }, c.status)
                      )
                    )
                  )
                )
              )
            ),

            el("section", { class: "card mt-5" },
              el("h2", { class: "text-lg font-bold text-slate-900" }, "Findings"),
              findings.length === 0
                ? el("p", { class: "mt-3 text-slate-400" }, "No findings recorded for this patient yet.")
                : el("ul", { class: "mt-3 divide-y divide-slate-100" },
                    ...findings.slice(0, 12).map((f) =>
                      el("li", { class: "py-3" },
                        el("button", {
                          class: "w-full text-left hover:text-cyan-700",
                          onClick: () => openCase(f.caseId),
                        },
                          el("div", { class: "font-semibold text-slate-900" }, f.label || "Finding"),
                          el("p", { class: "mt-1 text-sm text-slate-600" },
                            [f.location, f.pattern, f.sentence].filter(Boolean).join(" · ")
                          ),
                          el("p", { class: "mt-1 text-xs text-slate-400" },
                            f.caseId,
                            f.createdAt ? ` · ${new Date(f.createdAt).toISOString().slice(0, 10)}` : ""
                          )
                        )
                      )
                    )
                  )
            ),

            el("section", { class: "card mt-5" },
              el("h2", { class: "text-lg font-bold text-slate-900" }, "Remarks"),
              edit
                ? el("textarea", {
                    id: "patient-remarks",
                    class: "input mt-3 min-h-[140px]",
                    rows: 6,
                    placeholder: "Notes about this patient. These stay on the chart and are not written into a report.",
                    onInput: (e) => { remarksDraft = e.target.value; },
                  }, remarksDraft)
                : el("p", {
                    id: "patient-remarks",
                    class: "mt-3 whitespace-pre-wrap text-sm text-slate-700",
                  }, remarksDraft || "No remarks have been added."),
              el("p", { class: "mt-2 text-xs text-slate-500" },
                "Patient remarks are saved on the chart only. They do not change any study report."
              )
            ),

            el("section", { class: "card mt-5 p-0 overflow-hidden" },
              el("div", { class: "border-b px-5 py-4" },
                el("h2", { class: "text-lg font-bold text-slate-900" }, "Studies")
              ),
              cases.length === 0
                ? el("p", { class: "p-5 text-slate-400" }, "No studies yet.")
                : el("ul", { class: "divide-y divide-slate-100" },
                    ...cases.map((c) =>
                      el("li", {},
                        el("button", {
                          class: "flex w-full items-center justify-between gap-3 px-5 py-4 text-left hover:bg-slate-50",
                          onClick: () => openCase(c.caseId),
                        },
                          el("div", {},
                            el("div", { class: "flex flex-wrap items-center gap-2" },
                              el("div", { class: "font-semibold text-slate-900" }, c.caseId),
                              c.urgent ? urgentBadge() : null
                            ),
                            el("p", { class: "text-sm text-slate-600" }, c.diagnosis || "No diagnosis")
                          ),
                          el("span", { class: "text-xs capitalize text-slate-500" },
                            c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : "",
                            " · ",
                            c.status
                          )
                        )
                      )
                    )
                  )
            )
          )
    );
    mount(target, root);
  }

  paint();
}
