// src/components/login.js
// Login & Register screens (switch via state.page).

import { el } from "../dom.js";
import { state, setPage, toast } from "../state.js";
import { api, setSession } from "../api.js";
import { svgIcon } from "./icons.js";

const DEMO_USERS = [
  { role: "technician", username: "tech", password: "tech123", label: "Technician · Jamie Lee" },
  { role: "radiologist", username: "priya", password: "priya123", label: "Radiologist · Dr. Priya Nair" },
  { role: "doctor", username: "doctor", password: "doctor123", label: "Doctor · Dr. Alex Wong" },
  { role: "admin", username: "admin", password: "admin123", label: "Admin · System Admin" },
];

export function renderLoginPage() {
  let emailVal = "priya";
  let passVal = "priya123";
  let error = "";
  let busy = false;

  async function submit() {
    if (!emailVal.trim() || !passVal.trim()) {
      error = "Enter your email and password.";
      render();
      return;
    }
    busy = true; error = ""; render();
    try {
      const username = emailVal.includes("@") ? emailVal.split("@")[0].toLowerCase() : emailVal.toLowerCase();
      const data = await api.login(username, passVal);
      setSession({ token: data.token, user: data.user });
      toast(`Welcome back, ${data.user.name}`);
      // setPage triggers setState → subscribe(render) → dashboard mounts
      setPage("dashboard", { user: data.user, token: data.token });
    } catch (err) {
      error = err.message || "Login failed";
      render();
    } finally {
      busy = false;
    }
  }

  async function quickLogin(creds) {
    emailVal = creds.username;
    passVal = creds.password;
    render();
    await submit();
  }

  function render() {
    const root = el(
      "main",
      { class: "grid min-h-screen place-items-center bg-gradient-to-br from-slate-200 via-slate-100 to-blue-100 p-4" },
      el("div", { class: "grid w-full max-w-5xl overflow-hidden rounded-3xl border border-white/80 bg-white/90 shadow-[0_30px_90px_rgba(15,42,65,0.2)] backdrop-blur md:grid-cols-[1.05fr_0.95fr]" },
        el("section", { class: "relative hidden min-h-[620px] overflow-hidden bg-gradient-to-br from-[#003366] via-[#075985] to-[#0f766e] p-10 text-white md:flex md:flex-col md:justify-between" },
          el("div", { class: "absolute -right-20 -top-20 h-64 w-64 rounded-full border-[36px] border-white/10" }),
          el("div", { class: "absolute -bottom-24 -left-16 h-72 w-72 rounded-full bg-cyan-300/10" }),
          el("div", { class: "relative" },
            el("div", { class: "mb-12 flex items-center gap-3" },
              el("div", { class: "rounded-2xl bg-white/15 p-3 ring-1 ring-white/25" },
                svgIcon("activity", { size: 28 })
              ),
              el("div", {},
                el("p", { class: "text-lg font-bold tracking-wide" }, "RadAssist AI"),
                el("p", { class: "text-xs text-cyan-100" }, "HKBU CS · FYP")
              )
            ),
            el("p", { class: "mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-200" }, "Digital Front Door"),
            el("p", { class: "max-w-md text-sm leading-6 text-blue-100" },
              "Enter the radiology workspace to upload films, run AI, review findings, and read finalized reports."
            )
          ),
          el("div", { class: "relative grid gap-3 text-xs text-blue-50" },
            el("div", { class: "flex items-center gap-3 rounded-xl border border-white/15 bg-white/10 p-3" },
              "Classroom-only access with synthetic patient records"
            ),
            el("div", { class: "flex items-center gap-3 rounded-xl border border-white/15 bg-white/10 p-3" },
              "Technician upload, radiologist sign-off, doctor read of finalized reports"
            )
          )
        ),
        el("section", { class: "flex min-h-[620px] flex-col justify-center p-7 sm:p-12" },
          el("p", { class: "mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-ha-blue" }, "Secure workspace"),
          el("h2", { class: "mb-8 text-3xl font-semibold text-slate-900" }, "RadAssist AI"),
          el("div", { class: "space-y-4" },
            el("label", { class: "block" },
              el("span", { class: "mb-1.5 block text-xs font-semibold text-slate-700" }, "Email or username"),
              el("input", {
                type: "text",
                class: "w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-cyan-700 focus:ring-4 focus:ring-blue-100",
                placeholder: "priya",
                value: emailVal,
                onInput: (e) => (emailVal = e.target.value),
              })
            ),
            el("label", { class: "block" },
              el("span", { class: "mb-1.5 flex items-center justify-between text-xs font-semibold text-slate-700" },
                "Password",
                el("span", { class: "font-normal text-slate-400" }, "Demo account")
              ),
              el("input", {
                id: "login-password",
                type: "password",
                autocomplete: "current-password",
                class: "w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm outline-none transition focus:border-cyan-700 focus:ring-4 focus:ring-blue-100",
                placeholder: "••••••••",
                value: passVal,
                onInput: (e) => (passVal = e.target.value),
              })
            ),
            error ? el("p", { role: "alert", class: "rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700" }, error) : null,
            el("button", {
              type: "button",
              class: "flex w-full items-center justify-center gap-2 rounded-xl bg-ha-blue px-4 py-3 text-sm font-bold text-white shadow-lg shadow-blue-950/15 transition hover:bg-[#074f85] focus:outline-none focus:ring-4 focus:ring-blue-200 disabled:opacity-60",
              onClick: submit,
              disabled: busy,
            }, busy ? "Signing in…" : "Sign in")
          ),
          el("div", { class: "mt-6 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950" },
            el("p", { class: "font-bold" }, "Classroom demo credentials"),
            el("p", { class: "mt-1 leading-5 text-amber-800" }, "Click an account to sign in. Simulated authentication only."),
            el("div", { class: "mt-3 space-y-2" },
              ...DEMO_USERS.map((u) =>
                el("button", {
                  type: "button",
                  class: "quick-login",
                  onClick: () => quickLogin(u),
                  disabled: busy,
                },
                  el("span", { class: "mt-0.5 inline-block rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ha-blue" }, u.role),
                  el("span", { class: "flex-1" },
                    el("span", { class: "block font-semibold text-slate-800" }, u.label),
                    el("span", { class: "block font-mono text-slate-500" }, `${u.username} / ${u.password}`)
                  )
                )
              )
            )
          ),
          el("p", { class: "mt-5 text-center text-sm text-slate-600" },
            "Need an account? ",
            el("button", { class: "font-bold text-ha-blue hover:underline", onClick: () => setPage("register") }, "Register")
          )
        )
      )
    );
    const target = document.getElementById("app");
    target.innerHTML = "";
    target.appendChild(root);
  }
  render();
}

