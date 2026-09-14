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
      cases = data.cases || [];
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

  function render() {
    const root = el(
      "main",
      { class: "mx-auto max-w-7xl px-5 py-8" },
      el("button", {
        class: "mb-4 inline-flex items-center gap-1 text-slate-700 hover:text-slate-900",
        onClick: () => setPage("dashboard"),
      }, svgIcon("arrow-left", { size: 16 }), "Dashboard"),
      el("div", {},
        el("h1", { class: "text-3xl font-bold text-slate-900" }, "Cases"),
        el("p", { class: "mt-1 text-slate-500" }, "Open a case to see history, diagnosis, findings, and remarks.")
      ),
      el("section", { class: "card mt-6 p-0 overflow-hidden" },
        el("div", { class: "flex flex-wrap gap-3 border-b p-4" },
          el("div", { class: "relative flex-1 min-w-[200px]" },
            svgIcon("search", { size: 16, class: "absolute left-3 top-3 text-slate-400" }),
            el("input", {
              class: "w-full rounded-xl border border-slate-300 bg-white pl-10 pr-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100",
              placeholder: "Search case, patient, diagnosis…",
              value: q,
              onInput: (e) => { q = e.target.value; },
              onChange: () => { page = 1; selected.clear(); refresh(); },
            })
          ),
          el("select", {
            class: "rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600",
            value: status,
            onChange: (e) => { status = e.target.value; page = 1; selected.clear(); refresh(); },
          },
            el("option", { value: "all" }, "All statuses"),
            el("option", { value: "pending" }, "Pending"),
            el("option", { value: "completed" }, "Completed"),
            el("option", { value: "finalized" }, "Finalized")
          ),
          isAdmin() && bulkDeleteButton({ count: selected.size, onClick: deleteSelected })
        ),
        error
          ? el("div", { class: "p-6 text-red-700" }, error)
          : loading
          ? el("div", { class: "p-10 text-center text-slate-400" }, "Loading cases…")
          : cases.length === 0
          ? el("div", { class: "p-10 text-center text-slate-400" }, "No cases match your filter.")
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
                        ["Case", "Patient", "Date", "Status", "Diagnosis"].map((h) =>
                          el("th", { class: "p-4" }, h)
                        )
                      )
                    ),
                    el("tbody", {},
                      ...paged.items.map((c) =>
                        el("tr", {
                          class: "border-t cursor-pointer hover:bg-slate-50",
                          onClick: () => openCase(caseIdOf(c)),
                        },
                          isAdmin() ? rowCheckbox(caseIdOf(c), selected, (id, on) => { toggleSelected(selected, id, on); render(); }) : null,
                          el("td", { class: "p-4 font-bold text-slate-900" }, caseIdOf(c)),
                          el("td", {},
                            el("button", {
                              class: "hover:text-cyan-700 hover:underline",
                              onClick: (e) => {
                                e.stopPropagation();
                                openPatient(c.patientId);
                              },
                            }, c.patientId)
                          ),
                          el("td", { class: "text-slate-600" },
                            c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : "—"
                          ),
                          el("td", {}, statusBadge(c.status)),
                          el("td", { class: "max-w-md" }, c.diagnosis || el("em", { class: "text-slate-400" }, "—"))
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

  async function saveRemarks() {
    if (!localCase || !canRemark()) return;
    busy = true;
    paint();
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
      toast(stored.status === "finalized"
        ? "Remarks saved. The finalized report was not changed."
        : "Remarks saved and added to the report.");
    } catch (err) {
      toast(err.message || "Could not save remarks.");
    } finally {
      busy = false;
      paint();
    }
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
                el("p", { class: "mt-1 text-slate-600" },
                  el("button", {
                    class: "font-semibold hover:text-cyan-700 hover:underline",
                    onClick: () => openPatient(localCase.patientId),
                  }, localCase.patientId),
                  " · ",
                  localCase.age || "?", " years · ",
                  localCase.sex || "?",
                  " · ",
                  statusBadge(localCase.status)
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
                    onInput: (e) => { remarksDraft = e.target.value; },
                  }, remarksDraft)
                : el("p", {
                    id: "case-remarks",
                    class: "mt-3 whitespace-pre-wrap text-sm text-slate-700",
                  }, remarksDraft || "No remarks have been added."),
              el("p", { class: "mt-2 text-xs text-slate-500" },
                localCase.status === "finalized"
                  ? "This case is finalized. Remarks are saved as notes only and are not written into the report."
                  : "Saving adds these remarks to the stored report."
              )
            )
          )
    );
    mount(target, root);
  }

  paint();
}
