// src/components/login.js
// Login & Register screens (switch via state.page).

import { el } from "../dom.js";
import { state, setPage, toast } from "../state.js";
import { api, setSession } from "../api.js";
import { svgIcon } from "./icons.js";

const DEMO_USERS = [
  { role: "doctor", username: "doctor", password: "doctor123", label: "Doctor · Dr. Alex Wong" },
  { role: "nurse", username: "nurse", password: "nurse123", label: "Nurse · Jamie Lee" },
  { role: "admin", username: "admin", password: "admin123", label: "Admin · System Admin" },
];

export function renderLoginPage() {
  let emailVal = "doctor@demo.com";
  let passVal = "password";
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
      { class: "grid min-h-screen lg:grid-cols-2 bg-slate-50" },
      // Left brand panel — dark gradient
      el("section", {
        class: "hidden lg:flex flex-col justify-between p-12 text-white",
        style: { background: "linear-gradient(135deg, #020617 0%, #083344 50%, #0e7490 100%)" },
      },
        el("div", { class: "flex items-center gap-2 text-xl font-bold" },
          el("span", { class: "brand-dot inline-flex items-center justify-center rounded-lg p-1.5" },
            svgIcon("activity", { size: 18 })
          ),
          "RadAssist AI"
        ),
        el("div", {},
          el("h1", { class: "text-5xl font-bold leading-tight tracking-tight" },
            "Faster X-Ray reporting, with the clinician in control."
          ),
          el("p", { class: "mt-5 max-w-md text-slate-300" },
            "A clinician-reviewed frontend prototype with varied mock AI findings."
          )
        ),
        el("small", { class: "text-slate-400" }, "Final Year Project demonstration. Mock findings only.")
      ),

      // Right login card
      el("section", { class: "flex items-center justify-center p-7" },
        el("div", { class: "w-full max-w-md" },
          el("h2", { class: "text-3xl font-bold text-slate-900" }, "Welcome back"),
          el("p", { class: "mt-2 text-slate-500" }, "Sign in to access the reporting dashboard."),
          el("div", { class: "mt-8 space-y-5" },
            el("label", { class: "block" },
              el("span", { class: "mb-1 block text-sm font-semibold text-slate-700" }, "Email or username"),
              el("input", {
                type: "text",
                class: "input",
                placeholder: "doctor",
                value: emailVal,
                onInput: (e) => (emailVal = e.target.value),
              })
            ),
            el("label", { class: "block" },
              el("span", { class: "mb-1 block text-sm font-semibold text-slate-700" }, "Password"),
              el("input", {
                type: "password",
                class: "input",
                placeholder: "••••••••",
                value: passVal,
                onInput: (e) => (passVal = e.target.value),
              })
            ),
            error ? el("p", { class: "rounded-lg bg-red-50 p-3 text-sm text-red-700" }, error) : null,
            el("button", {
              type: "button",
              class: "btn w-full bg-cyan-600 text-white hover:bg-cyan-700",
              onClick: submit,
              disabled: busy,
            }, busy ? "Signing in…" : "Sign in")
          ),

          // Demo account quick login chips
          el("div", { class: "mt-6 rounded-xl bg-slate-100 p-4 text-xs" },
            el("p", { class: "mb-3 font-bold text-slate-700" }, "Demo accounts (click to sign in)"),
            el("div", { class: "space-y-2" },
              ...DEMO_USERS.map((u) =>
                el("button", {
                  class: "quick-login",
                  onClick: () => quickLogin(u),
                  disabled: busy,
                },
                  el("span", {
                    class: "mt-0.5 inline-block rounded-full bg-cyan-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-cyan-700",
                  }, u.role),
                  el("span", { class: "flex-1" },
                    el("span", { class: "block font-semibold text-slate-800" }, u.label),
                    el("span", { class: "block text-slate-400" },
                      `${u.username} / ${u.password}`
                    )
                  )
                )
              )
            )
          ),

          el("p", { class: "mt-5 text-center text-sm text-slate-600" },
            "Need an account? ",
            el("button", { class: "font-bold text-cyan-700 hover:underline", onClick: () => setPage("register") }, "Register")
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
      { class: "min-h-screen bg-slate-50 flex items-center justify-center p-7" },
      el("div", { class: "card w-full max-w-md" },
        el("h2", { class: "text-3xl font-bold text-slate-900" }, "Create an account"),
        el("p", { class: "mt-2 text-slate-500 text-sm" },
          "New accounts default to the 'doctor' role. Administrators are seeded only."
        ),
        el("div", { class: "mt-8 space-y-4" },
          field("Name", "name"),
          field("Username", "username"),
          field("Email", "email", "email"),
          field("Password (min. 6 chars)", "password", "password"),
          field("Department", "department"),
          error ? el("p", { class: "rounded-lg bg-red-50 p-3 text-sm text-red-700" }, error) : null,
          el("button", {
            class: "btn w-full bg-cyan-600 text-white hover:bg-cyan-700",
            onClick: submit,
            disabled: busy,
          }, svgIcon("user-plus", { size: 18 }), busy ? "Creating…" : "Create account")
        ),
        el("p", { class: "mt-5 text-center text-sm text-slate-600" },
          "Already have an account? ",
          el("button", { class: "font-bold text-cyan-700 hover:underline", onClick: () => setPage("login") }, "Sign in")
        )
      )
    );
    const target = document.getElementById("app");
    target.innerHTML = "";
    target.appendChild(root);
  }
  render();
}
