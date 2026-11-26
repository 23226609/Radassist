// The patient's list of their own reports: one button per report, named by its DATE (2026/11/26) with the
// exam type under it. No case ID is shown. Layout and navigation only: it reads the cases the server already
// returned for this patient and changes nothing in them.

import { el } from "../dom.js";
import { reportTitle } from "../../shared/reportTags.js";

const pad = (n) => String(n).padStart(2, "0");

function dateOf(c) {
  const d = c?.finalizedAt ? new Date(c.finalizedAt) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/** 2026/11/26, in the viewer's own time zone. "" when the report has no date. */
export function reportDate(c) {
  const d = dateOf(c);
  return d ? `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}` : "";
}

/** XRAY CHEST (AP): the same title the report itself carries. */
export function examLabel(c) {
  return reportTitle(c?.view);
}

/** Newest first. Reports with no date go last; ties keep a steady order. */
export function sortReports(cases) {
  return [...(Array.isArray(cases) ? cases : [])].sort((a, b) => {
    const ta = dateOf(a)?.getTime() ?? -Infinity;
    const tb = dateOf(b)?.getTime() ?? -Infinity;
    if (ta !== tb) return tb - ta;
    return String(a.caseId).localeCompare(String(b.caseId));
  });
}

function stamp(c) {
  const d = dateOf(c);
  return d ? d.toLocaleString() : "";
}

/** The list the patient chooses from: one button per report, the date as its name, the exam type under it. */
export function reportChoiceList({ cases, onSelect }) {
  return el("div", { id: "report-choice-list", class: "grid gap-2 sm:grid-cols-2 lg:grid-cols-3" },
    ...cases.map((c) => el("button", {
      type: "button",
      title: stamp(c),
      dataset: { caseId: c.caseId },
      class: "card !p-4 text-left transition-colors hover:border-ha-blue hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-ha-blue",
      onClick: () => onSelect(c.caseId),
    },
      el("span", { class: "block text-lg font-bold text-slate-900" }, reportDate(c) || "Date not recorded"),
      el("span", { class: "mt-0.5 block text-xs text-gray-500" }, examLabel(c))
    ))
  );
}
