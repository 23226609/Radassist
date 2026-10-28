// src/components/patients.js
// Patient list and a chart page: history, diagnoses, findings, remarks.

import { el, mount } from "../dom.js";
import { state, setPage, toast } from "../state.js";
import { api } from "../api.js";
import { svgIcon } from "./icons.js";
import { paginate, paginationBar } from "../lib/pagination.js";
import { toggleSelected, togglePage, rowCheckbox, headerCheckbox, bulkDeleteButton } from "../lib/bulkSelect.js";
import { urgentBadge, patientDisplayName } from "../lib/tags.js";
import { emptyState, bookingWhen } from "../lib/ui.js";
import { statusLabel } from "../lib/caseStatus.js";
import { CASES_CHANGED } from "../lib/analysisJob.js";
import { forgetPatients } from "../lib/records.js";
import { canEditPatient, canEditReport, canUpload, canRequestExam, isTechnician, isAdmin as roleIsAdmin } from "../lib/roles.js";
import { reviewState, cmsAssessmentStamp } from "./clinical.js";
import { sepsisButton, careNotesButton, PATIENT_UPDATED, isChartWindow } from "../lib/chartWindow.js";

const CHART_POLL_MS = 4000;
const CARE_NOTES_SHOWN = 3;
let chartWindowListener = null;

const SEVERITY_TAG = {
  significant: ["Significant", "bg-red-100 text-red-800"],
  minor: ["Minor", "bg-amber-100 text-amber-800"],
  normal: ["Normal", "bg-emerald-100 text-emerald-800"],
};

const DAY_STYLE = {
  open: ["border-emerald-300 bg-emerald-50 hover:bg-emerald-100", "text-emerald-800"],
  few: ["border-amber-300 bg-amber-50 hover:bg-amber-100", "text-amber-800"],
  full: ["cursor-not-allowed border-red-200 bg-red-50", "text-red-700"],
  closed: ["cursor-not-allowed border-gray-200 bg-gray-100", "text-gray-500"],
  past: ["cursor-not-allowed border-gray-100 bg-gray-50 text-gray-400", "text-gray-400"],
};

