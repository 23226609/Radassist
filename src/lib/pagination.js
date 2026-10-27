// src/lib/pagination.js
import { el } from "../dom.js";

export const PAGE_SIZE = 10;

export function paginate(items, page, pageSize = PAGE_SIZE) {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / pageSize) || 1);
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (current - 1) * pageSize;
  return {
    items: list.slice(start, start + pageSize),
    page: current,
    pages,
    total,
    from: total ? start + 1 : 0,
    to: Math.min(start + pageSize, total),
  };
}

/**
 * How many table rows fit in `scroller` without scrolling, measured from the
 * rows on screen. Returns `current` when nothing can be measured (tests).
 */
export function fitPageSize(scroller, current, { min = 3, max = 100 } = {}) {
  const rows = scroller?.querySelectorAll?.("tbody tr") || [];
  const room = scroller?.clientHeight || 0;
  if (!room || !rows.length) return current;
  const head = scroller.querySelector("thead")?.offsetHeight || 0;
  const rowHeight = Math.max(...[...rows].map((r) => r.offsetHeight || 0));
  if (!rowHeight) return current;
  return Math.min(max, Math.max(min, Math.floor((room - head - 2) / rowHeight)));
}

/** Measure now and again after layout, then call `apply` when the size changes. */
export function scheduleFit(scroller, current, apply) {
  const run = () => {
    const fit = fitPageSize(scroller, current);
    if (fit !== current) apply(fit);
  };
  run();
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
}

export function paginationBar({ page, pages, total, from, to, onPage }) {
  if (!total) return null;
  return el("div", {
    class: "flex flex-wrap items-center justify-between gap-2 px-1 py-0.5 text-xs text-slate-600",
  },
    el("p", {}, `${from}–${to} of ${total}`),
    pages > 1 && el("div", { class: "flex items-center gap-2" },
      el("button", {
        class: "rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40",
        disabled: page <= 1,
        onClick: () => onPage(page - 1),
      }, "Previous"),
      el("span", { class: "min-w-[7rem] text-center" }, `Page ${page} of ${pages}`),
      el("button", {
        class: "rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40",
        disabled: page >= pages,
        onClick: () => onPage(page + 1),
      }, "Next")
    )
  );
}
