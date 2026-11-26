// The patient's reports page. A patient account can only read: their own endorsed reports and the plain-language
// summary of each. There is no edit, no endorse and no AI here, and the server returns nothing else.
//
// Flow: choose first, then show.
//   1. The list of the patient's own reports, newest first. Each is a button named by its date (2026/11/26)
//      with the exam type under it. No case ID.
//   2. After a date is chosen: that report in two columns on one screen (plain language left, report right),
//      a "← Back to all reports" button, and a "Download PDF" button.
// A patient with exactly one report goes straight to it.

import { el, mount } from "../dom.js";
import { state, setPage } from "../state.js";
import { api } from "../api.js";
import { emptyState } from "../lib/ui.js";
import { svgIcon } from "./icons.js";
import { patientReportView } from "./laySummary.js";
import { reportChoiceList, reportDate, examLabel, sortReports } from "./patientReportNav.js";
import { downloadPatientReportPdf } from "../lib/patientReportPdf.js";

// The last list the server gave this patient, so a re-render does not flash an empty page. It is kept
// per user, so a different patient signing in on the same screen never sees it.
let last = { userId: "", cases: null };

export function renderMyReportsPage({ target }) {
  const userId = String(state.user?.userId || state.user?.username || "");
  const remembered = last.userId === userId ? last.cases : null;
  let cases = remembered || [];
  let loading = !remembered;
  let error = "";
  let lang = "english";
  let pdfBusy = false;
  let pdfError = "";

  const choose = (caseId) => setPage("my-reports", { selectedCaseId: caseId, patientBrowse: false });
  const back = () => setPage("my-reports", { selectedCaseId: null, patientBrowse: true });

  async function load() {
    error = "";
    try {
      const data = await api.listCases();
      cases = sortReports(Array.isArray(data.cases) ? data.cases : []);
      last = { userId, cases };
    } catch (err) {
      cases = [];
      last = { userId: "", cases: null };
      error = err.message || "Could not load your reports.";
    } finally {
      loading = false;
      paint();
    }
  }

  async function download(current) {
    pdfBusy = true;
    pdfError = "";
    paint();
    try {
      await downloadPatientReportPdf(current);
    } catch (err) {
      pdfError = err.message || "Could not make the PDF.";
    } finally {
      pdfBusy = false;
      paint();
    }
  }

  // Which report is open: the one chosen, or the only one the patient has (unless they pressed Back).
  function openReport() {
    const chosen = cases.find((c) => c.caseId === state.selectedCaseId);
    if (chosen) return chosen;
    return cases.length === 1 && !state.patientBrowse ? cases[0] : null;
  }

  function reportBar(current) {
    // A PDF is made only from an endorsed report.
    const canPdf = current.status === "finalized";
    return el("div", { id: "report-bar", class: "flex shrink-0 flex-wrap items-center gap-2" },
      el("button", {
        id: "back-to-reports",
        type: "button",
        class: "flex items-center gap-1 rounded border border-gray-400 bg-white px-3 py-1.5 text-sm font-semibold text-slate-800 hover:bg-gray-100",
        onClick: back,
      }, svgIcon("arrow-left", { size: 14 }), "Back to all reports"),
      el("h1", { class: "text-lg font-bold text-ha-blue" },
        reportDate(current) || "Report",
        el("span", { class: "ml-2 text-xs font-normal text-gray-500" }, examLabel(current))),
      el("div", { class: "ml-auto flex items-center gap-2" },
        pdfError ? el("span", { id: "pdf-error", class: "text-xs text-red-700" }, pdfError) : null,
        canPdf
          ? el("button", {
            id: "download-pdf",
            type: "button",
            disabled: pdfBusy,
            class: "flex items-center gap-1 rounded bg-ha-blue px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60",
            onClick: () => download(current),
          }, svgIcon("download", { size: 14 }), pdfBusy ? "Making PDF…" : "Download PDF")
          : null)
    );
  }

  function paint() {
    const current = openReport();
    const shell = "flex h-full min-h-0 w-full flex-col gap-2 overflow-y-auto px-1 py-1 md:overflow-hidden";

    if (current) {
      mount(target, el("div", { id: "my-reports", class: shell },
        reportBar(current),
        patientReportView({
          caseData: current,
          lang,
          onLang: (key) => { lang = key; paint(); },
          onRefresh: load,
        })
      ));
      return;
    }

    mount(target, el("div", { id: "my-reports", class: `${shell} md:overflow-y-auto` },
      el("div", { class: "flex shrink-0 flex-wrap items-baseline gap-x-3" },
        el("h1", { class: "text-xl font-bold text-ha-blue" }, "My reports"),
        state.user?.name ? el("p", { class: "text-slate-500" }, `Signed in as ${state.user.name}`) : null
      ),
      loading ? el("p", { class: "text-sm text-slate-500" }, "Loading…") : null,
      error ? el("p", { id: "my-reports-error", class: "rounded-lg bg-red-50 p-3 text-sm text-red-700" }, error) : null,
      !loading && !error && !cases.length
        ? emptyState({ title: "You have no reports yet", hint: "A report appears here after your doctor's radiologist has reviewed it.", icon: "file-text" })
        : null,
      cases.length ? el("p", { class: "text-sm text-slate-600" }, "Choose a report to open.") : null,
      cases.length ? reportChoiceList({ cases, onSelect: choose }) : null
    ));
  }

  paint();
  load();
}
