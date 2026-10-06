// src/components/dashboard.js
// Case dashboard with search + status filter + click-through to review.

import { el, mount } from "../dom.js";
import { state, setPage, toast } from "../state.js";
import { api } from "../api.js";
import { needsAzureDiagnosis } from "../lib/diagnosis.js";
import { paginate, paginationBar } from "../lib/pagination.js";
import { toggleSelected, togglePage, rowCheckbox, headerCheckbox, bulkDeleteButton } from "../lib/bulkSelect.js";
import { urgentBadge, patientDisplayName, doctorInCharge } from "../lib/tags.js";
import { searchField, sortWorklist } from "../lib/ui.js";
import { statusLabel, statusBadgeClass, isGenerating, isAwaitingAi, caseStatus } from "../lib/caseStatus.js";
import { CASES_CHANGED } from "../lib/analysisJob.js";
import { forgetCases } from "../lib/records.js";
import { canUpload, canEditReport, isReferringDoctor, isAdmin as roleIsAdmin } from "../lib/roles.js";

let dashboardLive = null;

function newDashboardAbort() {
  return typeof AbortController === "function"
    ? new AbortController()
    : { abort() {}, signal: { aborted: false } };
}

function isAbortError(err) {
  return err?.name === "AbortError" || err?.code === 20;
}

export function stopDashboardWatch() {
  dashboardLive?.abort();
}

const diagnosisRequested = new Set();
const diagnosisPending = new Set();

function statusBadge(c) {
  return el(
    "span",
    { class: `rounded-full px-2 py-0.5 text-xs font-bold ${statusBadgeClass(c.status, c)}` },
    statusLabel(c.status, c)
  );
}