function longDay(key) {
  return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

const FREQ_LABEL = {
  PRN: "when needed",
  OD: "once a day",
  BD: "twice a day",
  TDS: "three times a day",
  QID: "four times a day",
  QDS: "four times a day",
  NOCTE: "at night",
  MANE: "in the morning",
};

function medicineOrders(record) {
  return (Array.isArray(record?.medOrders) ? record.medOrders : [])
    .filter((row) => String(row?.drug || row?.name || "").trim())
    .slice()
    .sort((a, b) => String(b?.at || "").localeCompare(String(a?.at || "")));
}

function ordersAsText(orders) {
  return orders.map((row) => [row.drug || row.name, row.dose, row.frequency].filter(Boolean).join(" ")).join("; ");
}

function sameMedicineList(text, orders) {
  const norm = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const left = norm(text);
  return Boolean(left) && left === norm(ordersAsText(orders));
}

function freqLabel(value) {
  const raw = String(value || "").trim();
  return FREQ_LABEL[raw.toUpperCase()] || raw;
}

function dayLabel(info) {
  if (!info) return "";
  if (info.status === "closed") return "Closed";
  if (info.status === "past") return "";
  if (info.status === "full") return "Full";
  return `${info.left} left`;
}

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
        el("div", { class: "flex items-center justify-between border-b border-[#d9d3bc] bg-ha-paper px-2 py-1 font-bold text-stone-900" },
          el("span", {}, "Enquiry of Patient Master Index"),
          el("div", { class: "flex items-center gap-2" },
            canEditPatient(state.user) && el("button", {
              type: "button",
              class: "flex items-center gap-1 rounded border border-stone-400 bg-white px-2 py-0.5 text-[11px] font-semibold text-stone-900 hover:bg-stone-100",
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
                          ["Name", "Patient ID", "Age / sex", "Last diagnosis", "Studies", "Updated", "Monitor"].map((h) =>
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
                            el("td", {}, p.lastCaseAt ? new Date(p.lastCaseAt).toISOString().slice(0, 10) : "—"),
                            el("td", { class: "p-2" },
                              el("div", { class: "flex gap-1" },
                                sepsisButton(p, { compact: true }),
                                careNotesButton(p, { label: "Notes" })
                              )
                            )
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

export async function renderPatientPage({ target, patientId: givenId = "", embedded = false } = {}) {
  const patientId = givenId || state.selectedPatientId;
  let patient = null;
  let cases = [];
  let error = "";
  let busy = false;
  let historyDraft = "";
  let remarksDraft = "";
  let medicinesDraft = "";
  let heartRateDraft = "";
  let labResultsDraft = "";
  let booking = false;
  let allCareNotes = false;
  let bookCursor = new Date();
  let bookedDay = "";
  let bookedTime = "";
  let slotDays = {};
  let slotQuota = null;
  let slotsLoading = false;
  let slotsError = "";

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

  const stillHere = () => target.isConnected !== false
    && (embedded || (state.page === "patient" && state.selectedPatientId === patientId));

  // In the patient window a study opens back in the main window.
  function showCase(caseId) {
    const main = embedded ? window.opener : null;
    if (main && !main.closed) {
      try {
        main.location.hash = `#/cases/${encodeURIComponent(caseId)}`;
        main.focus();
        return;
      } catch { /* opener navigated elsewhere */ }
    }
    openCase(caseId);
  }

  let pollTimer = null;
  function pollChartFindings() {
    clearTimeout(pollTimer);
    if (!cases.some((c) => c.chartFindingsState === "running")) return;
    pollTimer = setTimeout(async () => {
      if (!stillHere()) return;
      try {
        const data = await api.getPatient(patientId);
        if (!stillHere()) return;
        cases = data.cases || cases;
        if (data.patient) patient = { ...patient, lastDiagnosis: data.patient.lastDiagnosis };
        paint();
      } catch { /* try again on the next tick */ }
      pollChartFindings();
    }, CHART_POLL_MS);
  }

  async function retryChartFindings(caseId) {
    try {
      const data = await api.rewriteChartFindings(caseId);
      cases = cases.map((c) => (c.caseId === caseId
        ? { ...c, chartFindingsState: data.chartFindingsState || "running" }
        : c));
      paint();
      pollChartFindings();
    } catch (err) {
      toast(err.message || "Could not ask Azure AI to try again.");
    }
  }

  // Vitals or care notes saved in a chart window. Drafts the user is still
  // editing here are left alone.
  function chartSaved(saved) {
    if (!saved || saved.patientId !== patientId || target.isConnected === false) return;
    if (heartRateDraft === (patient?.heartRate || "")) heartRateDraft = saved.heartRate || "";
    if (remarksDraft === (patient?.remarks || "")) remarksDraft = saved.remarks || "";
    patient = {
      ...patient,
      observations: saved.observations || [],
      heartRate: saved.heartRate || "",
      careNotes: saved.careNotes || [],
      remarks: saved.remarks || "",
    };
    paint();
  }

  if (chartWindowListener) window.removeEventListener("message", chartWindowListener);
  chartWindowListener = (e) => {
    if (e.origin && e.origin !== window.location.origin) return;
    if (e.data?.type === PATIENT_UPDATED) chartSaved(e.data.patient);
  };
  window.addEventListener("message", chartWindowListener);

  function chartFindingsBlock(c) {
    const when = c.finalizedAt || c.createdAt;
    const canRetry = canEditReport(state.user);
    const retry = canRetry && el("button", {
      type: "button",
      class: "ml-2 rounded border border-gray-400 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-800 hover:bg-slate-50",
      onClick: () => retryChartFindings(c.caseId),
    }, "Retry Azure AI");
    let body;
    if (c.chartFindingsState === "running") {
      body = el("p", { role: "status", class: "mt-1 text-sm text-sky-800" }, "Azure AI is reading the endorsed report…");
    } else if (c.chartFindingsState === "failed") {
      body = el("p", { class: "mt-1 text-sm text-red-700" }, "Azure AI could not write findings for this report.", retry);
    } else if (c.chartFindingsState === "unavailable") {
      body = el("p", { class: "mt-1 text-sm text-slate-500" }, "Azure AI is not configured on the server, so no findings were written.", retry);
    } else if (!(c.chartFindings || []).length) {
      body = el("p", { class: "mt-1 text-sm text-slate-400" }, "No findings written yet.");
    } else {
      body = el("ul", { class: "mt-1 divide-y divide-slate-100" },
        ...c.chartFindings.map((f) => {
          const [tag, tone] = SEVERITY_TAG[f.severity] || SEVERITY_TAG.minor;
          return el("li", { class: "py-2" },
            el("div", { class: "flex flex-wrap items-center gap-2" },
              el("span", { class: "font-semibold" }, f.label || "Finding"),
              el("span", { class: `rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${tone}` }, tag),
              f.location ? el("span", { class: "text-xs text-slate-500" }, f.location) : null
            ),
            f.detail ? el("p", { class: "text-sm text-slate-600" }, f.detail) : null
          );
        })
      );
    }
    return el("article", { class: "rounded border border-slate-200 bg-white p-2" },
      el("button", {
        type: "button",
        class: "text-left text-xs font-bold text-ha-blue hover:underline",
        onClick: () => showCase(c.caseId),
      },
        c.caseId,
        when ? ` · ${new Date(when).toISOString().slice(0, 10)}` : "",
        c.finalizedByName ? ` · Endorsed by ${c.finalizedByName}` : " · Endorsed"
      ),
      body
    );
  }

  function dayKey(date) {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function monthCells(date) {
    const year = date.getFullYear();
    const month = date.getMonth();
    const first = new Date(year, month, 1).getDay();
    const count = new Date(year, month + 1, 0).getDate();
    const cells = Array.from({ length: first }, () => null);
    for (let day = 1; day <= count; day += 1) cells.push(new Date(year, month, day));
    return cells;
  }

  function patientNeedsUrgentFilm() {
    const obs = (patient?.observations || []).slice(-1)[0] || {};
    return Boolean(patient?.urgent) || reviewState(obs, heartRateDraft).level === "urgent";
  }

  function dayCanTakeBooking(info) {
    if (!info) return false;
    if (["open", "few"].includes(info.status)) return true;
    return patientNeedsUrgentFilm() && info.status === "full";
  }

  function timeCanTakeBooking(slot) {
    if (!slot) return false;
    if (slot.status === "open") return true;
    return patientNeedsUrgentFilm() && slot.status === "full";
  }

  async function loadSlots() {
    const year = bookCursor.getFullYear();
    const month = bookCursor.getMonth();
    const from = dayKey(new Date(year, month, 1));
    const to = dayKey(new Date(year, month + 1, 0));
    slotsLoading = true;
    slotsError = "";
    paint();
    try {
      const data = await api.xrayAvailability(from, to);
      if (bookCursor.getFullYear() !== year || bookCursor.getMonth() !== month) return;
      slotDays = Object.fromEntries((data.days || []).map((d) => [d.day, d]));
      slotQuota = { daily: data.dailyQuota, perSlot: data.slotCapacity, minutes: data.slotMinutes };
      const chosen = slotDays[bookedDay];
      if (chosen && !dayCanTakeBooking(chosen)) bookedDay = "";
      if (bookedTime && !slotDays[bookedDay]?.slots.some((s) => s.time === bookedTime && timeCanTakeBooking(s))) bookedTime = "";
    } catch (err) {
      slotsError = err.message || "Could not load availability.";
    } finally {
      slotsLoading = false;
      paint();
    }
  }

  function openBooking() {
    booking = true;
    bookedDay = "";
    bookedTime = "";
    bookCursor = new Date();
    loadSlots();
  }

  function moveMonth(step) {
    bookCursor = new Date(bookCursor.getFullYear(), bookCursor.getMonth() + step, 1);
    slotDays = {};
    loadSlots();
  }

  function pickDay(key) {
    const info = slotDays[key];
    if (!dayCanTakeBooking(info)) return;
    if (bookedDay !== key) bookedTime = "";
    bookedDay = key;
    paint();
  }

  async function bookExam() {
    if (!patient || !canRequestExam(state.user)) return;
    if (!bookedDay || !bookedTime) {
      toast("Choose a day, then a time.");
      return;
    }
    busy = true;
    paint();
    try {
      await api.requestExam({
        patientId: patient.patientId,
        day: bookedDay,
        time: bookedTime,
        urgent: patientNeedsUrgentFilm(),
      });
      booking = false;
      await load();
      toast(`Chest X-ray booked for ${longDay(bookedDay)} at ${bookedTime}.`);
    } catch (err) {
      toast(err.message || "Could not book the X-ray.");
      if (booking) loadSlots();
    } finally {
      busy = false;
      paint();
    }
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

  function bookingDialog() {
    const chosenDay = slotDays[bookedDay];
    const legend = (cls, label) => el("span", { class: "inline-flex items-center gap-1" },
      el("span", { class: `inline-block h-3 w-3 rounded-sm border ${cls}` }), label);
    return el("section", { id: "book-xray", class: "max-h-[92vh] w-full max-w-2xl overflow-auto rounded border border-gray-300 bg-white p-4 shadow-2xl" },
      el("div", { class: "flex flex-wrap items-center justify-between gap-2" },
        el("h2", { class: "text-sm font-bold" }, "Book chest X-ray"),
        el("div", { class: "flex items-center gap-2 text-xs" },
          el("button", { type: "button", class: "rounded border border-gray-300 px-2 py-1", disabled: slotsLoading, onClick: () => moveMonth(-1) }, "Prev"),
          el("span", { class: "min-w-28 text-center font-semibold" }, bookCursor.toLocaleString(undefined, { month: "long", year: "numeric" })),
          el("button", { type: "button", class: "rounded border border-gray-300 px-2 py-1", disabled: slotsLoading, onClick: () => moveMonth(1) }, "Next")
        )
      ),
      el("p", { class: "mt-2 text-xs text-slate-600" },
        "Drag the exam onto a day, or click the day, then choose a time.",
        slotQuota ? ` Quota: ${slotQuota.daily} X-rays a day, ${slotQuota.perSlot} per ${slotQuota.minutes}-minute slot.` : "",
        patientNeedsUrgentFilm() ? " This patient is urgent, so a full day can still take the booking." : ""
      ),
      el("div", { class: "mt-2 flex flex-wrap items-center justify-between gap-2" },
        el("div", {
          draggable: "true",
          class: "inline-block cursor-grab rounded bg-ha-blue px-3 py-1 text-xs font-bold text-white",
          onDragstart: (e) => {
            e.dataTransfer?.setData("text/plain", "chest-xray");
            if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
          },
        }, "Chest X-ray"),
        el("div", { id: "book-legend", class: "flex flex-wrap gap-3 text-[11px] text-slate-600" },
          legend("border-emerald-300 bg-emerald-50", "Available"),
          legend("border-amber-300 bg-amber-50", "Few left"),
          legend("border-red-200 bg-red-50", "Full"),
          legend("border-gray-200 bg-gray-100", "Closed")
        )
      ),
      slotsError && el("p", { class: "mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-800" }, slotsError),
      el("div", { class: "mt-3 grid grid-cols-7 gap-1 text-center text-[11px] text-slate-500" },
        ...["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((name) => el("div", { class: "font-semibold" }, name))
      ),
      el("div", { class: "mt-1 grid grid-cols-7 gap-1", "aria-busy": slotsLoading ? "true" : "false" },
        ...monthCells(bookCursor).map((day) => {
          if (!day) return el("div", {});
          const key = dayKey(day);
          const info = slotDays[key];
          const chosen = key === bookedDay;
          const bookable = dayCanTakeBooking(info);
          let [cellCls, labelCls] = info ? DAY_STYLE[info.status] : ["border-gray-200 bg-white", "text-slate-400"];
          if (bookable && info?.status === "full") cellCls = cellCls.replace("cursor-not-allowed", "hover:bg-red-100");
          return el("button", {
            type: "button",
            "data-day": key,
            "data-status": info?.status || "loading",
            class: `min-h-14 rounded border p-1 text-left text-xs ${chosen ? "border-ha-blue bg-blue-50 ring-2 ring-ha-blue" : cellCls}`,
            disabled: !bookable,
            title: info ? `${info.booked} of ${info.quota} booked` : "",
            onClick: () => pickDay(key),
            onDragover: (e) => { if (bookable) e.preventDefault(); },
            onDrop: (e) => { e.preventDefault(); pickDay(key); },
          },
            el("div", { class: "font-semibold text-slate-700" }, String(day.getDate())),
            chosen
              ? el("div", { class: "mt-1 truncate rounded bg-ha-blue px-1 text-[10px] font-bold text-white" }, bookedTime || "Chest X-ray")
              : el("div", { class: `mt-1 text-[10px] font-semibold ${labelCls}` }, slotsLoading && !info ? "…" : dayLabel(info))
          );
        })
      ),
      chosenDay && el("div", { id: "book-times", class: "mt-3 rounded border border-gray-200 bg-slate-50 p-2" },
        el("div", { class: "flex flex-wrap items-baseline justify-between gap-2" },
          el("h3", { class: "text-xs font-bold text-slate-800" }, `Times on ${longDay(bookedDay)}`),
          el("span", { class: "text-[11px] text-slate-600" }, `${chosenDay.booked} of ${chosenDay.quota} booked · ${chosenDay.left} left`)
        ),
        el("div", { class: "mt-2 grid grid-cols-4 gap-1 sm:grid-cols-7" },
          ...chosenDay.slots.map((slot) => {
            const picked = slot.time === bookedTime;
            const open = timeCanTakeBooking(slot);
            const tone = picked
              ? "border-ha-blue bg-ha-blue text-white"
              : open
                ? (slot.status === "full"
                  ? "border-red-300 bg-white text-red-800 hover:bg-red-50"
                  : slot.left === 1 ? "border-amber-300 bg-white hover:bg-amber-50" : "border-emerald-300 bg-white hover:bg-emerald-50")
                : "cursor-not-allowed border-gray-200 bg-gray-100 text-gray-400";
            return el("button", {
              type: "button",
              "data-time": slot.time,
              class: `rounded border px-1 py-1 text-center text-xs ${tone}`,
              disabled: !open,
              onClick: () => { bookedTime = slot.time; paint(); },
            },
              el("div", { class: "font-bold" }, slot.time),
              el("div", { class: "text-[10px]" }, open
                ? (slot.status === "full" ? "Urgent" : `${slot.left} of ${slot.capacity} free`)
                : (slot.status === "full" ? "Full" : "Passed"))
            );
          })
        )
      ),
      el("div", { class: "mt-3 flex items-center justify-between gap-2" },
        el("span", { id: "book-summary", class: "text-xs text-slate-600" },
          bookedDay && bookedTime ? `Booking: ${longDay(bookedDay)} at ${bookedTime}`
            : bookedDay ? "Now choose a time." : "No day chosen yet."),
        el("div", { class: "flex gap-2" },
          el("button", {
            type: "button",
            class: "rounded border border-gray-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50",
            disabled: busy,
            onClick: () => { booking = false; paint(); },
          }, "Cancel"),
          el("button", {
            type: "button",
            class: "rounded bg-ha-blue px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50",
            disabled: busy || !bookedDay || !bookedTime,
            onClick: bookExam,
          }, busy ? "Booking…" : "Confirm booking")
        )
      )
    );
  }

  function paint() {
    const edit = canEdit();
    const endorsed = cases.filter((c) => c.status === "finalized");
    const openRequest = cases.find((c) => c.status === "requested");

    const root = el(
      "div",
      { class: "flex h-full min-h-0 flex-1 flex-col overflow-hidden" },
      el("div", { class: "relative flex h-full min-h-0 flex-col overflow-hidden border-2 border-white border-b-gray-500 border-r-gray-500 bg-[#d4d0c8] p-1.5 shadow-sm" },
        el("div", { class: "flex items-center justify-between border-b border-[#d9d3bc] bg-ha-paper px-2 py-1 font-bold text-stone-900" },
          embedded
            ? el("span", { class: "text-sm" }, "Patient chart")
            : el("button", {
                class: "text-sm",
                onClick: () => setPage("patients"),
              }, "Enquiry of Patient Master Index"),
          el("div", { class: "flex flex-wrap items-center justify-end gap-2" },
            patient && !isChartWindow() && sepsisButton(patient, { onSaved: chartSaved }),
            patient && !isChartWindow() && careNotesButton(patient, { onSaved: chartSaved }),
            !embedded && isAdmin() && el("button", {
              class: "rounded border border-stone-400 bg-white px-2 py-0.5 text-[11px] font-semibold text-stone-900 hover:bg-stone-100",
              disabled: busy,
              onClick: deleteThis,
            }, "Delete"),
            !embedded && edit && canUpload(state.user) && el("button", {
              class: "rounded border border-stone-400 bg-white px-2 py-0.5 text-[11px] font-semibold text-stone-900 hover:bg-stone-100",
              disabled: busy,
              onClick: () => setPage("new"),
            }, "New case"),
            canRequestExam(state.user) && el("button", {
              class: "rounded border border-stone-400 bg-white px-2 py-0.5 text-[11px] font-semibold text-stone-900 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-60",
              disabled: busy || Boolean(openRequest),
              onClick: openBooking,
              title: openRequest?.scheduledAt ? `Booked for ${bookingWhen(openRequest.scheduledAt)}` : "",
            }, openRequest ? (openRequest.scheduledAt ? `X-ray booked ${bookingWhen(openRequest.scheduledAt)}` : "Requested") : "Book chest X-ray"),
            edit && el("button", {
              class: "rounded bg-white px-2 py-0.5 text-[11px] font-bold text-ha-blue",
              disabled: busy,
              onClick: saveNotes,
            }, busy ? "Saving…" : "Save notes")
          )
        ),
        error
          ? el("p", { class: "p-4 text-red-700" }, error)
          : el("div", { class: "mt-1 flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden border-2 border-gray-500 bg-slate-100 p-1.5" },
              el("header", { class: "flex shrink-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded border border-slate-200 bg-white px-3 py-1.5" },
                el("div", { class: "flex min-w-0 flex-wrap items-baseline gap-x-2" },
                  el("h2", { class: "text-base font-bold" },
                    patientDisplayName(patient) || "Patient",
                    patient?.urgent ? urgentBadge({ class: "ml-2" }) : null
                  ),
                  el("span", { class: "font-mono text-xs font-bold text-ha-blue" }, patient?.patientId || ""),
                  el("span", { class: "text-xs text-gray-600" },
                    [patient?.age && `${patient.age} years`, patient?.sex].filter(Boolean).join(" · ") || "No demographics yet"
                  )
                ),
                el("p", { class: "text-xs text-slate-600" },
                  "Latest diagnosis: ",
                  el("span", { class: "font-semibold text-slate-900" }, patient?.lastDiagnosis || "No diagnosis yet.")
                )
              ),
              (() => {
                const obs = (patient?.observations || []).slice(-1)[0] || {};
                const review = reviewState(obs, heartRateDraft);
                const stamp = cmsAssessmentStamp(obs.at);
                const tile = (label, value) => el("article", { class: "rounded border border-slate-200 bg-slate-50 px-2 py-1" },
                  el("p", { class: "text-[10px] text-gray-500" }, label),
                  el("p", { class: "text-sm font-bold leading-tight" }, value || "—")
                );
                return el("section", { class: "shrink-0 rounded border border-slate-200 bg-white px-2 py-1.5" },
                  review.level !== "none"
                    ? el("p", {
                        role: "status",
                        class: review.level === "urgent"
                          ? "mt-1 rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-900"
                          : "mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900",
                      },
                        el("strong", {}, review.title),
                        stamp ? ` · ${stamp}` : "",
                        " · ",
                        review.reasons.join("; "),
                        ". Record a new assessment."
                      )
                    : null,
                  el("div", { class: "mt-1 grid grid-cols-3 gap-1 sm:grid-cols-6" },
                    tile("Blood pressure", obs.sbp ? `${obs.sbp} mmHg` : "—"),
                    tile("Heart rate", obs.hr ? `${obs.hr} bpm` : (heartRateDraft || "—")),
                    tile("Respiratory rate", obs.rr ? `${obs.rr} breaths/min` : "—"),
                    tile("Oxygen saturation", obs.spo2 ? `${obs.spo2} %` : "—"),
                    tile("Temperature", obs.temp ? `${obs.temp} °C` : "—"),
                    tile("Lactate", obs.lactate ? `${obs.lactate} mmol/L` : "—")
                  )
                );
              })(),

              el("div", { class: "grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-hidden sm:grid-cols-2" },
              el("div", { class: "flex min-h-0 flex-col gap-2 overflow-auto" },
              (() => {
                const orders = medicineOrders(patient);
                const taken = String(medicinesDraft || "").trim();
                const showTaken = (edit && !taken) || (taken && !sameMedicineList(taken, orders));
                return el("section", { class: "shrink-0 rounded border border-gray-200 bg-white p-3" },
                  el("h2", { class: "text-sm font-bold text-slate-900" }, "Medicines"),
                  el("div", { class: "mt-2 space-y-2" },
                    showTaken ? el("div", {},
                      el("h3", { class: "text-xs font-bold text-slate-500" }, "Taken before"),
                      edit
                        ? el("textarea", {
                            id: "patient-medicines",
                            class: "input mt-1 h-14 resize-none text-sm",
                            rows: 2,
                            placeholder: "Medicines the patient was already taking…",
                            onInput: (e) => { medicinesDraft = e.target.value; },
                          }, medicinesDraft)
                        : el("p", { class: "mt-1 text-sm leading-5" }, taken)
                    ) : null,
                    el("div", {},
                      el("h3", { class: "text-xs font-bold text-slate-500" }, "Given in hospital"),
                      orders.length
                        ? el("ul", { class: "mt-1 space-y-0.5 text-sm leading-5" },
                            ...orders.map((row) => {
                              const detail = [row.route, freqLabel(row.frequency), row.prescribedBy].filter(Boolean).join(" · ");
                              return el("li", {},
                                el("span", { class: "font-semibold text-slate-900" }, [row.drug || row.name, row.dose].filter(Boolean).join(" · ")),
                                detail ? el("span", { class: "text-slate-600" }, " · ", detail) : null
                              );
                            })
                          )
                        : el("p", { class: "mt-1 text-sm text-slate-500" }, "No hospital medicines recorded.")
                    )
                  )
                );
              })(),
                el("section", { class: "flex min-h-[6rem] flex-1 flex-col overflow-hidden rounded border border-gray-200 bg-white p-3" },
                  el("h2", { class: "shrink-0 text-sm font-bold text-slate-900" }, "Clinical history"),
                  edit
                    ? el("textarea", {
                        id: "patient-history",
                        class: "input mt-2 min-h-0 flex-1 resize-none text-sm",
                        rows: 3,
                        placeholder: "Relevant history for this patient…",
                        onInput: (e) => { historyDraft = e.target.value; },
                      }, historyDraft)
                    : el("p", { class: "mt-2 min-h-0 flex-1 overflow-auto text-sm leading-5" }, historyDraft || "No history recorded.")
                ),
                el("section", { class: "shrink-0 rounded border border-gray-200 bg-white p-3" },
                  el("h2", { class: "text-sm font-bold text-slate-900" }, "Lab test results"),
                  edit
                    ? el("textarea", {
                        class: "input mt-2 h-14 resize-none text-sm",
                        rows: 2,
                        placeholder: "Lab results…",
                        onInput: (e) => { labResultsDraft = e.target.value; },
                      }, labResultsDraft)
                    : el("p", { class: "mt-1 text-sm leading-5" }, labResultsDraft || "No lab results recorded.")
                ),
                edit ? el("label", { class: "flex shrink-0 items-center gap-2 rounded border border-gray-200 bg-white px-3 py-2 text-sm" },
                  el("span", { class: "shrink-0 font-bold text-slate-900" }, "Heart rate"),
                  el("input", {
                    class: "input",
                    placeholder: "e.g. 78 bpm",
                    value: heartRateDraft,
                    onInput: (e) => { heartRateDraft = e.target.value; },
                  })
                ) : null,
                el("section", { class: "shrink-0 rounded border border-gray-200 bg-white p-3" },
                  el("h2", { class: "text-sm font-bold text-slate-900" }, "Remarks"),
                  edit
                    ? el("textarea", {
                        id: "patient-remarks",
                        class: "input mt-2 h-14 resize-none text-sm",
                        rows: 2,
                        placeholder: "Chart notes. These are not written into a report.",
                        onInput: (e) => { remarksDraft = e.target.value; },
                      }, remarksDraft)
                    : el("p", { id: "patient-remarks", class: "mt-1 text-sm leading-5" }, remarksDraft || "No remarks have been added.")
                )
              ),

              el("div", { class: "flex min-h-0 flex-col gap-2 overflow-hidden" },
              !isTechnician(state.user) && el("section", { id: "patient-findings", class: "shrink-0 overflow-auto rounded border border-gray-200 bg-white p-3" },
                el("h2", { class: "text-sm font-bold text-slate-900" }, "Findings"),
                endorsed.length === 0
                  ? el("p", { class: "mt-1 text-sm text-slate-400" }, "Findings appear here after a radiologist endorses a report.")
                  : el("div", { class: "mt-2 space-y-2" }, ...endorsed.map(chartFindingsBlock))
              ),

              (() => {
                const notes = (patient?.careNotes || []).slice().reverse();
                if (!notes.length) return null;
                const shown = allCareNotes ? notes : notes.slice(0, CARE_NOTES_SHOWN);
                return el("section", { id: "patient-care-notes", class: "flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-gray-200 bg-white p-3" },
                  el("div", { class: "flex shrink-0 items-baseline justify-between gap-2" },
                    el("h2", { class: "text-sm font-bold text-slate-900" }, `Care notes (${notes.length})`),
                    careNotesButton(patient, {
                      onSaved: chartSaved,
                      label: "Open Nursing / Care Notes",
                      className: "text-xs font-semibold text-ha-blue hover:underline",
                    })
                  ),
                  el("ul", { class: "mt-1 min-h-0 flex-1 divide-y divide-slate-100 overflow-auto" },
                    ...shown.map((row) => el("li", { class: "py-1.5 text-sm leading-5" },
                      el("p", { class: "text-slate-800" },
                        el("span", { class: "font-semibold" }, row.author || "—"),
                        row.role ? el("span", { class: "text-slate-500" }, ` · ${row.role}`) : null,
                        el("span", { class: "text-slate-500" }, " · ", [row.category, cmsAssessmentStamp(row.at)].filter(Boolean).join(" · "))
                      ),
                      el("p", { class: "text-slate-700" }, row.note || "—")
                    ))
                  ),
                  notes.length > CARE_NOTES_SHOWN && el("button", {
                    type: "button",
                    class: "mt-1 shrink-0 text-left text-xs font-semibold text-ha-blue hover:underline",
                    onClick: () => { allCareNotes = !allCareNotes; paint(); },
                  }, allCareNotes ? "Show latest only" : `Show all ${notes.length} notes`)
                );
              })(),

              booking && canRequestExam(state.user) && el("div", {
                class: "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4",
                role: "dialog",
                "aria-modal": "true",
                "aria-label": "Book chest X-ray",
                onClick: (e) => { if (e.target === e.currentTarget) { booking = false; paint(); } },
              },
              bookingDialog()),
              cases.some((c) => c.status === "requested") && el("section", { class: "shrink-0 overflow-hidden rounded border border-gray-200 bg-white" },
                el("h2", { class: "border-b bg-gray-50 px-3 py-1.5 text-sm font-bold" }, "X-ray requests"),
                el("ul", { class: "divide-y text-sm" },
                  ...cases.filter((c) => c.status === "requested").map((c) => {
                    const due = c.scheduledAt && new Date(c.scheduledAt).getTime() <= Date.now();
                    return el("li", { class: "flex items-center justify-between gap-3 px-3 py-1.5" },
                      el("p", { class: "min-w-0 truncate" },
                        el("span", { class: "font-semibold" }, "Chest X-ray"),
                        el("span", { class: "text-slate-600" },
                          " · ",
                          c.scheduledAt ? `Booked for ${bookingWhen(c.scheduledAt)}` : (c.createdAt ? `Requested ${new Date(c.createdAt).toLocaleString()}` : "Requested"),
                          c.requestedByName ? ` · ${c.requestedByName}` : ""
                        )
                      ),
                      el("span", {
                        class: `shrink-0 rounded px-2 py-0.5 text-xs font-semibold ${due ? "bg-amber-100 text-amber-900" : "bg-sky-100 text-sky-900"}`,
                      }, due ? "Due · waiting for film" : "Booked · waiting for film")
                    );
                  })
                )
              ),
              el("section", { class: "shrink-0 overflow-hidden rounded border border-gray-200 bg-white" },
                el("h2", { class: "border-b bg-gray-50 px-3 py-1.5 text-sm font-bold" }, "Studies"),
                cases.filter((c) => c.status !== "requested").length === 0
                  ? el("p", { class: "px-3 py-2 text-sm text-slate-400" }, "No studies yet.")
                  : el("ul", { class: "divide-y" },
                      ...cases.filter((c) => c.status !== "requested").map((c) =>
                        el("li", {},
                          el("button", {
                            class: "flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm hover:bg-slate-50",
                            onClick: () => showCase(c.caseId),
                          },
                            el("span", { class: "shrink-0 font-mono text-xs text-slate-500" },
                              c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : "Study"
                            ),
                            el("span", { class: "min-w-0 flex-1 truncate font-semibold" },
                              c.caseId,
                              c.urgent ? urgentBadge({ class: "ml-2" }) : null,
                              el("span", { class: "font-normal text-slate-600" }, " · ", c.diagnosis || "No diagnosis")
                            ),
                            el("span", { class: "shrink-0 text-xs text-slate-500" }, statusLabel(c.status, c))
                          )
                        )
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
  pollChartFindings();
}
