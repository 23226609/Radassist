// Shared checkbox + bulk-delete controls for admin tables.

import { el } from "../dom.js";
import { svgIcon } from "../components/icons.js";

export function toggleSelected(selected, id, on) {
  if (!id) return;
  if (on) selected.add(id);
  else selected.delete(id);
}

export function togglePage(selected, ids, on) {
  for (const id of ids) toggleSelected(selected, id, on);
}

export function rowCheckbox(id, selected, onToggle) {
  return el("td", {
    class: "w-10 p-3",
    onClick: (e) => e.stopPropagation(),
  },
    el("input", {
      type: "checkbox",
      class: "h-4 w-4 accent-cyan-600",
      checked: selected.has(id),
      "aria-label": "Select row",
      onClick: (e) => e.stopPropagation(),
      onChange: (e) => onToggle(id, Boolean((e.currentTarget || e.target).checked)),
    })
  );
}

export function headerCheckbox(ids, selected, onTogglePage) {
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  return el("th", { class: "w-10 p-3" },
    el("input", {
      type: "checkbox",
      class: "h-4 w-4 accent-cyan-600",
      title: "Select all on this page",
      "aria-label": "Select all on this page",
      checked: all,
      onChange: (e) => onTogglePage(Boolean((e.currentTarget || e.target).checked)),
    })
  );
}

export function bulkDeleteButton({ count, onClick, disabled }) {
  return el("button", {
    class: "inline-flex items-center gap-1 rounded-xl border border-red-200 bg-white px-3 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50",
    disabled: disabled || !count,
    onClick,
  }, svgIcon("trash", { size: 16 }), count ? `Delete (${count})` : "Delete");
}
