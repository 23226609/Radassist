// One patient's Sepsis Monitor, Care Notes or whole chart in its own browser
// window (?view=sepsis|notes|patient&patientId=...), so it can sit beside the
// Patient Master Index or the report. If the browser blocks pop-ups, a
// floating in-page panel is used.

import { el, mount } from "../dom.js";
import { state, subscribe, toast } from "../state.js";
import { renderMonitorPage, renderNotesPage } from "../components/clinical.js";
import { renderPatientPage } from "../components/patients.js";
import { patientDisplayName } from "./tags.js";

export const PATIENT_UPDATED = "radassist-patient-updated";

const VIEWS = {
  sepsis: {
    title: "Sepsis Monitor",
    windowName: "radassist-sepsis",
    width: 820,
    pages: ["patients", "patient"],
    render: renderMonitorPage,
  },
  notes: {
    title: "Nursing / Care Notes",
    windowName: "radassist-notes",
    width: 760,
    pages: ["patients", "patient"],
    render: renderNotesPage,
  },
  patient: {
    title: "Patient chart",
    windowName: "radassist-patient",
    width: 980,
    pages: ["review"],
    render: renderPatientPage,
  },
};

let current = null;

function windowParams() {
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams();
  }
}

export function chartWindowUrl(view, patientId, name = "") {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("view", view);
  url.searchParams.set("patientId", String(patientId || ""));
  if (name) url.searchParams.set("name", name);
  return url.toString();
}

export function isChartWindow() {
  return Boolean(VIEWS[windowParams().get("view")]);
}

function windowFeatures(width) {
  const height = Math.min(900, (window.screen?.availHeight || 900) - 40);
  const left = Math.max(0, (window.screenX || 0) + (window.outerWidth || width) - width - 20);
  const top = Math.max(0, (window.screenY || 0) + 60);
  return `popup,width=${width},height=${height},left=${left},top=${top}`;
}

/**
 * Open (or reuse) the separate window for a view. Returns false when the
 * browser blocked it.
 */
export function openChartWindow(view, { patientId, name = "" } = {}) {
  const spec = VIEWS[view];
  if (!spec || !patientId || typeof window.open !== "function") return false;
  let win = null;
  try {
    win = window.open(chartWindowUrl(view, patientId, name), spec.windowName, windowFeatures(spec.width));
  } catch {
    win = null;
  }
  if (!win) return false;
  try { win.focus(); } catch { /* some browsers refuse focus */ }
  return true;
}

// The page inside the separate window.
export function renderChartWindow({ target }) {
  const params = windowParams();
  const spec = VIEWS[params.get("view")];
  const patientId = params.get("patientId") || "";
  const name = params.get("name") || "";
  try { document.title = `${spec.title} · ${name || patientId}`; } catch { /* tests */ }
  const body = el("div");
  mount(target,
    el("div", { class: "flex min-h-screen flex-col bg-[#d4d0c8]" },
      el("div", { class: "flex items-center justify-between gap-2 bg-[#008080] px-3 py-2 text-sm font-bold text-white" },
        el("span", { class: "truncate" }, `${spec.title} · ${name || patientId} (${patientId})`),
        el("button", {
          type: "button",
          class: "rounded px-2 py-0.5 text-xs font-bold hover:bg-white/20",
          onClick: () => window.close(),
        }, "Close window")
      ),
      body
    )
  );
  if (!patientId) {
    mount(body, el("p", { class: "p-4 text-sm text-red-800" }, "No patient was selected."));
    return;
  }
  spec.render({
    target: body,
    patientId,
    embedded: true,
    onSaved: (patient) => {
      try {
        window.opener?.postMessage({ type: PATIENT_UPDATED, patient }, window.location.origin);
      } catch { /* opener closed */ }
    },
  });
}

export function closeChartPanel() {
  if (!current) return;
  current.unsubscribe();
  current.node.remove();
  current = null;
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), Math.max(lo, hi));
}

function makeDraggable(node, handle) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest?.("button")) return;
    const box = node.getBoundingClientRect();
    const dx = e.clientX - box.left;
    const dy = e.clientY - box.top;
    node.style.left = `${box.left}px`;
    node.style.top = `${box.top}px`;
    node.style.right = "auto";
    node.style.bottom = "auto";
    handle.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      node.style.left = `${clamp(ev.clientX - dx, 0, window.innerWidth - 120)}px`;
      node.style.top = `${clamp(ev.clientY - dy, 0, window.innerHeight - 40)}px`;
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

