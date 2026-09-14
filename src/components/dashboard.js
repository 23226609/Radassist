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

const diagnosisRequested = new Set();
const diagnosisPending = new Set();

const STATUS_BADGE = {
  pending:    "bg-amber-50 text-amber-700",
  completed:  "bg-cyan-50 text-cyan-700",
  finalized:  "bg-green-50 text-green-700",
};

function statusBadge(s) {
  return el(
    "span",
    { class: `rounded-full px-2 py-0.5 text-xs font-bold capitalize ${STATUS_BADGE[s] || "bg-slate-100 text-slate-700"}` },
    s
  );
}

export async function renderDashboardPage({ target }) {
  // State scoped to this render call so we can re-fetch without leaking
  // listeners.
  let q = state.pendingFilter.q;
  let status = state.pendingFilter.status;
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
      const data = await api.listCases({ status: status === "all" ? "" : status, q });
      cases = data.cases || [];
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

  async function fillDiagnoses(list) {
    if (!["doctor", "admin"].includes(state.user?.role)) return;
    const todo = (list || []).filter((c) => {
      const id = c.caseId || c._id;
      return id && needsAzureDiagnosis(c) && !diagnosisRequested.has(id);
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

  function render() {
    const totalFinalized = stats?.finalizedCases ?? cases.filter((c) => c.status === "finalized").length;
    const totalPending = stats?.pendingCases ?? cases.filter((c) => c.status === "pending").length;
    const totalCases = stats?.totalCases ?? cases.length;

    function metric(n, label, tone) {
      return el("div", { class: "card" },
        el("p", { class: "text-slate-500 text-sm" }, label),
        el("b", { class: "text-3xl text-slate-900 mt-1 block" }, String(n)),
        tone ? el("div", { class: `mt-2 h-1 rounded ${tone}` }) : null,
      );
    }

    function diagnosisCell(c) {
      const id = c.caseId || c._id;
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
          class: "border-t cursor-pointer hover:bg-slate-50",
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
          }, svgIcon("eye", { size: 16 }), "View")
        )
      );
    }

    const filtered = paginate(cases, page);
    page = filtered.page;
    const pageIds = filtered.items.map(caseIdOf);

    const root = el(
      "main",
      { class: "mx-auto max-w-7xl px-5 py-8" },

      // Top header
      el("div", { class: "flex justify-between items-center gap-3 flex-wrap" },
        el("div", {},
          el("h1", { class: "text-3xl font-bold text-slate-900" }, "Case dashboard"),
          el("p", { class: "text-slate-500 mt-1" }, "Manage reporting progress across all patients.")
        ),
        el("div", { class: "flex gap-2" },
          el("button", {
            class: "inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50",
            onClick: () => setPage("patients"),
          }, svgIcon("users", { size: 16 }), "Patients"),
          el("button", {
            class: "inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50",
            onClick: () => setPage("cases"),
          }, svgIcon("file-text", { size: 16 }), "Cases"),
          el("button", {
            class: "inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50",
            onClick: () => setPage("audit"),
          }, svgIcon("list", { size: 16 }), "Audit log"),
          state.user?.role !== "nurse"
            ? el("button", {
                class: "inline-flex items-center gap-2 rounded-xl bg-cyan-600 px-4 py-2 font-semibold text-white hover:bg-cyan-700",
                onClick: () => setPage("new"),
              }, svgIcon("plus", { size: 16 }), "New case")
            : null
        )
      ),

      online === false && el("div", { class: "mt-4" },
        el("span", { class: "inline-block rounded-full bg-amber-50 text-amber-700 px-3 py-1 text-xs font-bold" },
          "Backend offline — show cached data")
      ),

      // Metric tiles
      el("div", { class: "mt-6 grid gap-4 sm:grid-cols-3" },
        metric(totalCases, "Total cases", "bg-cyan-600"),
        metric(totalFinalized, "Finalized", "bg-green-600"),
        metric(totalPending, "Pending review", "bg-amber-500"),
      ),

      // Filter / search
      el("section", { class: "card mt-6 p-0 overflow-hidden" },
        el("div", { class: "flex gap-3 border-b p-4 flex-wrap" },
          el("div", { class: "relative flex-1 min-w-[200px]" },
            svgIcon("search", { size: 16, class: "absolute left-3 top-3 text-slate-400" }),
            el("input", {
              class: "w-full rounded-xl border border-slate-300 bg-white pl-10 pr-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100",
              placeholder: "Search Patient ID, case, diagnosis…",
              value: q,
              onInput: (e) => { q = e.target.value; state.pendingFilter.q = q; },
              onChange: () => { page = 1; selected.clear(); refresh(); },
            })
          ),
          el("div", { class: "flex items-center gap-2" },
            svgIcon("filter", { size: 16, class: "text-slate-500" }),
            el("select", {
              class: "rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600",
              value: status,
              onChange: (e) => { status = e.target.value; state.pendingFilter.status = status; page = 1; selected.clear(); refresh(); },
            },
              el("option", { value: "all" }, "All statuses"),
              el("option", { value: "pending" }, "Pending"),
              el("option", { value: "completed" }, "Completed"),
              el("option", { value: "finalized" }, "Finalized")
            )
          ),
          isAdmin() && bulkDeleteButton({ count: selected.size, onClick: deleteSelected })
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
          ? el("div", { class: "p-10 text-center text-slate-400" }, "No cases match your filter.")
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
