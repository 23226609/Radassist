// src/components/cases.js
// Case list and a case record: history, diagnosis, findings, remarks.

import { el, mount } from "../dom.js";
import { state, setPage, toast } from "../state.js";
import { api } from "../api.js";
import { svgIcon } from "./icons.js";
import { unwrapLegacyReport } from "./review.js";
import { applyRemarksToReport, splitReportAndRemarks } from "../lib/reportExport.js";
import { paginate, paginationBar, fitPageSize, PAGE_SIZE } from "../lib/pagination.js";
import { toggleSelected, togglePage, rowCheckbox, headerCheckbox, bulkDeleteButton } from "../lib/bulkSelect.js";
import { urgentBadge, patientDisplayName, doctorInCharge, isDoctorInCharge, doctorFilterKey, doctorsInChargeOptions } from "../lib/tags.js";
import { searchField, emptyState, sortByRegistered, dateSortHeader, registeredDate, bookingWhen, debounce } from "../lib/ui.js";
import { statusLabel, statusBadgeClass, isGenerating, caseStatus } from "../lib/caseStatus.js";
import { canUpload, canEditReport, isAdmin as roleIsAdmin } from "../lib/roles.js";
import { CASES_CHANGED } from "../lib/analysisJob.js";
import { forgetCases } from "../lib/records.js";

function statusBadge(s, c) {
  const label = statusLabel(s, c) || "—";
  return el(
    "span",
    { class: `inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold ${statusBadgeClass(s, c)}` },
    label === "Pending approve" ? "Pending" : label
  );
}