export async function renderDashboardPage({ target }) {
  dashboardLive?.abort();
  dashboardLive = newDashboardAbort();
  const { signal } = dashboardLive;

  // State scoped to this render call so we can re-fetch without leaking
  // listeners.
  let q = state.pendingFilter.q;
  let status = state.pendingFilter.status || "all";
  let urgentOnly = Boolean(state.pendingFilter.urgentOnly);
  let cases = [];
  let stats = null;
  let loading = true;
  let error = "";
  let online = null;
  let page = 1;
  const selected = new Set();
  const isAdmin = () => roleIsAdmin(state.user);
  const caseIdOf = (c) => c.caseId || c._id;

  async function refresh() {
    if (signal.aborted) return;
    loading = true; error = ""; render();
    try {
      const data = await api.listCases({ q }, { signal });
      if (signal.aborted) return;
      cases = sortWorklist(data.cases || []);
      state.cases = cases;
      startQueuedReports(cases);
      for (const id of [...selected]) {
        if (!cases.some((c) => caseIdOf(c) === id)) selected.delete(id);
      }
      try { stats = (await api.stats({ signal })).stats; } catch { stats = null; }
      if (signal.aborted) return;
      online = true;
      fillDiagnoses(cases);
    } catch (err) {
      if (signal.aborted || isAbortError(err)) return;
      error = err.message; online = false;
    } finally {
      if (signal.aborted) return;
      loading = false;
      render();
    }
  }

  window.addEventListener(CASES_CHANGED, () => refresh(), { signal });

  const autoStarted = new Set();
  function startQueuedReports(list) {
    if (!canEditReport(state.user)) return;
    for (const c of list || []) {
      const id = caseIdOf(c);
      if (!id || autoStarted.has(id) || !c.imageId || !isAwaitingAi(c)) continue;
      autoStarted.add(id);
      api.analyzeCase(id).catch(() => autoStarted.delete(id));
    }
  }

  async function fillDiagnoses(list) {
    if (!canEditReport(state.user)) return;
    const todo = (list || []).filter((c) => {
      const id = c.caseId || c._id;
      return id && !isGenerating(c) && needsAzureDiagnosis(c) && !diagnosisRequested.has(id);
    });
    await Promise.all(todo.slice(0, 6).map(async (c) => {
      if (signal.aborted) return;
      const id = c.caseId || c._id;
      diagnosisRequested.add(id);
      diagnosisPending.add(id);
      render();
      try {
        const data = await api.summariseDiagnosis(id);
        if (signal.aborted) return;
        const updated = data.case;
        if (updated) {
          cases = cases.map((row) =>
            (row.caseId === id || row._id === id) ? { ...row, ...updated } : row
          );
          const idx = state.cases.findIndex((row) => row.caseId === id || row._id === id);
          if (idx >= 0) state.cases[idx] = { ...state.cases[idx], ...updated };
        }
      } catch (err) {
        console.warn("[dashboard] Azure diagnosis skipped:", err.message);
      } finally {
        diagnosisPending.delete(id);
        render();
      }
    }));
  }

  function setFilter(next, { urgent = false } = {}) {
    status = next;
    urgentOnly = urgent;
    state.pendingFilter.status = next;
    state.pendingFilter.urgentOnly = urgent;
    page = 1;
    selected.clear();
    refresh();
  }

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

  function render() {
    const counts = {
      all: cases.length,
      requested: cases.filter((c) => caseStatus(c.status) === "requested").length,
      pending: cases.filter((c) => caseStatus(c.status) === "pending" || isGenerating(c)).length,
      pending_approve: cases.filter((c) => caseStatus(c.status) === "pending_approve").length,
      finalized: cases.filter((c) => caseStatus(c.status) === "finalized").length,
      urgent: cases.filter((c) => c.urgent).length,
    };
    const queueId = urgentOnly ? "urgent" : status;
    const visible = cases.filter((c) => {
      if (urgentOnly) return Boolean(c.urgent);
      if (status === "pending") return caseStatus(c.status) === "pending" || isGenerating(c);
      if (status === "pending_approve") return caseStatus(c.status) === "pending_approve";
      if (status === "finalized") return caseStatus(c.status) === "finalized";
      if (status === "requested") return caseStatus(c.status) === "requested";
      return true;
    });

    function diagnosisCell(c) {
      const id = c.caseId || c._id;
      if (isGenerating(c)) {
        return el("em", { class: "text-slate-400" }, "Generating…");
      }
      if (diagnosisPending.has(id)) {
        return el("em", { class: "text-slate-400" }, "Summarising…");
      }
      if (c.diagnosis) return c.diagnosis;
      return el("em", { class: "text-slate-400" }, "—");
    }

    function row(c) {
      const id = caseIdOf(c);
      return el(
        "tr",
        {
          class: "cursor-pointer hover:bg-[#c5e0f5]",
          onClick: () => { state.selectedCaseId = id; setPage("case"); },
        },
        isAdmin() ? rowCheckbox(id, selected, (rowId, on) => { toggleSelected(selected, rowId, on); render(); }) : null,
        el("td", { class: "border border-[#b7d3ea] px-2 py-1 font-bold" },
          el("button", {
            class: "hover:text-ha-blue hover:underline",
            onClick: (e) => {
              e.stopPropagation();
              state.selectedPatientId = c.patientId;
              setPage("patient");
            },
          }, patientDisplayName(c) || c.patientId),
          patientDisplayName(c)
            ? el("div", { class: "text-xs font-normal text-slate-500 font-mono" }, c.patientId)
            : null
        ),
        el("td", { class: "border border-[#b7d3ea] px-2 py-1" }, "XRAY"),
        el("td", { class: "border border-[#b7d3ea] px-2 py-1 whitespace-nowrap" }, c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : ""),
        el("td", { class: "border border-[#b7d3ea] px-2 py-1" },
          el("div", {}, "Chest"),
          el("div", { class: "max-w-md text-[11px] opacity-80" }, diagnosisCell(c))
        ),
        el("td", { class: "border border-[#b7d3ea] px-2 py-1 font-semibold" }, c.urgent ? "U" : "R"),
        el("td", { class: "border border-[#b7d3ea] px-2 py-1 space-x-1" },
          statusBadge(c),
          c.urgent ? urgentBadge({ class: "ml-1" }) : null
        ),
        el("td", { class: "border border-[#b7d3ea] px-2 py-1" }, doctorInCharge(c)),
        el("td", { class: "border border-[#b7d3ea] px-2 py-1 space-x-1 whitespace-nowrap" },
          el("button", {
            class: "border border-gray-500 bg-[#ece9d8] px-2 py-0.5 text-[11px] hover:bg-white",
            onClick: (e) => { e.stopPropagation(); state.selectedCaseId = id; setPage("case"); },
          }, "View"),
          el("button", {
            class: "border border-gray-500 bg-[#ece9d8] px-2 py-0.5 text-[11px] hover:bg-white",
            onClick: (e) => {
              e.stopPropagation();
              if (caseStatus(c.status) === "requested") {
                if (canUpload(state.user)) {
                  state.pendingRequestId = id;
                  state.selectedPatientId = c.patientId;
                  setPage("new");
                } else {
                  toast("Waiting for the technician to register the film.");
                }
                return;
              }
              if (isGenerating(c)) {
                toast("The report is still generating.");
                return;
              }
              if (isAwaitingAi(c) && !canEditReport(state.user)) {
                toast("Waiting for the radiologist to run AI.");
                return;
              }
              state.selectedCaseId = id;
              setPage("review");
            },
          },
            caseStatus(c.status) === "requested" && canUpload(state.user)
              ? "Register"
              : isReferringDoctor(state.user)
                ? "Enquiry"
                : "Edit report")
        )
      );
    }

    const filtered = paginate(visible, page);
    page = filtered.page;
    const pageIds = filtered.items.map(caseIdOf);

    const queues = [
      ["all", "All work", counts.all],
      ["pending", "Outstanding", counts.pending],
      ["pending_approve", "Partially endorsed", counts.pending_approve],
      ["finalized", "Fully endorsed", counts.finalized],
      ["requested", "Requested", counts.requested],
      ["urgent", "Urgent attention", counts.urgent],
    ];
    const queueTitle = queues.find(([id]) => id === queueId)?.[1] || "All work";
    const root = el(
      "main",
      { class: "flex h-full min-h-[70vh] flex-col bg-[#d4d0c8] p-2" },
      el("div", { class: "flex h-full min-h-[70vh] flex-col border border-gray-500 bg-[#ece9d8] shadow-sm" },
        el("div", { class: "border-b border-gray-400 bg-[#d4d0c8] px-2 py-1 text-xs font-bold text-slate-900" },
          isReferringDoctor(state.user) ? "Examination enquiry" : "Radiologist Work List"
        ),
        online === false && el("p", { class: "bg-amber-100 px-2 py-1 text-xs text-amber-900" }, "Backend offline — showing cached data"),
        el("div", { class: "flex min-h-0 flex-1" },
          el("aside", { class: "w-44 shrink-0 border-r border-gray-400 bg-[#ece9d8] p-2 text-xs" },
            el("p", { class: "mb-2 font-bold text-slate-800" }, "My work"),
            ...queues.map(([id, label, n]) => el("button", {
              type: "button",
              class: `mb-1 w-full border px-2 py-1.5 text-left ${
                queueId === id
                  ? "border-gray-500 bg-[#d4d0c8] font-bold shadow-inner"
                  : "border-transparent bg-[#f4f1e4] hover:bg-white"
              }`,
              onClick: () => setFilter(id === "urgent" ? "all" : id, { urgent: id === "urgent" }),
            }, `${label}(${n})`))
          ),
          el("div", { class: "flex min-w-0 flex-1 flex-col border border-gray-400 bg-white m-1" },
            el("div", { class: "flex flex-wrap items-center justify-between gap-2 border-b border-gray-300 bg-[#f4f7fb] px-2 py-1" },
              el("div", {},
                el("h2", { class: "text-sm font-bold text-slate-900" }, `My work — ${queueTitle}`),
                el("p", { class: "text-[11px] text-slate-600" },
                  "Examination with report required",
                  el("span", { class: "ml-3 font-semibold text-red-700" }, "U = Urgent"),
                  el("span", { class: "ml-3" }, "Partially endorsed = draft report")
                )
              ),
              el("div", { class: "flex w-56 shrink-0 items-center gap-2" },
                searchField({
                  value: q,
                  placeholder: "Patient or diagnosis",
                  onQuery: (value) => { q = value; state.pendingFilter.q = value; },
                  onSearch: () => { page = 1; selected.clear(); refresh(); },
                }),
                isAdmin() && bulkDeleteButton({ count: selected.size, onClick: deleteSelected })
              )
            ),
            error
              ? el("div", { class: "p-4 text-sm text-red-700" }, error)
              : loading
              ? el("div", { class: "p-8 text-center text-sm text-slate-500" }, "Loading work list…")
              : filtered.total === 0
              ? el("p", { class: "p-6 text-sm text-slate-500" }, "No examinations in this list.")
              : el("div", { class: "flex min-h-0 flex-1 flex-col" },
                  el("div", { class: "overflow-auto" },
                    el("table", { class: "w-full min-w-[860px] border-collapse text-left text-xs" },
                      el("thead", { class: "bg-[#5b92c9] text-white" },
                        el("tr", {},
                          isAdmin() ? headerCheckbox(pageIds, selected, (on) => { togglePage(selected, pageIds, on); render(); }) : null,
                          ["Patient Name", "Mod.", "Reg. Date", "Procedure", "Ex. Pri.", "Status", "Uploaded by", ""].map((h) =>
                            el("th", { class: "border border-[#3d74ad] px-2 py-1 font-semibold" }, h)
                          )
                        )
                      ),
                      el("tbody", {}, ...filtered.items.map((c, i) => {
                        const node = row(c);
                        node.className = `${node.className || ""} ${i % 2 ? "bg-[#e7f3fb]" : "bg-white"} ${c.urgent ? "text-red-700" : "text-slate-900"}`;
                        return node;
                      }))
                    )
                  ),
                  el("div", { class: "mt-auto border-t border-gray-300 bg-[#f7f7f7] px-2 py-1 text-xs" },
                    paginationBar({ ...filtered, onPage: (n) => { page = n; render(); } })
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
