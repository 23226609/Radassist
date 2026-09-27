// Admin-only user list: enable or disable accounts.

import { el, mount } from "../dom.js";
import { state, toast } from "../state.js";
import { api } from "../api.js";
import { PAGE, searchField, emptyState, pageHeading } from "../lib/ui.js";

export async function renderUsersPage({ target }) {
  let q = "";
  let users = [];
  let loading = true;
  let error = "";
  let busyId = "";

  async function refresh() {
    loading = true;
    error = "";
    render();
    try {
      const data = await api.listUsers({ q });
      users = data.users || [];
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
      render();
    }
  }

  async function toggle(user) {
    if (user.userId === state.user?.userId) {
      toast("You cannot disable your own account.");
      return;
    }
    const next = user.isActive === false;
    const label = next ? "enable" : "disable";
    if (!confirm(`${next ? "Enable" : "Disable"} ${user.name || user.username}?`)) return;
    busyId = user.userId;
    render();
    try {
      await api.setUserActive(user.userId, next);
      toast(`${user.username} ${next ? "enabled" : "disabled"}.`);
      await refresh();
    } catch (err) {
      toast(err.message || `Could not ${label} this user.`);
      busyId = "";
      render();
    }
  }

  function render() {
    if (state.user?.role !== "admin") {
      mount(target, el("main", { class: PAGE },
        el("p", { class: "text-slate-600" }, "Only administrators can manage users.")
      ));
      return;
    }
    const root = el("main", { class: PAGE },
      pageHeading({
        title: "Users",
        subtitle: "Enable or disable accounts. A disabled user cannot sign in.",
      }),
      el("section", { class: "card mt-6 overflow-hidden p-0" },
        el("div", { class: "border-b p-4" },
          searchField({
            value: q,
            placeholder: "Search name, username, or email…",
            onQuery: (value) => { q = value; },
            onSearch: refresh,
          })
        ),
        error
          ? el("div", { class: "p-6 text-red-700" }, error)
          : loading
          ? el("div", { class: "p-10 text-center text-slate-400" }, "Loading users…")
          : users.length === 0
          ? emptyState({ title: "No users found", hint: "Try a different search." })
          : el("table", { class: "w-full text-left text-sm" },
              el("thead", { class: "bg-slate-50 text-xs uppercase text-slate-500" },
                el("tr", {},
                  el("th", { class: "px-4 py-3" }, "Name"),
                  el("th", { class: "px-4 py-3" }, "Username"),
                  el("th", { class: "px-4 py-3" }, "Role"),
                  el("th", { class: "px-4 py-3" }, "Status"),
                  el("th", { class: "px-4 py-3 text-right" }, "")
                )
              ),
              el("tbody", {},
                ...users.map((u) =>
                  el("tr", { class: "border-t" },
                    el("td", { class: "px-4 py-3 font-semibold text-slate-900" }, u.name || "—"),
                    el("td", { class: "px-4 py-3 font-mono text-xs text-slate-600" }, u.username || ""),
                    el("td", { class: "px-4 py-3 capitalize text-slate-700" }, u.role || ""),
                    el("td", { class: "px-4 py-3" },
                      u.isActive === false
                        ? el("span", { class: "rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600" }, "Disabled")
                        : el("span", { class: "rounded-full bg-green-50 px-2 py-0.5 text-xs font-semibold text-green-700" }, "Active")
                    ),
                    el("td", { class: "px-4 py-3 text-right" },
                      u.userId === state.user?.userId
                        ? el("span", { class: "text-xs text-slate-400" }, "You")
                        : el("button", {
                            class: u.isActive === false
                              ? "rounded-xl bg-ha-blue px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#074f85] disabled:opacity-50"
                              : "rounded-xl border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50",
                            disabled: busyId === u.userId,
                            onClick: () => toggle(u),
                          }, u.isActive === false ? "Enable" : "Disable")
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
