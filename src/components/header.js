// Hospital CMS shell, modelled on the COMP4126 CMS simulator:
// navy title bar, permanent MODULES column, gray workspace, status footer.

import { el } from "../dom.js";
import { state, setPage } from "../state.js";
import { api } from "../api.js";
import { svgIcon } from "./icons.js";
import { bindListHotkeys } from "../lib/ui.js";
import { canUpload, canSeeAudit, isAdmin, isTechnician, roleOf } from "../lib/roles.js";

let requestCount = 0;
let requestPoll = null;

function paintRequestCount() {
  const slot = document.getElementById("request-count");
  if (!slot) return;
  const n = requestCount;
  slot.textContent = n > 0 ? String(n) : "";
  slot.classList.toggle("hidden", n < 1);
  slot.setAttribute("aria-label", n === 1 ? "1 open request" : `${n} open requests`);
}

function watchRequests() {
  if (!isTechnician(state.user)) return;
  const load = async () => {
    if (!isTechnician(state.user)) return;
    try {
      const data = await api.listCases({ status: "requested" });
      requestCount = (data.cases || []).length;
      paintRequestCount();
    } catch { /* leave the last count */ }
  };
  load();
  if (!requestPoll) requestPoll = setInterval(load, 60000);
}

function go(page) {
  setPage(page);
}

function isActive(item) {
  const page = state.page;
  if (item.page === "new" || item.page === "new-patient") return page === item.page;
  if (item.page === "dashboard") return page === "dashboard" || page === "review";
  if (item.page === "requests") return page === "requests" || page === "new";
  if (item.page === "patients") return page === "patients" || page === "patient";
  if (item.page === "cases") return page === "cases" || page === "case";
  if (item.page === "users") return page === "users";
  return page === item.page;
}

function navButton(item) {
  const active = isActive(item);
  return el("button", {
    type: "button",
    title: item.label,
    "aria-label": item.label,
    class: `flex w-full flex-col items-center justify-center gap-1 border-b border-gray-300 border-l-4 px-1 py-2 text-center text-sm transition-colors md:flex-row md:justify-start md:gap-2 md:px-3 md:text-left ${
      active
        ? "border-l-ha-blue bg-blue-100 font-semibold text-ha-blue"
        : "border-l-transparent text-gray-700 hover:bg-gray-300"
    }`,
    onClick: () => go(item.page),
  },
    el("span", { class: "shrink-0", "aria-hidden": "true" }, svgIcon(item.icon, { size: 16 })),
    el("span", { class: "text-[9px] leading-tight md:text-sm" }, item.label),
    item.page === "requests"
      ? el("span", {
          id: "request-count",
          class: requestCount > 0
            ? "ml-auto min-w-5 rounded-full bg-amber-600 px-1.5 text-center text-[10px] font-bold text-white"
            : "ml-auto hidden min-w-5 rounded-full bg-amber-600 px-1.5 text-center text-[10px] font-bold text-white",
        }, requestCount > 0 ? String(requestCount) : "")
      : null
  );
}

function deptCode(user) {
  const role = roleOf(user);
  if (role === "admin") return "IT";
  if (role === "doctor") return "MED";
  return "RAD";
}

function sidebar() {
  const index = [
    { page: "patients", icon: "users", label: "Patient Master" },
  ];
  const ward = [
    { page: "monitor", icon: "activity", label: "Sepsis Monitor" },
    ...(isTechnician(state.user) || roleOf(state.user) === "radiologist" ? [] : [
      { page: "labs", icon: "file-text", label: "Lab Orders & Results" },
      { page: "meds", icon: "list", label: "Medication Chart" },
    ]),
    { page: "notes", icon: "edit", label: "Nursing / Care Notes" },
  ];
  const imaging = isTechnician(state.user)
    ? [{ page: "requests", icon: "file-text", label: "Requested case" }]
    : [
        { page: "dashboard", icon: "image", label: "X-ray Worklist" },
        ...(canUpload(state.user) ? [{ page: "new", icon: "plus", label: "Upload X-ray" }] : []),
        { page: "cases", icon: "file-text", label: "Case archive" },
      ];
  const admin = [
    ...(canSeeAudit(state.user) ? [{ page: "audit", icon: "shield", label: "Audit log" }] : []),
    ...(isAdmin(state.user) ? [{ page: "users", icon: "users", label: "Users" }] : []),
  ];
  const groups = [index, ward, imaging, admin].filter((group) => group.length);

  return el("aside", {
    id: "app-modules",
    class: "flex w-20 shrink-0 flex-col overflow-y-auto border-r border-gray-400 bg-gray-200 shadow-inner md:w-52",
    "aria-label": "Modules",
  },
    el("div", { class: "hidden border-b border-gray-400 bg-gray-300 p-2 text-xs font-bold text-gray-700 shadow-sm md:block" }, "MODULES"),
    el("nav", { class: "flex-1 p-1" },
      ...groups.flatMap((group, indexNo) => [
        indexNo ? el("div", { class: "my-2 border-t border-gray-400" }) : null,
        ...group.map(navButton),
      ])
    )
  );
}

export function Shell({ onLogout }) {
  bindListHotkeys();
  watchRequests();
  const user = state.user || {};
  const main = el("div", { class: "min-w-0 flex-1 overflow-auto" });
  const root = el("div", { class: "flex min-h-screen flex-col bg-ha-bg font-sans text-sm text-slate-900" },
    el("header", { class: "z-10 flex flex-wrap items-center justify-between gap-2 border-b-4 border-ha-light-blue bg-ha-blue p-2 text-white shadow-md" },
      el("div", { class: "flex min-w-0 items-center gap-2" },
        svgIcon("activity", { size: 20, class: "shrink-0" }),
        el("h1", { class: "truncate text-sm font-bold tracking-wide sm:text-lg" },
          "Clinical Management System ",
          el("span", { class: "hidden lg:inline" }, "· RadAssist")
        ),
        el("span", { class: "ml-2 hidden rounded bg-white px-2 py-0.5 text-xs font-bold text-ha-blue sm:inline" }, "INPATIENT")
      ),
      el("div", { class: "flex items-center gap-2 text-xs sm:gap-4 sm:pr-2" },
        el("span", { class: "hidden xl:inline" }, `User: ${user.name || "—"}`),
        el("span", { class: "hidden capitalize xl:inline" }, user.role || ""),
        el("span", { class: "hidden xl:inline" }, `Dept: ${deptCode(user)}`),
        el("span", { class: "hidden xl:inline" }, "Workstation: Demo radiology"),
        el("button", {
          type: "button",
          class: "flex items-center gap-1 rounded border border-white/40 bg-white/10 px-2 py-1 font-semibold hover:bg-white/20 focus:outline-none focus:ring-2 focus:ring-white/70",
          "aria-label": "Sign out",
          onClick: onLogout,
        }, svgIcon("log-out", { size: 13 }), el("span", { class: "hidden sm:inline" }, "Sign out"))
      )
    ),
    el("div", { class: "flex min-h-0 flex-1 overflow-hidden" },
      sidebar(),
      el("main", { class: "min-w-0 flex-1 overflow-auto bg-gray-100 p-2 shadow-inner" }, main)
    ),
    el("footer", { class: "flex justify-between gap-2 border-t border-gray-400 bg-gray-300 p-1 px-2 text-[10px] text-gray-600 sm:px-4 sm:text-xs" },
      el("span", {}, "Inpatient and X-ray simulator · demonstration data only"),
      el("span", {}, new Date().toLocaleString())
    )
  );
  return { root, main };
}

export function Header({ onLogout }) {
  return Shell({ onLogout }).root;
}
