// src/components/reportView.js
// Standalone report page opened in a popup window. Reads the case from
// MongoDB via ?view=report&caseId=... Doctors can edit and save; downloads
// always re-fetch the stored report first.

import { el, mount } from "../dom.js";
import { api } from "../api.js";
import { state, toast } from "../state.js";
import { unwrapLegacyReport } from "./review.js";
import { downloadReportDocx, downloadReportPdf, splitReportAndRemarks, applyRemarksToReport } from "../lib/reportExport.js";
import { svgIcon } from "./icons.js";
import { reportPopupUrl, isReportPopup, reportPopupCaseId } from "../lib/reportPopup.js";

export { reportPopupUrl, isReportPopup, reportPopupCaseId };

export async function renderReportViewPage({ target }) {
  const caseId = reportPopupCaseId();
  let stored = null;
  let error = "";
  let busy = false;
  let draftBody = "";
  let remarks = "";

  const canEdit = () =>
    stored &&
    state.user?.role !== "nurse" &&
    stored.status !== "finalized";

  const canRemark = () => stored && state.user?.role !== "nurse";

  async function load() {
    if (!caseId) {
      error = "No case id was given.";
      stored = null;
      return;
    }
    const data = await api.getCase(caseId);
    stored = unwrapLegacyReport(data.case || data);
    const split = splitReportAndRemarks(stored.reportText || "");
    draftBody = split.body;
    remarks = (stored.remarks || "").trim() || split.remarks;
    error = "";
  }

  try {
    await load();
  } catch (err) {
    error = err.message || "Could not load the report.";
  }

  let saveTimer = null;
  let persistChain = Promise.resolve();

  function hintMongo(text) {
    const n = document.getElementById("mongo-report-status");
    if (n) n.textContent = text;
  }

  function queuePersist() {
    if (!canRemark()) return;
    hintMongo("Saving to MongoDB…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      persist({ silent: true }).catch(() => {});
    }, 450);
  }

  async function persist({ silent } = {}) {
    if (!stored || !canRemark()) return;
    clearTimeout(saveTimer);
    const run = async () => {
      if (!silent) {
        busy = true;
        paint();
      }
      try {
        hintMongo("Saving to MongoDB…");
        const next = canEdit()
          ? applyRemarksToReport(draftBody, remarks)
          : { remarks: String(remarks || "").trim() };
        const updated = await api.updateCase(caseId, next);
        stored = unwrapLegacyReport(updated.case || { ...stored, ...next });
        const split = splitReportAndRemarks(stored.reportText || "");
        draftBody = split.body;
        remarks = stored.remarks || next.remarks || remarks;
        hintMongo(canEdit() ? "Report saved in MongoDB." : "Notes saved in MongoDB.");
        if (!silent) {
          toast(canEdit()
            ? "Report saved in MongoDB."
            : "Remarks saved. The finalized report was not changed.");
        }
      } catch (err) {
        hintMongo("");
        toast(err.message || "Could not save.");
        if (silent) throw err;
      } finally {
        if (!silent) {
          busy = false;
          paint();
        }
      }
    };
    const pending = persistChain.then(run, run);
    persistChain = pending.catch(() => {});
    return pending;
  }

  async function download(kind) {
    busy = true;
    paint();
    try {
      if (canRemark()) await persist({ silent: true });
      await load();
      if (!(stored?.reportText || "").trim()) {
        toast("No report has been saved for this case yet.");
        return;
      }
      if (kind === "docx") await downloadReportDocx(stored);
      else await downloadReportPdf(stored);
    } catch (err) {
      toast(err.message || "Download failed.");
    } finally {
      busy = false;
      paint();
    }
  }

  function paint() {
    const edit = canEdit();
    const root = el("main", { class: "mx-auto max-w-3xl px-5 py-7" },
      el("div", { class: "flex flex-wrap items-center justify-between gap-3" },
        el("div", {},
          el("h1", { class: "text-2xl font-bold text-slate-900" }, "Report"),
          stored && el("p", { class: "mt-1 text-slate-600" },
            stored.patientId || "", " · ",
            stored.age || "?", " years · ",
            stored.sex || "?",
            stored.caseId ? el("span", { class: "text-slate-400" }, " · ", stored.caseId) : null
          )
        ),
        el("div", { class: "flex gap-2 flex-wrap" },
          stored && el("button", {
            class: "inline-flex items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50",
            disabled: busy,
            onClick: () => download("docx"),
          }, svgIcon("download", { size: 16 }), "Word"),
          stored && el("button", {
            class: "inline-flex items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50",
            disabled: busy,
            onClick: () => download("pdf"),
          }, svgIcon("download", { size: 16 }), "PDF"),
          canRemark() && el("button", {
            class: "rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50",
            disabled: busy,
            onClick: () => persist(),
          }, busy ? "Saving…" : (edit ? "Save report" : "Save remarks")),
          el("button", {
            class: "rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50",
            onClick: () => window.close(),
          }, "Close")
        )
      ),
      error
        ? el("p", { class: "mt-6 rounded-xl bg-red-50 p-4 text-red-700" }, error)
        : el("section", { class: "card mt-5" },
            edit
              ? el("textarea", {
                  id: "report-body",
                  class: "input min-h-[360px] font-sans text-sm leading-6",
                  rows: 18,
                  onInput: (e) => { draftBody = e.target.value; queuePersist(); },
                }, draftBody)
              : el("pre", { class: "whitespace-pre-wrap font-sans text-sm leading-6 text-slate-800" },
                  draftBody || "No report has been saved for this case yet."
                ),
            el("div", { class: "mt-6 border-t border-slate-200 pt-4" },
              el("h2", { class: "text-sm font-semibold text-slate-700" }, "Radiologist remarks"),
              canRemark()
                ? el("textarea", {
                    id: "report-remarks",
                    class: "input mt-2 min-h-[120px] font-sans text-sm leading-6",
                    rows: 5,
                    placeholder: stored?.status === "finalized"
                      ? "Notes stay on this case. They are not added to the finalized report…"
                      : "Notes or extra findings to add to the report…",
                    onInput: (e) => { remarks = e.target.value; queuePersist(); },
                  }, remarks)
                : el("p", { class: "mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-800" },
                    remarks || "No remarks have been added."
                  )
            ),
            canRemark() && el("p", { class: "mt-3 text-xs text-slate-500" },
              stored?.status === "finalized"
                ? "The report is locked. Remarks are saved as notes only and are not written into the report, Word, or PDF."
                : "Every edit is saved to MongoDB on this case (reportText). Downloads always use that latest saved copy."
            ),
            canRemark() && el("p", { id: "mongo-report-status", class: "mt-1 text-xs font-medium text-cyan-700" })
          )
    );
    mount(target, root);
  }

  paint();
}
