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
import { downloadReportDocx, downloadReportPdf, previewReportPdf, openPreviewWindow, applyRemarksToReport, splitReportAndRemarks, reportHeaderFields, formatDateTime } from "../lib/reportExport.js";
import { reportTitle, examinationName, THANKS_LINE, VIEWS, cleanView } from "../../shared/reportTags.js";
import { thinkingBlockOf } from "../../shared/reportText.js";
import { ensureTags, assembleReport, boxOfTag, boxesForTag, isDrawnBox, addTag, setTagText, deleteTag, flipTag, moveTagTo, removeBox, placeBox, moveBox, drawnFinding, setCtr, refreshCtr, addLesionLine, removeLine } from "../lib/findingTags.js";
import { spacingOf, buildLine, applyMagnification, showFactor, MAGNIFICATION_NAMES, getMeasurementPolicy, experimentalLabel, EXPERIMENTAL_NOTE } from "../lib/measure.js";
import { urgentBadge, patientDisplayName, doctorInCharge } from "../lib/tags.js";
import { isGenerating, isAwaitingApprove, isAwaitingAi, statusLabel } from "../lib/caseStatus.js";
import { forgetCases } from "../lib/records.js";
import { CASES_CHANGED, startAnalysisWatch } from "../lib/analysisJob.js";
import { canEditReport, canRunAi, canExport, isReferringDoctor } from "../lib/roles.js";
import { patientChartButton } from "../lib/chartWindow.js";

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

// White so a measurement never matches one of the box colours above.
const MEASURE_COLOR = "#ffffff";
const MEASURE_LABEL_CLASS = "bg-white text-black ring-1 ring-black/60";

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

