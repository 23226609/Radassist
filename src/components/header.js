// src/components/header.js
import { el } from "../dom.js";
import { state, setPage } from "../state.js";
import { svgIcon } from "./icons.js";

export function Header({ onLogout }) {
  return el(
    "header",
    { class: "border-b bg-white sticky top-0 z-30" },
    el(
      "div",
      { class: "mx-auto flex max-w-7xl items-center justify-between px-5 py-3" },
      el(
        "button",
        {
          class: "flex items-center gap-2 font-bold text-slate-900",
          onClick: () => setPage("dashboard"),
        },
        el(
          "span",
          { class: "inline-flex items-center justify-center rounded-lg bg-cyan-600 text-white p-1.5" },
          svgIcon("activity", { size: 18 })
        ),
        "RadAssist AI"
      ),
      el(
        "div",
        { class: "flex items-center gap-4 text-sm" },
        el("div", { class: "flex items-center gap-2 text-slate-700" },
          el("span", { class: "inline-flex items-center justify-center w-7 h-7 rounded-full bg-slate-900 text-white text-xs font-bold" },
            (state.user?.name || "?").charAt(0).toUpperCase()
          ),
          el("div", { class: "leading-tight" },
            el("div", { class: "font-semibold" }, state.user?.name || ""),
            el("div", { class: "text-xs text-slate-500 capitalize" }, state.user?.role || "")
          )
        ),
        el(
          "button",
          {
            class: "ml-2 inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50",
            onClick: onLogout,
          },
          svgIcon("log-out", { size: 14 }),
          "Logout"
        )
      )
    )
  );
}
