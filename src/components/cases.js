// src/components/cases.js
// Case list and a case record: history, diagnosis, findings, remarks.

import { el, mount } from "../dom.js";
import { state, setPage, toast } from "../state.js";
import { api } from "../api.js";
import { svgIcon } from "./icons.js";
import { unwrapLegacyReport } from "./review.js";
import { applyRemarksToReport, splitReportAndRemarks } from "../lib/reportExport.js";
import { paginate, paginationBar } from "../lib/pagination.js";
import { toggleSelected, togglePage, rowCheckbox, headerCheckbox, bulkDeleteButton } from "../lib/bulkSelect.js";
import { urgentBadge, patientDisplayName, doctorInCharge, isDoctorInCharge, doctorFilterKey, doctorsInChargeOptions } from "../lib/tags.js";
import { PAGE, searchField, statusChips, emptyState, pageHeading, sortWorklist } from "../lib/ui.js";
import { statusLabel, statusBadgeClass, isGenerating } from "../lib/caseStatus.js";
import { CASES_CHANGED } from "../lib/analysisJob.js";
import { forgetCases } from "../lib/records.js";

function statusBadge(s) {
  return el(
    "span",
    { class: `rounded-full px-2 py-0.5 text-xs font-bold ${statusBadgeClass(s)}` },
    statusLabel(s) || "—"
  );
}

function openCase(caseId) {
  state.selectedCaseId = caseId;
  setPage("case");
}

function openPatient(patientId) {
  state.selectedPatientId = patientId;
  setPage("patient");
}

function openReview(caseId, c) {
  if (c && isGenerating(c)) {
    toast("The report is still generating.");
    return;
  }
  state.selectedCaseId = caseId;
  setPage("review");
}