/**
 * Floating, non-modal panel on the current page — the fallback when the
 * browser blocks the separate window.
 * @param {"sepsis"|"notes"|"patient"} view
 * @param {{ patientId: string, name?: string, onSaved?: (patient: object) => void }} opts
 */
export function openChartPanel(view, { patientId, name = "", onSaved } = {}) {
  const spec = VIEWS[view];
  if (!spec || !patientId) return null;
  closeChartPanel();

  let minimised = false;
  const body = el("div", { class: "min-h-0 flex-1 overflow-auto bg-[#d4d0c8]" });
  const minBtn = el("button", {
    type: "button",
    class: "rounded px-2 py-0.5 text-xs font-bold hover:bg-white/20",
    "aria-label": `Minimise ${spec.title}`,
    title: "Minimise",
    onClick: () => {
      minimised = !minimised;
      body.hidden = minimised;
      node.style.height = minimised ? "auto" : "";
      node.style.resize = minimised ? "none" : "both";
      minBtn.textContent = minimised ? "▢" : "–";
      minBtn.setAttribute("aria-label", `${minimised ? "Restore" : "Minimise"} ${spec.title}`);
    },
  }, "–");
  const title = el("div", {
    class: "flex cursor-move select-none items-center justify-between gap-2 bg-[#008080] px-3 py-1.5 text-xs font-bold text-white",
  },
    el("span", { class: "truncate" }, `${spec.title} · ${name || patientId} (${patientId})`),
    el("div", { class: "flex shrink-0 items-center gap-1" },
      minBtn,
      el("button", {
        type: "button",
        class: "rounded px-2 py-0.5 text-xs font-bold hover:bg-white/20",
        "aria-label": `Close ${spec.title}`,
        title: "Close",
        onClick: closeChartPanel,
      }, "✕")
    )
  );
  const node = el("section", {
    id: `${view}-popup`,
    role: "dialog",
    "aria-modal": "false",
    "aria-label": `${spec.title} for ${name || patientId}`,
    class: "fixed bottom-4 right-4 z-40 flex flex-col overflow-hidden rounded border-2 border-gray-500 bg-white shadow-2xl",
    style: {
      width: `min(${spec.width - 60}px, calc(100vw - 2rem))`,
      height: "min(78vh, 760px)",
      minWidth: "320px",
      minHeight: "160px",
      resize: "both",
    },
  }, title, body);

  makeDraggable(node, title);
  document.body.appendChild(node);

  const unsubscribe = subscribe(() => {
    if (!state.user || !spec.pages.includes(state.page)) closeChartPanel();
  });
  current = { node, patientId, unsubscribe };

  spec.render({ target: body, patientId, embedded: true, onSaved });
  return node;
}

function openChart(view, patient, onSaved) {
  const name = patientDisplayName(patient) || "";
  if (openChartWindow(view, { patientId: patient.patientId, name })) return;
  toast(`Pop-up blocked — showing ${VIEWS[view].title} on this page. Allow pop-ups for a separate window.`);
  openChartPanel(view, { patientId: patient.patientId, name, onSaved });
}

export function sepsisButton(patient, { onSaved, compact = false } = {}) {
  return el("button", {
    type: "button",
    class: "rounded border border-teal-700 bg-white px-2 py-0.5 text-[11px] font-semibold text-teal-800 hover:bg-teal-50",
    title: "Open the Sepsis Monitor in its own window",
    onClick: (e) => {
      e.stopPropagation();
      openChart("sepsis", patient, onSaved);
    },
  }, compact ? "Sepsis" : "Sepsis monitor");
}

export function patientChartButton(patient, { className } = {}) {
  return el("button", {
    type: "button",
    class: className || "rounded border border-teal-700 bg-white px-2 py-0.5 text-[11px] font-semibold text-teal-800 hover:bg-teal-50",
    title: "Open this patient's chart in its own window",
    onClick: (e) => {
      e.stopPropagation();
      openChart("patient", patient);
    },
  }, "Patient chart");
}

export function careNotesButton(patient, { onSaved, label = "Care notes", className } = {}) {
  return el("button", {
    type: "button",
    class: className || "rounded border border-teal-700 bg-white px-2 py-0.5 text-[11px] font-semibold text-teal-800 hover:bg-teal-50",
    title: "Open Nursing / Care Notes in its own window",
    onClick: (e) => {
      e.stopPropagation();
      openChart("notes", patient, onSaved);
    },
  }, label);
}
