// The patient's appointments page: their own booked chest X-rays, newest first. Read only. The server
// returns only this patient's own appointments, so nothing here can show anyone else's.

import { el, mount } from "../dom.js";
import { state } from "../state.js";
import { api } from "../api.js";
import { emptyState } from "../lib/ui.js";
import { reportTitle } from "../../shared/reportTags.js";

const STATUS_STYLE = {
  booked: "bg-blue-50 text-ha-blue",
  "checked in": "bg-amber-50 text-amber-800",
  completed: "bg-green-50 text-green-800",
};

export function renderMyAppointmentsPage({ target }) {
  let rows = [];
  let loading = true;
  let error = "";

  async function load() {
    try {
      const data = await api.listAppointments();
      rows = Array.isArray(data.appointments) ? data.appointments : [];
    } catch (err) {
      error = err.message || "Could not load your appointments.";
    } finally {
      loading = false;
      paint();
    }
  }

  function paint() {
    mount(target, el("div", { id: "my-appointments", class: "flex h-full min-h-0 w-full flex-col gap-2 overflow-y-auto px-1 py-1" },
      el("div", { class: "flex shrink-0 flex-wrap items-baseline gap-x-3" },
        el("h1", { class: "text-xl font-bold text-ha-blue" }, "My appointments"),
        state.user?.name ? el("p", { class: "text-slate-500" }, `Signed in as ${state.user.name}`) : null
      ),
      loading ? el("p", { class: "text-sm text-slate-500" }, "Loading…") : null,
      error ? el("p", { id: "my-appointments-error", class: "rounded-lg bg-red-50 p-3 text-sm text-red-700" }, error) : null,
      !loading && !error && !rows.length
        ? el("p", { id: "my-appointments-empty", class: "card !p-6 text-center text-sm text-slate-600" }, "No appointments yet.")
        : null,
      rows.length
        ? el("div", { id: "my-appointments-list", class: "card overflow-x-auto !p-0" },
          el("table", { class: "w-full text-left text-sm" },
            el("thead", { class: "border-b border-gray-300 bg-gray-100 text-xs uppercase tracking-wide text-slate-500" },
              el("tr", {}, ...["Date", "Time", "Exam", "Status"].map((h) => el("th", { class: "px-3 py-2 font-semibold" }, h)))),
            el("tbody", {}, ...rows.map((a) =>
              el("tr", { class: "border-b border-gray-200 last:border-0", dataset: { status: a.status } },
                el("td", { class: "px-3 py-2 font-semibold text-slate-900" }, a.date),
                el("td", { class: "px-3 py-2" }, a.time),
                el("td", { class: "px-3 py-2" }, reportTitle(a.view)),
                el("td", { class: "px-3 py-2" },
                  el("span", { class: `inline-block rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${STATUS_STYLE[a.status] || "bg-slate-100 text-slate-700"}` }, a.status))
              ))))
        )
        : null
    ));
  }

  paint();
  load();
}
