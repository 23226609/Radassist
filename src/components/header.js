// App chrome: hamburger + slide-out menu on every screen size, so the
// worklist and film can use the full width until someone opens the nav.

import { el } from "../dom.js";
import { state, setPage } from "../state.js";
import { svgIcon } from "./icons.js";
import { bindListHotkeys } from "../lib/ui.js";

function closeDrawer() {
  document.getElementById("app-drawer")?.classList.add("hidden");
  document.getElementById("app-scrim")?.classList.add("hidden");
  document.getElementById("app-menu-button")?.setAttribute("aria-expanded", "false");
}

function openDrawer() {
  document.getElementById("app-drawer")?.classList.remove("hidden");
  document.getElementById("app-scrim")?.classList.remove("hidden");
  document.getElementById("app-menu-button")?.setAttribute("aria-expanded", "true");
}

function go(page) {
  closeDrawer();
  setPage(page);
}

function isActive(item) {
  const page = state.page;
  if (item.page === "new" || item.page === "new-patient") return page === item.page;
  if (item.page === "dashboard") return page === "dashboard" || page === "review";
  if (item.page === "patients") return page === "patients" || page === "patient";
  if (item.page === "cases") return page === "cases" || page === "case";
  return page === item.page;
}

function navButton(item) {
  const active = isActive(item);
  return el("button", {
    class: `flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
      active
        ? "bg-cyan-500 text-white shadow-sm"
        : "text-slate-300 hover:bg-white/10 hover:text-white"
    }`,
    onClick: () => go(item.page),
  }, svgIcon(item.icon, { size: 18 }), item.label);
}

function sidebar({ onLogout }) {
  const nurse = state.user?.role === "nurse";
  const primary = [
    { page: "dashboard", icon: "activity", label: "Worklist" },
    { page: "patients", icon: "users", label: "Patients" },
    { page: "cases", icon: "file-text", label: "Case archive" },
    { page: "audit", icon: "list", label: "Audit log" },
  ];
  const create = nurse ? [] : [
    { page: "new", icon: "plus", label: "New case" },
    { page: "new-patient", icon: "user-plus", label: "New patient" },
  ];

  return el("div", { class: "flex h-full flex-col" },
    el("button", {
      class: "flex items-center gap-2 px-4 py-5 text-left font-bold text-white",
      onClick: () => go("dashboard"),
    },
      el("span", { class: "inline-flex items-center justify-center rounded-lg bg-cyan-500 p-1.5" },
        svgIcon("activity", { size: 18 })
      ),
      el("span", {},
        "RadAssist AI",
        el("span", { class: "mt-0.5 block text-xs font-medium text-slate-400" }, "Chest X-ray reporting")
      )
    ),
    el("nav", { class: "flex-1 space-y-1 px-3" },
      ...primary.map(navButton),
      create.length
        ? el("div", { class: "pt-4" },
            el("p", { class: "px-3 pb-2 text-[11px] font-bold uppercase tracking-wider text-slate-500" }, "Create"),
            el("div", { class: "space-y-1" }, ...create.map(navButton))
          )
        : null
    ),
    el("div", { class: "border-t border-white/10 p-3" },
      el("div", { class: "mb-3 flex items-center gap-2 px-1" },
        el("span", { class: "inline-flex h-9 w-9 items-center justify-center rounded-full bg-cyan-500 text-sm font-bold text-white" },
          (state.user?.name || "?").charAt(0).toUpperCase()
        ),
        el("div", { class: "min-w-0 leading-tight" },
          el("div", { class: "truncate font-semibold text-white" }, state.user?.name || ""),
          el("div", { class: "text-xs capitalize text-slate-400" }, state.user?.role || "")
        )
      ),
      el("button", {
        class: "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-slate-300 hover:bg-white/10 hover:text-white",
        onClick: onLogout,
      }, svgIcon("log-out", { size: 16 }), "Logout")
    )
  );
}

const TITLES = {
  dashboard: "Worklist",
  patients: "Patients",
  patient: "Patient chart",
  "new-patient": "New patient",
  cases: "Case archive",
  case: "Case",
  new: "New case",
  review: "Report review",
  audit: "Audit log",
};

export function Shell({ onLogout }) {
  bindListHotkeys();
  const main = el("div", { class: "min-w-0 flex-1" });
  const root = el("div", { class: "flex min-h-screen bg-slate-50 text-slate-900" },
    el("div", {
      id: "app-scrim",
      class: "fixed inset-0 z-40 hidden bg-slate-950/50",
      onClick: closeDrawer,
    }),
    el("aside", {
      id: "app-drawer",
      class: "fixed inset-y-0 left-0 z-50 hidden w-64 bg-slate-950 shadow-2xl",
      "aria-label": "Main menu",
    }, sidebar({ onLogout })),
    el("div", { class: "flex min-w-0 flex-1 flex-col" },
      el("header", { class: "sticky top-0 z-30 flex items-center gap-3 border-b bg-white/90 px-4 py-3 backdrop-blur" },
        el("button", {
          id: "app-menu-button",
          class: "rounded-lg p-2 text-slate-700 hover:bg-slate-100",
          "aria-label": "Open menu",
          "aria-expanded": "false",
          onClick: openDrawer,
        }, svgIcon("menu", { size: 20 })),
        el("div", { class: "font-bold text-slate-900" }, TITLES[state.page] || "RadAssist AI")
      ),
      main
    )
  );
  return { root, main };
}

export function Header({ onLogout }) {
  return Shell({ onLogout }).root;
}
