// Shared labeled name/demographics controls used by New Patient and New Case.

import { el } from "../dom.js";
import { api } from "../api.js";
import { composePatientName, nameFieldsFrom, tidyNamePart } from "../lib/patientName.js";
import { patientDisplayName } from "../lib/tags.js";

const CONTROL = "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-600 focus:ring-4 focus:ring-cyan-100 disabled:bg-slate-100";

export function labeledField({ label, optional, required, forId }, control) {
  return el("label", { class: "block min-w-0", for: forId || "" },
    el("span", { class: "mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500" },
      label,
      required ? el("span", { class: "normal-case tracking-normal text-red-500" }, "*") : null,
      optional ? el("span", { class: "normal-case tracking-normal font-medium text-slate-400" }, "optional") : null
    ),
    control
  );
}

export function sexPills({ f, disabled, onChange }) {
  return el("div", {
    class: "flex flex-wrap gap-2",
    role: "group",
    "aria-label": "Sex",
  },
    ...["Female", "Male", "Other"].map((s) =>
      el("button", {
        type: "button",
        disabled: Boolean(disabled),
        dataset: { sex: s },
        class: f.sex === s
          ? "rounded-xl bg-cyan-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
          : "rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50",
        onClick: () => {
          if (disabled) return;
          f.sex = s;
          for (const btn of document.querySelectorAll("[data-sex]")) {
            const on = btn.getAttribute("data-sex") === s;
            btn.className = on
              ? "rounded-xl bg-cyan-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
              : "rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50";
          }
          onChange?.();
        },
      }, s)
    )
  );
}

function previewText(f) {
  return composePatientName(f) || "Full name will appear here";
}

export function paintNamePreview(f) {
  const name = composePatientName(f);
  const preview = document.getElementById("full-name-preview");
  if (preview) {
    preview.textContent = name || "Full name will appear here";
    preview.classList.toggle("text-slate-400", !name);
    preview.classList.toggle("italic", !name);
    preview.classList.toggle("text-slate-900", Boolean(name));
  }
  const summaryName = document.getElementById("summary-full-name");
  if (summaryName) summaryName.textContent = name || "Name pending";
  const initials = document.getElementById("summary-initials");
  if (initials) {
    const { firstName, lastName } = nameFieldsFrom(f);
    initials.textContent = `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase() || "?";
  }
  const meta = document.getElementById("summary-meta");
  if (meta) {
    meta.textContent = [f.age && `${f.age} years`, f.sex].filter(Boolean).join(" · ") || "Age and sex pending";
  }
  const ready = document.getElementById("summary-ready");
  if (ready) {
    const ok = Boolean(f.firstName?.trim() && f.lastName?.trim() && f.age && f.sex);
    ready.textContent = ok ? "Ready to save" : "First name, last name, age and sex are required";
    ready.className = ok
      ? "mt-3 text-sm font-semibold text-green-700"
      : "mt-3 text-sm text-slate-500";
  }
}

export function nameFieldGroup({ f, disabled, onChange }) {
  function bind(key, { placeholder, id }) {
    return el("input", {
      id,
      class: CONTROL,
      disabled: Boolean(disabled),
      placeholder,
      autocomplete: "off",
      value: f[key],
      onInput: (e) => {
        f[key] = e.target.value;
        paintNamePreview(f);
        onChange?.("input", key);
      },
      onBlur: (e) => {
        f[key] = tidyNamePart(e.target.value);
        e.target.value = f[key];
        paintNamePreview(f);
        onChange?.("blur", key);
      },
    });
  }

  return el("div", {},
    el("div", { class: "grid gap-3 sm:grid-cols-8" },
      el("div", { class: "sm:col-span-3" },
        labeledField({ label: "First name", required: true, forId: "patient-first-name" },
          bind("firstName", { id: "patient-first-name", placeholder: "First name" })
        )
      ),
      el("div", { class: "sm:col-span-2" },
        labeledField({ label: "Middle name", optional: true, forId: "patient-middle-name" },
          bind("middleName", { id: "patient-middle-name", placeholder: "Middle name (optional)" })
        )
      ),
      el("div", { class: "sm:col-span-3" },
        labeledField({ label: "Last name", required: true, forId: "patient-last-name" },
          bind("lastName", { id: "patient-last-name", placeholder: "Last name" })
        )
      )
    ),
    el("div", {
      class: "mt-3 flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2",
    },
      el("span", { class: "text-[11px] font-bold uppercase tracking-wide text-slate-400" }, "Preview"),
      el("span", {
        id: "full-name-preview",
        class: `text-sm font-semibold ${composePatientName(f) ? "text-slate-900" : "italic text-slate-400"}`,
      }, previewText(f))
    )
  );
}

export function paintMatchList(hits, { onPick, excludeId } = {}) {
  const host = document.getElementById("patient-matches");
  if (!host) return;
  while (host.firstChild) host.removeChild(host.firstChild);
  const rows = (hits || []).filter((p) => !excludeId || String(p.patientId) !== String(excludeId));
  if (!rows.length) return;
  host.appendChild(
    el("div", { class: "rounded-xl border border-amber-200 bg-amber-50 p-3" },
      el("p", { class: "text-xs font-semibold uppercase tracking-wide text-amber-800" },
        "Possible existing charts"
      ),
      el("ul", { class: "mt-2 space-y-1" },
        ...rows.slice(0, 5).map((p) =>
          el("li", {},
            el("button", {
              type: "button",
              class: "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white",
              onClick: () => onPick?.(p),
            },
              el("span", {},
                el("span", { class: "font-semibold text-slate-900" }, patientDisplayName(p) || "Unnamed"),
                el("span", { class: "ml-2 font-mono text-xs text-slate-500" }, p.patientId)
              ),
              el("span", { class: "text-xs text-slate-500" },
                [p.age && `${p.age}y`, p.sex].filter(Boolean).join(" · ")
              )
            )
          )
        )
      )
    )
  );
}

export function createPatientSearch({ onHits }) {
  let timer = null;
  function schedule(query) {
    clearTimeout(timer);
    const q = String(query || "").trim();
    if (q.length < 2) {
      onHits?.([]);
      return;
    }
    timer = setTimeout(async () => {
      try {
        const data = await api.listPatients({ q });
        onHits?.(data.patients || []);
      } catch {
        onHits?.([]);
      }
    }, 280);
  }
  return { schedule };
}

export function searchQueryFrom(f) {
  return composePatientName(f) || [f.lastName, f.firstName, f.patientId].filter(Boolean).join(" ");
}
