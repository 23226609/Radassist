// The patient's view of one endorsed case: the endorsed report first, then the plain-language summary
// below it with an English / 繁體中文 toggle and the disclaimer under each version.
// Used by the patient's own page (myReports.js) and by the "Patient view" preview on Review.

import { el } from "../dom.js";
import { reportDate } from "./patientReportNav.js";

const LABELS = {
  english: {
    found: "What we found",
    meaning: "What it means in plain words",
    next: "What happens next",
    help: "When to seek help sooner",
  },
  traditionalChinese: {
    found: "檢查發現",
    meaning: "這代表甚麼",
    next: "接下來會怎樣",
    help: "何時應及早求醫",
  },
};
const PARTS = ["found", "meaning", "next", "help"];

/** The plain-language summary card. `lang` is "english" or "traditionalChinese". */
export function laySummaryCard({ caseData, lang, onLang, onRefresh, onRewrite, rewriting = false }) {
  const summary = caseData?.laySummary;
  const version = summary?.[lang];
  const ready = version && PARTS.every((k) => String(version[k] || "").trim());
  const zh = lang === "traditionalChinese";

  const toggle = el("div", { class: "flex gap-1", role: "group", "aria-label": "Language" },
    ...[["english", "English", "lay-lang-en"], ["traditionalChinese", "繁體中文", "lay-lang-zh"]].map(([key, label, id]) =>
      el("button", {
        id,
        type: "button",
        "aria-pressed": lang === key ? "true" : "false",
        class: `rounded-lg border px-2.5 py-1 text-xs font-semibold ${lang === key ? "border-ha-blue bg-ha-blue text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`,
        onClick: () => onLang(key),
      }, label)
    )
  );

  let body;
  if (ready) {
    body = el("div", { id: "lay-summary-body", lang: zh ? "zh-Hant" : "en", class: "mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto text-sm text-slate-800" },
      ...PARTS.map((k) => el("div", { dataset: { layPart: k } },
        el("h3", { class: "text-xs font-bold uppercase tracking-wide text-slate-500" }, LABELS[lang][k]),
        el("p", { class: "mt-0.5 leading-relaxed" }, String(version[k])))),
      el("p", { id: "lay-summary-disclaimer", class: "border-t border-slate-200 pt-2 text-xs text-slate-500" }, String(version.disclaimer || ""))
    );
  } else if (caseData?.laySummaryState === "running") {
    body = el("p", { id: "lay-summary-pending", class: "mt-2 text-sm text-slate-600" },
      "The plain-language summary is being prepared. Please check again in a minute.",
      onRefresh ? el("button", { id: "lay-summary-refresh", type: "button", class: "ml-2 font-semibold text-ha-blue underline", onClick: onRefresh }, "Check again") : null);
  } else {
    body = el("p", { id: "lay-summary-missing", class: "mt-2 text-sm text-slate-600" },
      "A plain-language summary is not available for this report yet.",
      onRewrite
        ? el("button", { id: "lay-summary-rewrite", type: "button", disabled: rewriting, class: "ml-2 font-semibold text-ha-blue underline disabled:opacity-50", onClick: onRewrite },
          rewriting ? "Writing…" : "Write it now")
        : null);
  }

  return el("section", { id: "lay-summary", class: "card flex min-h-0 flex-col !p-4" },
    el("div", { class: "flex flex-wrap items-center justify-between gap-2" },
      el("h2", { class: "text-base font-bold text-slate-900" }, "In plain language"),
      toggle
    ),
    body
  );
}

/** The endorsed report card. Text only: nothing in it can be edited. Named by its date, not its case ID. */
export function endorsedReportCard(caseData) {
  const by = caseData?.finalizedByName ? `endorsed by ${caseData.finalizedByName}` : "";
  const line = [reportDate(caseData), by].filter(Boolean).join(" · ");
  return el("section", { id: "endorsed-report", class: "card flex min-h-0 flex-col !p-4" },
    el("h2", { class: "text-base font-bold text-slate-900" }, "Your report"),
    el("p", { id: "endorsed-report-meta", class: "mt-0.5 text-xs text-slate-500" }, line),
    el("pre", { id: "endorsed-report-text", class: "mt-2 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-slate-800" },
      String(caseData?.reportText || "").trim() || "The report text is not available.")
  );
}

/** One screen, two columns: the plain-language summary on the left, the report on the right. */
export function patientReportView({ caseData, lang, onLang, onRefresh, onRewrite, rewriting }) {
  return el("div", { id: "patient-report-view", class: "grid flex-none gap-3 md:min-h-0 md:flex-1 md:grid-cols-2 md:grid-rows-1" },
    laySummaryCard({ caseData, lang, onLang, onRefresh, onRewrite, rewriting }),
    endorsedReportCard(caseData)
  );
}
