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
  let saving = false;
  let created = null;
  const form = { name: "", email: "", role: "doctor" };

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

  async function addUser() {
    if (!form.name.trim() || !form.email.trim()) {
      toast("Enter a name and an email.");
      return;
    }
    saving = true;
    render();
    try {
      const data = await api.createUser({
        name: form.name.trim(),
        email: form.email.trim(),
        role: form.role,
      });
      created = {
        email: data.user?.email || form.email.trim(),
        username: data.user?.username || "",
        temporaryPassword: data.temporaryPassword || "",
      };
      form.name = "";
      form.email = "";
      saving = false;
      toast("Account created. Copy the temporary password now.");
      await refresh();
    } catch (err) {
      toast(err.message || "Could not add this user.");
      saving = false;
      render();
    }
  }

  async function remove(user) {
    if (user.userId === state.user?.userId) {
      toast("You cannot delete your own account.");
      return;
    }
    if (!confirm(`Delete ${user.name || user.username}? They will not be able to sign in.`)) return;
    busyId = user.userId;
    render();
    try {
      await api.deleteUser(user.userId);
      toast(`${user.username} deleted.`);
      await refresh();
    } catch (err) {
      toast(err.message || "Could not delete this user.");
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
        subtitle: "Add an account by email, or disable and delete one. A disabled user cannot sign in.",
      }),
      el("section", { class: "card mt-6 p-4" },
        el("h2", { class: "text-sm font-bold text-slate-900" }, "Add user"),
        el("p", { class: "mt-1 text-xs text-slate-500" }, "The account is created for this email. This demo does not send the password by email, so copy it once and give it to them."),
        el("div", { class: "mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_10rem_auto]" },
          el("input", {
            class: "rounded-xl border border-slate-300 px-3 py-2",
            placeholder: "Full name",
            value: form.name,
            onInput: (e) => { form.name = e.target.value; },
          }),
          el("input", {
            class: "rounded-xl border border-slate-300 px-3 py-2",
            placeholder: "Email",
            type: "email",
            value: form.email,
            onInput: (e) => { form.email = e.target.value; },
          }),
          el("select", {
            class: "rounded-xl border border-slate-300 bg-white px-3 py-2",
            onChange: (e) => { form.role = e.target.value; },
          },
            ...["doctor", "radiologist", "technician", "admin"].map((role) =>
              el("option", { value: role, selected: form.role === role }, role)
            )
          ),
          el("button", {
            class: "rounded-xl bg-ha-blue px-4 py-2 text-sm font-semibold text-white hover:bg-[#074f85] disabled:opacity-50",
            disabled: saving,
            onClick: addUser,
          }, saving ? "Adding…" : "Add user")
        ),
        created && el("p", { class: "mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-950" },
          `Username ${created.username} · ${created.email}. Temporary password: `,
          el("strong", { class: "font-mono" }, created.temporaryPassword)
        )
      ),
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
                        : el("span", { class: "inline-flex gap-2" },
                            el("button", {
                              class: u.isActive === false
                                ? "rounded-xl bg-ha-blue px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#074f85] disabled:opacity-50"
                                : "rounded-xl border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50",
                              disabled: busyId === u.userId,
                              onClick: () => toggle(u),
                            }, u.isActive === false ? "Enable" : "Disable"),
                            el("button", {
                              class: "rounded-xl border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50",
                              disabled: busyId === u.userId,
                              onClick: () => remove(u),
                            }, "Delete")
                          )
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
