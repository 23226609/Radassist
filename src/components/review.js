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
import { downloadReportDocx, downloadReportPdf, previewReportPdf, openPreviewWindow, applyRemarksToReport, splitReportAndRemarks, withoutThinking, restoreThinking, normalizeReportShape } from "../lib/reportExport.js";
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

function isDrawnBox(f) {
  return String(f?.source || "").toLowerCase() === "manual";
}

function boxKey(f) {
  return String(f?._id || f?.id || "");
}

// Boxes the radiologist drew, plus Azure boxes for abnormal findings. Normal
// statements ("clear lungs") and older locally parsed findings have no real
// position. A deleted AI box stays stored as rejected so Azure does not put
// it back, but it is not drawn. Finalized cases arrive without `source`
// (the signed report carries no AI/manual tags), so a box placed by Azure
// or by hand is then recognised by its `bboxSource` instead.
function deniesFinding(f) {
  const text = `${f?.label || ""} ${f?.sentence || ""}`.replace(/\s+/g, " ").trim();
  if (!/\b(no|without|negative for|absence of|free of|no evidence of|no sign of)\b/i.test(text)) return false;
  const rest = text.replace(/\b(no|without|negative for|absence of|free of|no evidence of|no sign of)\b[^.]*/gi, " ");
  return !/\b(low lung volumes|volume loss|atelecta|consolidat|pneumonia|collapse|fracture|nodule|mass|cardiomegaly|white-?out|infiltrat|fibrosis|effusion|pneumothorax|edema|oedema)\b/i.test(rest);
}