function boxFromCorners(a, b) {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  return clampBox(left, top, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function clampBox(left, top, width, height) {
  let w = Math.max(3, Number(width) || 3);
  let h = Math.max(3, Number(height) || 3);
  let l = Number(left) || 0;
  let t = Number(top) || 0;
  l = Math.min(97, Math.max(0, l));
  t = Math.min(97, Math.max(0, t));
  w = Math.min(100 - l, w);
  h = Math.min(100 - t, h);
  return [Number(l.toFixed(2)), Number(t.toFixed(2)), Number(w.toFixed(2)), Number(h.toFixed(2))];
}

function movedBox(origin, start, pct) {
  const [l, t, w, h] = (origin || []).map(Number);
  return clampBox(
    Math.min(100 - w, Math.max(0, l + (pct.x - start.x))),
    Math.min(100 - h, Math.max(0, t + (pct.y - start.y))),
    w,
    h
  );
}

function resizedBox(origin, handle, pct) {
  const [l0, t0, w0, h0] = (origin || []).map(Number);
  let l = l0;
  let t = t0;
  let r = l0 + w0;
  let b = t0 + h0;
  if (handle.includes("e")) r = pct.x;
  if (handle.includes("w")) l = pct.x;
  if (handle.includes("s")) b = pct.y;
  if (handle.includes("n")) t = pct.y;
  return clampBox(Math.min(l, r), Math.min(t, b), Math.abs(r - l), Math.abs(b - t));
}

// "nw" / "ne" / "sw" / "se" for a corner handle, "move" inside the box.
function hitBoxHandle(pct, bbox) {
  if (!hasBbox({ bbox })) return null;
  const [l, t, w, h] = bbox.map(Number);
  const r = l + w;
  const b = t + h;
  const pad = 3;
  const corners = [["nw", l, t], ["ne", r, t], ["sw", l, b], ["se", r, b]];
  for (const [name, x, y] of corners) {
    if (Math.abs(pct.x - x) <= pad && Math.abs(pct.y - y) <= pad) return name;
  }
  if (pct.x >= l && pct.x <= r && pct.y >= t && pct.y <= b) return "move";
  return null;
}

function cursorForHandle(hit) {
  if (hit === "move") return "move";
  if (hit === "nw" || hit === "se") return "nwse-resize";
  if (hit === "ne" || hit === "sw") return "nesw-resize";
  return "";
}

function boxKey(f) {
  return String(f?._id || f?.id || "");
}

// A box's stored confidence as a whole percent. A box with no score is never hidden.
function confidencePct(f) {
  const n = Number(f?.confidence);
  if (f?.confidence == null || !Number.isFinite(n)) return 100;
  return Math.round(Math.min(1, Math.max(0, n)) * 100);
}

// Hover look for a film box and for its sentence tag. Written out in full so
// the style sheet keeps them.
const HOVER_BOX_CLASSES = ["z-20", "ring-2", "ring-white", "bg-white/20"];
const HOVER_ROW_CLASSES = ["ring-2", "ring-sky-400", "bg-sky-50"];

// One box per abnormal sentence tag. A deleted box stays stored as rejected so
// Azure does not put it back, but it is not drawn. A normal sentence has no box.
function filmBoxes(c) {
  const tags = Array.isArray(c?.findingTags) ? c.findingTags : [];
  const seen = new Set();
  return (Array.isArray(c?.findings) ? c.findings : []).filter((f) => {
    if (!hasBbox(f) || f.status === "rejected" || !f.tagKey) return false;
    const tag = tags.find((t) => t.key === f.tagKey);
    if (!tag || !tag.abnormal || seen.has(f.tagKey)) return false;
    seen.add(f.tagKey);
    return true;
  });
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
  let noticeTimer = null;
  let imageSrc = null; // resolved object URL once the blob is fetched
  let showBoxes = true;
  let showMeasures = true;
  let boxDrag = null;
  let zoom = 1;
  let filmAspect = 0;
  let showLog = false;
  let filmTool = "view";
  let selectedTagKey = "";
  // View only, never saved. 0 shows every finding; a higher value hides the film
  // boxes whose stored confidence (percent) is below it.
  let minConfidence = 0;
  // The sentence tag and its film box light up together while the pointer is on either.
  let hoverTagKey = "";
  let boxesDirty = false;
  let measureLine = null;
  let measuresDirty = false;
  let tagsDirty = false;
  let remarksDraft = "";
  let remarksDirty = false;
  let reportDirty = false;
  // Counts local edits, so a save that finishes after the radiologist typed
  // again does not overwrite what they typed.
  let editSeq = 0;
  let ctrHeart = null; // the first of the two heart-size lines, waiting for the second
  let dragKey = "";
  let dropMark = null; // { key, after } while a tag is dragged over another
  let newFinding = "";
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
  }

  // The case as the page works with it: a legacy wrapper unwrapped, and an
  // older case that has only report text split into sentence tags once. The
  // split is kept only here until the radiologist saves.
  function adopt(raw) {
    const next = ensureTags(unwrapLegacyReport(raw));
    if (next?.tagsDerived && next.status !== "finalized" && canEditReport(state.user)) {
      tagsDirty = true;
      boxesDirty = true;
      measuresDirty = true;
    }
    return next;
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

  function clearNoticeTimer() {
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = null;
  }

  // The green bar under the toolbar. It leaves on its own so it does not
  // sit on the film after the radiologist has already seen it.
  function showNotice(text) {
    msg = text || "";
    clearNoticeTimer();
    if (!msg || signal.aborted || leaving) return;
    const shown = msg;
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      if (signal.aborted || leaving || msg !== shown) return;
      msg = "";
      document.getElementById("draft-notice")?.remove();
    }, 5000);
  }

  signal.addEventListener("abort", clearNoticeTimer);

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
            localCase = {
              ...localCase,
              pixelSpacingMm: next.pixelSpacingMm,
              imagerPixelSpacingMm: next.imagerPixelSpacingMm,
              dicomPixelSpacingMm: next.dicomPixelSpacingMm,
              pixelSpacingSource: next.pixelSpacingSource,
            };
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
      localCase = adopt(localCase);
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
  localCase = adopt(localCase);
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
    hintMongo("Unsaved changes. Press Save draft.");
    document.getElementById("save-draft")?.classList.add("ring-2", "ring-slate-400", "ring-offset-1");
  }

  function measureLineEls(NS, line) {
    return [["#000000", "4"], [MEASURE_COLOR, "2"]].map(([stroke, width]) => {
      const ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", line.x1);
      ln.setAttribute("y1", line.y1);
      ln.setAttribute("x2", line.x2);
      ln.setAttribute("y2", line.y2);
      ln.setAttribute("stroke", stroke);
      ln.setAttribute("stroke-width", width);
      ln.setAttribute("stroke-linecap", "round");
      ln.setAttribute("vector-effect", "non-scaling-stroke");
      return ln;
    });
  }

  function measureOverlay(line) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("data-measure", "1");
    svg.setAttribute("class", "pointer-events-none absolute inset-0 z-20 h-full w-full");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    for (const ln of measureLineEls(NS, line)) svg.appendChild(ln);
    return svg;
  }

  function measurementList() {
    return Array.isArray(localCase?.measurements) ? localCase.measurements : [];
  }

  function measureKey(m, i) {
    return String(m?._id || m?.id || `m-${i}`);
  }

  // Every local edit goes through here, so the page knows what to save.
  function setCase(next, { tags = false, boxes = false, lines = false } = {}) {
    localCase = next;
    if (tags) tagsDirty = true;
    if (boxes) boxesDirty = true;
    if (lines) measuresDirty = true;
    editSeq += 1;
    markUnsaved();
  }

  // The film element is rebuilt on every render, so keep the last size it reported.
  let lastFilmPixels = { width: 0, height: 0 };
  function filmPixels() {
    const img = document.getElementById("xray-film");
    const width = img?.naturalWidth || 0;
    const height = img?.naturalHeight || 0;
    if (width && height) lastFilmPixels = { width, height };
    return lastFilmPixels;
  }

  // Spacing for the film centimetres: Imager Pixel Spacing when the file has it.
  function filmSpacing() {
    return spacingOf(localCase, filmSpacingAdjust(localCase?.imageId));
  }

  function measurementPolicy() {
    return getMeasurementPolicy(localCase, filmSpacingAdjust(localCase?.imageId));
  }

  function shownMeasure(m) {
    const policy = measurementPolicy();
    return applyMagnification(m, policy.showBodyMeasurement ? policy.magnification : null);
  }

  function spacingNote() {
    const spacing = filmSpacing();
    const policy = measurementPolicy();
    if (!spacing.mm) return "This film has no pixel spacing, so lines show pixels only. Body size is unavailable.";
    if (policy.showBodyMeasurement) {
      const mag = policy.magnification;
      return `Film centimetres come from ${spacing.name}. Body size uses ${MAGNIFICATION_NAMES[mag.source] || mag.name}. ×${showFactor(mag.factor)} is film size divided by body size. ${mag.detail}`;
    }
    const extra = policy.showExperimentalEstimate ? ` Experimental estimate: ${EXPERIMENTAL_NOTE}` : "";
    return `Film centimetres come from ${spacing.name}. Body-size estimate unavailable. ${policy.reason}${extra}`;
  }

  function filmLine(line, kind) {
    const { width, height } = filmPixels();
    if (!width || !height) return null;
    const policy = measurementPolicy();
    return buildLine(line, {
      width, height, spacing: filmSpacing(), kind,
      magnification: policy.showBodyMeasurement ? policy.magnification : null,
    });
  }

  function measureKind() {
    if (filmTool !== "ctr") return "lesion";
    return ctrHeart ? "ctr-thorax" : "ctr-heart";
  }

  function deleteMeasurement(key) {
    const line = measurementList().find((m, i) => measureKey(m, i) === key);
    if (!line) return;
    setCase(removeLine(localCase, line), { tags: true, boxes: true, lines: true });
    render();
  }

  function measurementsForSave() {
    return measurementList().map((m) => {
      const sized = shownMeasure(m);
      const row = {
        x1: sized.x1, y1: sized.y1, x2: sized.x2, y2: sized.y2,
        text: sized.text,
        label: String(sized.label || "").trim(),
        kind: sized.kind || "lesion",
        tagKey: sized.tagKey || "",
        dxPx: sized.dxPx,
        dyPx: sized.dyPx,
        lengthPx: sized.lengthPx,
        lengthMm: sized.lengthMm,
        bodyLengthMm: sized.bodyLengthMm,
        magnification: sized.magnification,
        magnificationSource: sized.magnificationSource || "",
        spacingTag: sized.spacingTag || "",
      };
      if (m._id && !String(m._id).startsWith("tmp-")) row._id = m._id;
      return row;
    });
  }

  function savedMeasuresLayer(list) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("data-saved-measures", "1");
    svg.setAttribute("class", "pointer-events-none absolute inset-0 z-20 h-full w-full");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    for (const m of list) for (const ln of measureLineEls(NS, m)) svg.appendChild(ln);
    return svg;
  }

  function measureTagText(m, i) {
    const shown = shownMeasure(m);
    const name = String(shown.label || "").trim();
    return `${i + 1} · ${name ? `${name} ` : ""}${shown.text}`;
  }

  // A small tag beside the end of the line, so it does not sit on the box labels.
  function savedMeasureLabel(m, i) {
    const [ex, ey] = Number(m.x2) >= Number(m.x1) ? [m.x2, m.y2] : [m.x1, m.y1];
    const flip = Number(ex) > 82;
    const y = Math.min(96, Math.max(4, Number(ey)));
    return el("span", {
      class: `pointer-events-none absolute z-30 -translate-y-1/2 whitespace-nowrap rounded px-1 text-[10px] font-semibold leading-4 ${MEASURE_LABEL_CLASS} ${flip ? "-translate-x-full -ml-1.5" : "ml-1.5"}`,
      style: { left: `${ex}%`, top: `${y}%` },
      dataset: { savedMeasureLabel: String(i + 1) },
    }, measureTagText(m, i));
  }

  function measureLength(line) {
    return filmLine(line, measureKind())?.text || "";
  }

  function measureLabelEl(line) {
    const label = measureLength(line);
    if (!label) return null;
    const x = Math.min(94, Math.max(6, (Number(line.x1) + Number(line.x2)) / 2));
    const y = Math.min(92, Math.max(8, (Number(line.y1) + Number(line.y2)) / 2));
    return el("span", {
      class: `pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-semibold ${MEASURE_LABEL_CLASS}`,
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
      node.className = `pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-semibold ${MEASURE_LABEL_CLASS}`;
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
    if (!svg.querySelector("line")) {
      for (const ln of measureLineEls(NS, line)) svg.appendChild(ln);
    }
    for (const ln of svg.querySelectorAll("line")) {
      ln.setAttribute("x1", line.x1);
      ln.setAttribute("y1", line.y1);
      ln.setAttribute("x2", line.x2);
      ln.setAttribute("y2", line.y2);
    }
    placeMeasureLabel(stage, line);
  }

  function measureText(line) {
    if (!line) return "";
    if (!filmPixels().width) return "Drag across the area you want to measure.";
    const made = filmLine(line, measureKind());
    if (!made) return "";
    if (made.lengthMm == null) return `${made.text}. This film has no DICOM pixel spacing, so centimetres are not available.`;
    return made.text;
  }

  function onFilmWheel(e) {
    e.preventDefault();
    const next = e.deltaY < 0 ? Math.min(4, +(zoom + 0.25).toFixed(2)) : Math.max(1, +(zoom - 0.25).toFixed(2));
    if (next === zoom) return;
    zoom = next;
    render();
  }

  function canEditBoxes() {
    return Boolean(localCase) && canEditReport(state.user) && localCase.status !== "finalized"
      && !isGenerating(localCase) && !placingBoxes(localCase);
  }

  const tagOf = (key) => (localCase.findingTags || []).find((t) => t.key === key) || null;

  function deleteBox(tagKey) {
    setCase(removeBox(localCase, tagKey), { tags: true, boxes: true });
    render();
  }

  // A box drawn while an abnormal sentence without a box is selected belongs to
  // that sentence. Otherwise it starts a new finding at the end of the list.
  function addDrawnBox(bbox) {
    const tag = tagOf(selectedTagKey);
    if (tag && tag.abnormal && !boxOfTag(localCase, tag.key)) {
      setCase(placeBox(localCase, tag.key, bbox), { tags: true, boxes: true });
      return;
    }
    const out = drawnFinding(localCase, bbox);
    setCase(out.c, { tags: true, boxes: true });
    selectedTagKey = out.tag.key;
  }

  function paintLiveBox(stage, bbox) {
    if (!stage || !bbox) return;
    let node = stage.querySelector("[data-draw-box]");
    if (!node) {
      node = document.createElement("div");
      node.setAttribute("data-draw-box", "1");
      node.className = "pointer-events-none absolute z-20 border-2 border-dashed border-white bg-white/20";
      stage.appendChild(node);
    }
    node.style.left = bbox[0] + "%";
    node.style.top = bbox[1] + "%";
    node.style.width = bbox[2] + "%";
    node.style.height = bbox[3] + "%";
  }

  function liveBox(pct) {
    if (boxDrag.mode === "move") return movedBox(boxDrag.origin, boxDrag.start, pct);
    if (boxDrag.mode === "resize") return resizedBox(boxDrag.origin, boxDrag.handle, pct);
    return boxFromCorners(boxDrag.start, pct);
  }

  // The boxes the radiologist can see: the confidence slider hides the rest, so
  // a hidden box cannot be clicked, moved or resized by accident.
  const belowThreshold = (f) => confidencePct(f) < minConfidence;
  const shownBoxes = () => filmBoxes(localCase).filter((f) => !belowThreshold(f));

  function selectedBox() {
    return selectedTagKey ? shownBoxes().find((f) => f.tagKey === selectedTagKey) || null : null;
  }

  // Hover highlight, painted straight onto the DOM. A repaint here would throw
  // away a half-typed sentence and the slider the radiologist is dragging.
  function applyHover() {
    for (const node of document.querySelectorAll("[data-box-tag]")) {
      const on = Boolean(hoverTagKey) && node.dataset.boxTag === hoverTagKey;
      for (const c of HOVER_BOX_CLASSES) node.classList[on ? "add" : "remove"](c);
      if (on) node.setAttribute("data-hover", "1"); else node.removeAttribute("data-hover");
    }
    for (const row of document.querySelectorAll("[data-tag]")) {
      const on = Boolean(hoverTagKey) && row.dataset.tag === hoverTagKey;
      for (const c of HOVER_ROW_CLASSES) row.classList[on ? "add" : "remove"](c);
      if (on) row.setAttribute("data-hover", "1"); else row.removeAttribute("data-hover");
    }
  }

  function setHover(key) {
    const next = key || "";
    if (next === hoverTagKey) return;
    hoverTagKey = next;
    applyHover();
  }

  // The slider moved: show or hide the boxes and dim their sentence tags in place.
  function applyConfidenceFilter() {
    const all = filmBoxes(localCase);
    const hidden = new Set(all.filter(belowThreshold).map((f) => f.tagKey));
    for (const node of document.querySelectorAll("[data-box-tag]")) {
      node.style.display = hidden.has(node.dataset.boxTag) ? "none" : "";
    }
    for (const row of document.querySelectorAll("[data-tag]")) {
      const off = hidden.has(row.dataset.tag);
      row.classList[off ? "add" : "remove"]("opacity-50");
      if (off) row.setAttribute("data-below-threshold", "1"); else row.removeAttribute("data-below-threshold");
    }
    const value = document.getElementById("confidence-value");
    if (value) value.textContent = `${minConfidence}%`;
    const count = document.getElementById("confidence-count");
    if (count) count.textContent = `${all.length - hidden.size} of ${all.length} shown`;
    const slider = document.getElementById("confidence-slider");
    if (slider) slider.setAttribute("aria-valuetext", `${minConfidence}% minimum confidence`);
    // A box that just went away cannot stay the hovered one.
    if (hoverTagKey && hidden.has(hoverTagKey)) setHover("");
  }

  function setMinConfidence(value) {
    const n = Math.round(Number(value));
    minConfidence = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
    applyConfidenceFilter();
  }

  const lineTool = () => filmTool === "measure" || filmTool === "ctr";

  function onFilmPointerDown(e) {
    if (e.button != null && e.button !== 0) return;
    const stage = e.currentTarget || document.getElementById("xray-stage");
    if (!stage) return;
    const pct = eventToPct(e, stage);
    if (lineTool()) {
      measureLine = { x1: pct.x, y1: pct.y, x2: pct.x, y2: pct.y };
      boxDrag = { mode: "measure" };
      try { stage.setPointerCapture?.(e.pointerId); } catch { /* tests */ }
      paintMeasure(stage, measureLine);
      e.preventDefault();
      return;
    }
    if (!canEditBoxes()) {
      // A reader can still click a box to see which sentence it belongs to.
      if (filmTool === "view" && showBoxes) {
        const under = [...shownBoxes()].reverse().find((f) => hitBoxHandle(pct, f.bbox) === "move");
        selectedTagKey = under ? under.tagKey : "";
        render();
      }
      return;
    }
    if (filmTool === "draw") {
      boxDrag = { mode: "draw", start: pct };
    } else {
      if (!showBoxes) return;
      const sel = selectedBox();
      const hit = sel ? hitBoxHandle(pct, sel.bbox) : null;
      if (hit === "move") {
        boxDrag = { mode: "move", key: selectedTagKey, start: pct, origin: sel.bbox.slice() };
      } else if (hit) {
        boxDrag = { mode: "resize", handle: hit, key: selectedTagKey, start: pct, origin: sel.bbox.slice() };
      } else {
        const under = [...shownBoxes()].reverse().find((f) => hitBoxHandle(pct, f.bbox) === "move");
        selectedTagKey = under ? under.tagKey : "";
        render();
        return;
      }
    }
    try { stage.setPointerCapture?.(e.pointerId); } catch { /* tests */ }
    e.preventDefault();
  }

  function onFilmPointerMove(e) {
    const stage = e.currentTarget || document.getElementById("xray-stage");
    if (!stage) return;
    const pct = eventToPct(e, stage);
    if (boxDrag?.mode === "measure") {
      if (!measureLine) return;
      measureLine = { ...measureLine, x2: pct.x, y2: pct.y };
      paintMeasure(stage, measureLine);
      return;
    }
    if (boxDrag) {
      paintLiveBox(stage, liveBox(pct));
      return;
    }
    if (filmTool === "view" && showBoxes) {
      const over = [...shownBoxes()].reverse().find((f) => hitBoxHandle(pct, f.bbox) === "move");
      setHover(over ? over.tagKey : "");
    }
    if (filmTool === "view" && canEditBoxes()) {
      const sel = selectedBox();
      stage.style.cursor = sel ? cursorForHandle(hitBoxHandle(pct, sel.bbox)) : "";
    }
  }

  // The end of a dragged line: one lesion line, or one of the two heart diameters.
  function finishLine(line) {
    const long = line && Math.hypot(line.x2 - line.x1, line.y2 - line.y1) >= 1;
    const made = long ? filmLine(line, measureKind()) : null;
    measureLine = null;
    if (!made || !canEditBoxes()) return;
    const edits = { tags: true, boxes: true, lines: true };
    if (filmTool === "ctr") {
      if (!ctrHeart) {
        ctrHeart = made;
        return;
      }
      const out = setCtr(localCase, ctrHeart, made);
      setCase(out.c, edits);
      selectedTagKey = out.key;
      ctrHeart = null;
      filmTool = "view";
      return;
    }
    const out = addLesionLine(localCase, made, selectedTagKey);
    setCase(out.c, edits);
    selectedTagKey = out.key;
  }

  function onFilmPointerUp(e) {
    if (!boxDrag) return;
    const stage = e.currentTarget || document.getElementById("xray-stage");
    if (boxDrag.mode === "measure") {
      if (stage && measureLine) {
        const pct = eventToPct(e, stage);
        measureLine = { ...measureLine, x2: pct.x, y2: pct.y };
      }
      boxDrag = null;
      finishLine(measureLine);
      render();
      return;
    }
    if (!stage) return;
    const pct = eventToPct(e, stage);
    const drag = boxDrag;
    const bbox = liveBox(pct);
    boxDrag = null;
    if (drag.mode === "draw") {
      const moved = Math.abs(pct.x - drag.start.x) >= 2 || Math.abs(pct.y - drag.start.y) >= 2;
      if (!moved) {
        stage.querySelector("[data-draw-box]")?.remove();
        return;
      }
      addDrawnBox(bbox);
      filmTool = "view";
      showBoxes = true;
    } else {
      setCase(moveBox(localCase, drag.key, bbox), { boxes: true });
    }
    render();
  }

  // ---- the sentence tags

  function pickTag(key) {
    if (selectedTagKey === key) return;
    selectedTagKey = key;
    render();
  }

  function addFinding() {
    const out = addTag(localCase, newFinding);
    if (!out.tag) return;
    newFinding = "";
    selectedTagKey = out.tag.key;
    setCase(out.c, { tags: true });
    render();
  }

  function editTagText(key, value) {
    setCase(setTagText(localCase, key, value), { tags: true, boxes: true });
    for (const chip of document.querySelectorAll(`[data-box-tag="${key}"] [data-bbox-label]`)) chip.textContent = value;
  }

  function flip(key) {
    setCase(flipTag(localCase, key), { tags: true, boxes: true });
    render();
  }

  function removeTag(key) {
    if (selectedTagKey === key) selectedTagKey = "";
    setCase(deleteTag(localCase, key), { tags: true, boxes: true, lines: true });
    render();
  }

  function reorder(fromKey, toKey, after) {
    if (!fromKey || !toKey || fromKey === toKey) return;
    setCase(moveTagTo(localCase, fromKey, toKey, after), { tags: true });
    render();
  }

  function dropAfter(e, row) {
    const r = row?.getBoundingClientRect?.();
    return Boolean(r && r.height && typeof e.clientY === "number" && e.clientY > r.top + r.height / 2);
  }

  function changeView(value) {
    setCase(refreshCtr({ ...localCase, view: cleanView(value) }), { tags: true, boxes: true });
    render();
  }

  function changeComment(value) {
    setCase({ ...localCase, comment: value }, { tags: true });
  }

  const tagsForSave = () => (localCase.findingTags || []).map((t) => ({
    key: t.key,
    text: String(t.text || "").replace(/\s+/g, " ").trim(),
    abnormal: t.abnormal !== false,
    manual: Boolean(t.manual),
    kind: t.kind === "ctr" ? "ctr" : "",
    boxDeclined: Boolean(t.boxDeclined),
  })).filter((t) => t.text);

  const tagSignature = (tags) => (Array.isArray(tags) ? tags : [])
    .map((t) => `${t.key}|${t.abnormal === false ? 0 : 1}|${String(t.text || "").trim()}`).sort().join("\n");

  // An abnormal sentence that has no box and still wants one from Azure.
  function wantsBox(c) {
    return (c.findingTags || []).some((t) => t.abnormal && !t.boxDeclined && t.kind !== "ctr"
      && !boxesForTag(c.findings, t.key).length);
  }

  function findingsForSave(list) {
    return (list || []).map((f) => {
      const o = { ...f };
      if (String(o._id || "").startsWith("tmp-")) delete o._id;
      if (String(o.id || "").startsWith("tmp-")) delete o.id;
      o.label = String(o.label || "").trim() || "Marked area";
      return o;
    });
  }

  function syncFromPersisted(stored, fallback = {}) {
    localCase = {
      ...localCase,
      ...stored,
      remarks: stored.remarks ?? fallback.remarks ?? localCase.remarks,
    };
    delete localCase.tagsDerived;
    remarksDraft = localCase.remarks || fallback.remarks || "";
    remarksDirty = false;
    reportDirty = false;
    tagsDirty = false;
    boxesDirty = false;
    measuresDirty = false;
    if (selectedTagKey && !tagOf(selectedTagKey)) selectedTagKey = "";
  }

  // The sentence tags, the COMMENT and the view are sent only when the
  // radiologist changed them, boxes only when they drew, moved or deleted one;
  // otherwise the stored copy is kept so a stale copy here cannot overwrite a
  // fresh Azure pass. The server assembles the stored report from the tags.
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
      const seq = editSeq;
      const storedBody = splitReportAndRemarks(stored.reportText || "").body;
      const tags = tagsForSave();
      const payload = {};
      let base = stored.reportText;
      if (tagsDirty) {
        const view = cleanView(localCase.view);
        const comment = String(localCase.comment || "").replace(/\s+/g, " ").trim();
        base = assembleReport({ view, tags, comment, thinking: thinkingBlockOf(storedBody) });
        payload.findingTags = tags;
        payload.comment = comment;
        payload.view = view;
      }
      const composed = applyRemarksToReport(base, note);
      payload.reportText = composed.reportText;
      payload.remarks = composed.remarks;
      if (boxesDirty) payload.findings = findingsForSave(localCase.findings);
      if (measuresDirty) payload.measurements = measurementsForSave();
      const updated = await api.updateCase(getEffectiveCaseId(), payload);
      let next = unwrapLegacyReport(updated.case || { ...stored, ...payload });
      const sentencesChanged = tagsDirty && tagSignature(stored.findingTags) !== tagSignature(tags);
      const neverBoxed = !stored.boxesState && !filmBoxes({
        findingTags: tags,
        findings: payload.findings || stored.findings,
      }).length;
      if ((sentencesChanged || neverBoxed) && wantsBox(next)) {
        hintMongo("Placing film boxes…");
        next = await resyncMachineFindings(getEffectiveCaseId(), next);
      }
      if (editSeq !== seq) {
        // The radiologist kept editing while this saved: keep their newer work.
        localCase = {
          ...next,
          findingTags: localCase.findingTags,
          comment: localCase.comment,
          view: localCase.view,
          findings: localCase.findings,
          measurements: localCase.measurements,
        };
        hintMongo("Unsaved changes. Press Save draft.");
        return next;
      }
      syncFromPersisted(next, composed);
      hintMongo(sentencesChanged ? "Report saved. Film boxes now match this draft." : "Report saved in MongoDB.");
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
      showNotice("Draft saved.");
      toast("Draft saved.");
    } catch (err) {
      showNotice(err.message);
      toast(err.message);
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
      const endorsed = localCase?.chartFindingsState === "running"
        ? "Report endorsed. Azure AI is writing the findings on the patient chart."
        : "Report finalized and approved.";
      showNotice(endorsed);
      toast(endorsed);
    } catch (err) {
      showNotice(err.message);
      toast(err.message);
    } finally { busy = false; render(); }
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
    const preview = kind === "preview" ? openPreviewWindow() : null;
    if (kind === "preview" && !preview) toast("Pop-up blocked — the PDF will download instead. Allow pop-ups for a preview window.");
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
        preview?.close();
        toast("No report has been saved for this case yet.");
        return;
      }
      if (kind === "docx") await downloadReportDocx(stored);
      else if (kind === "docx-films") await downloadReportDocx(stored, "films");
      else if (kind === "preview") await previewReportPdf(stored, preview);
      else if (kind === "pdf-films") await downloadReportPdf(stored, "films");
      else await downloadReportPdf(stored);
    } catch (err) {
      preview?.close();
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
    const boxes = filmBoxes(localCase);
    const tags = Array.isArray(localCase.findingTags) ? localCase.findingTags : [];
    const placing = placingBoxes(localCase);
    const editBoxes = canEditBoxes();
    const patientName = patientDisplayName(localCase);
    const measures = measurementList();
    const view = cleanView(localCase.view);

    function boxStatus() {
      if (generating || awaitingAi) return "";
      if (placing) return "Azure is placing boxes on the film from the report…";
      if (localCase.boxesState === "failed") return "Azure could not place boxes for this report.";
      if (localCase.boxesState === "done" && !boxes.length && wantsBox(localCase)) return "Azure found nothing to box on this film.";
      if (boxes.some((f) => !isDrawnBox(f))) return "AI boxes are placed by Azure from the report wording. They are approximate, not drawn by CURV.";
      if (boxes.length) return "";
      if (wantsBox(localCase) && !localCase.boxesState) {
        if (localCase.status === "finalized") {
          return "This report is endorsed. It is not sent through the AI again.";
        }
        return "This report has no film boxes yet. Press Re-run AI for a fresh CURV report with boxes, or Save draft to box this one.";
      }
      return "";
    }

    const _imageSrc = imageSrc;

    const btn = "inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50";
    const btnLight = `${btn} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`;
    const unsavedDraft = tagsDirty || remarksDirty || boxesDirty || measuresDirty;
    const listMax = "max-h-36";

    const viewLabel = (v) => (v === "PA" ? "PA (erect)" : v || "not recorded");

    function clearDropMark() {
      dropMark = null;
      for (const row of document.querySelectorAll("[data-tag]")) {
        row.classList.remove("border-t-2", "border-b-2", "border-t-ha-blue", "border-b-ha-blue");
      }
    }

    function markDrop(row, after) {
      clearDropMark();
      dropMark = { key: row.dataset.tag, after };
      row.classList.add(after ? "border-b-2" : "border-t-2", after ? "border-b-ha-blue" : "border-t-ha-blue");
    }

    const rowsFor = (text) => Math.max(1, Math.ceil(String(text || "").length / 58));

    function tagRow(t) {
      const selected = t.key === selectedTagKey;
      const index = boxes.findIndex((f) => f.tagKey === t.key);
      const color = index >= 0 ? filmBoxColor(index, boxes.length) : null;
      const off = index >= 0 && belowThreshold(boxes[index]);
      const row = el("li", {
        class: `flex items-start gap-1.5 rounded-md border px-1.5 py-1 ${selected ? "border-slate-500 bg-slate-100" : "border-transparent hover:bg-slate-50"}${off ? " opacity-50" : ""}`,
        dataset: { tag: t.key, abnormal: t.abnormal ? "1" : "", selected: selected ? "1" : "", ...(off ? { belowThreshold: "1" } : {}) },
        onClick: () => pickTag(t.key),
        onMouseenter: () => setHover(t.key),
        onMouseleave: () => setHover(""),
        onDragover: (e) => {
          if (!dragKey) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          markDrop(row, dropAfter(e, row));
        },
        onDrop: (e) => {
          if (!dragKey) return;
          e.preventDefault();
          const from = dragKey;
          const after = dropAfter(e, row);
          dragKey = "";
          clearDropMark();
          reorder(from, t.key, after);
        },
      },
        edit && el("button", {
          type: "button",
          draggable: "true",
          class: "mt-0.5 shrink-0 cursor-grab select-none px-0.5 text-slate-400 hover:text-slate-700",
          title: "Drag to reorder",
          "aria-label": "Drag to reorder this finding",
          dataset: { dragTag: t.key },
          onDragstart: (e) => {
            dragKey = t.key;
            if (e.dataTransfer) {
              e.dataTransfer.effectAllowed = "move";
              try { e.dataTransfer.setData("text/plain", t.key); } catch { /* some browsers refuse */ }
              try { e.dataTransfer.setDragImage?.(row, 8, 8); } catch { /* not supported */ }
            }
          },
          onDragend: () => { dragKey = ""; clearDropMark(); },
        }, "\u22ee\u22ee"),
        el("button", {
          type: "button",
          disabled: !edit,
          class: `mt-0.5 shrink-0 rounded-full px-2 text-[11px] font-bold leading-5 ${t.abnormal ? "bg-rose-100 text-rose-800" : "bg-emerald-100 text-emerald-800"} disabled:cursor-default`,
          title: edit ? "Click to switch between normal and abnormal. Only an abnormal finding has a film box." : "",
          dataset: { flip: t.key },
          onClick: (e) => { e.stopPropagation(); flip(t.key); },
        }, t.abnormal ? "Abnormal" : "Normal"),
        edit
          ? el("textarea", {
              id: `tag-text-${t.key}`,
              class: "min-w-0 flex-1 resize-none rounded border border-transparent bg-transparent px-1 py-0.5 text-sm leading-5 outline-none hover:border-slate-300 focus:border-slate-400 focus:bg-white",
              rows: rowsFor(t.text),
              dataset: { tagText: t.key },
              onInput: (e) => {
                editTagText(t.key, e.target.value);
                e.target.rows = rowsFor(e.target.value);
              },
              onKeydown: (e) => {
                if (e.key === "Enter") e.preventDefault();
                if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                  e.preventDefault();
                  const at = tags.findIndex((x) => x.key === t.key);
                  const to = tags[at + (e.key === "ArrowUp" ? -1 : 1)];
                  if (to) reorder(t.key, to.key, e.key === "ArrowDown");
                }
              },
            }, t.text)
          : el("span", { class: "min-w-0 flex-1 px-1 py-0.5 text-sm leading-5" }, t.text),
        color
          ? el("span", { class: `mt-1.5 h-3 w-3 shrink-0 rounded-sm ${color.chip}`, title: "This finding's box on the film", dataset: { hasBox: t.key } })
          : t.abnormal
          ? el("span", { class: "mt-1 shrink-0 text-[10px] italic text-amber-700", title: "No box on the film yet. Select this finding and use Draw box." }, "no box")
          : null,
        edit && color && editBoxes && el("button", {
          type: "button",
          class: "mt-0.5 shrink-0 rounded border border-slate-300 px-1.5 text-[11px] font-semibold leading-5 text-slate-600 hover:bg-slate-100",
          title: "Delete this finding's box. Azure will not put it back.",
          dataset: { deleteBox: t.key },
          onClick: (e) => { e.stopPropagation(); deleteBox(t.key); },
        }, "Remove box"),
        edit && el("button", {
          type: "button",
          class: "mt-0.5 shrink-0 rounded border border-red-200 px-1.5 text-[11px] font-semibold leading-5 text-red-700 hover:bg-red-50",
          title: "Delete this finding, its box and its measurement",
          dataset: { deleteTag: t.key },
          onClick: (e) => { e.stopPropagation(); removeTag(t.key); },
        }, "Delete")
      );
      return row;
    }

    const root = el(
      "main",
      { class: "flex flex-col gap-2 p-1 lg:h-full" },
      el("div", { class: "flex shrink-0 flex-wrap items-start justify-between gap-2" },
        el("div", { class: "min-w-0" },
          el("div", { class: "flex flex-wrap items-center gap-x-3 gap-y-1" },
            el("button", {
              class: "inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900",
              onClick: () => setPage("dashboard"),
            }, svgIcon("arrow-left", { size: 14 }), isReferringDoctor(state.user) ? "Ward enquiry" : "Work list"),
            el("h1", { class: "text-lg font-bold text-slate-900" }, isReferringDoctor(state.user) ? "Exam enquiry" : "Reporting"),
            el("span", { class: "flex flex-wrap items-center gap-2 text-sm text-slate-600" },
              el("button", {
                class: "font-semibold text-slate-800 hover:text-ha-blue hover:underline",
                onClick: () => {
                  state.selectedPatientId = localCase.patientId;
                  setPage("patient");
                },
              }, patientName || localCase.patientId),
              patientName
                ? el("span", { class: "font-mono text-xs text-slate-500" }, localCase.patientId)
                : null,
              el("span", {}, `${localCase.age || "?"} years · ${localCase.sex || "?"}`),
              localCase.urgent ? urgentBadge() : null
            ),
            generating
              ? el("span", { class: "rounded-full bg-amber-50 text-amber-700 px-2.5 py-0.5 text-xs font-bold" }, "GENERATING")
              : awaitingAi
              ? el("span", { class: "rounded-full bg-violet-50 text-violet-700 px-2.5 py-0.5 text-xs font-bold" }, "AWAITING AI")
              : isAwaitingApprove(localCase)
              ? el("span", { class: "rounded-full bg-blue-50 text-ha-blue px-2.5 py-0.5 text-xs font-bold" }, "PENDING APPROVE")
              : localCase.status === "finalized"
              ? el("span", { class: "rounded-full bg-green-50 text-green-700 px-2.5 py-0.5 text-xs font-bold" }, "FINALIZED")
              : null
          ),
          el("p", { class: "mt-0.5 text-xs text-slate-500" },
            "Modality: ", el("b", { class: "text-slate-700" }, "XRAY"),
            " · Examination: ", el("b", { class: "text-slate-700" }, examinationName(view)),
            localCase.examinedAt
              ? el("span", { id: "examined-at" }, " · Examined: ", formatDateTime(localCase.examinedAt))
              : null,
            (localCase.registeredAt || localCase.imageId)
              ? el("span", {}, " · Registered: ", new Date(localCase.registeredAt || localCase.createdAt).toLocaleString())
              : null,
            " · Doctor in charge: ",
            el("span", { class: "font-semibold text-slate-700" }, doctorInCharge(localCase)),
            " · Case ", el("span", { class: "font-mono" }, localCase.caseId || localCase._id || ""),
            localCase.imageId ? el("span", {}, " · image ", el("span", { class: "font-mono" }, String(localCase.imageId).slice(-8))) : null
          )
        ),
        el("div", { class: "flex flex-wrap gap-1.5" },
          localCase.patientId && patientChartButton(localCase, { className: `${btn} border border-teal-700 bg-white text-teal-800 hover:bg-teal-50` }),
          canRunAi(state.user) && localCase.status !== "finalized" && !awaitingAi && el("button", {
            class: `${btn} bg-ha-blue text-white hover:bg-[#074f85]`,
            disabled: busy || generating,
            onClick: runAi,
          }, generating ? "Generating…" : "Re-run AI"),
          canExport(state.user) && el("button", {
            class: `${btn} bg-slate-900 text-white hover:bg-slate-700`,
            disabled: busy || generating || awaitingAi,
            onClick: () => download("preview"),
          }, svgIcon("eye", { size: 14 }), "Preview PDF"),
          canExport(state.user) && el("button", {
            class: btnLight,
            disabled: busy || generating || awaitingAi,
            title: "The report with one clean film",
            onClick: () => download("docx"),
          }, svgIcon("download", { size: 14 }), "Word"),
          canExport(state.user) && el("button", {
            class: btnLight,
            disabled: busy || generating || awaitingAi,
            title: "The report with one clean film",
            onClick: () => download("pdf"),
          }, svgIcon("download", { size: 14 }), "PDF"),
          canExport(state.user) && el("button", {
            class: btnLight,
            disabled: busy || generating || awaitingAi,
            title: "The report, then the whole film again for each abnormal finding with its box and measurement",
            onClick: () => download("docx-films"),
          }, svgIcon("download", { size: 14 }), "Word with finding films"),
          canExport(state.user) && el("button", {
            class: btnLight,
            disabled: busy || generating || awaitingAi,
            title: "The report, then the whole film again for each abnormal finding with its box and measurement",
            onClick: () => download("pdf-films"),
          }, svgIcon("download", { size: 14 }), "PDF with finding films"),
          canFlag && localCase.status === "finalized" && el("button", {
            class: btnLight,
            disabled: busy,
            onClick: shareReport,
          }, svgIcon("share", { size: 14 }), localCase.shared || localCase.shareToken ? "Copy share link" : "Share"),
          edit && el("button", {
            class: `${btn} bg-green-600 text-white hover:bg-green-700`,
            disabled: busy,
            onClick: finalize,
          }, "Endorse report"),
          canFlag && el("button", {
            class: localCase.urgent
              ? `${btn} border border-red-200 bg-red-50 text-red-700 hover:bg-red-100`
              : `${btn} border border-red-200 bg-white text-red-700 hover:bg-red-50`,
            disabled: busy,
            onClick: toggleUrgent,
          }, localCase.urgent ? "Remove urgent" : "Mark urgent")
        )
      ),

      msg && el("p", { id: "draft-notice", class: "shrink-0 rounded bg-green-50 px-3 py-1.5 text-sm text-green-700" }, msg),
      awaitingAi && el("p", { class: "shrink-0 rounded bg-violet-50 px-3 py-1.5 text-sm text-violet-900" },
        "The film is registered. The draft report is generated automatically and will appear here as pending approve."
      ),
      generating && el("p", { class: "shrink-0 rounded bg-amber-50 px-3 py-1.5 text-sm text-amber-800" },
        "The report is still generating. Return to the worklist — Review is ready once the status is ",
        el("b", {}, statusLabel("pending_approve")),
        "."
      ),

      // Film and report side by side, sharing the rest of the window.
      el("div", { class: "grid gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]" },
        // X-ray with the Azure boxes
        el("section", { class: "flex min-h-0 flex-col rounded-xl bg-slate-950 p-3 text-white" },
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
                class: `rounded-lg border px-2.5 py-1 text-xs font-semibold ${filmTool === "measure" ? "border-white bg-white text-black" : "border-white/20 bg-white/10 text-white hover:bg-white/20"}`,
                onClick: () => {
                  filmTool = filmTool === "measure" ? "view" : "measure";
                  measureLine = null;
                  ctrHeart = null;
                  showMeasures = true;
                  render();
                },
              }, filmTool === "measure" ? "Measuring" : "Measure"),
              editBoxes && el("button", {
                id: "measure-ctr",
                type: "button",
                title: "Draw the greatest transverse cardiac diameter, then the greatest inner thoracic diameter",
                class: `rounded-lg border px-2.5 py-1 text-xs font-semibold ${filmTool === "ctr" ? "border-white bg-white text-black" : "border-white/20 bg-white/10 text-white hover:bg-white/20"}`,
                onClick: () => {
                  filmTool = filmTool === "ctr" ? "view" : "ctr";
                  measureLine = null;
                  ctrHeart = null;
                  showMeasures = true;
                  render();
                },
              }, filmTool === "ctr" ? "Heart size…" : "Heart size"),
              editBoxes && el("button", {
                id: "draw-box",
                type: "button",
                class: `rounded-lg border px-2.5 py-1 text-xs font-semibold ${filmTool === "draw" ? "border-yellow-300 bg-yellow-600 text-white" : "border-white/20 bg-white/10 text-white hover:bg-white/20"}`,
                onClick: () => { filmTool = filmTool === "draw" ? "view" : "draw"; showBoxes = true; render(); },
              }, filmTool === "draw" ? "Drawing…" : "Draw box"),
              boxes.length > 0 && el("button", {
                id: "toggle-bboxes",
                type: "button",
                class: "rounded-lg border border-white/20 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white hover:bg-white/20",
                onClick: () => { showBoxes = !showBoxes; render(); },
              }, showBoxes ? "Hide boxes" : "Show boxes"),
              measures.length > 0 && el("button", {
                id: "toggle-measures",
                type: "button",
                class: "rounded-lg border border-white/20 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white hover:bg-white/20",
                onClick: () => { showMeasures = !showMeasures; render(); },
              }, showMeasures ? "Hide lines" : "Show lines")
            )
          ),
          boxes.length > 0 && el("div", { id: "confidence-filter", class: "mt-2 flex items-center gap-2 text-xs text-slate-300" },
            el("label", { for: "confidence-slider", class: "shrink-0 font-semibold" }, "Min confidence"),
            el("input", {
              id: "confidence-slider",
              type: "range",
              min: "0",
              max: "100",
              step: "5",
              value: String(minConfidence),
              class: "min-w-0 flex-1 accent-white",
              title: "Hide film boxes the AI is less sure about. 0% shows every box. This only changes the view, not the report.",
              "aria-valuetext": `${minConfidence}% minimum confidence`,
              onInput: (e) => setMinConfidence(e.target.value),
              onChange: (e) => setMinConfidence(e.target.value),
            }),
            el("span", { id: "confidence-value", class: "w-10 shrink-0 text-right font-mono text-white" }, `${minConfidence}%`),
            el("span", { id: "confidence-count", class: "shrink-0 text-slate-400" },
              `${boxes.filter((f) => !belowThreshold(f)).length} of ${boxes.length} shown`)
          ),
          el("div", {
            class: "mt-2 flex h-[60vh] overflow-auto rounded-lg bg-gradient-to-b from-slate-500 to-slate-900 lg:h-auto lg:min-h-0 lg:flex-1",
            style: { containerType: "size" },
          },
            el("div", {
              id: "xray-stage",
              class: `relative m-auto shrink-0 touch-none ${filmTool === "measure" || filmTool === "ctr" || filmTool === "draw" ? "cursor-crosshair" : ""}`,
              // At 100% the whole film fits the panel; zoom scales from there.
              style: {
                width: filmAspect
                  ? `calc(min(100cqw, ${(100 * filmAspect).toFixed(3)}cqh) * ${zoom})`
                  : `${Math.round(zoom * 100)}%`,
              },
              onPointerdown: onFilmPointerDown,
              onPointermove: onFilmPointerMove,
              onPointerup: onFilmPointerUp,
              onPointercancel: onFilmPointerUp,
              onPointerleave: () => { if (!boxDrag) setHover(""); },
              onWheel: onFilmWheel,
            },
              _imageSrc
                ? el("img", {
                    id: "xray-film",
                    src: _imageSrc,
                    class: "pointer-events-none block h-auto w-full",
                    alt: "Chest X-ray",
                    onLoad: (e) => {
                      const { naturalWidth: w, naturalHeight: h } = e.target;
                      const next = w && h ? w / h : 0;
                      if (next && Math.abs(next - filmAspect) > 0.001) {
                        filmAspect = next;
                        render();
                      }
                    },
                  })
                : el("div", { class: "pointer-events-none flex h-[320px] w-full min-w-[240px] items-center justify-center text-slate-300 text-sm" }, localCase.imageId ? "Loading image…" : "No image"),
              showMeasures && (measures.length > 0 || ctrHeart) && savedMeasuresLayer(ctrHeart ? [...measures, ctrHeart] : measures),
              ...(showMeasures ? (ctrHeart ? [...measures, ctrHeart] : measures).map((m, i) => savedMeasureLabel(m, i)) : []),
              measureLine && measureOverlay(measureLine),
              measureLine && measureLabelEl(measureLine),
              ...(!showBoxes ? [] : boxes.map((finding, index) => {
                const color = filmBoxColor(index, boxes.length);
                const selected = finding.tagKey === selectedTagKey;
                const tag = tagOf(finding.tagKey);
                return el("div", {
                  class: `pointer-events-none absolute ${color.border} ${selected ? `z-10 border-2 ${color.fill}` : "border-[1.5px]"} ${lineTool() ? "opacity-40" : ""}`,
                  dataset: { bbox: String(index + 1), bboxKey: boxKey(finding), boxTag: finding.tagKey, selected: selected ? "1" : "" },
                  style: {
                    display: belowThreshold(finding) ? "none" : "",
                    left: finding.bbox[0] + "%",
                    top: finding.bbox[1] + "%",
                    width: finding.bbox[2] + "%",
                    height: finding.bbox[3] + "%",
                  },
                  title: tag?.text || finding.sentence || finding.label,
                },
                  el("span", {
                    class: `absolute -top-4 left-0 max-w-[11rem] truncate rounded-sm px-1 text-[10px] font-semibold leading-4 text-black ${color.chip}`,
                    dataset: { bboxLabel: "1" },
                  }, tag?.text || finding.label),
                  ...(selected && editBoxes ? ["nw", "ne", "sw", "se"].map((h) =>
                    el("span", {
                      class: `absolute h-2.5 w-2.5 rounded-sm border ${color.handle}`,
                      dataset: { handle: h },
                      style: {
                        left: h.includes("w") ? "-5px" : "auto",
                        right: h.includes("e") ? "-5px" : "auto",
                        top: h.includes("n") ? "-5px" : "auto",
                        bottom: h.includes("s") ? "-5px" : "auto",
                      },
                    })
                  ) : [])
                );
              }))
            )
          ),
          el("p", { id: "film-hint", class: "mt-1.5 shrink-0 text-center text-xs text-slate-300" },
            filmTool === "ctr"
              ? (measureLine
                  ? measureText(measureLine)
                  : ctrHeart
                  ? "Now draw the greatest inner thoracic diameter."
                  : "Draw the greatest transverse cardiac diameter.")
              : filmTool === "measure"
              ? (measureLine
                  ? measureText(measureLine)
                  : editBoxes
                  ? "Drag a line across the lesion. It is written into the selected finding, or starts a new one."
                  : "Drag a line across the lesion. The label shows the film size. A body size is shown only when this file has a calibration.")
              : filmTool === "draw"
              ? "Drag on the film to draw a box for the selected finding, or for a new one."
              : editBoxes && boxes.length
              ? "Click a box to select its finding. Drag it to move, or drag a corner to resize."
              : `Zoom ${Math.round(zoom * 100)}%. Scroll the film to move around.`
          ),
          measurementPolicy().conflict && el("p", {
            id: "projection-warning",
            class: "shrink-0 text-center text-[11px] font-semibold text-amber-200",
          }, measurementPolicy().reason),
          (measures.length > 0 || lineTool()) && el("p", { id: "spacing-note", class: "shrink-0 text-center text-[11px] text-slate-400" },
            spacingNote()
          ),
          boxStatus() && el("p", { id: "box-status", class: "mt-0.5 shrink-0 text-center text-xs text-slate-400" }, boxStatus()),
          measures.length > 0 && el("div", { class: "mt-2 shrink-0" },
            el("div", { class: "flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-400" },
              el("span", {}, "Measurements (written into the report)"),
              measuresDirty && el("span", { class: "normal-case tracking-normal text-amber-300" }, "Unsaved. Press Save draft.")
            ),
            el("ul", { id: "measure-list", class: `mt-1 ${listMax} divide-y divide-white/10 overflow-y-auto rounded-lg border border-white/10` },
              ...measures.map((m, i) => {
                const key = measureKey(m, i);
                const owner = tagOf(m.tagKey);
                const shown = shownMeasure(m);
                const policy = measurementPolicy();
                const trial = policy.showExperimentalEstimate ? experimentalLabel(shown) : "";
                return el("li", { class: "flex items-center gap-2 px-3 py-1", dataset: { measureRow: key } },
                  el("span", { class: "shrink-0 rounded bg-white px-1.5 text-xs font-bold text-black" }, String(i + 1)),
                  el("span", { class: "min-w-0 flex-1 text-sm text-slate-100", title: owner?.text || "" },
                    el("span", { class: "block truncate" }, m.kind === "ctr-heart" ? "Heart" : m.kind === "ctr-thorax" ? "Thorax" : "Line"),
                    trial && el("span", { class: "block truncate text-[11px] text-amber-200", dataset: { experimentalEstimate: String(i + 1) } }, `${trial}. ${EXPERIMENTAL_NOTE}`)
                  ),
                  el("span", { class: "shrink-0 font-mono text-sm text-white" }, shown.text),
                  editBoxes && el("button", {
                    type: "button",
                    class: "shrink-0 rounded border border-red-300/40 px-2 py-0.5 text-xs font-semibold text-red-200 hover:bg-red-500/20",
                    title: m.kind === "lesion" || !m.kind ? "Delete this line" : "Delete this line and the ratio sentence",
                    dataset: { deleteMeasure: key },
                    onClick: () => deleteMeasurement(key),
                  }, "Delete")
                );
              })
            )
          )
        ),

        el("section", { class: "flex min-h-0 flex-col gap-3" },
          el("div", { class: "flex min-h-0 flex-1 flex-col" },
            edit && el("div", { class: "mb-2 flex justify-end" },
              el("button", {
                id: "save-draft",
                class: `${btn} bg-slate-900 px-3.5 py-2 text-sm text-white shadow-sm hover:bg-slate-700 ${unsavedDraft ? "ring-2 ring-slate-400 ring-offset-1" : ""}`,
                disabled: busy,
                onClick: saveDraft,
              }, svgIcon("save", { size: 16 }), "Save draft")
            ),
            el("div", { class: "card flex min-h-0 flex-1 flex-col !p-3", id: "report-panel" },
              el("div", { class: "flex shrink-0 flex-wrap items-center justify-between gap-2" },
                el("h2", { class: "text-base font-bold text-slate-900" }, "Report"),
                edit
                  ? el("label", { class: "flex items-center gap-1.5 text-xs font-semibold text-slate-600" },
                      "View",
                      el("select", {
                        id: "view-select",
                        class: "input !w-auto py-1 text-xs",
                        value: view,
                        onChange: (e) => changeView(e.target.value),
                      }, ...VIEWS.map((v) => el("option", { value: v, selected: v === view }, viewLabel(v)))))
                  : el("span", { id: "view-label", class: "text-xs font-semibold text-slate-600" }, `View: ${viewLabel(view)}`)
              ),
              el("dl", { id: "report-header", class: "mt-1 grid shrink-0 grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] leading-4 text-slate-600" },
                ...reportHeaderFields(localCase, state.user?.name || "").map((f) =>
                  el("div", { class: "truncate", dataset: { field: f.label } },
                    el("dt", { class: "inline font-semibold text-slate-500" }, `${f.label}: `),
                    el("dd", { class: "inline text-slate-800" }, f.value))
                )
              ),
              el("div", { id: "report-text", class: "mt-2 min-h-0 flex-1 overflow-y-auto text-sm leading-6 text-slate-800" },
                generating
                  ? el("p", {}, "The report is still generating.")
                  : !tags.length && !edit && !String(localCase.comment || "").trim()
                  ? el("p", {}, "No report has been saved for this case yet.")
                  : [
                      el("p", { id: "report-title", class: "text-sm font-bold tracking-wide text-slate-900" }, reportTitle(view)),
                      el("h3", { class: "mt-2 text-xs font-bold uppercase tracking-wide text-slate-500" }, "FINDINGS"),
                      el("ul", { id: "tag-list", class: "mt-1 space-y-0.5" }, ...tags.map(tagRow)),
                      edit && el("div", { class: "mt-1.5 flex gap-1.5" },
                        el("input", {
                          id: "new-finding",
                          class: "input min-w-0 flex-1 py-1 text-sm",
                          placeholder: "Add a finding at the end of the list…",
                          value: newFinding,
                          onInput: (e) => { newFinding = e.target.value; },
                          onKeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); addFinding(); } },
                        }),
                        el("button", { id: "add-finding", type: "button", class: btnLight, onClick: addFinding }, "Add")
                      ),
                      el("h3", { class: "mt-3 text-xs font-bold uppercase tracking-wide text-slate-500" }, "COMMENT"),
                      edit
                        ? el("textarea", {
                            id: "comment-text",
                            class: "input mt-1 h-16 resize-none py-1.5 text-sm",
                            rows: 2,
                            placeholder: "One conclusive line",
                            onInput: (e) => changeComment(e.target.value),
                          }, localCase.comment || "")
                        : el("p", { id: "comment-text", class: "mt-0.5" }, String(localCase.comment || "").trim() ? `– ${String(localCase.comment).trim()}` : ""),
                      el("p", { class: "mt-3" }, THANKS_LINE),
                      el("p", { id: "endorser", class: localCase.status === "finalized" ? "font-semibold" : "text-slate-400 italic" },
                        localCase.status === "finalized"
                          ? (localCase.finalizedByName || "")
                          : "The endorsing radiologist's name is added when the report is endorsed.")
                    ]
              ),
              edit && el("p", { class: "mt-1 shrink-0 text-xs text-slate-500" },
                "Drag \u22ee\u22ee to reorder. Click a finding to see its box, or a box to see its finding. COMMENT is the conclusive line and has no box. Save draft keeps your edits and Azure adds boxes for new abnormal findings."
              ),
              canRemark && el("p", { id: "mongo-report-status", class: "mt-0.5 shrink-0 text-xs font-medium text-ha-blue" })
            )
          ),
          showProvenance && (localCase.editLog || []).length > 0 && el("div", { class: "card shrink-0 !p-0" },
            el("button", {
              id: "toggle-log",
              type: "button",
              class: "flex w-full items-center justify-between gap-2 px-3 py-2 text-left",
              "aria-expanded": showLog ? "true" : "false",
              onClick: () => { showLog = !showLog; render(); },
            },
              el("span", { class: "text-sm font-bold text-slate-900" },
                `Draft log (AI vs manual) · ${(localCase.editLog || []).length}`),
              el("span", { class: "text-xs font-semibold text-ha-blue" }, showLog ? "Hide" : "Show")
            ),
            showLog && el("div", { class: "max-h-48 overflow-y-auto border-t border-slate-200 px-3 pb-2" },
            el("p", { class: "mt-2 text-xs text-slate-500" },
              "Shown while editing. The signed report the doctor sees has no source tags."
            ),
            el("ul", { class: "mt-2 space-y-2 text-sm" },
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
      )
    );

    mount(target, root);
    applyHover();
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
