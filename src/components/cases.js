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
import { urgentBadge, patientDisplayName } from "../lib/tags.js";
import { PAGE, searchField, statusChips, emptyState, pageHeading, sortWorklist } from "../lib/ui.js";

const STATUS_BADGE = {
  pending: "bg-amber-50 text-amber-700",
  completed: "bg-cyan-50 text-cyan-700",
  finalized: "bg-green-50 text-green-700",
};

function statusBadge(s) {
  return el(
    "span",
    { class: `rounded-full px-2 py-0.5 text-xs font-bold capitalize ${STATUS_BADGE[s] || "bg-slate-100 text-slate-700"}` },
    s || "—"
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

function openReview(caseId) {
  state.selectedCaseId = caseId;
  setPage("review");
}

export async function renderCasesPage({ target }) {
  let q = "";
  let status = "all";
  let urgentOnly = false;
  let cases = [];
  let loading = true;
  let error = "";
  let page = 1;
  const selected = new Set();
  const isAdmin = () => state.user?.role === "admin";
  const caseIdOf = (c) => c.caseId || c._id;

  function deleteSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} selected ${ids.length === 1 ? "case" : "cases"}? This cannot be undone.`)) return;
    api.deleteCases(ids)
      .then((data) => {
        selected.clear();
        toast(`Deleted ${data.deleted ?? ids.length} ${ids.length === 1 ? "case" : "cases"}.`);
        refresh();
      })
      .catch((err) => toast(err.message || "Could not delete the selected cases."));
  }

  async function refresh() {
    loading = true;
    error = "";
    render();
    try {
      const data = await api.listCases({ status: status === "all" ? "" : status, q });
      cases = sortWorklist(data.cases || []);
      if (urgentOnly) cases = cases.filter((c) => c.urgent);
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

  function setFilter(next, { urgent = false } = {}) {
    status = next;
    urgentOnly = urgent;
    page = 1;
    selected.clear();
    refresh();
  }

  function render() {
    const chipValue = urgentOnly ? "urgent" : status;
    const root = el(
      "main",
      { class: PAGE },
      pageHeading({
        title: "Cases",
        subtitle: "Urgent studies stay at the top. Press / to search.",
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
              class: "rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600",
              value: status,
              onChange: (e) => setFilter(e.target.value),
            },
              el("option", { value: "all" }, "All statuses"),
              el("option", { value: "pending" }, "Pending"),
              el("option", { value: "completed" }, "Completed"),
              el("option", { value: "finalized" }, "Finalized")
            ),
            isAdmin() && bulkDeleteButton({ count: selected.size, onClick: deleteSelected })
          ),
          statusChips({
            value: chipValue,
            extra: [{ id: "urgent", label: "Urgent" }],
            onChange: (id) => setFilter(id === "urgent" ? "all" : id, { urgent: id === "urgent" }),
          })
        ),
        error
          ? el("div", { class: "p-6 text-red-700" }, error)
          : loading
          ? el("div", { class: "p-10 text-center text-slate-400" }, "Loading cases…")
          : cases.length === 0
          ? emptyState({
              icon: "file-text",
              title: "No cases match this filter",
              hint: "Clear the search or add a new X-ray case.",
              actionLabel: state.user?.role !== "nurse" ? "New case" : null,
              onAction: () => setPage("new"),
            })
          : (() => {
              const paged = paginate(cases, page);
              page = paged.page;
              const pageIds = paged.items.map(caseIdOf);
              return el("div", {},
                el("div", { class: "overflow-x-auto" },
                  el("table", { class: "w-full min-w-[760px] text-left text-sm" },
                    el("thead", { class: "bg-slate-50 text-slate-600" },
                      el("tr", {},
                        isAdmin() ? headerCheckbox(pageIds, selected, (on) => { togglePage(selected, pageIds, on); render(); }) : null,
                        ["Case", "Patient", "Date", "Status", "Diagnosis", "Actions"].map((h) =>
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
                          el("td", { class: "max-w-md" }, c.diagnosis || el("em", { class: "text-slate-400" }, "—")),
                          el("td", { class: "whitespace-nowrap" },
                            el("button", {
                              class: "inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-cyan-700 hover:bg-cyan-50 text-sm",
                              onClick: (e) => { e.stopPropagation(); openReview(caseIdOf(c)); },
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
                )
              ),
              el("div", { class: "flex flex-wrap gap-2" },
                el("button", {
                  class: "inline-flex items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50",
                  onClick: () => openReview(id),
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
