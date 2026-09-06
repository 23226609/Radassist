// src/components/audit.js
// Admin/doctor-only audit log page with simple filtering.

import { el, mount } from "../dom.js";
import { state, setPage } from "../state.js";
import { api } from "../api.js";
import { svgIcon } from "./icons.js";

const ACTION_TONE = {
  LOGIN: "bg-cyan-50 text-cyan-700",
  LOGOUT: "bg-slate-100 text-slate-700",
  REGISTER: "bg-cyan-50 text-cyan-700",
  AI_ANALYZED: "bg-purple-50 text-purple-700",
  CASE_CREATED: "bg-cyan-50 text-cyan-700",
  CASE_UPDATED: "bg-amber-50 text-amber-700",
  CASE_FINALIZED: "bg-green-50 text-green-700",
  CASE_DELETED: "bg-red-50 text-red-700",
};

export async function renderAuditPage({ target }) {
  let logs = [];
  let q = "";
  let action = "";
  let loading = true;
  let error = "";

  async function refresh() {
    loading = true; error = ""; render();
    try {
      const data = await api.listAudit({ q, action });
      logs = data.logs || [];
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
      render();
    }
  }

  function row(l) {
    return el("tr", { class: "border-t" },
      el("td", { class: "p-3 whitespace-nowrap text-slate-700" },
        new Date(l.timestamp).toLocaleString()
      ),
      el("td", { class: "p-3" },
        el("span", {
          class: `inline-block rounded-full px-2 py-0.5 text-xs font-bold ${ACTION_TONE[l.action] || "bg-slate-100 text-slate-700"}`,
        }, l.action)
      ),
      el("td", { class: "p-3 font-mono text-xs text-slate-500" }, l.userId),
      el("td", { class: "p-3" }, l.details || ""),
      el("td", { class: "p-3 text-xs font-mono text-slate-500" }, l.affectedCaseId || ""),
      l.oldValue != null || l.newValue != null
        ? el("td", { class: "p-3 text-xs" },
            l.oldValue ? el("span", { class: "rounded bg-red-50 text-red-700 px-1.5 py-0.5 mr-1" }, l.oldValue) : null,
            " → ",
            l.newValue ? el("span", { class: "rounded bg-green-50 text-green-700 px-1.5 py-0.5" }, l.newValue) : null,
          )
        : el("td", { class: "p-3 text-xs text-slate-400" }, "—")
    );
  }

  function render() {
    const root = el(
      "main",
      { class: "mx-auto max-w-7xl px-5 py-8" },
      el("button", {
        class: "mb-4 inline-flex items-center gap-1 text-slate-700 hover:text-slate-900",
        onClick: () => setPage("dashboard"),
      }, svgIcon("arrow-left", { size: 16 }), "Dashboard"),
      el("h1", { class: "text-3xl font-bold text-slate-900" }, "Audit log"),
      el("p", { class: "text-slate-500 mt-1" },
        "Tamper-evident trail of logins, case edits, AI generations and finalizations. ",
        state.user?.role === "admin" ? "Admins see everything." : "Doctors see case activity."
      ),

      el("section", { class: "card mt-6 p-0 overflow-hidden" },
        el("div", { class: "flex gap-3 border-b p-4 flex-wrap" },
          el("div", { class: "relative flex-1 min-w-[200px]" },
            svgIcon("search", { size: 16, class: "absolute left-3 top-3 text-slate-400" }),
            el("input", {
              class: "w-full rounded-xl border border-slate-300 bg-white pl-10 pr-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100",
              placeholder: "Search details, action, user, case id…",
              value: q,
              onInput: (e) => (q = e.target.value),
              onChange: refresh,
            })
          ),
          el("select", {
            class: "rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600",
            value: action,
            onChange: (e) => { action = e.target.value; refresh(); },
          },
            el("option", { value: "" }, "All actions"),
            ...Object.keys(ACTION_TONE).map((a) => el("option", { value: a }, a))
          )
        ),

        error
          ? el("p", { class: "p-6 text-red-700" }, error)
          : loading
          ? el("p", { class: "p-10 text-center text-slate-400" }, "Loading…")
          : logs.length === 0
          ? el("p", { class: "p-10 text-center text-slate-400" }, "No matching log entries.")
          : el("div", { class: "overflow-x-auto" },
              el("table", { class: "w-full min-w-[820px] text-left text-sm" },
                el("thead", { class: "bg-slate-50 text-slate-600" },
                  el("tr", {},
                    ["Time", "Action", "User", "Details", "Case", "Change"].map((h) => el("th", { class: "p-3" }, h))
                  )
                ),
                el("tbody", {}, ...logs.map(row))
              )
            )
      )
    );
    mount(target, root);
  }

  await refresh();
}
