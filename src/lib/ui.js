// Shared interactive controls used by list pages.

import { el } from "../dom.js";
import { svgIcon } from "../components/icons.js";

export const PAGE = "page-enter mx-auto max-w-7xl px-5 py-6 lg:py-8";

export function debounce(fn, ms = 280) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function searchField({
  id = "app-search",
  value = "",
  placeholder = "Search…",
  onQuery,
  onSearch,
}) {
  const later = debounce(() => onSearch?.(), 280);
  return el("div", { class: "relative flex-1 min-w-[200px]" },
    svgIcon("search", { size: 16, class: "pointer-events-none absolute left-3 top-3 text-slate-400" }),
    el("input", {
      id,
      class: "w-full rounded-xl border border-slate-300 bg-white pl-10 pr-3 py-2.5 outline-none transition focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100",
      placeholder,
      value,
      autocomplete: "off",
      onInput: (e) => {
        onQuery?.(e.target.value);
        later();
      },
      onChange: () => onSearch?.(),
      onKeydown: (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSearch?.();
        }
      },
    })
  );
}

export function statusChips({ value, onChange, extra }) {
  const opts = [
    { id: "all", label: "All" },
    { id: "pending", label: "Pending" },
    { id: "completed", label: "Completed" },
    { id: "finalized", label: "Finalized" },
    ...(extra || []),
  ];
  return el("div", { class: "flex flex-wrap gap-1.5", role: "tablist", "aria-label": "Filter by status" },
    ...opts.map((opt) => {
      const on = value === opt.id;
      return el("button", {
        type: "button",
        role: "tab",
        "aria-selected": on ? "true" : "false",
        class: on
          ? "rounded-full bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
          : "rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-800",
        onClick: () => onChange?.(opt.id),
      }, opt.label);
    })
  );
}

export function metricCard({ n, label, tone, active, onClick }) {
  return el("button", {
    type: "button",
    class: `card text-left transition hover:-translate-y-0.5 hover:shadow-md ${active ? "ring-2 ring-cyan-500" : ""}`,
    onClick,
  },
    el("p", { class: "text-slate-500 text-sm" }, label),
    el("b", { class: "mt-1 block text-3xl text-slate-900" }, String(n)),
    tone ? el("div", { class: `mt-2 h-1 rounded ${tone}` }) : null
  );
}

export function emptyState({ title, hint, actionLabel, onAction, icon = "search" }) {
  return el("div", { class: "px-6 py-14 text-center" },
    el("div", { class: "mx-auto mb-3 inline-flex rounded-2xl bg-slate-100 p-3 text-slate-400" },
      svgIcon(icon, { size: 22 })
    ),
    el("p", { class: "font-semibold text-slate-800" }, title),
    hint ? el("p", { class: "mx-auto mt-1 max-w-sm text-sm text-slate-500" }, hint) : null,
    actionLabel
      ? el("button", {
          class: "btn mt-4 bg-cyan-600 text-white hover:bg-cyan-700",
          onClick: onAction,
        }, actionLabel)
      : null
  );
}

export function pageHeading({ title, subtitle, actions }) {
  return el("div", { class: "flex flex-wrap items-end justify-between gap-3" },
    el("div", {},
      el("h1", { class: "text-3xl font-bold tracking-tight text-slate-900" }, title),
      subtitle ? el("p", { class: "mt-1 text-slate-500" }, subtitle) : null
    ),
    actions ? el("div", { class: "flex flex-wrap items-center gap-2" }, ...[].concat(actions).filter(Boolean)) : null
  );
}

export function bindListHotkeys() {
  if (typeof document === "undefined" || document.documentElement.dataset.hotkeys === "1") return;
  document.documentElement.dataset.hotkeys = "1";
  document.addEventListener("keydown", (e) => {
    const tag = String(e.target?.tagName || "");
    const typing = /INPUT|TEXTAREA|SELECT/.test(tag) || e.target?.isContentEditable;
    if (e.key === "/" && !typing) {
      const box = document.getElementById("app-search");
      if (!box) return;
      e.preventDefault();
      box.focus();
      box.select?.();
    }
    if (e.key === "Escape") {
      document.getElementById("app-drawer")?.classList.add("hidden");
      document.getElementById("app-scrim")?.classList.add("hidden");
    }
  });
}

export function sortWorklist(cases) {
  return [...(cases || [])].sort((a, b) => {
    const urgent = Number(Boolean(b.urgent)) - Number(Boolean(a.urgent));
    if (urgent) return urgent;
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });
}
