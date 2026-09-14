// src/components/dashboard.js
// Case dashboard with search + status filter + click-through to review.

import { el, mount } from "../dom.js";
import { state, setPage, toast } from "../state.js";
import { api } from "../api.js";
import { svgIcon } from "./icons.js";
import { needsAzureDiagnosis } from "../lib/diagnosis.js";
import { paginate, paginationBar } from "../lib/pagination.js";
import { toggleSelected, togglePage, rowCheckbox, headerCheckbox, bulkDeleteButton } from "../lib/bulkSelect.js";
import { urgentBadge, patientDisplayName } from "../lib/tags.js";
import { PAGE, searchField, statusChips, metricCard, emptyState, pageHeading, sortWorklist } from "../lib/ui.js";
import { statusLabel, statusBadgeClass, isGenerating, caseStatus } from "../lib/caseStatus.js";
import { CASES_CHANGED } from "../lib/analysisJob.js";
import { forgetCases } from "../lib/records.js";

const diagnosisRequested = new Set();
const diagnosisPending = new Set();

function statusBadge(s) {
  return el(
    "span",
    { class: `rounded-full px-2 py-0.5 text-xs font-bold ${statusBadgeClass(s)}` },
    statusLabel(s)
  );
}

export async function renderDashboardPage({ target }) {
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
  const isAdmin = () => state.user?.role === "admin";
  const caseIdOf = (c) => c.caseId || c._id;

  async function refresh() {
    loading = true; error = ""; render();
    try {
      const data = await api.listCases({ status: status === "all" || status === "urgent" ? "" : status, q });
      cases = sortWorklist(data.cases || []);
      if (urgentOnly) cases = cases.filter((c) => c.urgent);
      state.cases = cases;
      for (const id of [...selected]) {
        if (!cases.some((c) => caseIdOf(c) === id)) selected.delete(id);
      }
      try { stats = (await api.stats()).stats; } catch { stats = null; }
      online = true;
      fillDiagnoses(cases);
    } catch (err) {
      error = err.message; online = false;
    } finally {
      loading = false;
      render();
    }
  }

  if (target._stopCaseWatch) target._stopCaseWatch();
  const watch = new AbortController();
  target._stopCaseWatch = () => watch.abort();
  window.addEventListener(CASES_CHANGED, () => refresh(), { signal: watch.signal });

  async function fillDiagnoses(list) {
    if (!["doctor", "admin"].includes(state.user?.role)) return;
    const todo = (list || []).filter((c) => {
      const id = c.caseId || c._id;
      return id && !isGenerating(c) && needsAzureDiagnosis(c) && !diagnosisRequested.has(id);
    });
    await Promise.all(todo.slice(0, 6).map(async (c) => {
      const id = c.caseId || c._id;
      diagnosisRequested.add(id);
      diagnosisPending.add(id);
      render();
      try {
        const data = await api.summariseDiagnosis(id);
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
    const totalFinalized = stats?.finalizedCases ?? cases.filter((c) => caseStatus(c.status) === "finalized").length;
    const totalPending = stats?.pendingCases ?? cases.filter((c) => caseStatus(c.status) === "pending_approve").length;
    const totalCases = stats?.totalCases ?? cases.length;
    const totalUrgent = stats?.urgentCases ?? cases.filter((c) => c.urgent).length;
    const chipValue = urgentOnly ? "urgent" : status;

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
          class: "border-t cursor-pointer hover:bg-cyan-50/60",
          onClick: () => { state.selectedCaseId = id; setPage("case"); },
        },
        isAdmin() ? rowCheckbox(id, selected, (rowId, on) => { toggleSelected(selected, rowId, on); render(); }) : null,
        el("td", { class: "p-4 font-bold text-slate-900" },
          el("button", {
            class: "hover:text-cyan-700 hover:underline",
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
        el("td", { class: "text-slate-600" }, c.createdAt ? new Date(c.createdAt).toISOString().slice(0, 10) : ""),
        el("td", { class: "space-x-1" },
          statusBadge(c.status),
          c.urgent ? urgentBadge({ class: "ml-1" }) : null
        ),
        el("td", { class: "max-w-md" }, diagnosisCell(c)),
        el("td", { class: "space-x-1 whitespace-nowrap" },
          el("button", {
            class: "inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-cyan-700 hover:bg-cyan-50 text-sm",
            onClick: (e) => { e.stopPropagation(); state.selectedCaseId = id; setPage("case"); },
          }, svgIcon("eye", { size: 16 }), "View"),
          el("button", {
            class: "inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-slate-600 hover:bg-slate-100 text-sm",
            onClick: (e) => {
              e.stopPropagation();
              if (isGenerating(c)) {
                toast("The report is still generating.");
                return;
              }
              state.selectedCaseId = id;
              setPage("review");
            },
          }, svgIcon("image", { size: 16 }), "Review")
        )
      );
    }

    const filtered = paginate(cases, page);
    page = filtered.page;
    const pageIds = filtered.items.map(caseIdOf);

    const root = el(
      "main",
      { class: PAGE },

      pageHeading({
        title: "Worklist",
        subtitle: "Today’s reporting queue. Urgent stays at the top. Open Review for the film.",
        actions: state.user?.role !== "nurse"
          ? el("button", {
              class: "inline-flex items-center gap-2 rounded-xl bg-cyan-600 px-4 py-2 font-semibold text-white hover:bg-cyan-700",
              onClick: () => setPage("new"),
            }, svgIcon("plus", { size: 16 }), "New case")
          : null,
      }),

      online === false && el("div", { class: "mt-4" },
        el("span", { class: "inline-block rounded-full bg-amber-50 text-amber-700 px-3 py-1 text-xs font-bold" },
          "Backend offline — showing cached data")
      ),

      el("div", { class: "mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" },
        metricCard({
          n: totalCases, label: "Total cases", tone: "bg-cyan-600",
          active: status === "all" && !urgentOnly,
          onClick: () => setFilter("all"),
        }),
        metricCard({
          n: totalUrgent, label: "Urgent", tone: "bg-red-500",
          active: urgentOnly,
          onClick: () => setFilter("all", { urgent: true }),
        }),
        metricCard({
          n: totalFinalized, label: "Finalized", tone: "bg-green-600",
          active: status === "finalized" && !urgentOnly,
          onClick: () => setFilter("finalized"),
        }),
        metricCard({
          n: totalPending, label: "Pending approve", tone: "bg-amber-500",
          active: status === "pending_approve" && !urgentOnly,
          onClick: () => setFilter("pending_approve"),
        }),
      ),

      el("section", { class: "card mt-6 p-0 overflow-hidden" },
        el("div", { class: "flex flex-col gap-3 border-b p-4" },
          el("div", { class: "flex flex-wrap items-center gap-3" },
            searchField({
              value: q,
              placeholder: "Search Patient ID, case, diagnosis…",
              onQuery: (value) => { q = value; state.pendingFilter.q = value; },
              onSearch: () => { page = 1; selected.clear(); refresh(); },
            }),
            el("select", {
              class: "rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600",
              value: status === "urgent" ? "all" : status,
              onChange: (e) => setFilter(e.target.value),
            },
              el("option", { value: "all" }, "All statuses"),
              el("option", { value: "pending_approve" }, "Pending approve"),
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

        // Table
        error
          ? el("div", { class: "p-6 text-red-700" },
              el("p", { class: "font-bold" }, "Failed to load cases"),
              el("p", { class: "text-sm mt-1" }, error),
            )
          : loading
          ? el("div", { class: "p-10 text-center text-slate-400" }, "Loading cases…")
          : filtered.total === 0
          ? emptyState({
              icon: "file-text",
              title: "No cases match this filter",
              hint: "Try another status, or add a new X-ray case.",
              actionLabel: state.user?.role !== "nurse" ? "New case" : null,
              onAction: () => setPage("new"),
            })
          : el("div", {},
              el("div", { class: "overflow-x-auto" },
                el("table", { class: "w-full min-w-[760px] text-left text-sm" },
                  el("thead", { class: "bg-slate-50 text-slate-600" },
                    el("tr", {},
                      isAdmin() ? headerCheckbox(pageIds, selected, (on) => { togglePage(selected, pageIds, on); render(); }) : null,
                      ["Patient ID", "Date", "Status", "Diagnosis", "Actions"].map((h) =>
                        el("th", { class: "p-4" }, h)
                      )
                    )
                  ),
                  el("tbody", {}, ...filtered.items.map(row))
                )
              ),
              paginationBar({ ...filtered, onPage: (n) => { page = n; render(); } })
            )
      )
    );

    mount(target, root);
  }

  await refresh();
}
