// Shared interactive controls used by list pages.

import { el } from "../dom.js";
import { svgIcon } from "../components/icons.js";

export const PAGE = "page-enter w-full px-1 py-1";

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
      class: "w-full rounded border border-gray-400 bg-white py-2 pl-10 pr-3 outline-none transition focus:border-ha-blue focus:ring-2 focus:ring-blue-200",
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
    { id: "requested", label: "Requested" },
    { id: "pending_approve", label: "Pending approve" },
    { id: "finalized", label: "Endorsed" },
    ...(extra || []),
  ];
  return el("div", { class: "flex flex-wrap gap-1.5", role: "tablist", "aria-label": "Filter by status" },
    ...opts.map((opt) => {
      const on = value === opt.id;
      return el("button", {
        type: "button",
        id: opt.buttonId,
        role: "tab",
        "aria-selected": on ? "true" : "false",
        class: on
          ? "rounded border border-ha-blue bg-ha-blue px-3 py-1.5 text-xs font-semibold text-white"
          : "rounded border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-blue-50 hover:text-ha-blue",
        onClick: () => onChange?.(opt.id),
      }, opt.label);
    })
  );
}

export function metricCard({ n, label, tone, active, onClick }) {
  return el("button", {
    type: "button",
    class: `rounded border border-gray-400 bg-white p-4 text-left ${active ? "ring-2 ring-ha-blue" : ""}`,
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
          class: "btn mt-4 bg-ha-blue text-white hover:bg-[#074f85]",
          onClick: onAction,
        }, actionLabel)
      : null
  );
}

export function pageHeading({ title, subtitle, actions }) {
  return el("div", { class: "flex flex-wrap items-end justify-between gap-3" },
    el("div", {},
      el("h1", { class: "text-xl font-bold text-ha-blue" }, title),
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
      document.getElementById("app-menu-button")?.setAttribute("aria-expanded", "false");
    }
  });
}

export function bookingWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} · ${time}`;
}

export function registeredAt(c = {}) {
  const value = c.registeredAt || ((c.imageId || c.imageUrl) ? c.createdAt : null) || c.createdAt;
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

export function registeredDate(c = {}) {
  const time = registeredAt(c);
  if (!time) return "—";
  const d = new Date(time);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

export function sortByRegistered(cases, dir = "desc") {
  const sign = dir === "asc" ? 1 : -1;
  return [...(cases || [])].sort((a, b) => {
    const diff = (registeredAt(a) - registeredAt(b)) * sign;
    if (diff) return diff;
    return String(a.caseId || a._id || "").localeCompare(String(b.caseId || b._id || ""));
  });
}

export function dateSortHeader({ label = "Reg. Date", dir = "desc", onToggle } = {}) {
  const newest = dir !== "asc";
  return el("button", {
    type: "button",
    class: "inline-flex items-center gap-1 font-semibold hover:text-ha-blue",
    title: newest ? "Newest first. Click for oldest first." : "Oldest first. Click for newest first.",
    "aria-label": `Sort by registration date, ${newest ? "newest first" : "oldest first"}`,
    "data-sort": newest ? "desc" : "asc",
    onClick: (e) => { e.stopPropagation(); onToggle?.(); },
  },
    label,
    el("span", { class: "text-[10px] leading-none", "aria-hidden": "true" }, newest ? "▼" : "▲")
  );
}

export function sortWorklist(cases) {
  return sortByRegistered(cases, "desc");
}
