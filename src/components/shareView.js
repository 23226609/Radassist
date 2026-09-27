// Public, no-login view of one finalized report. Opened from #/share/<token>.

import { el, mount } from "../dom.js";
import { api } from "../api.js";
import { state } from "../state.js";
import { svgIcon } from "./icons.js";
import { downloadReportDocx, downloadReportPdf, splitReportAndRemarks } from "../lib/reportExport.js";
import { patientDisplayName, doctorInCharge } from "../lib/tags.js";

function findingDetail(f) {
  const bits = [];
  if (f.sentence && f.sentence !== f.label) bits.push(f.sentence);
  if (f.location) bits.push(`Location: ${f.location}`);
  if (f.size) bits.push(`Size: ${f.size}`);
  if (f.pattern && f.pattern !== "Other") bits.push(`Pattern: ${f.pattern}`);
  return bits;
}

export async function renderSharePage({ target }) {
  const token = state.shareToken || "";
  let stored = null;
  let error = "";
  let busy = false;
  let imageSrc = token ? api.sharedImageUrl(token) : "";

  async function load() {
    if (!token) {
      error = "This share link is missing a token.";
      return;
    }
    const data = await api.getSharedCase(token);
    stored = data.case || data;
    error = "";
  }

  try {
    await load();
  } catch (err) {
    error = err.message || "This share link is invalid or has been turned off.";
  }

  async function download(kind) {
    if (!stored) return;
    busy = true;
    paint();
    try {
      if (kind === "docx") await downloadReportDocx({ ...stored, shareImageUrl: api.sharedImageUrl(token) });
      else await downloadReportPdf({ ...stored, shareImageUrl: api.sharedImageUrl(token) });
    } catch (err) {
      error = err.message || "Download failed.";
    } finally {
      busy = false;
      paint();
    }
  }

  function filmCard() {
    return el("section", { class: "self-start rounded-2xl bg-slate-950 p-4 text-white" },
      el("b", {}, "Chest X-Ray"),
      el("div", { class: "mt-3 flex justify-center overflow-hidden rounded-xl bg-gradient-to-b from-slate-500 to-slate-900" },
        imageSrc
          ? el("img", {
            src: imageSrc,
            alt: "Chest X-ray",
            class: "max-h-[420px] w-full object-contain",
            onError: () => { imageSrc = ""; paint(); },
          })
          : el("p", { class: "p-16 text-sm text-slate-300" }, "No image")
      )
    );
  }

  function findingsCard(findings) {
    if (!findings.length) return null;
    return el("section", { class: "card self-start max-h-[480px] overflow-y-auto" },
      el("h2", { class: "font-bold text-slate-900" }, "Findings"),
      el("ol", { class: "mt-3 space-y-3" },
        ...findings.map((f, i) => {
          const extra = findingDetail(f);
          return el("li", { class: "text-sm text-slate-700" },
            el("b", { class: "text-slate-900" }, `${i + 1}. ${f.label || "Finding"}`),
            extra.length
              ? el("div", { class: "mt-0.5 space-y-0.5 text-slate-600" },
                  ...extra.map((line) => el("p", {}, line))
                )
              : null
          );
        })
      )
    );
  }

  function reportCard(body) {
    return el("section", { class: "card" },
      el("div", { class: "flex flex-wrap items-center justify-between gap-2" },
        el("h2", { class: "font-bold text-slate-900" }, "Report"),
        el("div", { class: "flex gap-2" },
          el("button", {
            class: "rounded-xl border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50",
            disabled: busy,
            onClick: () => download("docx"),
          }, svgIcon("download", { size: 16 }), " Word"),
          el("button", {
            class: "rounded-xl border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50",
            disabled: busy,
            onClick: () => download("pdf"),
          }, svgIcon("download", { size: 16 }), " PDF")
        )
      ),
      el("pre", { class: "mt-4 max-w-3xl whitespace-pre-wrap font-sans text-sm leading-7 text-slate-800" },
        body || "No report text."
      )
    );
  }

  function paint() {
    const body = splitReportAndRemarks(stored?.reportText || "").body;
    const findings = (stored?.findings || []).filter((f) => f.status !== "rejected");
    const root = el("main", { class: "mx-auto max-w-5xl px-5 py-8" },
      el("p", { class: "text-xs font-semibold uppercase tracking-wider text-ha-blue" }, "Shared report"),
      el("h1", { class: "mt-1 text-3xl font-bold text-slate-900" }, "Chest X-ray report"),
      stored && el("p", { class: "mt-2 text-slate-600" },
        patientDisplayName(stored) || stored.patientId || "",
        " · ", stored.age || "?", " years · ", stored.sex || "?",
        stored.caseId ? el("span", { class: "text-slate-400" }, " · ", stored.caseId) : null
      ),
      stored && el("p", { class: "mt-1 text-sm text-slate-500" },
        "Doctor in charge: ",
        el("span", { class: "font-semibold text-slate-700" }, doctorInCharge(stored))
      ),
      el("p", { class: "mt-2 text-sm text-slate-500" },
        "Anyone with this link can view this finalized report. Sign in is not required."
      ),
      error
        ? el("p", { class: "mt-6 rounded-xl bg-red-50 p-4 text-red-700" }, error)
        : el("div", { class: "mt-6 flex flex-col gap-5" },
            el("div", { class: "grid items-start gap-5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]" },
              filmCard(),
              findingsCard(findings)
            ),
            reportCard(body)
          )
    );
    mount(target, root);
  }

  paint();
}
