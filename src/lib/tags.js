// Small shared status chips.

import { el } from "../dom.js";
import { composePatientName } from "./patientName.js";

export function urgentBadge({ class: extra = "" } = {}) {
  return el("span", {
    class: `inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-red-700 ${extra}`.trim(),
  }, "Urgent");
}

export function patientDisplayName(p = {}) {
  return composePatientName(p);
}