export async function renderRequestedPage({ target }) {
  let rows = [];
  let error = "";
  let page = 1;
  let pageSize = PAGE_SIZE;

  if (target._stopRequestWatch) target._stopRequestWatch();
  const watch = new AbortController();
  target._stopRequestWatch = () => watch.abort();
  window.addEventListener("resize", debounce(() => {
    if (target.isConnected !== false) paint();
  }, 150), { signal: watch.signal });

  async function load() {
    const data = await api.listCases({ status: "requested" });
    const when = (c) => new Date(c.scheduledAt || c.createdAt || 0).getTime() || 0;
    rows = (data.cases || []).slice().sort((a, b) => when(a) - when(b));
  }
  function paint() {
    const paged = paginate(rows, page, pageSize);
    page = paged.page;
    const cell = "border border-[#b7d3ea] px-1.5 py-1";
    let body;
    if (error) body = el("div", { class: "p-4 text-sm text-red-700" }, error);
    else if (!rows.length) {
      body = emptyState({
        icon: "file-text",
        title: "No open X-ray requests",
        hint: "When a doctor requests a chest X-ray, it appears here.",
      });
    } else {
      body = el("div", { class: "flex min-h-0 flex-1 flex-col" },
        el("div", { class: "min-h-0 flex-1 overflow-x-hidden overflow-y-auto", "data-fit-rows": "" },
          el("table", { class: "w-full table-fixed border-collapse text-left text-xs" },
            el("colgroup", {},
              el("col", { style: { width: "28%" } }),
              el("col", { style: { width: "22%" } }),
              el("col"),
              el("col", { style: { width: "7.5rem" } })
            ),
            el("thead", { class: "bg-ha-paper text-stone-900" },
              el("tr", {}, ["Patient", "Requested by", "Booked for", ""].map((h) =>
                el("th", { class: "border border-[#d9d3bc] px-1.5 py-1 font-semibold" }, h)
              ))
            ),
            el("tbody", {}, ...paged.items.map((row, i) => el("tr", {
              class: `${i % 2 ? "bg-[#e7f3fb]" : "bg-white"} ${row.urgent ? "text-red-700" : ""}`,
            },
              el("td", { class: cell },
                el("span", { class: "flex min-w-0 items-center gap-1" },
                  el("span", { class: "truncate font-semibold", title: patientDisplayName(row) || row.patientId }, patientDisplayName(row) || row.patientId),
                  row.urgent ? urgentBadge({ class: "shrink-0" }) : null
                ),
                el("span", { class: "block truncate font-mono text-[11px] text-slate-500" }, row.patientId)
              ),
              el("td", { class: cell },
                el("span", { class: "block truncate", title: row.requestedByName || row.createdByName || "" }, row.requestedByName || row.createdByName || "—")
              ),
              el("td", { class: cell },
                row.scheduledAt
                  ? el("span", { class: "font-semibold" }, bookingWhen(row.scheduledAt))
                  : el("span", { class: "text-slate-500" }, row.createdAt ? `Requested ${new Date(row.createdAt).toLocaleString()}` : "—")
              ),
              el("td", { class: `${cell} text-right` },
                el("button", {
                  type: "button",
                  class: "border border-gray-500 bg-[#ece9d8] px-2 py-0.5 text-[11px] font-semibold hover:bg-white",
                  onClick: () => {
                    state.pendingRequestId = row.caseId || row._id;
                    state.selectedPatientId = row.patientId;
                    setPage("new");
                  },
                }, "Register film")
              )
            )))
          )
        ),
        el("div", { class: "mt-auto border-t border-gray-300 bg-[#f7f7f7] px-2 py-1 text-xs" },
          paginationBar({ ...paged, onPage: (n) => { page = n; paint(); } })
        )
      );
    }
    const root = el("main", { class: "flex h-full min-h-0 flex-col bg-[#d4d0c8] p-2" },
      el("div", { class: "flex h-full min-h-0 flex-col border border-gray-500 bg-[#ece9d8] shadow-sm" },
        el("div", { class: "border-b border-gray-400 bg-[#d4d0c8] px-2 py-1 text-xs font-bold text-slate-900" }, "Requested case"),
        el("div", { class: "m-1 flex min-h-0 flex-1 flex-col border border-gray-400 bg-white" },
          el("div", { class: "border-b border-gray-300 bg-[#f4f7fb] px-2 py-1" },
            el("h2", { class: "text-sm font-bold text-slate-900" }, "Requested case"),
            el("p", { class: "text-[11px] text-slate-600" }, "Chest X-ray requests from the ward. Register the film here. Reports stay with the radiologist.")
          ),
          body
        )
      )
    );
    mount(target, root);
    const fit = fitPageSize(root.querySelector("[data-fit-rows]"), pageSize);
    if (fit !== pageSize) {
      const first = (page - 1) * pageSize;
      pageSize = fit;
      page = Math.floor(first / fit) + 1;
      paint();
    }
  }
  try { await load(); }
  catch (err) { error = err.message || "Could not load requests."; }
  paint();
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
  let pageSize = PAGE_SIZE;
  let dateDir = "desc";
  const selected = new Set();
  const isAdmin = () => roleIsAdmin(state.user);
  const canFilterMine = () => canEditReport(state.user);
  const caseIdOf = (c) => c.caseId || c._id;

  if (target._stopCaseWatch) target._stopCaseWatch();
  const watch = new AbortController();
  target._stopCaseWatch = () => watch.abort();
  window.addEventListener(CASES_CHANGED, () => refresh(), { signal: watch.signal });
  window.addEventListener("resize", debounce(() => { if (target.isConnected !== false) render(); }, 150), { signal: watch.signal });

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
    let next = list.filter((c) => inQueue(c, status));
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
      const data = await api.listCases({ q });
      allCases = data.cases || [];
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

  function inQueue(c, id) {
    const s = caseStatus(c.status);
    if (id === "pending_approve") return s === "pending_approve" && !isGenerating(c);
    if (id === "finalized") return s === "finalized";
    if (id === "requested") return s === "requested";
    return true;
  }

  function render() {
    const queueId = mineOnly ? "mine" : urgentOnly ? "urgent" : status;
    const base = doctorFilter ? allCases.filter((c) => doctorFilterKey(c) === doctorFilter) : allCases;
    const queues = [
      ["all", "All", base.length],
      ["requested", "Requested", base.filter((c) => inQueue(c, "requested")).length],
      ["pending_approve", "Partially endorsed", base.filter((c) => inQueue(c, "pending_approve")).length],
      ["finalized", "Fully endorsed", base.filter((c) => inQueue(c, "finalized")).length],
      ["urgent", "Urgent", base.filter((c) => c.urgent).length],
      ...(canFilterMine() ? [["mine", "My cases", base.filter((c) => isDoctorInCharge(c, state.user)).length]] : []),
    ];
    const queueTitle = queues.find(([id]) => id === queueId)?.[1] || "All";
    const cell = "border border-[#b7d3ea] px-1.5 py-1";
    const smallBtn = "border border-gray-500 bg-[#ece9d8] px-2 py-0.5 text-[11px] hover:bg-white";

    function row(c, i) {
      const id = caseIdOf(c);
      return el("tr", {
        class: `cursor-pointer hover:bg-[#c5e0f5] ${i % 2 ? "bg-[#e7f3fb]" : "bg-white"} ${c.urgent ? "text-red-700" : "text-slate-900"}`,
        onClick: () => openCase(id),
      },
        isAdmin() ? rowCheckbox(id, selected, (rowId, on) => { toggleSelected(selected, rowId, on); render(); }) : null,
        el("td", { class: `${cell} font-mono font-semibold` },
          el("span", { class: "block truncate", title: id }, id)
        ),
        el("td", { class: `${cell} font-bold` },
          el("button", {
            class: "block w-full truncate text-left hover:text-ha-blue hover:underline",
            title: patientDisplayName(c) || c.patientId,
            onClick: (e) => { e.stopPropagation(); openPatient(c.patientId); },
          }, patientDisplayName(c) || c.patientId),
          patientDisplayName(c)
            ? el("div", { class: "truncate font-mono text-xs font-normal text-slate-500" }, c.patientId)
            : null
        ),
        el("td", { class: cell }, "XRAY"),
        el("td", { class: `${cell} whitespace-nowrap` }, registeredDate(c)),
        el("td", { class: cell },
          el("div", {}, "Chest"),
          el("div", { class: "truncate text-[11px] opacity-80", title: c.diagnosis || "" },
            isGenerating(c) ? el("em", { class: "text-slate-400" }, "Generating…")
              : c.diagnosis || el("em", { class: "text-slate-400" }, "—"))
        ),
        el("td", { class: `${cell} text-center font-semibold` }, c.urgent ? "U" : "R"),
        el("td", { class: `${cell} whitespace-nowrap` },
          statusBadge(c.status, c)
        ),
        el("td", { class: cell },
          el("span", { class: "block truncate", title: doctorInCharge(c) }, doctorInCharge(c))
        ),
        el("td", { class: cell },
          el("div", { class: "flex flex-nowrap items-center gap-1" },
            el("button", { class: `${smallBtn} shrink-0`, onClick: (e) => { e.stopPropagation(); openCase(id); } }, "View"),
            caseStatus(c.status) !== "requested" && el("button", {
              class: `${smallBtn} shrink-0`,
              onClick: (e) => { e.stopPropagation(); openReview(id, c); },
            }, "Review")
          )
        )
      );
    }

    let body;
    if (error) body = el("div", { class: "p-4 text-sm text-red-700" }, error);
    else if (loading) body = el("div", { class: "p-8 text-center text-sm text-slate-500" }, "Loading cases…");
    else if (cases.length === 0) {
      body = emptyState({
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
        actionLabel: canUpload(state.user) ? "New case" : null,
        onAction: () => setPage("new"),
      });
    } else {
      const paged = paginate(sortByRegistered(cases, dateDir), page, pageSize);
      page = paged.page;
      const pageIds = paged.items.map(caseIdOf);
      body = el("div", { class: "flex min-h-0 flex-1 flex-col" },
        el("div", { class: "min-h-0 flex-1 overflow-x-hidden overflow-y-auto", "data-fit-rows": "" },
          el("table", { class: "w-full table-fixed border-collapse text-left text-xs" },
            el("colgroup", {},
              isAdmin() ? el("col", { style: { width: "2rem" } }) : null,
              el("col", { style: { width: "13%" } }),
              el("col", { style: { width: "14%" } }),
              el("col", { style: { width: "3.25rem" } }),
              el("col", { style: { width: "6.75rem" } }),
              el("col"),
              el("col", { style: { width: "2.75rem" } }),
              el("col", { style: { width: "8.75rem" } }),
              el("col", { style: { width: "10%" } }),
              el("col", { style: { width: "8.5rem" } })
            ),
            el("thead", { class: "bg-ha-paper text-stone-900" },
              el("tr", {},
                isAdmin() ? headerCheckbox(pageIds, selected, (on) => { togglePage(selected, pageIds, on); render(); }) : null,
                ...[
                  "Case No.",
                  "Patient Name",
                  "Mod.",
                  dateSortHeader({
                    dir: dateDir,
                    onToggle: () => { dateDir = dateDir === "desc" ? "asc" : "desc"; page = 1; render(); },
                  }),
                  "Procedure",
                  "Pri.",
                  "Status",
                  "Doctor",
                  "",
                ].map((h) =>
                  el("th", { class: "border border-[#d9d3bc] px-1.5 py-1 font-semibold" }, h)
                )
              )
            ),
            el("tbody", {}, ...paged.items.map(row))
          )
        ),
        el("div", { class: "mt-auto border-t border-gray-300 bg-[#f7f7f7] px-2 py-1 text-xs" },
          paginationBar({ ...paged, onPage: (n) => { page = n; render(); } })
        )
      );
    }

    const root = el(
      "main",
      { class: "flex h-full min-h-0 flex-col bg-[#d4d0c8] p-2" },
      el("div", { class: "flex h-full min-h-0 flex-col border border-gray-500 bg-[#ece9d8] shadow-sm" },
        el("div", { class: "flex items-center justify-between gap-2 border-b border-gray-400 bg-[#d4d0c8] px-2 py-1 text-xs font-bold text-slate-900" },
          el("span", {}, "Case archive"),
          canUpload(state.user) && el("button", {
            type: "button",
            class: smallBtn,
            onClick: () => setPage("new"),
          }, "New case")
        ),
        el("div", { class: "flex min-h-0 flex-1" },
          el("aside", { class: "w-36 shrink-0 border-r border-gray-400 bg-[#ece9d8] p-2 text-xs", role: "tablist", "aria-label": "Case queues" },
            el("p", { class: "mb-2 font-bold text-slate-800" }, "Archive"),
            ...queues.map(([id, label, n]) => el("button", {
              type: "button",
              role: "tab",
              id: id === "mine" ? "filter-my-cases" : undefined,
              "aria-selected": queueId === id ? "true" : "false",
              class: `mb-1 flex w-full justify-between border px-2 py-1.5 text-left ${
                queueId === id
                  ? "border-gray-500 bg-[#d4d0c8] font-bold shadow-inner"
                  : "border-transparent bg-[#f4f1e4] hover:bg-white"
              }`,
              onClick: () => {
                if (id === "urgent") setFilter("all", { urgent: true });
                else if (id === "mine") setFilter("all", { mine: true });
                else setFilter(id);
              },
            }, el("span", {}, label), el("span", { class: "text-slate-500" }, `(${n})`)))
          ),
          el("div", { class: "m-1 flex min-w-0 flex-1 flex-col border border-gray-400 bg-white" },
            el("div", { class: "flex flex-wrap items-center justify-between gap-2 border-b border-gray-300 bg-[#f4f7fb] px-2 py-1" },
              el("div", {},
                el("h2", { class: "text-sm font-bold text-slate-900" }, `Case archive — ${queueTitle}`),
                el("p", { class: "text-[11px] text-slate-600" },
                  "Every stored study — case, film and report",
                  el("span", { class: "ml-3 font-semibold text-red-700" }, "U = Urgent"),
                  el("span", { class: "ml-3" }, "The worklist is the daily queue")
                )
              ),
              el("div", { class: "flex shrink-0 flex-wrap items-center gap-2" },
                el("select", {
                  id: "filter-doctor",
                  class: "rounded border border-slate-300 bg-white px-2 py-1.5 text-xs outline-none focus:border-ha-blue",
                  value: doctorFilter,
                  "aria-label": "Doctor in charge",
                  onChange: (e) => setDoctorFilter(e.target.value),
                },
                  el("option", { value: "" }, "All doctors"),
                  ...doctorsInChargeOptions(allCases).map(([key, label]) => el("option", { value: key }, label))
                ),
                el("div", { class: "w-56" },
                  searchField({
                    value: q,
                    placeholder: "Case, patient or diagnosis",
                    onQuery: (value) => { q = value; },
                    onSearch: () => { page = 1; selected.clear(); refresh(); },
                  })
                ),
                isAdmin() && bulkDeleteButton({ count: selected.size, onClick: deleteSelected })
              )
            ),
            body
          )
        )
      )
    );
    mount(target, root);
    const fit = fitPageSize(root.querySelector("[data-fit-rows]"), pageSize);
    if (fit !== pageSize) {
      const first = (page - 1) * pageSize;
      pageSize = fit;
      page = Math.floor(first / fit) + 1;
      render();
    }
  }

  await refresh();
}

export async function renderCasePage({ target }) {
  const caseId = state.selectedCaseId;
  let localCase = null;
  let error = "";
  let busy = false;
  let remarksDraft = "";

  const canRemark = () => canEditReport(state.user);
  const isAdmin = () => roleIsAdmin(state.user);

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

  let persistChain = Promise.resolve();

  async function saveRemarks({ silent } = {}) {
    if (!localCase || !canRemark()) return;
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
                    class: "font-semibold hover:text-ha-blue hover:underline",
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
                    onInput: (e) => { remarksDraft = e.target.value; },
                  }, remarksDraft)
                : el("p", {
                    id: "case-remarks",
                    class: "mt-3 whitespace-pre-wrap text-sm text-slate-700",
                  }, remarksDraft || "No remarks have been added."),
              el("p", { class: "mt-2 text-xs text-slate-500" },
                localCase.status === "finalized"
                  ? "This case is finalized. Remarks are saved as notes only and are not written into the report."
                  : "Press Save remarks to write these notes. Typing does not save by itself."
              )
            )
          )
    );
    mount(target, root);
  }

  paint();
}
