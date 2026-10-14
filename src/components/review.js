// src/components/review.js
// Single-case review page: the film and the report, as a reading room shows them.
//
//   1. CURV writes the report. It is shown here as written; edits happen in
//      the Report popup.
//   2. After the draft is stored, Azure reads the report and the film and
//      places labelled boxes on the film. It does not change the report.
//      `boxesState` is "running" while that happens.
//
// Older cases persisted with `reportText` accidentally JSON-stringified
// (`{"report":"..."}`) are unwrapped once on load so the rest of this
// file can assume a clean report.

import { el, mount } from "../dom.js";
import { state, setPage, toast } from "../state.js";
import { api, clearFilmSpacingAdjust, filmSpacingAdjust } from "../api.js";
import { svgIcon } from "./icons.js";
import { reportPopupUrl } from "../lib/reportPopup.js";
import { downloadReportDocx, downloadReportPdf, composeReportText, splitReportAndRemarks, withoutThinking, normalizeReportShape } from "../lib/reportExport.js";
import { dedupeFindings } from "../lib/findingsSync.js";
import { urgentBadge, patientDisplayName, doctorInCharge } from "../lib/tags.js";
import { isGenerating, isAwaitingApprove, isAwaitingAi, statusLabel } from "../lib/caseStatus.js";
import { forgetCases } from "../lib/records.js";
import { CASES_CHANGED, startAnalysisWatch } from "../lib/analysisJob.js";
import { canEditReport, canRunAi, canExport, isReferringDoctor } from "../lib/roles.js";

let reviewLive = null;
let reviewWatchId = "";

function newAbort() {
  return typeof AbortController === "function"
    ? new AbortController()
    : { abort() {}, signal: { aborted: false } };
}

function isAbortError(err) {
  return err?.name === "AbortError" || err?.code === 20;
}

export function stopReviewWatch() {
  reviewLive?.abort();
  reviewWatchId = "";
}

try {
  window.addEventListener(CASES_CHANGED, (ev) => {
    const ids = (ev.detail?.ids || []).map(String);
    if (reviewWatchId && ids.includes(String(reviewWatchId))) {
      stopReviewWatch();
    }
  });
} catch { /* tests */ }

const FILM_BOX_COLORS = [
  { border: "border-yellow-300", fill: "bg-yellow-300/30", handle: "border-yellow-100 bg-yellow-300", chip: "bg-yellow-400", name: "yellow" },
  { border: "border-cyan-300", fill: "bg-cyan-300/30", handle: "border-cyan-100 bg-cyan-300", chip: "bg-cyan-400", name: "cyan" },
  { border: "border-rose-400", fill: "bg-rose-400/30", handle: "border-rose-200 bg-rose-400", chip: "bg-rose-400", name: "rose" },
  { border: "border-lime-300", fill: "bg-lime-300/30", handle: "border-lime-100 bg-lime-300", chip: "bg-lime-400", name: "lime" },
  { border: "border-violet-400", fill: "bg-violet-400/30", handle: "border-violet-200 bg-violet-400", chip: "bg-violet-400", name: "violet" },
  { border: "border-orange-400", fill: "bg-orange-400/25", handle: "border-orange-200 bg-orange-400", chip: "bg-orange-400", name: "orange" },
];

function filmBoxColor(index, total) {
  if (total <= 1) return FILM_BOX_COLORS[0];
  return FILM_BOX_COLORS[index % FILM_BOX_COLORS.length];
}

function hasBbox(f) {
  return Array.isArray(f?.bbox) && f.bbox.length === 4
    && Number(f.bbox[2]) > 0 && Number(f.bbox[3]) > 0;
}

function eventToPct(e, el) {
  const r = el.getBoundingClientRect();
  const w = r.width || 1;
  const h = r.height || 1;
  return {
    x: Math.min(100, Math.max(0, ((e.clientX - r.left) / w) * 100)),
    y: Math.min(100, Math.max(0, ((e.clientY - r.top) / h) * 100)),
  };
}

// Azure boxes for abnormal findings. Normal statements ("clear lungs") and
// older locally parsed findings have no real position, so they are not drawn.
function filmBoxes(findings) {
  return (findings || []).filter((f) => f?.source === "Azure" && f.severity !== "normal" && hasBbox(f));
}

// ---------------------------------------------------------------------------
// AI report parser — splits a report into finding statements. Best-effort heuristics:
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
  "upper lobes", "mid lung", "lung area",
];
const SIZE_REGEX = /(about\s+)?([~]?\s*)([0-9]+(\.[0-9]+)?)\s*(cm|mm|centimeter|millimeter|millimetres?|centimeters?)/i;

