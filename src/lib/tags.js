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

export function doctorInCharge(c = {}) {
  return String(c.createdByName || "").trim() || "Unassigned";
}

export function isDoctorInCharge(c = {}, user = {}) {
  const uid = String(user?.userId || "").trim();
  if (uid && String(c.createdBy || "") === uid) return true;
  const name = String(user?.name || "").trim();
  if (name && String(c.createdByName || "").trim() === name) return true;
  return false;
}

export function doctorFilterKey(c = {}) {
  const uid = String(c.createdBy || "").trim();
  if (uid) return uid;
  const name = String(c.createdByName || "").trim();
  return name ? `name:${name}` : "unassigned";
}

export function isListedDoctorInCharge(c = {}) {
  const uid = String(c.createdBy || "").trim();
  const name = String(c.createdByName || "").trim();
  if (/^usr-admin/i.test(uid)) return false;
  if (/^system admin$/i.test(name)) return false;
  return true;
}

export function doctorsInChargeOptions(list = []) {
  const seen = new Map();
  for (const c of list) {
    if (!isListedDoctorInCharge(c)) continue;
    const key = doctorFilterKey(c);
    if (!seen.has(key)) seen.set(key, doctorInCharge(c));
  }
  return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: "base" }));
}