export function renderRegisterPage() {
  let f = { name: "", email: "", username: "", password: "", department: "Radiology" };
  let error = "";
  let busy = false;

  async function submit() {
    if (!f.name || !f.email || !f.password || !f.username) {
      error = "All fields are required."; return render();
    }
    busy = true; error = ""; render();
    try {
      const data = await api.register({
        username: f.username,
        email: f.email,
        password: f.password,
        name: f.name,
        department: f.department,
      });
      setSession({ token: data.token, user: data.user });
      state.user = data.user; state.token = data.token;
      state.page = "dashboard";
      toast(`Account created — welcome, ${data.user.name}!`);
      window.dispatchEvent(new CustomEvent("state-render"));
    } catch (err) {
      error = err.message || "Registration failed";
    } finally { busy = false; render(); }
  }

  function field(label, key, type = "text") {
    return el("label", { class: "block" },
      el("span", { class: "mb-1 block text-sm font-semibold text-slate-700" }, label),
      el("input", {
        type,
        class: "input",
        value: f[key],
        onInput: (e) => (f[key] = e.target.value),
      })
    );
  }

  function render() {
    const root = el(
      "main",
      { class: "min-h-screen bg-ha-bg flex items-center justify-center p-7" },
      el("div", { class: "card w-full max-w-md" },
        el("h2", { class: "text-3xl font-bold text-slate-900" }, "Create an account"),
        el("p", { class: "mt-2 text-slate-500 text-sm" },
          "New accounts default to the technician role. Radiologists, doctors, and administrators are seeded for the demo."
        ),
        el("div", { class: "mt-8 space-y-4" },
          field("Name", "name"),
          field("Username", "username"),
          field("Email", "email", "email"),
          field("Password (min. 6 chars)", "password", "password"),
          field("Department", "department"),
          error ? el("p", { class: "rounded-lg bg-red-50 p-3 text-sm text-red-700" }, error) : null,
          el("button", {
            class: "btn w-full bg-ha-blue text-white hover:bg-[#074f85]",
            onClick: submit,
            disabled: busy,
          }, svgIcon("user-plus", { size: 18 }), busy ? "Creating…" : "Create account")
        ),
        el("p", { class: "mt-5 text-center text-sm text-slate-600" },
          "Already have an account? ",
          el("button", { class: "font-bold text-ha-blue hover:underline", onClick: () => setPage("login") }, "Sign in")
        )
      )
    );
    const target = document.getElementById("app");
    target.innerHTML = "";
    target.appendChild(root);
  }
  render();
}
