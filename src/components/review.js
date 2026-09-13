// src/components/review.js
// Single-case review page.
//
// Workflow mirrors the original Radassist design:
//   1. AI gives us a free-text radiology report (markdown) in `reportText`
//      plus optional pre-structured findings in `findings`.
//   2. On first load we parse the report into finding cards so the clinician
//      can accept/reject them.  Already-parsed / AI-supplied findings are
//      never overwritten by the auto-parse.
//   3. The X-ray is mandatory — it always renders, with bbox overlays from
//      the findings.
//   4. The generated report lives in MongoDB (used by Azure to build
//      findings). It is not shown on this page — Download pulls it from
//      the server when someone wants a Word or PDF copy.
//
// Older cases persisted with `reportText` accidentally JSON-stringified
// (`{"report":"..."}`) are unwrapped once on load so the rest of this
// file can assume a clean markdown report.

import { el, mount } from "../dom.js";
import { state, setPage, toast } from "../state.js";
import { api } from "../api.js";
import { svgIcon } from "./icons.js";
import { downloadReportDocx, downloadReportPdf, applyRemarksToReport, splitReportAndRemarks } from "../lib/reportExport.js";

const PATTERNS = ["Nodular", "Diffuse", "Linear", "Ground-glass", "Consolidation", "Other"];

function confidenceTitle(f) {
  const parts = [];
  if (f?.languageScore != null) parts.push(`report wording ${Math.round(f.languageScore * 100)}%`);
  if (f?.imageSupport != null) parts.push(`image ${Math.round(f.imageSupport * 100)}%`);
  if (!parts.length) return "Clinician-adjustable confidence";
  return `From ${parts.join(" + ")}`;
}

// ---------------------------------------------------------------------------
// AI report parser — converts the markdown report produced by the AI into
// a list of finding cards the clinician can review. Best-effort heuristics:
//   1. Split on explicit numbered findings:  "Finding 1:",  "1." headers,
//      or markdown headings ("## 1. ...")
//   2. Fall back to splitting on section boundaries  ("**Finding**", "Impression")
//   3. Try to detect: location (lung field, lobe, anatomical phrase),
//      pattern keyword (one of PATTERNS), and size from the prose.
// Confidence is derived from how confident the parser is (more matches = higher).
// ---------------------------------------------------------------------------
const LOCATION_HINTS = [
  "right upper lobe", "left upper lobe", "right middle lobe", "right lower lobe",
  "left lower lobe", "right lung", "left lung", "both lungs", "right hilum",
  "left hilum", "mediastinum", "right cardiophrenic", "left cardiophrenic",
  "right costophrenic", "left costophrenic", "perihilar", "retrocardiac",
  "right apex", "left apex", "right base", "left base",
];
const SIZE_REGEX = /(about\s+)?([~]?\s*)([0-9]+(\.[0-9]+)?)\s*(cm|mm|centimeter|millimeter|millimetres?|centimeters?)/i;

function inferPattern(text) {
  const t = (text || "").toLowerCase();
  // Nodular first because sentences sometimes mention both nodule and consolidation
  if (/\bnodul|\bmass\b|\bcoin lesion\b|\bround(?!ed glass)/.test(t)) return "Nodular";
  if (/ground[- ]?glass|ggo/.test(t)) return "Ground-glass";
  if (/consolidat|air[- ]?space|airspace/.test(t)) return "Consolidation";
  if (/opacity|opacit/.test(t)) return "Consolidation";
  if (/linear|band|streak|septal|kerley/.test(t)) return "Linear";
  if (/diffus|scattered|bilateral|widespread|throughout/.test(t)) return "Diffuse";
  return "Other";
}