function filmBoxes(findings) {
  return (findings || []).filter((f) => {
    if (!hasBbox(f) || f.status === "rejected") return false;
    if (isDrawnBox(f)) return true;
    if (deniesFinding(f)) return false;
    if (f.source) return f.source === "Azure" && f.severity !== "normal";
    return Boolean(f.bboxSource) && f.severity !== "normal";
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
  let selectedBoxKey = "";
  let boxesDirty = false;
  let measureLine = null;
  let measuresDirty = false;
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
    bodyDraft = withoutThinking(normalizeReportShape(split.body));
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

  function setMeasurements(next) {
    localCase = { ...localCase, measurements: next };
    measuresDirty = true;
    markUnsaved();
  }

  function addMeasurement(line, text) {
    const id = `tmp-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const r = (n) => Math.round(Math.min(100, Math.max(0, Number(n) || 0)) * 100) / 100;
    setMeasurements([...measurementList(), {
      _id: id,
      x1: r(line.x1), y1: r(line.y1), x2: r(line.x2), y2: r(line.y2),
      text,
      label: "",
    }]);
  }

  function deleteMeasurement(key) {
    setMeasurements(measurementList().filter((m, i) => measureKey(m, i) !== key));
    render();
  }

  function measurementsForSave() {
    return measurementList().map(({ _id, x1, y1, x2, y2, text, label }) => {
      const row = { x1, y1, x2, y2, text, label: String(label || "").trim() };
      if (_id && !String(_id).startsWith("tmp-")) row._id = _id;
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
    const name = String(m.label || "").trim();
    return `${i + 1} · ${name ? `${name} ` : ""}${m.text}`;
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

  function canEditBoxes() {
    return Boolean(localCase) && canEditReport(state.user) && localCase.status !== "finalized"
      && !isGenerating(localCase) && !placingBoxes(localCase);
  }

  function setFindings(next) {
    localCase = { ...localCase, findings: next };
    boxesDirty = true;
    markUnsaved();
  }

  function patchBox(key, patch) {
    setFindings((localCase.findings || []).map((f) => (boxKey(f) === key ? { ...f, ...patch } : f)));
  }

  function deleteBox(key) {
    const target = (localCase.findings || []).find((f) => boxKey(f) === key);
    if (!target) return;
    setFindings(isDrawnBox(target)
      ? (localCase.findings || []).filter((f) => boxKey(f) !== key)
      : (localCase.findings || []).map((f) => (boxKey(f) === key ? { ...f, status: "rejected" } : f)));
    if (selectedBoxKey === key) selectedBoxKey = "";
    render();
  }

  function addDrawnBox(bbox) {
    const id = `tmp-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    setFindings([...(localCase.findings || []), {
      _id: id,
      id,
      label: "Marked area",
      bbox,
      source: "manual",
      bboxSource: "manual",
      status: "pending",
      severity: "",
      confidence: 1,
      pattern: "Other",
      sentence: "",
      location: "",
      size: "",
    }]);
    selectedBoxKey = id;
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

  function selectedBox() {
    return filmBoxes(localCase.findings).find((f) => boxKey(f) === selectedBoxKey) || null;
  }

  function onFilmPointerDown(e) {
    if (e.button != null && e.button !== 0) return;
    const stage = e.currentTarget || document.getElementById("xray-stage");
    if (!stage) return;
    const pct = eventToPct(e, stage);
    if (filmTool === "measure") {
      measureLine = { x1: pct.x, y1: pct.y, x2: pct.x, y2: pct.y };
      boxDrag = { mode: "measure" };
      try { stage.setPointerCapture?.(e.pointerId); } catch { /* tests */ }
      paintMeasure(stage, measureLine);
      e.preventDefault();
      return;
    }
    if (!canEditBoxes()) return;
    if (filmTool === "draw") {
      boxDrag = { mode: "draw", start: pct };
    } else {
      if (!showBoxes) return;
      const sel = selectedBox();
      const hit = sel ? hitBoxHandle(pct, sel.bbox) : null;
      if (hit === "move") {
        boxDrag = { mode: "move", key: selectedBoxKey, start: pct, origin: sel.bbox.slice() };
      } else if (hit) {
        boxDrag = { mode: "resize", handle: hit, key: selectedBoxKey, start: pct, origin: sel.bbox.slice() };
      } else {
        const under = [...filmBoxes(localCase.findings)].reverse().find((f) => hitBoxHandle(pct, f.bbox) === "move");
        selectedBoxKey = under ? boxKey(under) : "";
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
    if (filmTool === "view" && canEditBoxes()) {
      const sel = selectedBox();
      stage.style.cursor = sel ? cursorForHandle(hitBoxHandle(pct, sel.bbox)) : "";
    }
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
      const line = measureLine;
      const long = line && Math.hypot(line.x2 - line.x1, line.y2 - line.y1) >= 1;
      const text = long ? measureLength(line) : "";
      if (!text) {
        measureLine = null;
      } else if (canEditBoxes()) {
        addMeasurement(line, text);
        measureLine = null;
      }
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
      patchBox(drag.key, { bbox, bboxSource: "manual" });
    }
    render();
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
    remarksDraft = localCase.remarks || fallback.remarks || "";
    remarksDirty = false;
    reportDirty = false;
    bodyDraft = withoutThinking(normalizeReportShape(splitReportAndRemarks(localCase.reportText || "").body));
    bodyDirty = false;
    boxesDirty = false;
    measuresDirty = false;
    if (selectedBoxKey && !filmBoxes(localCase.findings).some((f) => boxKey(f) === selectedBoxKey)) {
      selectedBoxKey = "";
    }
  }

  // The report body is sent only when the radiologist typed in it, and boxes
  // only when they drew, moved or deleted one; otherwise the stored copy is
  // kept so a stale copy here cannot overwrite the popup or a fresh Azure pass.
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
      const storedBody = splitReportAndRemarks(stored.reportText || "").body;
      const composed = applyRemarksToReport(
        typedBody == null ? stored.reportText : restoreThinking(storedBody, typedBody),
        note
      );
      const payload = {
        reportText: composed.reportText,
        remarks: composed.remarks,
      };
      if (boxesDirty) payload.findings = findingsForSave(localCase.findings);
      if (measuresDirty) payload.measurements = measurementsForSave();
      const reportChanged = withoutThinking(splitReportAndRemarks(composed.reportText).body)
        !== withoutThinking(storedBody);
      const updated = await api.updateCase(getEffectiveCaseId(), payload);
      let next = unwrapLegacyReport(updated.case || { ...stored, ...payload });
      const typedSince = bodyDirty && bodyDraft !== typedBody;
      const neverBoxed = !stored.boxesState && !filmBoxes(payload.findings || stored.findings).length;
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

  async function saveRemarks() {
    busy = true;
    render();
    try {
      const stored = await persistClinicianEdits();
      const saved = stored.status === "finalized"
        ? "Remarks saved. The finalized report was not changed."
        : "Remarks saved and added to the report.";
      showNotice(saved);
      toast(saved);
    } catch (err) {
      showNotice(err.message);
      toast(err.message);
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
      else if (kind === "preview") await previewReportPdf(stored, preview);
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
    const boxes = filmBoxes(localCase.findings);
    const placing = placingBoxes(localCase);
    const editBoxes = canEditBoxes();
    const patientName = patientDisplayName(localCase);
    const reportBody = withoutThinking(normalizeReportShape(splitReportAndRemarks(localCase.reportText || "").body));
    const measures = measurementList();

    function boxStatus() {
      if (generating || awaitingAi) return "";
      if (placing) return "Azure is placing boxes on the film from the report…";
      if (localCase.boxesState === "failed") return "Azure could not place boxes for this report.";
      if (localCase.boxesState === "done" && !boxes.length) return "Azure found nothing to box on this film.";
      if (boxes.some((f) => !isDrawnBox(f))) return "AI boxes are placed by Azure from the report wording. They are approximate, not drawn by CURV.";
      if (boxes.length) return "";
      if (String(localCase.reportText || "").trim() && !localCase.boxesState) {
        return "This report has no film boxes yet. Press Re-run AI for a fresh CURV report with boxes, or Save draft to box this one.";
      }
      return "";
    }

    const _imageSrc = imageSrc;

    const btn = "inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50";
    const btnLight = `${btn} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`;
    const unsavedDraft = bodyDirty || remarksDirty || boxesDirty || measuresDirty;
    const listMax = boxes.length > 0 && measures.length > 0 ? "max-h-28" : "max-h-36";

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
            " · Procedure: ", el("b", { class: "text-slate-700" }, "Chest"),
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
            onClick: () => download("docx"),
          }, svgIcon("download", { size: 14 }), "Word"),
          canExport(state.user) && el("button", {
            class: btnLight,
            disabled: busy || generating || awaitingAi,
            onClick: () => download("pdf"),
          }, svgIcon("download", { size: 14 }), "PDF"),
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
                  showMeasures = true;
                  render();
                },
              }, filmTool === "measure" ? "Measuring" : "Measure"),
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
          el("div", {
            class: "mt-2 flex h-[60vh] overflow-auto rounded-lg bg-gradient-to-b from-slate-500 to-slate-900 lg:h-auto lg:min-h-0 lg:flex-1",
            style: { containerType: "size" },
          },
            el("div", {
              id: "xray-stage",
              class: `relative m-auto shrink-0 touch-none ${filmTool === "measure" || filmTool === "draw" ? "cursor-crosshair" : ""}`,
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
              showMeasures && measures.length > 0 && savedMeasuresLayer(measures),
              ...(showMeasures ? measures.map((m, i) => savedMeasureLabel(m, i)) : []),
              measureLine && measureOverlay(measureLine),
              measureLine && measureLabelEl(measureLine),
              ...(!showBoxes ? [] : boxes.map((finding, index) => {
                const color = filmBoxColor(index, boxes.length);
                const selected = boxKey(finding) === selectedBoxKey;
                return el("div", {
                  class: `pointer-events-none absolute ${color.border} ${selected ? `z-10 border-2 ${color.fill}` : "border-[1.5px]"} ${filmTool === "measure" ? "opacity-40" : ""}`,
                  dataset: { bbox: String(index + 1), bboxKey: boxKey(finding), selected: selected ? "1" : "" },
                  style: {
                    left: finding.bbox[0] + "%",
                    top: finding.bbox[1] + "%",
                    width: finding.bbox[2] + "%",
                    height: finding.bbox[3] + "%",
                  },
                  title: finding.sentence || finding.label,
                },
                  el("span", {
                    class: `absolute -top-4 left-0 max-w-[11rem] truncate rounded-sm px-1 text-[10px] font-semibold leading-4 text-black ${color.chip}`,
                    dataset: { bboxLabel: "1" },
                  }, finding.label),
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
          el("p", { class: "mt-1.5 shrink-0 text-center text-xs text-slate-300" },
            filmTool === "measure"
              ? (measureLine
                  ? measureText(measureLine)
                  : editBoxes
                  ? "Drag a line across the lesion. Each line is added to the report when you press Save draft."
                  : "Drag a line across the lesion. Centimetres use the DICOM pixel spacing.")
              : filmTool === "draw"
              ? "Drag on the film to draw a box, then name it in the list below."
              : editBoxes && boxes.length
              ? "Click a box to select it. Drag it to move, or drag a corner to resize."
              : `Zoom ${Math.round(zoom * 100)}%. Scroll the film to move around.`
          ),
          boxStatus() && el("p", { id: "box-status", class: "mt-0.5 shrink-0 text-center text-xs text-slate-400" }, boxStatus()),
          boxes.length > 0 && el("div", { class: "mt-2 shrink-0" },
            el("div", { class: "flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-400" },
              el("span", {}, "Boxes on the film"),
              boxesDirty && el("span", { class: "normal-case tracking-normal text-amber-300" }, "Unsaved. Press Save draft.")
            ),
            el("ul", { id: "box-list", class: `mt-1 ${listMax} divide-y divide-white/10 overflow-y-auto rounded-lg border border-white/10` },
              ...boxes.map((f, i) => {
                const key = boxKey(f);
                const color = filmBoxColor(i, boxes.length);
                const selected = key === selectedBoxKey;
                const select = () => { selectedBoxKey = selected ? "" : key; render(); };
                return el("li", {
                  class: `flex items-center gap-2 px-3 py-1 ${selected ? "bg-white/10" : ""}`,
                  dataset: { boxRow: key },
                },
                  el("button", {
                    type: "button",
                    class: `h-3.5 w-3.5 shrink-0 rounded-sm ${color.chip}`,
                    title: "Select this box",
                    onClick: select,
                  }),
                  editBoxes && isDrawnBox(f)
                    ? el("input", {
                        class: "min-w-0 flex-1 rounded bg-white/10 px-2 py-1 text-sm text-white outline-none focus:bg-white/20",
                        value: f.label || "",
                        placeholder: "Name this box",
                        dataset: { boxName: key },
                        onFocus: () => { selectedBoxKey = key; },
                        onInput: (e) => {
                          patchBox(key, { label: e.target.value });
                          const tag = document.querySelector(`[data-bbox-key="${key}"] [data-bbox-label]`);
                          if (tag) tag.textContent = e.target.value || "Marked area";
                        },
                      })
                    : el("button", {
                        type: "button",
                        class: "min-w-0 flex-1 truncate text-left text-sm text-slate-100",
                        title: f.sentence || f.label,
                        onClick: select,
                      }, f.label),
                  f.source && el("span", { class: "shrink-0 text-[11px] font-semibold uppercase text-slate-400" },
                    isDrawnBox(f) ? "Manual" : f.bboxSource === "manual" ? "AI · adjusted" : "AI"),
                  editBoxes && el("button", {
                    type: "button",
                    class: "shrink-0 rounded border border-red-300/40 px-2 py-0.5 text-xs font-semibold text-red-200 hover:bg-red-500/20",
                    dataset: { deleteBox: key },
                    onClick: () => deleteBox(key),
                  }, "Delete")
                );
              })
            )
          ),
          measures.length > 0 && el("div", { class: "mt-2 shrink-0" },
            el("div", { class: "flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-400" },
              el("span", {}, "Measurements (in the report)"),
              measuresDirty && el("span", { class: "normal-case tracking-normal text-amber-300" }, "Unsaved. Press Save draft.")
            ),
            el("ul", { id: "measure-list", class: `mt-1 ${listMax} divide-y divide-white/10 overflow-y-auto rounded-lg border border-white/10` },
              ...measures.map((m, i) => {
                const key = measureKey(m, i);
                return el("li", { class: "flex items-center gap-2 px-3 py-1", dataset: { measureRow: key } },
                  el("span", { class: "shrink-0 rounded bg-white px-1.5 text-xs font-bold text-black" }, String(i + 1)),
                  editBoxes
                    ? el("input", {
                        class: "min-w-0 flex-1 rounded bg-white/10 px-2 py-1 text-sm text-white outline-none focus:bg-white/20",
                        value: m.label || "",
                        placeholder: "Name (optional), e.g. Nodule",
                        dataset: { measureName: key },
                        onInput: (e) => {
                          setMeasurements(measurementList().map((row, j) => (measureKey(row, j) === key ? { ...row, label: e.target.value } : row)));
                          const tag = document.querySelector(`[data-saved-measure-label="${i + 1}"]`);
                          if (tag) tag.textContent = measureTagText({ ...m, label: e.target.value }, i);
                        },
                      })
                    : el("span", { class: "min-w-0 flex-1 truncate text-sm text-slate-100" }, m.label || "Measurement"),
                  el("span", { class: "shrink-0 font-mono text-sm text-white" }, m.text),
                  editBoxes && el("button", {
                    type: "button",
                    class: "shrink-0 rounded border border-red-300/40 px-2 py-0.5 text-xs font-semibold text-red-200 hover:bg-red-500/20",
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
            el("h2", { class: "shrink-0 text-base font-bold text-slate-900" }, "Report"),
            edit
              ? el("textarea", {
                  id: "report-text",
                  class: "input mt-2 min-h-[16rem] flex-1 resize-none font-sans text-sm leading-6 lg:min-h-[8rem]",
                  rows: 18,
                  onInput: (e) => { bodyDraft = e.target.value; bodyDirty = true; markUnsaved(); },
                }, bodyDraft)
              : el("pre", { id: "report-text", class: "mt-2 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap font-sans text-sm leading-6 text-slate-800" },
                  generating
                    ? "The report is still generating."
                    : reportBody || "No report has been saved for this case yet."
                ),
            edit && el("p", { class: "mt-1 shrink-0 text-xs text-slate-500" },
              "Save draft keeps your edits and Azure adds boxes for new findings. Boxes you drew, resized or deleted stay as you left them."
            )
          )
          ),
          el("div", { class: "card shrink-0 !p-3" },
            el("div", { class: "flex flex-wrap items-center justify-between gap-2" },
              el("h2", { class: "text-base font-bold text-slate-900" }, "Remarks"),
              canRemark && el("button", {
                class: `${btn} bg-slate-900 text-white hover:bg-slate-700`,
                disabled: busy,
                onClick: saveRemarks,
              }, "Save remarks")
            ),
            el("textarea", {
              id: "remarks-box",
              class: "input mt-2 h-20 resize-y py-1.5 text-sm",
              rows: 3,
              readOnly: !canRemark,
              placeholder: localCase.status === "finalized"
                ? "Notes stay on this case. They are not added to the finalized report…"
                : "Notes or extra findings to add to the report…",
              onInput: (e) => { remarksDraft = e.target.value; remarksDirty = true; markUnsaved(); },
            }, remarksDraft),
            el("p", { class: "mt-1 text-xs text-slate-500" },
              localCase.status === "finalized"
                ? "This case is finalized. Remarks are saved as notes only and are not written into the report, Word, or PDF."
                : "Nothing is written until you press Save draft or Save remarks. Both save the report and the remarks."
            ),
            canRemark && el("p", { id: "mongo-report-status", class: "mt-0.5 text-xs font-medium text-ha-blue" })
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
