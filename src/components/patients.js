// src/components/patients.js
// Patient list and a chart page: history, diagnoses, findings, remarks.

import { el, mount } from "../dom.js";
import { state, setPage, toast } from "../state.js";
import { api } from "../api.js";
import { svgIcon } from "./icons.js";
import { paginate, paginationBar } from "../lib/pagination.js";
import { toggleSelected, togglePage, rowCheckbox, headerCheckbox, bulkDeleteButton } from "../lib/bulkSelect.js";
import { urgentBadge, patientDisplayName } from "../lib/tags.js";
import { emptyState } from "../lib/ui.js";
import { statusLabel } from "../lib/caseStatus.js";
import { CASES_CHANGED } from "../lib/analysisJob.js";
import { forgetPatients } from "../lib/records.js";
import { canEditPatient, canUpload, isAdmin as roleIsAdmin } from "../lib/roles.js";
import { monitorAlert } from "./clinical.js";

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
  let showAll = roleIsAdmin(state.user);
  let query = "";
  const selected = new Set();
  const isAdmin = () => roleIsAdmin(state.user);
  target._patientGen = (target._patientGen || 0) + 1;
  const gen = target._patientGen;

  if (target._stopCaseWatch) target._stopCaseWatch();
  const watch = new AbortController();
  target._stopCaseWatch = () => watch.abort();
  window.addEventListener(CASES_CHANGED, () => refresh(), { signal: watch.signal });

  function deleteSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} selected ${ids.length === 1 ? "patient" : "patients"} and all of their studies? This cannot be undone.`)) return;
    api.deletePatients(ids)
      .then((data) => {
        selected.clear();
        forgetPatients(data.ids || ids);
        toast(`Deleted ${data.deleted ?? ids.length} ${ids.length === 1 ? "patient" : "patients"}.`);
        refresh();
      })
      .catch((err) => toast(err.message || "Could not delete the selected patients."));
  }

  async function refresh() {
    if (target._patientGen !== gen) return;
    loading = true;
    error = "";
    render();
    try {
      const data = await api.listPatients({ q });
      if (target._patientGen !== gen) return;
      patients = data.patients || [];
      for (const id of [...selected]) {
        if (!patients.some((p) => p.patientId === id)) selected.delete(id);
      }
    } catch (err) {
      error = err.message;
    } finally {
      if (target._patientGen !== gen) return;
      loading = false;
      render();
    }
  }

  function render() {
    const male = patients.filter((p) => p.sex === "Male").length;
    const female = patients.filter((p) => p.sex === "Female").length;
    const unknown = patients.filter((p) => p.sex !== "Male" && p.sex !== "Female").length;
    const ages = patients.map((p) => Number(p.age)).filter((n) => Number.isFinite(n) && n > 0);
    const averageAge = ages.length ? Math.round(ages.reduce((sum, n) => sum + n, 0) / ages.length) : "—";
    const studies = patients.reduce((sum, p) => sum + Number(p.caseCount || 0), 0);
    const cards = patients.slice(0, 4);

    function stat(n, label) {
      return el("div", { class: "flex items-center gap-3 rounded border border-gray-200 bg-white px-3 py-3 shadow-sm" },
        el("div", {},
          el("div", { class: "text-2xl font-semibold leading-none text-slate-900" }, String(n)),
          el("div", { class: "mt-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500" }, label)
        )
      );
    }

    function personCard(p) {
      return el("button", {
        type: "button",
        class: "w-full rounded border border-gray-200 bg-white p-3 text-left hover:border-ha-blue",
        onClick: () => openPatient(p.patientId),
      },
        el("div", { class: "text-sm font-bold uppercase text-slate-900" }, patientDisplayName(p) || "Unnamed"),
        el("div", { class: "mt-1 text-xs text-gray-500" },
          [p.patientId, p.age && `${p.age}y`, p.sex].filter(Boolean).join(" · ")
        ),
        el("div", { class: "mt-2 flex flex-wrap gap-1" },
          p.urgent ? urgentBadge() : null,
          p.lastDiagnosis
            ? el("span", { class: "text-xs text-slate-600" }, p.lastDiagnosis)
            : null
        )
      );
    }

    const root = el("div", { class: "flex h-full min-h-[70vh] flex-col p-2" },
      el("div", { class: "relative flex h-full flex-col border-2 border-white border-b-gray-500 border-r-gray-500 bg-[#d4d0c8] p-2 shadow-sm" },
        el("div", { class: "flex items-center justify-between bg-ha-blue px-2 py-1 font-bold text-white" },
          el("span", {}, "Enquiry of Patient Master Index"),
          el("div", { class: "flex items-center gap-2" },
            canEditPatient(state.user) && el("button", {
              type: "button",
              class: "flex items-center gap-1 rounded border border-white/40 bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-white/20",
              onClick: () => setPage("new-patient"),
            }, svgIcon("user-plus", { size: 12 }), "Add Patient"),
            el("button", {
              type: "button",
              class: "flex items-center gap-1 rounded bg-yellow-400 px-2 py-0.5 text-xs font-bold text-black shadow hover:bg-yellow-300",
              onClick: () => { showAll = !showAll; render(); },
            }, showAll ? "Hide full index" : `View All Patients (${patients.length})`)
          )
        ),
        el("form", {
          class: "my-2 flex flex-wrap items-center gap-2 border border-gray-400 bg-gray-100 p-2",
          onSubmit: (e) => {
            e.preventDefault();
            q = query;
            page = 1;
            showAll = true;
            refresh();
          },
        },
          el("label", { class: "text-xs font-bold uppercase" }, "Patient No. / ID / Name:"),
          el("input", {
            class: "w-64 border border-gray-500 bg-white px-2 py-1 text-sm uppercase",
            placeholder: "e.g. PT-2026-0018 or CHAN",
            "aria-label": "Search patient by patient number or name",
            value: query,
            onInput: (e) => { query = e.target.value; },
          }),
          el("button", {
            type: "submit",
            class: "flex items-center gap-1 border border-gray-400 border-b-gray-600 border-r-gray-600 bg-[#ece9d8] px-3 py-1 text-sm font-bold hover:bg-gray-200",
          }, svgIcon("search", { size: 14 }), "Enquiry")
        ),
        el("div", { class: "flex-1 space-y-3 overflow-auto border-2 border-gray-500 bg-slate-100 p-3" },
        error
          ? el("div", { class: "p-6 text-red-700" }, error)
          : loading
          ? el("div", { class: "p-10 text-center text-slate-400" }, "Loading patients…")
          : showAll
          ? (patients.length === 0
            ? emptyState({
                icon: "users",
                title: "No patients yet",
                hint: "Add a chart first, then upload an X-ray for that person.",
                actionLabel: canEditPatient(state.user) ? "New patient" : null,
                onAction: () => setPage("new-patient"),
              })
            : (() => {
                const paged = paginate(patients, page);
                page = paged.page;
                const pageIds = paged.items.map((p) => p.patientId);
                return el("div", {},
                  isAdmin() && el("div", { class: "flex justify-end border-b px-3 py-2" },
                    bulkDeleteButton({ count: selected.size, onClick: deleteSelected })
                  ),
                  el("div", { class: "overflow-x-auto" },
                    el("table", { class: "w-full min-w-[720px] text-left text-sm" },
                      el("thead", { class: "bg-slate-50 text-slate-600" },
                        el("tr", {},
                          isAdmin() ? headerCheckbox(pageIds, selected, (on) => { togglePage(selected, pageIds, on); render(); }) : null,
                          ["Name", "Patient ID", "Age / sex", "Last diagnosis", "Studies", "Updated"].map((h) =>
                            el("th", { class: "p-3" }, h)
                          )
                        )
                      ),
                      el("tbody", {},
                        ...paged.items.map((p) =>
                          el("tr", {
                            class: "cursor-pointer border-t hover:bg-blue-50",
                            onClick: () => openPatient(p.patientId),
                          },
                            isAdmin() ? rowCheckbox(p.patientId, selected, (id, on) => { toggleSelected(selected, id, on); render(); }) : null,
                            el("td", { class: "p-3 font-bold" }, patientDisplayName(p) || "—", p.urgent ? urgentBadge({ class: "ml-2" }) : null),
                            el("td", { class: "font-mono text-xs text-slate-500" }, p.patientId),
                            el("td", {}, [p.age && `${p.age} years`, p.sex].filter(Boolean).join(" · ") || "—"),
                            el("td", {}, p.lastDiagnosis || "—"),
                            el("td", {}, String(p.caseCount || 0)),
                            el("td", {}, p.lastCaseAt ? new Date(p.lastCaseAt).toISOString().slice(0, 10) : "—")
                          )
                        )
                      )
                    )
                  ),
                  paginationBar({ ...paged, onPage: (n) => { page = n; render(); } })
                );
              })())
          : el("div", { class: "space-y-3 p-3" },
              el("div", { class: "grid gap-2 sm:grid-cols-3 xl:grid-cols-6" },
                stat(patients.length, "Total patients"),
                stat(studies, "X-ray studies"),
                stat(male, "Male"),
                stat(female, "Female"),
                stat(averageAge, "Average age"),
                stat(unknown, "Unknown sex")
              ),
              el("div", { class: "grid gap-3 lg:grid-cols-[minmax(0,1fr)_16rem]" },
                el("section", { class: "rounded border border-gray-200 p-3" },
                  el("h2", { class: "text-sm font-semibold text-slate-800" }, "Recently viewed patients"),
                  cards.length
                    ? el("div", { class: "mt-3 grid gap-2 sm:grid-cols-2" }, ...cards.map(personCard))
                    : el("p", { class: "mt-3 text-sm text-gray-500" }, "No patients in the index yet.")
                ),
                el("aside", { class: "rounded border border-amber-100 bg-[#fbf8ef] p-3" },
                  el("h2", { class: "text-sm font-semibold text-slate-800" }, "Quick actions"),
                  el("div", { class: "mt-3 space-y-2" },
                    canEditPatient(state.user) && el("button", {
                      class: "w-full rounded border border-gray-300 bg-white px-3 py-2 text-left text-sm",
                      onClick: () => setPage("new-patient"),
                    }, "Register a new patient"),
                    canUpload(state.user) && el("button", {
                      class: "w-full rounded border border-gray-300 bg-white px-3 py-2 text-left text-sm",
                      onClick: () => setPage("new"),
                    }, "Upload an X-ray"),
                    el("button", {
                      class: "w-full rounded border border-gray-300 bg-white px-3 py-2 text-left text-sm",
                      onClick: () => { showAll = true; render(); },
                    }, `Browse full Master Index (${patients.length})`)
                  )
                )
              )
            )
        )
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
  let medicinesDraft = "";
  let heartRateDraft = "";
  let labResultsDraft = "";

  const canEdit = () => canEditPatient(state.user);
  const isAdmin = () => roleIsAdmin(state.user);

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
    medicinesDraft = patient.medicines || "";
    heartRateDraft = patient.heartRate || "";
    labResultsDraft = patient.labResults || "";
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
        medicines: medicinesDraft,
        heartRate: heartRateDraft,
        labResults: labResultsDraft,
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
      forgetPatients([id]);
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
      "div",
      { class: "flex h-full min-h-[70vh] flex-col p-2" },
      el("div", { class: "relative flex h-full flex-col border-2 border-white border-b-gray-500 border-r-gray-500 bg-[#d4d0c8] p-2 shadow-sm" },
        el("div", { class: "flex items-center justify-between bg-ha-blue px-2 py-1 font-bold text-white" },
          el("button", {
            class: "text-sm",
            onClick: () => setPage("patients"),
          }, "Enquiry of Patient Master Index"),
          el("div", { class: "flex items-center gap-2" },
            isAdmin() && el("button", {
              class: "rounded border border-white/40 px-2 py-0.5 text-[11px] font-semibold",
              disabled: busy,
              onClick: deleteThis,
            }, "Delete"),
            edit && canUpload(state.user) && el("button", {
              class: "rounded border border-white/40 px-2 py-0.5 text-[11px] font-semibold",
              disabled: busy,
              onClick: () => setPage("new"),
            }, "New case"),
            edit && el("button", {
              class: "rounded bg-white px-2 py-0.5 text-[11px] font-bold text-ha-blue",
              disabled: busy,
              onClick: saveNotes,
            }, busy ? "Saving…" : "Save notes")
          )
        ),
        error
          ? el("p", { class: "p-4 text-red-700" }, error)
          : el("div", { class: "mt-2 flex-1 space-y-3 overflow-auto border-2 border-gray-500 bg-slate-100 p-3" },
              el("header", { class: "rounded-lg border border-slate-200 bg-white p-4" },
                el("div", { class: "flex flex-wrap justify-between gap-2" },
                  el("div", {},
                    el("p", { class: "font-mono font-bold text-ha-blue" }, "Hospital patient number ", patient?.patientId || ""),
                    el("h2", { class: "mt-1 text-xl font-bold" },
                      patientDisplayName(patient) || "Patient",
                      patient?.urgent ? urgentBadge({ class: "ml-2" }) : null
                    ),
                    el("p", { class: "text-xs text-gray-600" },
                      [patient?.age && `${patient.age} years`, patient?.sex].filter(Boolean).join(" · ") || "No demographics yet"
                    )
                  )
                ),
                el("dl", { class: "mt-4 grid gap-3 text-xs sm:grid-cols-2" },
                  el("div", {}, el("dt", { class: "font-bold text-gray-500" }, "Clinical history"), el("dd", { class: "mt-1" }, historyDraft || "No history recorded.")),
                  el("div", {}, el("dt", { class: "font-bold text-gray-500" }, "Prior medicines"), el("dd", { class: "mt-1" }, medicinesDraft || "No medicines recorded.")),
                  el("div", {}, el("dt", { class: "font-bold text-gray-500" }, "Lab test results"), el("dd", { class: "mt-1" }, labResultsDraft || "No lab results recorded.")),
                  el("div", {}, el("dt", { class: "font-bold text-gray-500" }, "Latest diagnosis"), el("dd", { class: "mt-1" }, patient?.lastDiagnosis || "No diagnosis yet."))
                )
              ),
              (() => {
                const obs = (patient?.observations || []).slice(-1)[0] || {};
                const reasons = monitorAlert(obs, heartRateDraft);
                const tile = (label, value) => el("article", { class: "rounded border border-slate-200 bg-slate-50 p-3" },
                  el("p", { class: "text-xs text-gray-500" }, label),
                  el("p", { class: "text-lg font-bold" }, value || "—")
                );
                return el("section", { class: "rounded-lg border border-slate-200 bg-white p-4" },
                  el("h3", { class: "flex items-center gap-2 font-bold" }, "Health metrics and trends"),
                  reasons.length
                    ? el("div", { role: "status", class: "my-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900" },
                        el("strong", {}, "Abnormal observations — review"),
                        el("div", { class: "mt-1 font-bold" }, reasons.join("; "), ". Record a new assessment."))
                    : null,
                  el("div", { class: "mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3" },
                    tile("Blood pressure", obs.sbp ? `${obs.sbp} mmHg` : "—"),
                    tile("Heart rate", obs.hr ? `${obs.hr} bpm` : (heartRateDraft || "—")),
                    tile("Respiratory rate", obs.rr ? `${obs.rr} breaths/min` : "—"),
                    tile("Oxygen saturation", obs.spo2 ? `${obs.spo2} %` : "—"),
                    tile("Temperature", obs.temp ? `${obs.temp} °C` : "—"),
                    tile("Lactate", obs.lactate ? `${obs.lactate} mmol/L` : "—")
                  )
                );
              })(),

              el("div", { class: "grid gap-3 lg:grid-cols-3" },
                el("section", { class: "rounded border border-gray-200 p-3" },
                  el("h2", { class: "text-sm font-bold text-slate-900" }, "Prior medicines"),
                  edit
                    ? el("textarea", {
                        class: "input mt-2 min-h-[88px]",
                        rows: 3,
                        placeholder: "Medicines taken before…",
                        onInput: (e) => { medicinesDraft = e.target.value; },
                      }, medicinesDraft)
                    : el("p", { class: "mt-2 whitespace-pre-wrap text-sm" }, medicinesDraft || "No medicines recorded.")
                ),
                el("section", { class: "rounded border border-gray-200 p-3" },
                  el("h2", { class: "text-sm font-bold text-slate-900" }, "Heart rate"),
                  edit
                    ? el("input", {
                        class: "input mt-2",
                        placeholder: "e.g. 78 bpm",
                        value: heartRateDraft,
                        onInput: (e) => { heartRateDraft = e.target.value; },
                      })
                    : el("p", { class: "mt-2 text-sm" }, heartRateDraft || "Not recorded.")
                ),
                el("section", { class: "rounded border border-gray-200 p-3" },
                  el("h2", { class: "text-sm font-bold text-slate-900" }, "Lab test results"),
                  edit
                    ? el("textarea", {
                        class: "input mt-2 min-h-[88px]",
                        rows: 3,
                        placeholder: "Lab results…",
                        onInput: (e) => { labResultsDraft = e.target.value; },
                      }, labResultsDraft)
                    : el("p", { class: "mt-2 whitespace-pre-wrap text-sm" }, labResultsDraft || "No lab results recorded.")
                )
              ),

              el("div", { class: "grid gap-3 lg:grid-cols-2" },
                el("section", { class: "rounded border border-gray-200 p-3" },
                  el("h2", { class: "text-sm font-bold text-slate-900" }, "Clinical history"),
                  edit
                    ? el("textarea", {
                        id: "patient-history",
                        class: "input mt-2 min-h-[120px]",
                        rows: 5,
                        placeholder: "Relevant history for this patient…",
                        onInput: (e) => { historyDraft = e.target.value; },
                      }, historyDraft)
                    : el("p", { class: "mt-2 whitespace-pre-wrap text-sm" }, historyDraft || "No history recorded.")
                ),
                el("section", { class: "rounded border border-gray-200 p-3" },
                  el("h2", { class: "text-sm font-bold text-slate-900" }, "Diagnosis"),
                  patient?.lastDiagnosis
                    ? el("p", { class: "mt-2 font-semibold" }, patient.lastDiagnosis)
                    : el("p", { class: "mt-2 text-slate-400" }, "No diagnosis yet."),
                  cases.length > 1 && el("ul", { class: "mt-3 space-y-2 text-sm text-slate-600" },
                    ...cases.map((c) =>
                      el("li", {},
                        el("button", {
                          class: "text-left hover:text-ha-blue",
                          onClick: () => openCase(c.caseId),
                        },
                          c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : "Study",
                          " · ",
                          c.diagnosis || "No diagnosis",
                          el("span", { class: "ml-2 text-slate-400" }, statusLabel(c.status))
                        )
                      )
                    )
                  )
                )
              ),

              el("section", { class: "rounded border border-gray-200 p-3" },
                el("h2", { class: "text-sm font-bold text-slate-900" }, "Findings"),
                findings.length === 0
                  ? el("p", { class: "mt-2 text-slate-400" }, "No findings recorded for this patient yet.")
                  : el("ul", { class: "mt-2 divide-y divide-slate-100" },
                      ...findings.slice(0, 12).map((f) =>
                        el("li", { class: "py-2" },
                          el("button", {
                            class: "w-full text-left hover:text-ha-blue",
                            onClick: () => openCase(f.caseId),
                          },
                            el("div", { class: "font-semibold" }, f.label || "Finding"),
                            el("p", { class: "text-sm text-slate-600" }, [f.location, f.pattern, f.sentence].filter(Boolean).join(" · "))
                          )
                        )
                      )
                    )
              ),

              el("section", { class: "rounded border border-gray-200 p-3" },
                el("h2", { class: "text-sm font-bold text-slate-900" }, "Remarks"),
                edit
                  ? el("textarea", {
                      id: "patient-remarks",
                      class: "input mt-2 min-h-[120px]",
                      rows: 5,
                      placeholder: "Notes about this patient. These stay on the chart and are not written into a report.",
                      onInput: (e) => { remarksDraft = e.target.value; },
                    }, remarksDraft)
                  : el("p", { id: "patient-remarks", class: "mt-2 whitespace-pre-wrap text-sm" }, remarksDraft || "No remarks have been added."),
                el("p", { class: "mt-2 text-xs text-slate-500" }, "Patient remarks are saved on the chart only. They do not change any study report.")
              ),

              el("section", { class: "overflow-hidden rounded border border-gray-200" },
                el("div", { class: "border-b bg-gray-50 px-3 py-2" },
                  el("h2", { class: "text-sm font-bold" }, "Studies")
                ),
                cases.length === 0
                  ? el("p", { class: "p-3 text-slate-400" }, "No studies yet.")
                  : el("ul", { class: "divide-y" },
                      ...cases.map((c) =>
                        el("li", {},
                          el("button", {
                            class: "flex w-full items-center justify-between gap-3 px-3 py-3 text-left hover:bg-slate-50",
                            onClick: () => openCase(c.caseId),
                          },
                            el("div", {},
                              el("div", { class: "font-semibold" }, c.caseId, c.urgent ? urgentBadge({ class: "ml-2" }) : null),
                              el("p", { class: "text-sm text-slate-600" }, c.diagnosis || "No diagnosis")
                            ),
                            el("span", { class: "text-xs text-slate-500" }, statusLabel(c.status))
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