function detectLocation(text) {
  const low = (text || "").toLowerCase();
  for (const hint of LOCATION_HINTS) {
    if (low.includes(hint)) return hint.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  // Generic "lung field", "right lung", etc.
  const m = low.match(/\b(the\s+)?(right|left)\s+(lung|hilum|apex|base|hemithorax)\b/);
  if (m) return m[2] + " " + m[3];
  return "";
}

function detectSize(text) {
  const m = (text || "").match(SIZE_REGEX);
  if (!m) return "";
  return `${m[3]} ${m[5].toLowerCase().startsWith("cent") ? "cm" : m[5][0] + "m"}`;
}

function extractSection(block) {
  // Strip leading numbering ("1. ", "Finding 2:"), bold asterisks, etc.
  let b = (block || "").replace(/^\s*(\*{0,2})(finding\s*\d+|impression|conclusion|observations?|notes?)\s*\d*\s*[:.\-–]\s*/i, "");
  b = b.replace(/^\s*\d+\.\s+/, "");
  b = b.replace(/^[\*]+/, "").replace(/[\*]+$/, "").trim();
  return b;
}

// Strip markdown emphasis, heading marks, list markers and a trailing colon.
function stripMarkdown(line) {
  return (line || "")
    .replace(/^\s*#+\s*/, "")
    .replace(/^\s*(?:[-+*\u2022]\s+|\d+[.)]\s+)/, "")
    .replace(/\*+/g, "")
    .replace(/\s*:\s*$/, "")
    .trim();
}

// A line such as `**Lungs:**` introduces a section but is not itself a
// finding — the AI puts the actual observation on the bullets beneath it.
function isSectionLabel(line) {
  const raw = (line || "").trim();
  if (!raw || /[.!?]$/.test(raw)) return false;
  if (!/:\s*\**\s*$/.test(raw)) return false;
  return stripMarkdown(raw).length < 60;
}

// Separate a block into its section heading and the statements below it.
function splitBlock(block) {
  const lines = (block || "").split(/\n/).map((l) => l.trim()).filter(Boolean);
  const header = lines.length && isSectionLabel(lines[0]) ? stripMarkdown(lines[0]) : "";
  const body = (header ? lines.slice(1) : lines)
    .map(stripMarkdown)
    .filter((l) => l.length > 4);
  return { header, body };
}

function pickLabel(block) {
  // Prefer the first real observation; fall back to the section heading.
  const { header, body } = splitBlock(block);
  const statement = body
    .map((line) => line.split(/(?<=[.!?])\s+/)[0].trim())
    .find((s) => s.length > 4);
  const label = statement || header || "AI finding";
  return label.length > 80 ? label.slice(0, 77) + "…" : label;
}

export function parseFindingsFromReport(reportText, existingCount = 0) {
  if (!reportText || typeof reportText !== "string") return [];
  const text = reportText.trim();

  // Try numbered headers first:  lines starting with **Finding N:**, "Finding 1:"
  // or markdown headings "## 1. ..." / "### Finding ..."
  //
  // Original Radassist regex bug: the inner negative-lookahead used `\s*[:.\-–]`,
  // which never matched because `\s*` already greedily ate the space and the
  // character class didn't contain a space.  That made `1.\n2.\n3.` collapse
  // into a single block.  Adding the space into the class lets the lookahead
  // hit and split properly.
  const blocks = [];
  const numberedRx = /(?:^|\n)\s*(?:\*+\s*)?(?:finding\s*\d+|impression\s*\d*|observation\s*\d*|#{2,3}\s*\d+\.?|\d+\.)[:.\s\-–]+([^\n#]+(?:\n(?![*\s]*(?:\*+\s*)?(?:finding\s*\d+|impression|observation|\d+\.)\s*[:\s.\-–])[^\n#]+)*)/gi;
  let m;
  while ((m = numberedRx.exec(text)) !== null) {
    const block = (m[1] || "").trim();
    if (block.length > 10) blocks.push(block);
  }

  // Fallback: split on bold "**Finding**" / "**Impression**" sections.
  if (blocks.length === 0) {
    const sectionRx = /(\*+\s*(?:findings?|impression|observations?|conclusion|abnormalities?|recommendations?)\s*\*+[:.\s\-–]*)([\s\S]*?)(?=(\n\s*\n|\Z))/gi;
    let combined = "";
    while ((m = sectionRx.exec(text)) !== null) {
      combined += "\n" + (m[2] || "").trim();
    }
    if (combined.trim().length > 10) {
      // Split combined text into sentences/clauses at ". " or "; "
      const parts = combined
        .split(/(?<=[.!?])\s+|\n\s*[\-\u2022]\s*/)
        .map((s) => s.trim())
        .filter((s) => s.length > 20);
      parts.forEach((p) => blocks.push(p));
    }
  }

  // Last resort: split the whole text into sentences.
  if (blocks.length === 0) {
    text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 25 && !/^#{1,6}\s+/.test(s))
      .forEach((s) => blocks.push(s));
  }

  // De-dup near-identical blocks.
  const seen = new Set();
  const unique = blocks.filter((b) => {
    const k = b.toLowerCase().slice(0, 60);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const findings = unique.slice(0, 6).map((block, idx) => {
    const cleaned = extractSection(block);
    const pattern = inferPattern(cleaned);
    const location = detectLocation(cleaned);
    const size = detectSize(cleaned);
    // Keep the observations, not the section heading, as the quoted text.
    const { header, body } = splitBlock(cleaned);
    const sentence = (body.join(" ") || header).slice(0, 240);
    // Confidence: higher when we found strong signals.
    let conf = 0.45;
    if (location) conf += 0.15;
    if (pattern !== "Other") conf += 0.15;
    if (size) conf += 0.1;
    conf = Math.min(0.95, Math.max(0.3, conf));

    return {
      _id: "ai-" + Date.now() + "-" + idx + "-" + Math.random().toString(16).slice(2, 6),
      id: "ai-" + (idx + existingCount),
      label: pickLabel(cleaned),
      confidence: Number(conf.toFixed(2)),
      bbox: [10 + idx * 12, 10 + idx * 8, 18, 18],
      location,
      size,
      pattern,
      sentence,
      status: "pending",
      source: "AI",
    };
  });

  return findings;
}

// ---------------------------------------------------------------------------
// Backwards-compat: older / dev-environment cases persisted the AI's raw
// JSON payload as a string in `reportText` (e.g. `{"report":"1. ... ###"}`)
// and left `findings` empty.  Detect that shape and unwrap so the rest of
// this file sees a clean markdown report.  This is purely a one-shot data
// fixup — it does NOT change how new AI reports are rendered.
// ---------------------------------------------------------------------------
export function unwrapLegacyReport(raw) {
  if (!raw || typeof raw.reportText !== "string") return raw;
  const rt = raw.reportText.trim();
  // Only treat as the legacy wrapper if it starts with `{"` and contains `"report"`.
  if (!rt.startsWith("{") || !rt.includes('"report"')) return raw;
  let parsed;
  try { parsed = JSON.parse(rt); } catch { return raw; }
  if (!parsed || typeof parsed !== "object" || typeof parsed.report !== "string") return raw;
  return { ...raw, reportText: parsed.report };
}

// Cache of imageId -> object URL so we don't re-fetch on every render().
const _imageCache = new Map();
// Module-level so a toast / session refresh doesn't re-run Azure and remount
// the remarks box the clinician is typing in.
let autoFilledCaseId = null;
async function getImageObjectUrl(imageId) {
  if (!imageId) return null;
  if (_imageCache.has(imageId)) return _imageCache.get(imageId);
  try {
    const blob = await api.fetchImage(imageId);
    const objUrl = URL.createObjectURL(blob);
    _imageCache.set(imageId, objUrl);
    return objUrl;
  } catch (err) {
    console.warn("[review] image load failed:", err.message);
    return null;
  }
}

export async function renderReviewPage({ target }) {
  // Local working copy.  Support both caseId (new) and _id (legacy).
  let localCase = state.cases.find(
    (c) => c.caseId === state.selectedCaseId || c._id === state.selectedCaseId
  );
  let busy = false;
  let msg = "";
  let imageSrc = null; // resolved object URL once the blob is fetched
  let carouselIndex = 0; // which finding card the carousel is showing
  let remarksDraft = "";
  let remarksDirty = false;

  // Effective case ID that works with both caseId (new) and _id (legacy)
  const getEffectiveCaseId = () => localCase?.caseId || localCase?._id;

  function syncRemarksFromCase() {
    const split = splitReportAndRemarks(localCase?.reportText || "");
    remarksDraft = (localCase?.remarks || "").trim() || split.remarks;
    remarksDirty = false;
  }

  // Pull findings out of the AI's markdown report and append them as cards,
  // client-side only (not saved until the clinician hits "Save draft").
  // Used as the fallback when Azure isn't available — see autoPopulateFindings.
  function fillFromLocalParser() {
    if (!localCase) return;
    const report = localCase.reportText || "";
    if (!report.trim()) return;
    const existing = localCase.findings || [];
    const parsed = parseFindingsFromReport(report, 0);
    if (parsed.length === 0) return;
    localCase = { ...localCase, findings: [...existing, ...parsed] };
  }

  // Runs once per case, right after it loads: summarises the report into a
  // few grouped cards with Azure AI so the clinician never has to click the
  // button themselves. Idempotent — skips if AI/Azure findings already
  // exist, so re-opening an already-summarised case doesn't call Azure again
  // or duplicate cards.
  async function autoPopulateFindings() {
    if (!localCase) return;
    const report = localCase.reportText || "";
    if (!report.trim()) return;

    const existing = localCase.findings || [];
    // Skip only when Azure has already produced cards for this case. Old
    // Azure cards (no bboxSource) and local-parser cards are re-run so the
    // boxes get placed on the film instead of the leftover placeholders.
    const azureReady = existing.some(
      (f) => f.source === "Azure" &&
        (f.bboxSource === "vision" || f.bboxSource === "zone") &&
        f.confidenceSource === "calibrated"
    );
    if (azureReady) return;

    // Matches the backend route's own authorization (doctor/admin) and
    // avoids mutating a finalized case's saved findings.
    const canUseAzure = ["doctor", "admin"].includes(state.user?.role) &&
      localCase.status !== "finalized";

    if (canUseAzure) {
      try {
        const data = await api.summariseFindings(getEffectiveCaseId());
        localCase = data.case || localCase;
        const idx = state.cases.findIndex(
          (c) => c.caseId === (localCase.caseId || localCase._id) || c._id === localCase._id
        );
        if (idx >= 0) state.cases[idx] = localCase;
        return;
      } catch (err) {
        // Most common cause: AZURE_OPENAI_* isn't configured on the server,
        // which throws a 400 with a clear message — not an error worth
        // alarming the clinician with on every page they open. Fall back
        // to the local parser below instead.
        console.warn("[review] Azure auto-summarise skipped:", err.message);
      }
    }
    fillFromLocalParser();
  }

  async function refreshFromServer() {
    const caseId = getEffectiveCaseId();
    if (!caseId) return;
    try {
      const data = await api.getCase(caseId);
      localCase = data.case || data;
      // One-shot fixup: unwrap the legacy `{"report":"..."}` string shape.
      localCase = unwrapLegacyReport(localCase);
      syncRemarksFromCase();
      // Sync the cache so the rest of the app sees the same case.
      const idx = state.cases.findIndex(
        (c) => c.caseId === (localCase.caseId || localCase._id) || c._id === localCase._id
      );
      if (idx >= 0) state.cases[idx] = localCase;
      // Resolve image to a blob URL the <img> tag can use (auth header handled by fetch).
      if (localCase.imageId) {
        imageSrc = await getImageObjectUrl(localCase.imageId);
        // If GridFS returned 404 (orphan imageId), drop the imageId so the
        // X-ray panel falls back to "No image" instead of "Loading image…".
        if (!imageSrc) localCase = { ...localCase, imageId: null };
      } else {
        imageSrc = null;
      }
      render();
    } catch (err) {
      toast(err.message);
    }
  }

  if (!localCase) {
    // Try fetching from server if not in cache
    try {
      const list = await api.listCases({});
      state.cases = list.cases || [];
      localCase = state.cases.find(
        (c) => c.caseId === state.selectedCaseId || c._id === state.selectedCaseId
      );
      if (localCase) {
        // Normalize: ensure we have caseId for consistent handling
        state.selectedCaseId = localCase.caseId || localCase._id;
      } else if (state.selectedCaseId) {
        // Try to fetch the case directly from the server
        try {
          const data = await api.getCase(state.selectedCaseId);
          localCase = data.case || data;
          if (localCase) {
            state.cases = [localCase, ...state.cases];
            state.selectedCaseId = localCase.caseId || localCase._id;
          }
        } catch {
          // Fall through to "not found" message
        }
      }
    } catch (err) {
      target.appendChild(el("p", { class: "p-8 text-red-700" }, "Backend unreachable: " + err.message));
      return;
    }
  }

  if (!localCase) {
    target.appendChild(el("p", { class: "p-8 text-slate-500" }, "Case not found. Please go back to dashboard and select a case."));
    return;
  }
  // One-shot fixup on the initial case too (covers the path where the case
  // came from the local cache rather than a fresh /cases/:id fetch).
  localCase = unwrapLegacyReport(localCase);
  syncRemarksFromCase();

  function patchFinding(id, patch, { refresh = false } = {}) {
    localCase = {
      ...localCase,
      findings: (localCase.findings || []).map((f) => (f._id === id || f.id === id ? { ...f, ...patch } : f)),
    };
    // Text fields keep their own caret — remounting on every keystroke made
    // the remarks box and finding inputs feel like they wouldn't accept typing.
    if (refresh) render();
  }

  function addFinding() {
    // Generate a stable-ish temp id so the in-memory list works before save.
    const tempId = "tmp-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8);
    const newFinding = {
      _id: tempId,
      id: tempId,
      label: "New finding",
      confidence: 0.5,
      bbox: [10, 10, 20, 20],
      location: "",
      size: "",
      pattern: "Other",
      sentence: "",
      status: "pending",
    };
    localCase = { ...localCase, findings: [...(localCase.findings || []), newFinding] };
    render();
  }

  function removeFinding(id) {
    localCase = {
      ...localCase,
      findings: (localCase.findings || []).filter((f) => !(f._id === id || f.id === id)),
    };
    render();
  }

  async function saveDraft() {
    busy = true; render();
    try {
      const updated = await api.updateCase(getEffectiveCaseId(), {
        diagnosis: localCase.diagnosis,
        reportText: localCase.reportText,
        findings: localCase.findings,
      });
      localCase = updated.case || updated;
      msg = "Draft saved.";
      toast(msg);
    } catch (err) {
      msg = err.message;
      toast(msg);
    } finally { busy = false; render(); }
  }

  async function finalize() {
    if (!confirm("Finalize this report? Finalized cases are read-only for clinicians.")) return;
    busy = true; render();
    try {
      // Save findings + text first, then finalize
      await api.updateCase(getEffectiveCaseId(), {
        diagnosis: localCase.diagnosis,
        reportText: localCase.reportText,
        findings: localCase.findings,
      });
      const data = await api.finalizeCase(getEffectiveCaseId());
      localCase = data.case || data;
      msg = "Report finalized and approved.";
      toast(msg);
    } catch (err) {
      msg = err.message;
      toast(msg);
    } finally { busy = false; render(); }
  }

  function openReport() {
    const id = getEffectiveCaseId();
    if (!id) {
      toast("This case has no id yet.");
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("view", "report");
    url.searchParams.set("caseId", id);
    const popup = window.open(
      url.toString(),
      "radassist-report",
      "popup=yes,width=820,height=920,scrollbars=yes,resizable=yes"
    );
    if (!popup) toast("Allow popups to open the report in a new window.");
  }

  async function saveRemarks() {
    busy = true;
    render();
    try {
      const data = await api.getCase(getEffectiveCaseId());
      const stored = unwrapLegacyReport(data.case || data);
      const note = String(remarksDraft || "").trim();
      // Finalized reports are locked. Remarks still save on the case, but
      // they are not copied into reportText / Word / PDF.
      const next = stored.status === "finalized"
        ? { remarks: note }
        : { ...applyRemarksToReport(stored.reportText, note), findings: localCase.findings };
      const updated = await api.updateCase(getEffectiveCaseId(), next);
      localCase = updated.case || { ...localCase, ...next };
      remarksDraft = localCase.remarks || note;
      remarksDirty = false;
      msg = stored.status === "finalized"
        ? "Remarks saved. The finalized report was not changed."
        : "Remarks saved and added to the report.";
      toast(msg);
    } catch (err) {
      msg = err.message;
      toast(msg);
    } finally {
      busy = false;
      render();
    }
  }

  async function download(kind) {
    busy = true;
    render();
    try {
      // Persist any unsaved remarks, then read the report back from MongoDB
      // so Word/PDF always match the latest stored copy.
      const data = await api.getCase(getEffectiveCaseId());
      let stored = unwrapLegacyReport(data.case || data);
      const isNurse = state.user?.role === "nurse";
      if (!isNurse && remarksDirty) {
        const note = String(remarksDraft || "").trim();
        const next = stored.status === "finalized"
          ? { remarks: note }
          : { ...applyRemarksToReport(stored.reportText, note), findings: localCase.findings };
        const updated = await api.updateCase(getEffectiveCaseId(), next);
        stored = unwrapLegacyReport(updated.case || { ...stored, ...next });
        localCase = { ...localCase, reportText: stored.reportText, remarks: stored.remarks ?? note };
        remarksDraft = localCase.remarks || note;
        remarksDirty = false;
      }
      if (!(stored.reportText || "").trim()) {
        toast("No report has been saved for this case yet.");
        return;
      }
      if (kind === "docx") await downloadReportDocx(stored);
      else await downloadReportPdf(stored);
    } catch (err) {
      toast(err.message || "Download failed.");
    } finally {
      busy = false;
      render();
    }
  }

  function render() {
    const edit = state.user?.role !== "nurse" && localCase.status !== "finalized";
    const canRemark = state.user?.role !== "nurse";
    const findings = localCase.findings || [];
    const visible = findings;

    function findingCard(f) {
      const isNew = String(f._id || f.id || "").startsWith("tmp-");
      return el("article", {
        class: "card mb-3",
        dataset: { id: f._id || f.id },
      },
        el("div", { class: "flex justify-between items-start gap-2" },
          el("div", { class: "flex-1" },
            el("div", { class: "flex items-center gap-2" },
              el("small", { class: "font-bold text-cyan-700 text-xs" }, isNew ? "NEW FINDING (unsaved)" : `FINDING ${f._id || f.id}`),
            ),
            edit
              ? el("input", {
                  id: `finding-label-${f._id || f.id}`,
                  class: "mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1 outline-none focus:border-cyan-600 font-bold text-slate-900",
                  value: f.label || "",
                  onInput: (e) => patchFinding(f._id || f.id, { label: e.target.value }),
                })
              : el("h3", { class: "font-bold text-slate-900" }, f.label)
          ),
          el("div", { class: "flex flex-col items-end gap-2" },
            el("b", {
              class: "rounded-full bg-cyan-50 px-3 py-0.5 text-cyan-700 text-sm",
              title: confidenceTitle(f),
            }, `${Math.round((f.confidence ?? 0) * 100)}%`),
            edit && isNew && el("button", {
              class: "text-xs text-red-600 hover:text-red-800",
              onClick: () => removeFinding(f._id || f.id),
            }, "Remove")
          )
        ),
        !edit ? null : el("div", { class: "mt-3 grid grid-cols-2 gap-2" },
          ...["location", "size"].map((k) =>
            el("label", { class: "block" },
              el("span", { class: "text-xs font-semibold text-slate-500 capitalize" }, k),
              el("input", {
                id: `finding-${k}-${f._id || f.id}`,
                class: "mt-1 w-full rounded-xl border border-slate-300 bg-white px-2 py-1.5 outline-none focus:border-cyan-600",
                value: f[k] || "",
                onInput: (e) => patchFinding(f._id || f.id, { [k]: e.target.value }),
              })
            )
          )
        ),
        el("label", { class: "block mt-3" },
          el("span", { class: "text-xs font-semibold text-slate-500 capitalize" }, "Pattern"),
          el("select", {
            disabled: !edit,
            class: "mt-1 w-full rounded-xl border border-slate-300 bg-white px-2 py-1.5 outline-none focus:border-cyan-600 disabled:bg-slate-100",
            value: f.pattern || "Other",
            onChange: (e) => patchFinding(f._id || f.id, { pattern: e.target.value }, { refresh: true }),
          },
            ...PATTERNS.map((p) => el("option", { value: p }, p))
          )
        )
      );
    }

    // Findings shown one at a time with prev/next and dot indicators, so a
    // long list of AI findings doesn't push the report off the screen.
    function findingsCarousel(items) {
      if (carouselIndex > items.length - 1) carouselIndex = items.length - 1;
      if (carouselIndex < 0) carouselIndex = 0;

      const go = (i) => {
        carouselIndex = (i + items.length) % items.length;
        render();
      };

      return el("div", {},
        el("div", { class: "flex items-center justify-between gap-2" },
          el("b", { class: "text-slate-900" }, "Findings"),
          el("span", { class: "text-xs font-semibold text-slate-500" },
            `${carouselIndex + 1} of ${items.length}`
          )
        ),

        el("div", { class: "mt-3 flex items-stretch gap-2" },
          el("button", {
            class: "shrink-0 rounded-xl border border-slate-300 px-2 text-slate-600 hover:bg-slate-50 disabled:opacity-40",
            disabled: items.length < 2,
            title: "Previous finding",
            onClick: () => go(carouselIndex - 1),
          }, svgIcon("arrow-left", { size: 16 })),

          el("div", { class: "min-w-0 flex-1" }, findingCard(items[carouselIndex])),

          el("button", {
            class: "shrink-0 rounded-xl border border-slate-300 px-2 text-slate-600 hover:bg-slate-50 disabled:opacity-40 rotate-180",
            disabled: items.length < 2,
            title: "Next finding",
            onClick: () => go(carouselIndex + 1),
          }, svgIcon("arrow-left", { size: 16 }))
        ),

        items.length > 1 && el("div", { class: "mt-1 flex flex-wrap justify-center gap-1.5" },
          ...items.map((f, i) =>
            el("button", {
              class: `h-2.5 rounded-full transition-all ${i === carouselIndex ? "w-6 bg-cyan-600" : "w-2.5 bg-slate-300 hover:bg-slate-400"}`,
              title: `${i + 1}. ${f.label || "Finding"}`,
              onClick: () => go(i),
            })
          )
        )
      );
    }

    const _imageSrc = imageSrc;

    const root = el(
      "main",
      { class: "mx-auto max-w-[1450px] px-5 py-7" },
      el("button", {
        class: "inline-flex items-center gap-1 text-slate-700 hover:text-slate-900",
        onClick: () => setPage("dashboard"),
      }, svgIcon("arrow-left", { size: 16 }), "Dashboard"),

      el("div", { class: "mt-3 flex flex-wrap items-center justify-between gap-3" },
        el("div", {},
          el("h1", { class: "text-3xl font-bold text-slate-900" }, "Report review"),
          el("p", { class: "text-slate-600 mt-1" },
            el("button", {
              class: "font-semibold hover:text-cyan-700 hover:underline",
              onClick: () => {
                state.selectedPatientId = localCase.patientId;
                setPage("patient");
              },
            }, localCase.patientId),
            " · ",
            localCase.age || "?", " years · ",
            localCase.sex || "?"
          ),
          el("p", { class: "text-xs text-slate-500 mt-1" },
            "MongoDB case id: ", el("span", { class: "font-mono" }, localCase.caseId || localCase._id || ""),
            localCase.imageId ? el("span", {}, " · image: ", el("span", { class: "font-mono" }, String(localCase.imageId).slice(-8))) : null
          )
        ),
        el("div", { class: "flex gap-2 flex-wrap" },
          el("button", {
            class: "inline-flex items-center gap-1 rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50",
            disabled: busy,
            onClick: openReport,
          }, svgIcon("file-text", { size: 16 }), "Report"),
          el("button", {
            class: "inline-flex items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50",
            disabled: busy,
            onClick: () => download("docx"),
          }, svgIcon("download", { size: 16 }), "Word"),
          el("button", {
            class: "inline-flex items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50",
            disabled: busy,
            onClick: () => download("pdf"),
          }, svgIcon("download", { size: 16 }), "PDF"),
          edit && el("button", {
            class: "rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50",
            disabled: busy,
            onClick: saveDraft,
          }, "Save draft"),
          edit && el("button", {
            class: "rounded-xl bg-green-600 px-3 py-2 text-sm font-semibold text-white hover:bg-green-700",
            disabled: busy,
            onClick: finalize,
          }, "Finalize & approve"),
          localCase.status === "finalized"
            ? el("span", { class: "rounded-full bg-green-50 text-green-700 px-3 py-1 text-xs font-bold" }, "FINALIZED")
            : null
        )
      ),

      msg && el("p", { class: "mt-4 rounded-lg bg-green-50 text-green-700 p-3" }, msg),

      // Image + findings — the report itself stays in MongoDB and is only
      // pulled out when someone downloads it.
      el("div", { class: "mt-5 grid gap-5 xl:grid-cols-2" },
        // X-ray image w/ bbox overlays
        el("section", { class: "rounded-2xl bg-slate-950 p-4 text-white" },
          el("div", { class: "flex items-baseline gap-2" },
            el("b", {}, "Chest X-Ray"),
            el("span", { class: "text-xs text-slate-400" }, _imageSrc ? "· loaded from MongoDB GridFS" : "")
          ),
          el("div", { class: "mt-3 flex justify-center rounded-xl bg-gradient-to-b from-slate-500 to-slate-900" },
            el("div", { class: "relative inline-block max-w-full" },
              _imageSrc
                ? el("img", { src: _imageSrc, class: "block max-h-[560px] max-w-full h-auto w-auto", alt: "Chest X-ray" })
                : el("div", { class: "flex h-[320px] w-full min-w-[240px] items-center justify-center text-slate-300 text-sm" }, localCase.imageId ? "Loading image…" : "No image"),
              visible.length > 0 && visible.map((f, i) =>
                el("button", {
                  class: `absolute border-2 ${i === carouselIndex ? "border-yellow-300 bg-yellow-300/25" : "border-cyan-400 bg-cyan-300/20 hover:bg-yellow-300/30 hover:border-yellow-300"}`,
                  style: {
                    left: (f.bbox?.[0] ?? 0) + "%",
                    top: (f.bbox?.[1] ?? 0) + "%",
                    width: (f.bbox?.[2] ?? 10) + "%",
                    height: (f.bbox?.[3] ?? 10) + "%",
                  },
                  title: f.label,
                  onClick: () => { carouselIndex = i; render(); },
                },
                  el("span", { class: "absolute -top-5 left-0 bg-black px-1 text-xs text-white" }, `F${i + 1}`)
                )
              )
            )
          )
        ),

        el("section", { class: "flex flex-col gap-5" },
          findings.length === 0
            ? el("div", { class: "card text-center text-slate-500" },
                el("p", {}, busy
                  ? "Summarising findings…"
                  : "No findings yet — they will be summarised from the saved report, or add one by hand."),
                edit && !busy && el("div", { class: "mt-3 flex flex-wrap items-center justify-center gap-2" },
                  el("button", {
                    class: "inline-flex items-center gap-1 rounded-xl border border-cyan-600 px-4 py-2 text-sm font-semibold text-cyan-700 hover:bg-cyan-50",
                    onClick: addFinding,
                  }, "+ Add manually"),
                )
              )
            : el("div", { class: "card" },
                findingsCarousel(visible),
                edit && el("button", {
                  class: "mt-2 w-full rounded-xl border border-cyan-600 px-3 py-2 text-sm font-semibold text-cyan-700 hover:bg-cyan-50",
                  onClick: addFinding,
                }, "+ Add manually")
              ),
          el("div", { class: "card flex-1" },
            el("div", { class: "flex flex-wrap items-center justify-between gap-2" },
              el("h2", { class: "text-lg font-bold text-slate-900" }, "Remarks"),
              canRemark && el("button", {
                class: "rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50",
                disabled: busy,
                onClick: saveRemarks,
              }, "Save remarks")
            ),
            el("textarea", {
              id: "remarks-box",
              class: "input mt-3 min-h-[180px]",
              rows: 8,
              readOnly: !canRemark,
              placeholder: localCase.status === "finalized"
                ? "Notes stay on this case. They are not added to the finalized report…"
                : "Notes or extra findings to add to the report…",
              onInput: (e) => { remarksDraft = e.target.value; remarksDirty = true; },
            }, remarksDraft),
            el("p", { class: "mt-2 text-xs text-slate-500" },
              localCase.status === "finalized"
                ? "This case is finalized. Remarks are saved as notes only and are not written into the report, Word, or PDF."
                : "Saving adds these remarks to the stored report. Word and PDF always download that latest saved copy."
            )
          )
        )
      )
    );

    mount(target, root);
  }

  await refreshFromServer();

  // First time we view this case, automatically summarise the report into
  // findings — Azure AI first, falling back to the local text parser — so
  // the clinician never has to click a button. Guarded by autoFilledCaseId,
  // and autoPopulateFindings itself skips once real findings already exist,
  // so this can't re-trigger on every re-render or re-summarise on reopen.
  if (localCase && autoFilledCaseId !== (localCase.caseId || localCase._id)) {
    autoFilledCaseId = localCase.caseId || localCase._id;
    busy = true;
    msg = "Summarising findings…";
    render();
    await autoPopulateFindings();
    busy = false;
    msg = "";
  }

  render();
}