export async function renderCasesPage({ target }) {
  let q = "";
  let status = "all";
  let urgentOnly = false;
  let mineOnly = false;
  let doctorFilter = "";
  let allCases = [];
  let cases = [];
  let loading = true;
  let error = "";
  let page = 1;
  const selected = new Set();
  const isAdmin = () => state.user?.role === "admin";
  const canFilterMine = () => state.user?.role === "doctor" || state.user?.role === "admin";
  const caseIdOf = (c) => c.caseId || c._id;

  if (target._stopCaseWatch) target._stopCaseWatch();
  const watch = new AbortController();
  target._stopCaseWatch = () => watch.abort();
  window.addEventListener(CASES_CHANGED, () => refresh(), { signal: watch.signal });

  function deleteSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} selected ${ids.length === 1 ? "case" : "cases"}? This cannot be undone.`)) return;
    api.deleteCases(ids)
      .then((data) => {
        selected.clear();
        forgetCases(data.ids || ids);
        toast(`Deleted ${data.deleted ?? ids.length} ${ids.length === 1 ? "case" : "cases"}.`);
        refresh();
      })
      .catch((err) => toast(err.message || "Could not delete the selected cases."));
  }

  function applyLocalFilters(list) {
    let next = list;
    if (urgentOnly) next = next.filter((c) => c.urgent);
    if (mineOnly) next = next.filter((c) => isDoctorInCharge(c, state.user));
    if (doctorFilter) next = next.filter((c) => doctorFilterKey(c) === doctorFilter);
    return next;
  }

  async function refresh() {
    loading = true;
    error = "";
    render();
    try {
      const data = await api.listCases({ status: status === "all" ? "" : status, q });
      allCases = sortWorklist(data.cases || []);
      cases = applyLocalFilters(allCases);
      for (const id of [...selected]) {
        if (!cases.some((c) => caseIdOf(c) === id)) selected.delete(id);
      }
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
      render();
    }
  }

  function setFilter(next, { urgent = false, mine = false } = {}) {
    status = next;
    urgentOnly = urgent;
    mineOnly = mine;
    if (mine) doctorFilter = "";
    page = 1;
    selected.clear();
    refresh();
  }

  function setDoctorFilter(value) {
    doctorFilter = value;
    if (mineOnly) mineOnly = false;
    page = 1;
    selected.clear();
    cases = applyLocalFilters(allCases);
    render();
  }

  function render() {
    const chipValue = mineOnly ? "mine" : urgentOnly ? "urgent" : status;
    const root = el(
      "main",
      { class: PAGE },
      pageHeading({
        title: "Case archive",
        subtitle: "Every stored study — case ID, film, and report. The worklist is the daily queue.",
        actions: state.user?.role !== "nurse"
          ? el("button", {
              class: "inline-flex items-center gap-2 rounded-xl bg-cyan-600 px-4 py-2 font-semibold text-white hover:bg-cyan-700",
              onClick: () => setPage("new"),
            }, svgIcon("plus", { size: 16 }), "New case")
          : null,
      }),
      el("section", { class: "card mt-6 p-0 overflow-hidden" },
        el("div", { class: "flex flex-col gap-3 border-b p-4" },
          el("div", { class: "flex flex-wrap gap-3" },
            searchField({
              value: q,
              placeholder: "Search case, patient, diagnosis…",
              onQuery: (value) => { q = value; },
              onSearch: () => { page = 1; selected.clear(); refresh(); },
            }),
            el("select", {
              id: "filter-doctor",
              class: "rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600",
              value: doctorFilter,
              "aria-label": "Doctor in charge",
              onChange: (e) => setDoctorFilter(e.target.value),
            },
              el("option", { value: "" }, "All doctors"),
              ...doctorsInChargeOptions(allCases).map(([key, label]) =>
                el("option", { value: key }, label)
              )
            ),
            isAdmin() && bulkDeleteButton({ count: selected.size, onClick: deleteSelected })
          ),
          statusChips({
            value: chipValue,
            extra: [
              { id: "urgent", label: "Urgent" },
              ...(canFilterMine() ? [{ id: "mine", label: "My cases", buttonId: "filter-my-cases" }] : []),
            ],
            onChange: (id) => {
              if (id === "urgent") setFilter("all", { urgent: true });
              else if (id === "mine") setFilter("all", { mine: true });
              else setFilter(id);
            },
          })
        ),
        error
          ? el("div", { class: "p-6 text-red-700" }, error)
          : loading
          ? el("div", { class: "p-10 text-center text-slate-400" }, "Loading cases…")
          : cases.length === 0
          ? emptyState({
              icon: "file-text",
              title: mineOnly
                ? "No cases of yours match this filter"
                : doctorFilter
                ? "No studies for this doctor"
                : "No studies in the archive",
              hint: mineOnly
                ? "Choose All to see the full archive, or add a new X-ray."
                : doctorFilter
                ? "Choose another doctor, or All doctors, to see more studies."
                : "Clear the search, or add a new X-ray from the worklist.",
              actionLabel: state.user?.role !== "nurse" ? "New case" : null,
              onAction: () => setPage("new"),
            })
          : (() => {
              const paged = paginate(cases, page);
              page = paged.page;
              const pageIds = paged.items.map(caseIdOf);
              return el("div", {},
                el("div", { class: "overflow-x-auto" },
                  el("table", { class: "w-full min-w-[900px] text-left text-sm" },
                    el("thead", { class: "bg-slate-50 text-slate-600" },
                      el("tr", {},
                        isAdmin() ? headerCheckbox(pageIds, selected, (on) => { togglePage(selected, pageIds, on); render(); }) : null,
                        ["Case", "Patient", "Date", "Status", "Doctor", "Diagnosis", "Actions"].map((h) =>
                          el("th", { class: "p-4" }, h)
                        )
                      )
                    ),
                    el("tbody", {},
                      ...paged.items.map((c) =>
                        el("tr", {
                          class: "border-t cursor-pointer hover:bg-cyan-50/60",
                          onClick: () => openCase(caseIdOf(c)),
                        },
                          isAdmin() ? rowCheckbox(caseIdOf(c), selected, (id, on) => { toggleSelected(selected, id, on); render(); }) : null,
                          el("td", { class: "p-4 font-bold text-slate-900" },
                            el("div", { class: "flex flex-wrap items-center gap-2" },
                              caseIdOf(c),
                              c.urgent ? urgentBadge() : null
                            )
                          ),
                          el("td", {},
                            el("button", {
                              class: "hover:text-cyan-700 hover:underline",
                              onClick: (e) => {
                                e.stopPropagation();
                                openPatient(c.patientId);
                              },
                            }, patientDisplayName(c) || c.patientId),
                            patientDisplayName(c)
                              ? el("div", { class: "text-xs font-mono text-slate-500" }, c.patientId)
                              : null
                          ),
                          el("td", { class: "text-slate-600" },
                            c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : "—"
                          ),
                          el("td", {}, statusBadge(c.status)),
                          el("td", { class: "text-slate-700" }, doctorInCharge(c)),
                          el("td", { class: "max-w-md" }, c.diagnosis || el("em", { class: "text-slate-400" }, "—")),
                          el("td", { class: "whitespace-nowrap" },
                            el("button", {
                              class: "inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-cyan-700 hover:bg-cyan-50 text-sm",
                              onClick: (e) => { e.stopPropagation(); openReview(caseIdOf(c), c); },
                            }, svgIcon("image", { size: 16 }), "Review")
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

export async function renderCasePage({ target }) {
  const caseId = state.selectedCaseId;
  let localCase = null;
  let error = "";
  let busy = false;
  let remarksDraft = "";

  const canRemark = () => state.user?.role !== "nurse";
  const isAdmin = () => state.user?.role === "admin";

  async function load() {
    if (!caseId) {
      error = "No case was selected.";
      return;
    }
    const data = await api.getCase(caseId);
    localCase = unwrapLegacyReport(data.case || data);
    const split = splitReportAndRemarks(localCase.reportText || "");
    remarksDraft = (localCase.remarks || "").trim() || split.remarks;
    error = "";
  }

  try {
    await load();
  } catch (err) {
    error = err.message || "Could not load this case.";
  }

  let saveTimer = null;
  let persistChain = Promise.resolve();

  function queueRemarksSync() {
    if (!localCase || !canRemark()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveRemarks({ silent: true }).catch(() => {});
    }, 450);
  }

  async function saveRemarks({ silent } = {}) {
    if (!localCase || !canRemark()) return;
    clearTimeout(saveTimer);
    const run = async () => {
      if (!silent) {
        busy = true;
        paint();
      }
      try {
        const data = await api.getCase(localCase.caseId || localCase._id);
        const stored = unwrapLegacyReport(data.case || data);
        const note = String(remarksDraft || "").trim();
        const next = stored.status === "finalized"
          ? { remarks: note }
          : applyRemarksToReport(stored.reportText, note);
        const updated = await api.updateCase(localCase.caseId || localCase._id, next);
        localCase = unwrapLegacyReport(updated.case || { ...localCase, ...next });
        remarksDraft = localCase.remarks || note;
        if (!silent) {
          toast(stored.status === "finalized"
            ? "Remarks saved. The finalized report was not changed."
            : "Remarks saved to MongoDB.");
        }
      } catch (err) {
        toast(err.message || "Could not save remarks.");
        if (silent) throw err;
      } finally {
        if (!silent) {
          busy = false;
          paint();
        }
      }
    };
    const pending = persistChain.then(run, run);
    persistChain = pending.catch(() => {});
    return pending;
  }

  async function deleteThis() {
    if (!localCase || !isAdmin()) return;
    const id = localCase.caseId || localCase._id;
    if (!confirm(`Delete case ${id} for ${localCase.patientId}?`)) return;
    busy = true;
    paint();
    try {
      await api.deleteCase(id);
      forgetCases([id]);
      toast(`Deleted ${id}`);
      setPage("cases");
    } catch (err) {
      toast(err.message || "Could not delete this case.");
      busy = false;
      paint();
    }
  }

  function paint() {
    const edit = canRemark();
    const findings = localCase?.findings || [];
    const id = localCase?.caseId || localCase?._id;

    const root = el(
      "main",
      { class: "mx-auto max-w-5xl px-5 py-8" },
      el("button", {
        class: "mb-4 inline-flex items-center gap-1 text-slate-700 hover:text-slate-900",
        onClick: () => setPage("cases"),
      }, svgIcon("arrow-left", { size: 16 }), "Cases"),

      error
        ? el("p", { class: "rounded-xl bg-red-50 p-4 text-red-700" }, error)
        : el("div", {},
            el("div", { class: "flex flex-wrap items-start justify-between gap-3" },
              el("div", {},
                el("h1", { class: "text-3xl font-bold text-slate-900" }, id || "Case"),
                el("p", { class: "mt-1 text-slate-600 flex flex-wrap items-center gap-2" },
                  el("button", {
                    class: "font-semibold hover:text-cyan-700 hover:underline",
                    onClick: () => openPatient(localCase.patientId),
                  }, patientDisplayName(localCase) || localCase.patientId),
                  patientDisplayName(localCase)
                    ? el("span", { class: "font-mono text-xs text-slate-500" }, localCase.patientId)
                    : null,
                  " · ",
                  localCase.age || "?", " years · ",
                  localCase.sex || "?",
                  " · ",
                  statusBadge(localCase.status),
                  localCase.urgent ? urgentBadge() : null
                ),
                el("p", { class: "mt-1 text-sm text-slate-500" },
                  "Doctor in charge: ",
                  el("span", { class: "font-semibold text-slate-700" }, doctorInCharge(localCase))
                )
              ),
              el("div", { class: "flex flex-wrap gap-2" },
                el("button", {
                  class: "inline-flex items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50",
                  onClick: () => openReview(id, localCase),
                }, svgIcon("eye", { size: 16 }), "Review X-ray"),
                isAdmin() && el("button", {
                  class: "inline-flex items-center gap-1 rounded-xl border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50",
                  disabled: busy,
                  onClick: deleteThis,
                }, svgIcon("trash", { size: 16 }), "Delete"),
                edit && el("button", {
                  class: "rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50",
                  disabled: busy,
                  onClick: saveRemarks,
                }, busy ? "Saving…" : "Save remarks")
              )
            ),

            el("div", { class: "mt-6 grid gap-5 lg:grid-cols-2" },
              el("section", { class: "card" },
                el("h2", { class: "text-lg font-bold text-slate-900" }, "Clinical history"),
                el("p", { class: "mt-3 whitespace-pre-wrap text-sm text-slate-700" },
                  localCase.history || "No history recorded for this study.")
              ),
              el("section", { class: "card" },
                el("h2", { class: "text-lg font-bold text-slate-900" }, "Diagnosis"),
                el("p", { class: "mt-3 text-lg font-semibold text-slate-900" },
                  localCase.diagnosis || el("span", { class: "font-normal text-slate-400" }, "No diagnosis yet."))
              )
            ),

            el("section", { class: "card mt-5" },
              el("h2", { class: "text-lg font-bold text-slate-900" }, "Findings"),
              findings.length === 0
                ? el("p", { class: "mt-3 text-slate-400" }, "No findings recorded for this case yet.")
                : el("ul", { class: "mt-3 divide-y divide-slate-100" },
                    ...findings.map((f) =>
                      el("li", { class: "py-3" },
                        el("div", { class: "font-semibold text-slate-900" }, f.label || "Finding"),
                        el("p", { class: "mt-1 text-sm text-slate-600" },
                          [f.location, f.pattern, f.sentence].filter(Boolean).join(" · ")
                        )
                      )
                    )
                  )
            ),

            el("section", { class: "card mt-5" },
              el("h2", { class: "text-lg font-bold text-slate-900" }, "Remarks"),
              edit
                ? el("textarea", {
                    id: "case-remarks",
                    class: "input mt-3 min-h-[140px]",
                    rows: 6,
                    placeholder: localCase.status === "finalized"
                      ? "Notes stay on this case. They are not added to the finalized report…"
                      : "Notes or extra findings to add to the report…",
                    onInput: (e) => { remarksDraft = e.target.value; queueRemarksSync(); },
                  }, remarksDraft)
                : el("p", {
                    id: "case-remarks",
                    class: "mt-3 whitespace-pre-wrap text-sm text-slate-700",
                  }, remarksDraft || "No remarks have been added."),
              el("p", { class: "mt-2 text-xs text-slate-500" },
                localCase.status === "finalized"
                  ? "This case is finalized. Remarks are saved as notes only and are not written into the report."
                  : "Saving writes these remarks into the MongoDB report."
              )
            )
          )
    );
    mount(target, root);
  }

  paint();
}