function inferPattern(text) {
  const t = (text || "").toLowerCase();
  // Nodular first because sentences sometimes mention both nodule and consolidation
  if (/\bnodul|\bmass\b|\bcoin lesion\b|\bround(?!ed glass)/.test(t)) return "Nodular";
  if (/white-?out|opaque hemithorax|complete opacif/.test(t)) return "Diffuse";
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

function shortFindingLabel(text) {
  let s = String(text || "").replace(/\s+/g, " ").trim();
  s = s.replace(/^(the\s+)?(chest\s+x-?ray|study|film|examination)\s+(demonstrates|shows|reveals|indicates|findings are)\s+/i, "");
  s = s.replace(/^(there\s+is|there\s+are)\s+/i, "");
  s = s.split(/\s+(?:without|with no|but\b|which\b|and there is|and there are)\s+/i)[0];
  s = s.split(",")[0].trim().replace(/[.!?]+$/, "");
  if (s.length > 60) s = s.slice(0, 57).trim() + "…";
  if (s.length < 3) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function pickLabel(block) {
  // Prefer the first real observation; fall back to the section heading.
  const { header, body } = splitBlock(block);
  const statement = body
    .map((line) => line.split(/(?<=[.!?])\s+/)[0].trim())
    .find((s) => s.length > 4);
  const label = shortFindingLabel(statement) || shortFindingLabel(header) || "AI finding";
  return label.length > 80 ? label.slice(0, 77) + "…" : label;
}

function isBoilerplateLine(line) {
  return /^(radiology report|chest x-?ray( examination)?|patient id|age|sex|date of examination|examiner|description of findings|conclusion|impression|clinician-added findings|radiologist remarks)\b/i.test(String(line || "").trim());
}

function findingsProse(text) {
  const src = String(text || "");
  const stop = "conclusion|impression|thinking|reasoning|recommendation|clinician-added findings|radiologist remarks";
  const section = src.match(new RegExp(`(?:description of findings|findings)\\s*:?\\s*\\n([\\s\\S]*?)(?=\\n\\s*(?:${stop})\\s*:?\\s*(?:\\n|$)|$)`, "i"));
  if (section?.[1]?.trim()) return section[1].trim();
  const colon = src.match(new RegExp(`(?:description of findings|findings)\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:${stop})\\s*:|$)`, "i"));
  if (colon?.[1]?.trim()) return colon[1].trim();
  return src;
}

function splitFindingUnits(text) {
  return String(text || "")
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && !isBoilerplateLine(s) && !/^#{1,6}\s+/.test(s));
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

  // Prose reports (CURV / edited popup drafts): use Description of Findings,
  // not the patient header or the conclusion. Include short added lines such
  // as "Lung cancer in lung area."
  if (blocks.length === 0) {
    splitFindingUnits(findingsProse(text)).forEach((s) => blocks.push(s));
  }

  // Last resort: split the whole text into sentences.
  if (blocks.length === 0) {
    splitFindingUnits(text).forEach((s) => blocks.push(s));
  }

  // De-dup near-identical blocks.
  const seen = new Set();
  const unique = blocks.filter((b) => {
    const k = b.toLowerCase().slice(0, 60);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const findings = unique.slice(0, 12).map((block, idx) => {
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
const _imageFlights = new Map();
export async function resyncMachineFindings(caseId, stored) {
  if (!caseId || !stored || stored.status === "finalized") return stored;
  try {
    const data = await api.summariseFindings(caseId);
    return unwrapLegacyReport(data.case || stored);
  } catch {
    return stored;
  }
}

async function getImageObjectUrl(imageId) {
  if (!imageId) return null;
  const key = String(imageId);
  if (_imageCache.has(key)) return _imageCache.get(key);
  if (_imageFlights.has(key)) return _imageFlights.get(key);
  const job = (async () => {
    try {
      const blob = await api.fetchImage(key);
      const objUrl = URL.createObjectURL(blob);
      _imageCache.set(key, objUrl);
      return objUrl;
    } catch (err) {
      console.warn("[review] image load failed:", err.message);
      return null;
    } finally {
      _imageFlights.delete(key);
    }
  })();
  _imageFlights.set(key, job);
  return job;
}

export async function renderReviewPage({ target }) {
  reviewLive?.abort();
  reviewLive = newAbort();
  const { signal } = reviewLive;
  let leaving = false;

  // Local working copy.  Support both caseId (new) and _id (legacy).
  let localCase = state.cases.find(
    (c) => c.caseId === state.selectedCaseId || c._id === state.selectedCaseId
  );
  let busy = false;
  let msg = "";
  let imageSrc = null; // resolved object URL once the blob is fetched
  let showBoxes = true;
  let boxDrag = null;
  let zoom = 1;
  let filmTool = "view";
  let measureLine = null;
  let remarksDraft = "";
  let remarksDirty = false;
  let reportDirty = false;
  let bodyDraft = "";
  let bodyDirty = false;
  let openLogKey = "";
  let genPoll = null;

  // Effective case ID that works with both caseId (new) and _id (legacy)
  const getEffectiveCaseId = () => localCase?.caseId || localCase?._id || state.selectedCaseId;
  reviewWatchId = String(getEffectiveCaseId() || "");

  function leaveMissingCase() {
    if (leaving || signal.aborted) return;
    leaving = true;
    reviewLive.abort();
    reviewWatchId = "";
    toast("This case is no longer available.");
    forgetCases([getEffectiveCaseId()].filter(Boolean));
  }

  function syncRemarksFromCase() {
    const split = splitReportAndRemarks(localCase?.reportText || "");
    remarksDraft = (localCase?.remarks || "").trim() || split.remarks;
    remarksDirty = false;
    bodyDraft = normalizeReportShape(split.body);
    bodyDirty = false;
  }

  function placingBoxes(c) {
    return c?.boxesState === "running";
  }

  function stopGeneratingWatch() {
    if (genPoll) clearInterval(genPoll);
    genPoll = null;
  }

  function watchGenerating() {
    if (genPoll || signal.aborted || leaving || !(isGenerating(localCase) || placingBoxes(localCase))) return;
    genPoll = setInterval(() => {
      if (signal.aborted || leaving) {
        stopGeneratingWatch();
        return;
      }
      refreshFromServer();
    }, 2000);
  }

  signal.addEventListener("abort", stopGeneratingWatch);

  let loadedFilmId = "";

  function loadFilm() {
    const id = localCase?.imageId;
    if (!id) {
      imageSrc = null;
      loadedFilmId = "";
      return;
    }
    if (loadedFilmId === String(id) && imageSrc) return;
    getImageObjectUrl(id).then(async (url) => {
      if (signal.aborted || leaving || String(localCase?.imageId || "") !== String(id)) return;
      if (!url) localCase = { ...localCase, imageId: null };
      else loadedFilmId = String(id);
      imageSrc = url;
      const caseId = getEffectiveCaseId();
      if (caseId && !reportDirty && !remarksDirty) {
        try {
          const data = await api.getCase(caseId);
          const next = data.case || data;
          const before = JSON.stringify(localCase?.pixelSpacingMm || null);
          const after = JSON.stringify(next?.pixelSpacingMm || null);
          if (before !== after && Array.isArray(next?.pixelSpacingMm)) {
            clearFilmSpacingAdjust(id);
            localCase = { ...localCase, pixelSpacingMm: next.pixelSpacingMm };
          }
        } catch { /* the film is already on screen */ }
      }
      render();
    });
  }

  async function refreshFromServer() {
    const caseId = getEffectiveCaseId();
    if (!caseId || signal.aborted || leaving) return;
    if (reportDirty || remarksDirty) return;
    const wasGenerating = isGenerating(localCase);
    try {
      const data = await api.getCase(caseId, { signal });
      if (signal.aborted || leaving) return;
      localCase = data.case || data;
      // One-shot fixup: unwrap the legacy `{"report":"..."}` string shape.
      localCase = unwrapLegacyReport(localCase);
      localCase = { ...localCase, findings: dedupeFindings(localCase.findings || []) };
      syncRemarksFromCase();
      if (wasGenerating && !isGenerating(localCase)) toast("Draft ready — pending approve.");
      if (isGenerating(localCase) || placingBoxes(localCase)) watchGenerating();
      else stopGeneratingWatch();
      // Sync the cache so the rest of the app sees the same case.
      const idx = state.cases.findIndex(
        (c) => c.caseId === (localCase.caseId || localCase._id) || c._id === localCase._id
      );
      if (idx >= 0) state.cases[idx] = localCase;
      // Draw the examination before the film arrives. A slow GridFS
      // download must not leave this page blank.
      loadFilm();
      render();
    } catch (err) {
      if (signal.aborted || leaving || isAbortError(err)) return;
      if (err?.status === 404) {
        leaveMissingCase();
        return;
      }
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
          const data = await api.getCase(state.selectedCaseId, { signal });
          localCase = data.case || data;
          if (localCase) {
            state.cases = [localCase, ...state.cases];
            state.selectedCaseId = localCase.caseId || localCase._id;
          }
        } catch (err) {
          if (isAbortError(err)) return;
          if (err?.status === 404) {
            leaveMissingCase();
            return;
          }
        }
      }
    } catch (err) {
      if (isAbortError(err)) return;
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
  if (isReferringDoctor(state.user) && localCase.status !== "finalized") {
    toast("Doctors can only open finalized reports.");
    setPage("dashboard");
    return;
  }

  function hintMongo(text) {
    const n = document.getElementById("mongo-report-status");
    if (n) n.textContent = text;
  }

  let persistChain = Promise.resolve();

  function markUnsaved() {
    reportDirty = true;
    hintMongo("Unsaved changes. Press Save draft or Save remarks.");
  }

  function measureOverlay(line) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("data-measure", "1");
    svg.setAttribute("class", "pointer-events-none absolute inset-0 z-20 h-full w-full");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    const ln = document.createElementNS(NS, "line");
    ln.setAttribute("x1", line.x1);
    ln.setAttribute("y1", line.y1);
    ln.setAttribute("x2", line.x2);
    ln.setAttribute("y2", line.y2);
    ln.setAttribute("stroke", "#67e8f9");
    ln.setAttribute("stroke-width", "0.8");
    svg.appendChild(ln);
    return svg;
  }

  function measureLength(line) {
    const text = measureText(line);
    const match = String(text).match(/([0-9]+(?:\.[0-9]+)?)\s*(cm|px)/i);
    return match ? `${match[1]} ${match[2].toLowerCase()}` : "";
  }

  function measureLabelEl(line) {
    const label = measureLength(line);
    if (!label) return null;
    const x = Math.min(94, Math.max(6, (Number(line.x1) + Number(line.x2)) / 2));
    const y = Math.min(92, Math.max(8, (Number(line.y1) + Number(line.y2)) / 2));
    return el("span", {
      class: "pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 text-xs font-semibold text-cyan-100",
      style: { left: `${x}%`, top: `${y}%` },
      dataset: { measureLabel: "1" },
    }, label);
  }

  function placeMeasureLabel(stage, line) {
    const label = measureLength(line);
    let node = stage.querySelector("[data-measure-label]");
    if (!label) {
      node?.remove();
      return;
    }
    if (!node) {
      node = document.createElement("span");
      node.setAttribute("data-measure-label", "1");
      node.className = "pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 text-xs font-semibold text-cyan-100";
      stage.appendChild(node);
    }
    const x = Math.min(94, Math.max(6, (Number(line.x1) + Number(line.x2)) / 2));
    const y = Math.min(92, Math.max(8, (Number(line.y1) + Number(line.y2)) / 2));
    node.style.left = `${x}%`;
    node.style.top = `${y}%`;
    node.textContent = label;
  }

  function paintMeasure(stage, line) {
    if (!stage || !line) return;
    const NS = "http://www.w3.org/2000/svg";
    let svg = stage.querySelector("[data-measure]");
    if (!svg) {
      svg = document.createElementNS(NS, "svg");
      svg.setAttribute("data-measure", "1");
      svg.setAttribute("class", "pointer-events-none absolute inset-0 z-20 h-full w-full");
      svg.setAttribute("viewBox", "0 0 100 100");
      svg.setAttribute("preserveAspectRatio", "none");
      stage.appendChild(svg);
    }
    let ln = svg.querySelector("line");
    if (!ln) {
      ln = document.createElementNS(NS, "line");
      ln.setAttribute("stroke", "#67e8f9");
      ln.setAttribute("stroke-width", "0.7");
      svg.appendChild(ln);
    }
    ln.setAttribute("x1", line.x1);
    ln.setAttribute("y1", line.y1);
    ln.setAttribute("x2", line.x2);
    ln.setAttribute("y2", line.y2);
    placeMeasureLabel(stage, line);
  }

  function measureText(line) {
    if (!line) return "";
    const img = document.getElementById("xray-film");
    const width = img?.naturalWidth || 0;
    const height = img?.naturalHeight || 0;
    const adjust = filmSpacingAdjust(localCase?.imageId);
    const spacing = Array.isArray(localCase?.pixelSpacingMm) && localCase.pixelSpacingMm.length === 2
      ? [
          Number(localCase.pixelSpacingMm[0]) * (adjust?.row || 1),
          Number(localCase.pixelSpacingMm[1]) * (adjust?.col || 1),
        ]
      : null;
    if (!width || !height) return "Drag across the area you want to measure.";
    const dx = ((line.x2 - line.x1) / 100) * width;
    const dy = ((line.y2 - line.y1) / 100) * height;
    const pixels = Math.sqrt(dx * dx + dy * dy);
    if (!spacing) return `${pixels.toFixed(0)} px. This film has no DICOM pixel spacing, so centimetres are not available.`;
    const mm = Math.sqrt((dx * Number(spacing[1])) ** 2 + (dy * Number(spacing[0])) ** 2);
    return `${(mm / 10).toFixed(2)} cm`;
  }

  function onFilmWheel(e) {
    e.preventDefault();
    const next = e.deltaY < 0 ? Math.min(4, +(zoom + 0.25).toFixed(2)) : Math.max(1, +(zoom - 0.25).toFixed(2));
    if (next === zoom) return;
    zoom = next;
    render();
  }

  function onFilmPointerDown(e) {
    if (filmTool !== "measure") return;
    if (e.button != null && e.button !== 0) return;
    const stage = e.currentTarget || document.getElementById("xray-stage");
    if (!stage) return;
    const pct = eventToPct(e, stage);
    measureLine = { x1: pct.x, y1: pct.y, x2: pct.x, y2: pct.y };
    boxDrag = { mode: "measure" };
    try { stage.setPointerCapture?.(e.pointerId); } catch { /* tests */ }
    paintMeasure(stage, measureLine);
    e.preventDefault();
  }

  function onFilmPointerMove(e) {
    if (boxDrag?.mode !== "measure" || !measureLine) return;
    const stage = e.currentTarget || document.getElementById("xray-stage");
    if (!stage) return;
    const pct = eventToPct(e, stage);
    measureLine = { ...measureLine, x2: pct.x, y2: pct.y };
    paintMeasure(stage, measureLine);
  }

  function onFilmPointerUp(e) {
    if (boxDrag?.mode !== "measure") return;
    const stage = e.currentTarget || document.getElementById("xray-stage");
    if (stage && measureLine) {
      const pct = eventToPct(e, stage);
      measureLine = { ...measureLine, x2: pct.x, y2: pct.y };
    }
    boxDrag = null;
    render();
  }

  function syncFromPersisted(stored, fallback = {}) {
    localCase = {
      ...localCase,
      ...stored,
      remarks: stored.remarks ?? fallback.remarks ?? localCase.remarks,
    };
    remarksDraft = localCase.remarks || fallback.remarks || "";
    remarksDirty = false;
    reportDirty = false;
    bodyDraft = normalizeReportShape(splitReportAndRemarks(localCase.reportText || "").body);
    bodyDirty = false;
  }

  // The report body is sent only when the radiologist typed in it; otherwise
  // the stored text is kept so a stale copy here cannot overwrite the popup.
  // Film boxes are never sent: Azure re-places them after a report edit.
  function persistClinicianEdits() {
    const run = async () => {
      if (signal.aborted || leaving) return;
      hintMongo("Saving to MongoDB…");
      let data;
      try {
        data = await api.getCase(getEffectiveCaseId(), { signal });
      } catch (err) {
        if (signal.aborted || leaving || isAbortError(err)) return;
        if (err?.status === 404) {
          leaveMissingCase();
          return;
        }
        throw err;
      }
      const stored = unwrapLegacyReport(data.case || data);
      const note = String(remarksDraft || "").trim();
      if (stored.status === "finalized" || !canEditReport(state.user)) {
        if (canEditReport(state.user)) {
          const updated = await api.updateCase(getEffectiveCaseId(), { remarks: note });
          const next = unwrapLegacyReport(updated.case || { ...stored, remarks: note });
          syncFromPersisted(next, { remarks: note });
          hintMongo("Notes saved in MongoDB.");
          return next;
        }
        hintMongo("");
        return stored;
      }
      const typedBody = bodyDirty ? bodyDraft : null;
      const composed = composeReportText(typedBody ?? stored.reportText, { remarks: note, findings: stored.findings });
      const payload = {
        reportText: composed.reportText,
        remarks: composed.remarks,
      };
      const reportChanged = splitReportAndRemarks(composed.reportText).body.trim()
        !== splitReportAndRemarks(stored.reportText || "").body.trim();
      const updated = await api.updateCase(getEffectiveCaseId(), payload);
      let next = unwrapLegacyReport(updated.case || { ...stored, ...payload });
      const typedSince = bodyDirty && bodyDraft !== typedBody;
      const neverBoxed = !stored.boxesState && !filmBoxes(stored.findings).length;
      if (reportChanged || neverBoxed) {
        hintMongo("Placing film boxes…");
        next = await resyncMachineFindings(getEffectiveCaseId(), next);
      }
      if (typedSince) {
        localCase = { ...localCase, ...next };
        hintMongo("Unsaved changes. Press Save draft.");
        return next;
      }
      syncFromPersisted(next, composed);
      hintMongo(reportChanged ? "Report saved. Film boxes now match this draft." : "Report saved in MongoDB.");
      return next;
    };
    const pending = persistChain.then(run, run);
    persistChain = pending.catch(() => {});
    return pending;
  }

  async function saveDraft() {
    busy = true; render();
    try {
      await persistClinicianEdits();
      msg = "Draft saved.";
      toast(msg);
    } catch (err) {
      msg = err.message;
      toast(msg);
    } finally { busy = false; render(); }
  }

  async function runAi() {
    if (!canRunAi(state.user) || isGenerating(localCase)) return;
    busy = true;
    render();
    try {
      const data = await api.analyzeCase(getEffectiveCaseId());
      const next = data.case || data;
      localCase = next;
      startAnalysisWatch({
        caseId: next.caseId || getEffectiveCaseId(),
        patientName: patientDisplayName(next),
        patientId: next.patientId,
      });
    } catch (err) {
      toast(err.message || "Could not start AI.");
    } finally {
      busy = false;
      render();
    }
  }

  async function finalize() {
    if (isGenerating(localCase)) {
      toast("The report is still generating.");
      return;
    }
    if (!confirm("Endorse this report? The ward will see the clean report, without the draft log.")) return;
    busy = true; render();
    try {
      await persistClinicianEdits();
      const data = await api.finalizeCase(getEffectiveCaseId());
      localCase = data.case || data;
      msg = "Report finalized and approved.";
      toast(msg);
    } catch (err) {
      msg = err.message;
      toast(msg);
    } finally { busy = false; render(); }
  }

  async function openReport() {
    const id = getEffectiveCaseId();
    if (!id) {
      toast("This case has no id yet.");
      return;
    }
    if (canEditReport(state.user)) {
      try {
        await persistClinicianEdits();
      } catch (err) {
        toast(err.message || "Could not save before opening the report.");
      }
    }
    const popup = window.open(
      reportPopupUrl(id),
      "radassist-report",
      "popup=yes,width=820,height=920,scrollbars=yes,resizable=yes"
    );
    if (!popup) toast("Allow popups to open the report in a new window.");
  }

  async function saveRemarks() {
    busy = true;
    render();
    try {
      const stored = await persistClinicianEdits();
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

  async function shareReport() {
    if (localCase.status !== "finalized") {
      toast("Finalize the report before sharing.");
      return;
    }
    busy = true;
    render();
    try {
      const data = await api.shareCase(getEffectiveCaseId());
      localCase = unwrapLegacyReport(data.case || { ...localCase, shareToken: data.token });
      const token = data.token || localCase.shareToken;
      const url = `${window.location.origin}${window.location.pathname}#/share/${encodeURIComponent(token)}`;
      try {
        await navigator.clipboard.writeText(url);
        toast("Share link copied. Anyone with the link can open this report.");
      } catch {
        window.prompt("Copy this share link:", url);
      }
    } catch (err) {
      toast(err.message || "Could not create a share link.");
    } finally {
      busy = false;
      render();
    }
  }

  async function toggleUrgent() {
    if (!canEditReport(state.user)) return;
    const next = !localCase.urgent;
    busy = true;
    render();
    try {
      const updated = await api.updateCase(getEffectiveCaseId(), { urgent: next });
      localCase = unwrapLegacyReport(updated.case || { ...localCase, urgent: next });
      const idx = state.cases.findIndex(
        (c) => c.caseId === (localCase.caseId || localCase._id) || c._id === localCase._id
      );
      if (idx >= 0) state.cases[idx] = { ...state.cases[idx], urgent: localCase.urgent };
      toast(next ? "Marked urgent." : "Urgent tag removed.");
    } catch (err) {
      toast(err.message || "Could not update urgency.");
    } finally {
      busy = false;
      render();
    }
  }

  async function download(kind) {
    busy = true;
    render();
    try {
      // Persist unsaved remarks and hand-added findings, then download the
      // stored report so Word/PDF match what the clinician just typed.
      let stored;
      if (!canEditReport(state.user)) {
        const data = await api.getCase(getEffectiveCaseId());
        stored = unwrapLegacyReport(data.case || data);
      } else {
        stored = await persistClinicianEdits();
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
    const generating = isGenerating(localCase);
    const awaitingAi = isAwaitingAi(localCase);
    const showProvenance = canEditReport(state.user) && localCase.status !== "finalized";
    const edit = !generating && canEditReport(state.user) && localCase.status !== "finalized";
    const canRemark = !generating && canEditReport(state.user);
    const canFlag = canEditReport(state.user);
    const boxes = filmBoxes(localCase.findings);
    const placing = placingBoxes(localCase);
    const patientName = patientDisplayName(localCase);
    const reportBody = (() => {
      const body = normalizeReportShape(splitReportAndRemarks(localCase.reportText || "").body);
      return localCase.status === "finalized" ? withoutThinking(body) : body;
    })();

    function boxStatus() {
      if (generating || awaitingAi) return "";
      if (placing) return "Azure is placing boxes on the film from the report…";
      if (localCase.boxesState === "failed") return "Azure could not place boxes for this report.";
      if (localCase.boxesState === "done" && !boxes.length) return "Azure found nothing to box on this film.";
      if (boxes.length) return "Boxes are placed by Azure from the report wording. They are approximate, not drawn by CURV.";
      if (String(localCase.reportText || "").trim() && !localCase.boxesState) {
        return "This report has no film boxes yet. Press Re-run AI for a fresh CURV report with boxes, or Save draft to box this one.";
      }
      return "";
    }

    const _imageSrc = imageSrc;

    const root = el(
      "main",
      { class: "mx-auto max-w-[1450px] px-5 py-7" },
      el("button", {
        class: "inline-flex items-center gap-1 text-slate-700 hover:text-slate-900",
        onClick: () => setPage("dashboard"),
      }, svgIcon("arrow-left", { size: 16 }), isReferringDoctor(state.user) ? "Ward enquiry" : "Work list"),

      el("div", { class: "mt-3 flex flex-wrap items-center justify-between gap-3" },
        el("div", {},
          el("h1", { class: "text-3xl font-bold text-slate-900" }, isReferringDoctor(state.user) ? "Exam enquiry" : "Reporting"),
          el("p", { class: "text-slate-600 mt-1 flex flex-wrap items-center gap-2" },
            el("button", {
              class: "font-semibold hover:text-ha-blue hover:underline",
              onClick: () => {
                state.selectedPatientId = localCase.patientId;
                setPage("patient");
              },
            }, patientName || localCase.patientId),
            patientName
              ? el("span", { class: "font-mono text-xs text-slate-500" }, localCase.patientId)
              : null,
            " · ",
            localCase.age || "?", " years · ",
            localCase.sex || "?",
            localCase.urgent ? urgentBadge() : null
          ),
          el("p", { class: "mt-1 text-sm text-slate-700" },
            "Modality: ", el("b", {}, "XRAY"),
            " · Procedure: ", el("b", {}, "Chest"),
            (localCase.registeredAt || localCase.imageId)
              ? el("span", {}, " · Registered: ", new Date(localCase.registeredAt || localCase.createdAt).toLocaleString())
              : null
          ),
          el("p", { class: "mt-1 text-sm text-slate-500" },
            "Doctor in charge: ",
            el("span", { class: "font-semibold text-slate-700" }, doctorInCharge(localCase))
          ),
          el("p", { class: "text-xs text-slate-500 mt-1" },
            "MongoDB case id: ", el("span", { class: "font-mono" }, localCase.caseId || localCase._id || ""),
            localCase.imageId ? el("span", {}, " · image: ", el("span", { class: "font-mono" }, String(localCase.imageId).slice(-8))) : null
          )
        ),
        el("div", { class: "flex gap-2 flex-wrap" },
          canRunAi(state.user) && localCase.status !== "finalized" && !awaitingAi && el("button", {
            class: "inline-flex items-center gap-1 rounded-xl bg-ha-blue px-3 py-2 text-sm font-semibold text-white hover:bg-[#074f85] disabled:opacity-50",
            disabled: busy || generating,
            onClick: runAi,
          }, generating ? "Generating…" : "Re-run AI"),
          canExport(state.user) && el("button", {
            class: "inline-flex items-center gap-1 rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50",
            disabled: busy || generating || awaitingAi,
            onClick: openReport,
          }, svgIcon("file-text", { size: 16 }), "Report"),
          canExport(state.user) && el("button", {
            class: "inline-flex items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50",
            disabled: busy || generating || awaitingAi,
            onClick: () => download("docx"),
          }, svgIcon("download", { size: 16 }), "Word"),
          canExport(state.user) && el("button", {
            class: "inline-flex items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50",
            disabled: busy || generating || awaitingAi,
            onClick: () => download("pdf"),
          }, svgIcon("download", { size: 16 }), "PDF"),
          canFlag && localCase.status === "finalized" && el("button", {
            class: "inline-flex items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50",
            disabled: busy,
            onClick: shareReport,
          }, svgIcon("share", { size: 16 }), localCase.shared || localCase.shareToken ? "Copy share link" : "Share"),
          edit && el("button", {
            class: "rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50",
            disabled: busy,
            onClick: saveDraft,
          }, "Save draft"),
          edit && el("button", {
            class: "rounded-xl bg-green-600 px-3 py-2 text-sm font-semibold text-white hover:bg-green-700",
            disabled: busy,
            onClick: finalize,
          }, "Endorse report"),
          canFlag && el("button", {
            class: localCase.urgent
              ? "rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
              : "rounded-xl border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50",
            disabled: busy,
            onClick: toggleUrgent,
          }, localCase.urgent ? "Remove urgent" : "Mark urgent"),
          generating
            ? el("span", { class: "rounded-full bg-amber-50 text-amber-700 px-3 py-1 text-xs font-bold" }, "GENERATING")
            : awaitingAi
            ? el("span", { class: "rounded-full bg-violet-50 text-violet-700 px-3 py-1 text-xs font-bold" }, "AWAITING AI")
            : isAwaitingApprove(localCase)
            ? el("span", { class: "rounded-full bg-blue-50 text-ha-blue px-3 py-1 text-xs font-bold" }, "PENDING APPROVE")
            : localCase.status === "finalized"
            ? el("span", { class: "rounded-full bg-green-50 text-green-700 px-3 py-1 text-xs font-bold" }, "FINALIZED")
            : null
        )
      ),

      msg && el("p", { class: "mt-4 rounded-lg bg-green-50 text-green-700 p-3" }, msg),
      awaitingAi && el("p", { class: "mt-4 rounded-lg bg-violet-50 text-violet-900 p-3" },
        "The film is registered. The draft report is generated automatically and will appear here as pending approve."
      ),
      generating && el("p", { class: "mt-4 rounded-lg bg-amber-50 text-amber-800 p-3" },
        "The report is still generating. Return to the worklist — Review is ready once the status is ",
        el("b", {}, statusLabel("pending_approve")),
        "."
      ),

      // Film and report side by side.
      el("div", { class: "mt-5 grid gap-5 xl:grid-cols-2" },
        // X-ray with the Azure boxes
        el("section", { class: "rounded-2xl bg-slate-950 p-4 text-white" },
          el("div", { class: "flex flex-wrap items-center justify-between gap-2" },
            el("div", { class: "flex items-baseline gap-2" },
              el("b", {}, "Chest X-Ray"),
              el("span", { class: "text-xs text-slate-400" }, _imageSrc ? "· loaded from MongoDB GridFS" : "")
            ),
            el("div", { class: "flex flex-wrap gap-1" },
              el("button", {
                type: "button",
                class: "rounded-lg border border-white/20 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white hover:bg-white/20",
                onClick: () => { zoom = Math.min(4, +(zoom + 0.25).toFixed(2)); render(); },
              }, "Zoom in"),
              el("button", {
                type: "button",
                class: "rounded-lg border border-white/20 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white hover:bg-white/20",
                onClick: () => { zoom = Math.max(1, +(zoom - 0.25).toFixed(2)); render(); },
              }, "Zoom out"),
              el("button", {
                type: "button",
                class: `rounded-lg border px-2.5 py-1 text-xs font-semibold ${filmTool === "measure" ? "border-cyan-300 bg-cyan-700 text-white" : "border-white/20 bg-white/10 text-white hover:bg-white/20"}`,
                onClick: () => { filmTool = filmTool === "measure" ? "box" : "measure"; render(); },
              }, filmTool === "measure" ? "Measuring" : "Measure"),
              boxes.length > 0 && el("button", {
                id: "toggle-bboxes",
                type: "button",
                class: "rounded-lg border border-white/20 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white hover:bg-white/20",
                onClick: () => { showBoxes = !showBoxes; render(); },
              }, showBoxes ? "Hide boxes" : "Show boxes")
            )
          ),
          el("div", { class: "mt-3 max-h-[560px] overflow-auto rounded-xl bg-gradient-to-b from-slate-500 to-slate-900" },
            el("div", {
              id: "xray-stage",
              class: `relative touch-none ${filmTool === "measure" ? "cursor-crosshair" : ""}`,
              style: { width: `${Math.round(zoom * 100)}%` },
              onPointerdown: onFilmPointerDown,
              onPointermove: onFilmPointerMove,
              onPointerup: onFilmPointerUp,
              onPointercancel: onFilmPointerUp,
              onWheel: onFilmWheel,
            },
              _imageSrc
                ? el("img", { id: "xray-film", src: _imageSrc, class: "pointer-events-none block h-auto w-full", alt: "Chest X-ray" })
                : el("div", { class: "pointer-events-none flex h-[320px] w-full min-w-[240px] items-center justify-center text-slate-300 text-sm" }, localCase.imageId ? "Loading image…" : "No image"),
              measureLine && measureOverlay(measureLine),
              measureLine && measureLabelEl(measureLine),
              ...(!showBoxes ? [] : boxes.map((finding, index) => {
                const color = filmBoxColor(index, boxes.length);
                return el("div", {
                  class: `pointer-events-none absolute border-2 ${color.border} ${color.fill}`,
                  dataset: { bbox: String(index + 1) },
                  style: {
                    left: finding.bbox[0] + "%",
                    top: finding.bbox[1] + "%",
                    width: finding.bbox[2] + "%",
                    height: finding.bbox[3] + "%",
                  },
                  title: finding.sentence || finding.label,
                },
                  el("span", {
                    class: `absolute -top-5 left-0 max-w-[16rem] truncate px-1 text-xs font-bold text-black ${color.chip}`,
                    dataset: { bboxLabel: "1" },
                  }, finding.label)
                );
              }))
            )
          ),
          el("p", { class: "mt-2 text-center text-xs text-slate-300" },
            filmTool === "measure"
              ? (measureLine ? measureText(measureLine) : "Drag a line across the lesion. Centimetres use the DICOM pixel spacing.")
              : `Zoom ${Math.round(zoom * 100)}%. Scroll the film to move around.`
          ),
          boxStatus() && el("p", { id: "box-status", class: "mt-1 text-center text-xs text-slate-400" }, boxStatus())
        ),

        el("section", { class: "flex flex-col gap-5" },
          el("div", { class: "card", id: "report-panel" },
            el("div", { class: "flex flex-wrap items-center justify-between gap-2" },
              el("h2", { class: "text-lg font-bold text-slate-900" }, "Report"),
              canExport(state.user) && !generating && !awaitingAi && el("button", {
                class: "rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50",
                disabled: busy,
                onClick: openReport,
              }, "Open report")
            ),
            edit && el("p", { class: "mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950" },
              "Thinking is on this draft so you can check the model’s reasoning. It is not included in the endorsed report, or in the Word and PDF files after you endorse."
            ),
            edit
              ? el("textarea", {
                  id: "report-text",
                  class: "input mt-3 min-h-[420px] font-sans text-sm leading-6",
                  rows: 18,
                  onInput: (e) => { bodyDraft = e.target.value; bodyDirty = true; markUnsaved(); },
                }, bodyDraft)
              : el("pre", { id: "report-text", class: "mt-3 max-h-[560px] overflow-y-auto whitespace-pre-wrap font-sans text-sm leading-6 text-slate-800" },
                  generating
                    ? "The report is still generating."
                    : reportBody || "No report has been saved for this case yet."
                ),
            edit && el("p", { class: "mt-2 text-xs text-slate-500" },
              "Edit the report here. Save draft keeps it and Azure moves the film boxes to match."
            )
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
              onInput: (e) => { remarksDraft = e.target.value; remarksDirty = true; markUnsaved(); },
            }, remarksDraft),
            el("p", { class: "mt-2 text-xs text-slate-500" },
              localCase.status === "finalized"
                ? "This case is finalized. Remarks are saved as notes only and are not written into the report, Word, or PDF."
                : "Nothing is written until you press Save draft or Save remarks. Both save the report and the remarks."
            ),
            canRemark && el("p", { id: "mongo-report-status", class: "mt-1 text-xs font-medium text-ha-blue" })
          ),
          showProvenance && (localCase.editLog || []).length > 0 && el("div", { class: "card" },
            el("h2", { class: "text-lg font-bold text-slate-900" }, "Draft log (AI vs manual)"),
            el("p", { class: "mt-1 text-xs text-slate-500" },
              "Shown while editing. The signed report the doctor sees has no source tags."
            ),
            el("ul", { class: "mt-3 space-y-2 text-sm" },
              ...(localCase.editLog || []).slice(-12).reverse().map((row, index) => {
                const key = String(row._id || row.at || index);
                const open = openLogKey === key;
                const changes = Array.isArray(row.changes) ? row.changes : [];
                return el("li", { class: "border-b border-slate-100 pb-2 last:border-0" },
                  el("button", {
                    type: "button",
                    class: "flex w-full gap-2 text-left",
                    onClick: () => {
                      openLogKey = open ? "" : key;
                      render();
                    },
                  },
                    el("b", {
                      class: row.kind === "ai"
                        ? "rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-ha-blue"
                        : "rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-slate-700",
                    }, row.kind === "ai" ? "AI" : "Manual"),
                    el("span", { class: "min-w-0 text-slate-700" },
                      row.summary || "",
                      el("span", { class: "mt-0.5 block text-xs text-slate-400" },
                        [row.userName, row.at && new Date(row.at).toLocaleString(), open ? "Hide detail" : "Show what changed"].filter(Boolean).join(" · ")
                      )
                    )
                  ),
                  open && el("div", { class: "mt-2 space-y-1 pl-2 text-xs" },
                    changes.length
                      ? changes.map((change) => {
                          const title = change.action === "added" ? "Added" : change.action === "removed" ? "Removed" : "Edited";
                          const tone = change.action === "added"
                            ? "text-green-800"
                            : change.action === "removed"
                              ? "text-red-800"
                              : "text-slate-800";
                          const body = change.action === "edited"
                            ? `${change.before || "—"} → ${change.after || "—"}`
                            : (change.after || change.before || "");
                          return el("p", { class: tone },
                            el("b", {}, `${title}${change.label ? ` · ${change.label}` : ""}: `),
                            body
                          );
                        })
                      : el("p", { class: "text-slate-500" }, "This entry has no line-by-line detail.")
                  )
                );
              })
            )
          )
        )
      )
    );

    mount(target, root);
  }

  mount(target, el("p", { class: "p-8 text-slate-500" }, "Loading examination…"));
  await refreshFromServer();
  if (signal.aborted || leaving) return;
  window.addEventListener("focus", () => {
    if (!signal.aborted) refreshFromServer();
  }, { signal });
  window.addEventListener("message", (ev) => {
    if (signal.aborted) return;
    const ids = [localCase?.caseId, localCase?._id].filter(Boolean).map(String);
    if (ev?.data?.type === "radassist-case-updated" && ids.includes(String(ev.data.caseId || ""))) {
      refreshFromServer();
    }
  }, { signal });
  render();
}
