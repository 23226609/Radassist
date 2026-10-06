// src/components/review.js
// Single-case review page.
//
// Workflow mirrors the original Radassist design:
//   1. AI gives us a free-text radiology report (markdown) in `reportText`
//      plus optional pre-structured findings in `findings`.
//   2. Finding cards are stored on the case during generate (Azure when
//      configured). Opening Review only shows them — it does not call Azure.
//      If a case has no cards, a local parse of the report fills the list.
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
import { reportPopupUrl } from "../lib/reportPopup.js";
import { downloadReportDocx, downloadReportPdf, composeReportText, splitReportAndRemarks, splitManualFindings, removeFindingFromReport, applyFindingChangeToReport } from "../lib/reportExport.js";
import { mergeFindingsFromReport, overlayAzureOnParsed, dedupeFindings } from "../lib/findingsSync.js";
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

const PATTERNS = ["Nodular", "Diffuse", "Linear", "Ground-glass", "Consolidation", "Other"];

function confidenceTitle(f) {
  const parts = [];
  if (f?.languageScore != null) parts.push(`report wording ${Math.round(f.languageScore * 100)}%`);
  if (f?.imageSupport != null) parts.push(`image ${Math.round(f.imageSupport * 100)}%`);
  if (!parts.length) return "Clinician-adjustable confidence";
  return `From ${parts.join(" + ")}`;
}

function isManualFinding(f) {
  if (!f) return false;
  if (f.source === "manual") return true;
  return String(f._id || f.id || "").startsWith("tmp-");
}

function isUnsavedManual(f) {
  if (!isManualFinding(f)) return false;
  if (f.draft === true) return true;
  return String(f._id || f.id || "").startsWith("tmp-");
}

function findingPointMeta(f) {
  const bits = [];
  if (f?.location) bits.push(String(f.location).trim());
  if (f?.size) bits.push(String(f.size).trim());
  if (f?.pattern && f.pattern !== "Other") bits.push(f.pattern);
  const cleaned = bits.filter(Boolean);
  if (cleaned.length) return cleaned.join(" · ");
  const extra = String(f?.sentence || f?.detail || "").replace(/\s+/g, " ").trim();
  if (!extra) return "";
  if (extra.toLowerCase() === String(f?.label || "").trim().toLowerCase()) return "";
  return extra.length > 90 ? extra.slice(0, 87).trim() + "…" : extra;
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
  return [
    Number(left.toFixed(2)),
    Number(top.toFixed(2)),
    Number(Math.max(1, Math.abs(a.x - b.x)).toFixed(2)),
    Number(Math.max(1, Math.abs(a.y - b.y)).toFixed(2)),
  ];
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
  return clampBox(l + (pct.x - start.x), t + (pct.y - start.y), w, h);
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

function hitBoxHandle(pct, bbox) {
  if (!hasBbox({ bbox })) return null;
  const [l, t, w, h] = bbox.map(Number);
  const r = l + w;
  const b = t + h;
  const pad = 4;
  const corners = [
    ["nw", l, t],
    ["ne", r, t],
    ["sw", l, b],
    ["se", r, b],
  ];
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
  return "crosshair";
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
export async function resyncMachineFindings(caseId, stored) {
  if (!caseId || !stored || stored.status === "finalized") return stored;
  const previous = stored.findings || [];
  const body = splitManualFindings(splitReportAndRemarks(stored.reportText || "").body).body;
  let parsed = parseFindingsFromReport(body, 0);
  try {
    const data = await api.summariseFindings(caseId);
    const next = unwrapLegacyReport(data.case || stored);
    const azure = (next.findings || []).filter((f) => !isManualFinding(f));
    parsed = overlayAzureOnParsed(parsed, azure, stored.reportText || next.reportText);
  } catch {
    // Local parse is the source of truth for add / edit / delete in the draft.
  }
  const findings = mergeFindingsFromReport(previous, parsed, stored.reportText);
  try {
    const updated = await api.updateCase(caseId, { findings });
    return unwrapLegacyReport(updated.case || { ...stored, findings });
  } catch {
    return { ...stored, findings };
  }
}

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
  let selectedIndex = 0; // which finding is selected in the list / editor
  let showBoxes = true;
  let boxDrag = null;
  let remarksDraft = "";
  let remarksDirty = false;

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

  // If Azure already wrote cards during generate, show them. Otherwise parse
  // the stored report locally — do not call Azure on page open.
  function fillFromLocalParser() {
    if (!localCase) return;
    const report = localCase.reportText || "";
    if (!report.trim()) return;
    const existing = localCase.findings || [];
    if (existing.length) return;
    const parsed = parseFindingsFromReport(report, 0);
    if (parsed.length === 0) return;
    localCase = { ...localCase, findings: parsed };
  }

  async function refreshFromServer() {
    const caseId = getEffectiveCaseId();
    if (!caseId || signal.aborted || leaving) return;
    try {
      const data = await api.getCase(caseId, { signal });
      if (signal.aborted || leaving) return;
      localCase = data.case || data;
      // One-shot fixup: unwrap the legacy `{"report":"..."}` string shape.
      localCase = unwrapLegacyReport(localCase);
      const tidy = dedupeFindings(localCase.findings || []);
      if (tidy.length !== (localCase.findings || []).length) {
        localCase = { ...localCase, findings: tidy };
        if (canEditReport(state.user) && localCase.status !== "finalized") {
          persistClinicianEdits().catch(() => {});
        }
      }
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

  let saveTimer = null;
  let persistChain = Promise.resolve();

  function isDraftFindingId(id) {
    return String(id || "").startsWith("tmp-");
  }

  function queueReportSync() {
    if (!canEditReport(state.user) || !getEffectiveCaseId()) return;
    hintMongo("Saving to MongoDB…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      persistClinicianEdits().catch((err) => {
        hintMongo("");
        toast(err.message || "Could not save the report.");
      });
    }, 450);
  }

  function patchFinding(id, patch, { refresh = false } = {}) {
    const prev = (localCase.findings || []).find((f) => String(f._id || f.id) === String(id));
    if (!prev) return;
    const next = { ...prev, ...patch };
    const clinicalKeys = ["label", "location", "size", "pattern", "sentence"];
    const clinicalChanged = clinicalKeys.some((k) => (
      Object.prototype.hasOwnProperty.call(patch, k) && String(patch[k] ?? "") !== String(prev[k] ?? "")
    ));

    let reportText = localCase.reportText;
    if (clinicalChanged && !isDraftFindingId(id)) {
      if (isManualFinding(next)) {
        const findings = (localCase.findings || []).map((f) => (
          String(f._id || f.id) === String(id) ? next : f
        ));
        reportText = applyLocalEdits(reportText, { findings }).reportText;
      } else {
        const applied = applyFindingChangeToReport(reportText, prev, next);
        reportText = applied.reportText;
        next.sentence = applied.sentence;
      }
    }

    localCase = {
      ...localCase,
      reportText,
      findings: (localCase.findings || []).map((f) => (
        String(f._id || f.id) === String(id) ? next : f
      )),
    };
    // Text fields keep their own caret — remounting on every keystroke made
    // the remarks box and finding inputs feel like they wouldn't accept typing.
    if (refresh) render();
    // Keep unsaved manual cards local until Finish this finding — otherwise a
    // mid-draw autosave can overwrite the box or the details.
    if (!isDraftFindingId(id)) queueReportSync();
  }

  function addFinding() {
    // Generate a stable-ish temp id so the in-memory list works before save.
    const tempId = "tmp-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8);
    const newFinding = {
      _id: tempId,
      id: tempId,
      label: "New finding",
      confidence: 0.5,
      bbox: [],
      location: "",
      size: "",
      pattern: "Other",
      sentence: "",
      status: "pending",
      source: "manual",
      bboxSource: "manual",
      draft: true,
    };
    const next = [...(localCase.findings || []), newFinding];
    localCase = { ...localCase, findings: next };
    selectedIndex = next.length - 1;
    render();
  }

  function removeFinding(id, index = selectedIndex) {
    const findings = [...(localCase.findings || [])];
    const idx = findings.findIndex((f, i) => {
      const fid = String(f._id || f.id || "");
      if (id != null && id !== "" && fid && fid === String(id)) return true;
      return (id == null || id === "" || !fid) && i === index;
    });
    const removed = idx >= 0 ? findings[idx] : null;
    if (!removed) return;
    findings.splice(idx, 1);
    const stripped = isDraftFindingId(removed._id || removed.id)
      ? { reportText: localCase.reportText, remarks: remarksDraft }
      : removeFindingFromReport(localCase.reportText, removed);
    const composed = applyLocalEdits(stripped.reportText, { remarks: remarksDraft, findings });
    localCase = {
      ...localCase,
      findings,
      reportText: composed.reportText,
      remarks: composed.remarks,
    };
    if (selectedIndex >= findings.length) selectedIndex = Math.max(0, findings.length - 1);
    render();
    if (isDraftFindingId(removed._id || removed.id)) return;
    persistClinicianEdits({ includeDraft: true }).catch((err) => {
      hintMongo("");
      toast(err.message || "Could not delete this finding.");
    });
  }

  function acceptFinding(id) {
    patchFinding(id, { status: "accepted" }, { refresh: true });
    toast("Finding accepted.");
  }

  async function finishManualFinding() {
    if (!localCase || busy) return;
    busy = true;
    render();
    try {
      await persistClinicianEdits({ includeDraft: true });
      toast("Finding saved.");
      hintMongo("Finding saved in MongoDB.");
    } catch (err) {
      toast(err.message || "Could not save this finding.");
    } finally {
      busy = false;
      render();
    }
  }

  function canEditBox() {
    if (!localCase || isGenerating(localCase)) return false;
    if (!canEditReport(state.user) || localCase.status === "finalized") return false;
    return Boolean((localCase.findings || [])[selectedIndex]);
  }

  function paintLiveBox(stage, bbox) {
    if (!stage || !bbox) return;
    let node = stage.querySelector("[data-draw-box]");
    if (!node) {
      node = document.createElement("div");
      node.setAttribute("data-draw-box", "1");
      node.className = "pointer-events-none absolute border-2 border-yellow-300 bg-yellow-300/25";
      stage.appendChild(node);
    }
    node.style.left = bbox[0] + "%";
    node.style.top = bbox[1] + "%";
    node.style.width = bbox[2] + "%";
    node.style.height = bbox[3] + "%";
  }

  function liveBboxFromDrag(pct) {
    if (!boxDrag) return null;
    if (boxDrag.mode === "move") return movedBox(boxDrag.origin, boxDrag.start, pct);
    if (boxDrag.mode === "resize") return resizedBox(boxDrag.origin, boxDrag.handle, pct);
    return boxFromCorners(boxDrag.start, pct);
  }

  function onFilmPointerDown(e) {
    if (!canEditBox()) return;
    if (e.button != null && e.button !== 0) return;
    const stage = e.currentTarget || document.getElementById("xray-stage");
    if (!stage) return;
    const pct = eventToPct(e, stage);
    const f = (localCase.findings || [])[selectedIndex];
    const hit = hasBbox(f) ? hitBoxHandle(pct, f.bbox) : null;
    showBoxes = true;
    if (hit === "move") {
      boxDrag = { mode: "move", start: pct, origin: f.bbox.slice() };
    } else if (hit) {
      boxDrag = { mode: "resize", handle: hit, start: pct, origin: f.bbox.slice() };
    } else {
      boxDrag = { mode: "draw", start: pct };
    }
    try { stage.setPointerCapture?.(e.pointerId); } catch { /* tests */ }
    paintLiveBox(stage, liveBboxFromDrag(pct));
    e.preventDefault();
  }

  function onFilmPointerMove(e) {
    const stage = e.currentTarget || document.getElementById("xray-stage");
    if (!stage) return;
    const pct = eventToPct(e, stage);
    if (!boxDrag) {
      if (!canEditBox()) return;
      const f = (localCase.findings || [])[selectedIndex];
      stage.style.cursor = cursorForHandle(hasBbox(f) ? hitBoxHandle(pct, f.bbox) : null);
      return;
    }
    paintLiveBox(stage, liveBboxFromDrag(pct));
  }

  function commitDrawnBox(stage, bbox) {
    if (!stage || !bbox) return;
    stage.querySelector("[data-draw-box]")?.remove();
    let node = stage.querySelector("[data-bbox]");
    if (!node) {
      node = document.createElement("div");
      node.setAttribute("data-bbox", "1");
      node.className = "pointer-events-none absolute border-2 border-yellow-300 bg-yellow-300/25";
      stage.appendChild(node);
    }
    node.style.left = bbox[0] + "%";
    node.style.top = bbox[1] + "%";
    node.style.width = bbox[2] + "%";
    node.style.height = bbox[3] + "%";
    let tag = node.querySelector("[data-bbox-label]");
    if (!tag) {
      tag = document.createElement("span");
      tag.setAttribute("data-bbox-label", "1");
      tag.className = "absolute -top-5 left-0 bg-black px-1 text-xs text-white";
      node.appendChild(tag);
    }
    tag.textContent = `F${selectedIndex + 1}`;
    const hint = document.querySelector("[data-bbox-hint]");
    if (hint) {
      hint.textContent = "Drag the yellow box to move it, a corner to resize, or elsewhere on the film to redraw.";
    }
  }

  function onFilmPointerUp(e) {
    if (!boxDrag) return;
    const stage = e.currentTarget || document.getElementById("xray-stage");
    if (!stage) return;
    const pct = eventToPct(e, stage);
    const bbox = liveBboxFromDrag(pct);
    const wasDraw = boxDrag.mode === "draw";
    boxDrag = null;
    e.preventDefault?.();
    // A click without a drag should not replace an existing box with a 1% stub.
    if (wasDraw && bbox[2] < 3 && bbox[3] < 3) {
      stage.querySelector("[data-draw-box]")?.remove();
      return;
    }
    const f = (localCase.findings || [])[selectedIndex];
    if (f) {
      // Do not remount the page here. Replacing the DOM on pointerup makes the
      // following click land on Finish this finding and the button vanishes.
      patchFinding(f._id || f.id, { bbox, bboxSource: "manual" });
    }
    commitDrawnBox(stage, bbox);
    const swallow = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      document.removeEventListener("click", swallow, true);
    };
    document.addEventListener("click", swallow, true);
    setTimeout(() => document.removeEventListener("click", swallow, true), 400);
  }

  function applyLocalEdits(reportText, { remarks = remarksDraft, findings } = {}) {
    return composeReportText(reportText, {
      remarks,
      findings: findings ?? localCase.findings,
    });
  }

  function syncFromPersisted(stored, fallback = {}, { keepDrafts = true } = {}) {
    const drafts = keepDrafts
      ? (localCase.findings || []).filter((f) => isDraftFindingId(f._id || f.id))
      : [];
    localCase = {
      ...localCase,
      ...stored,
      findings: stored.findings ? [...stored.findings, ...drafts] : localCase.findings,
      reportText: stored.reportText ?? localCase.reportText,
      remarks: stored.remarks ?? fallback.remarks ?? localCase.remarks,
    };
    remarksDraft = localCase.remarks || fallback.remarks || "";
    remarksDirty = false;
  }

  function findingsForSave(list, { includeDraft = false } = {}) {
    return (list || [])
      .filter((f) => includeDraft || !isDraftFindingId(f._id || f.id))
      .map((f) => {
        const o = { ...f };
        if (isDraftFindingId(o._id)) delete o._id;
        if (isDraftFindingId(o.id)) delete o.id;
        delete o.draft;
        if (!hasBbox(o)) o.bbox = [];
        return o;
      });
  }

  function persistClinicianEdits({ includeDraft = false } = {}) {
    clearTimeout(saveTimer);
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
      const findings = findingsForSave(localCase.findings, { includeDraft });
      const composed = applyLocalEdits(localCase.reportText || stored.reportText, { remarks: note, findings });
      const payload = {
        diagnosis: localCase.diagnosis,
        reportText: composed.reportText,
        remarks: composed.remarks,
        findings,
      };
      const updated = await api.updateCase(getEffectiveCaseId(), payload);
      const next = unwrapLegacyReport(updated.case || { ...stored, ...payload });
      syncFromPersisted(next, composed, { keepDrafts: !includeDraft });
      hintMongo("Report saved in MongoDB.");
      return next;
    };
    const pending = persistChain.then(run, run);
    persistChain = pending.catch(() => {});
    return pending;
  }

  async function saveDraft() {
    busy = true; render();
    try {
      await persistClinicianEdits({ includeDraft: true });
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
      await persistClinicianEdits({ includeDraft: true });
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
        await persistClinicianEdits({ includeDraft: true });
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
      const stored = await persistClinicianEdits({ includeDraft: true });
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
        stored = await persistClinicianEdits({ includeDraft: true });
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
    const findings = localCase.findings || [];
    const visible = findings;
    const patientName = patientDisplayName(localCase);

    function findingCard(f, index) {
      const isNew = isUnsavedManual(f);
      return el("article", {
        class: "rounded-xl border border-slate-200 bg-slate-50 p-4",
        dataset: { id: f._id || f.id, findingIndex: String(index) },
      },
        el("div", { class: "flex justify-between items-start gap-2" },
          el("div", { class: "flex-1" },
            el("div", { class: "flex items-center gap-2" },
              el("small", { class: "font-bold text-ha-blue text-xs" },
                showProvenance && isManualFinding(f)
                  ? (isNew ? "NEW FINDING (unsaved)" : "MANUAL FINDING")
                  : `FINDING ${index + 1}`
              ),
            ),
            edit
              ? el("input", {
                  id: `finding-label-${f._id || f.id}`,
                  class: "mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1 outline-none focus:border-ha-blue font-bold text-slate-900",
                  value: f.label || "",
                  onInput: (e) => patchFinding(f._id || f.id, { label: e.target.value }),
                })
              : el("h3", { class: "font-bold text-slate-900" }, f.label)
          ),
          el("div", { class: "flex flex-col items-end gap-2" },
            showProvenance && isManualFinding(f)
              ? el("b", { class: "rounded-full bg-slate-100 px-3 py-0.5 text-sm text-slate-600" }, "Manual")
              : el("b", {
                  class: "rounded-full bg-blue-50 px-3 py-0.5 text-ha-blue text-sm",
                  title: confidenceTitle(f),
                }, `${Math.round((f.confidence ?? 0) * 100)}%`),
            f.status === "accepted" && el("b", { class: "rounded-full bg-green-50 px-3 py-0.5 text-sm text-green-700" }, "Accepted"),
            edit && isManualFinding(f) && el("button", {
              id: "delete-manual-finding",
              class: "rounded-lg border border-red-200 px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-50",
              onClick: () => removeFinding(f._id || f.id, selectedIndex),
            }, "Delete")
          )
        ),
        edit && el("p", { class: "mt-2 text-xs text-slate-500", dataset: { bboxHint: "1" } },
          hasBbox(f)
            ? "Drag the yellow box to move it, a corner to resize, or elsewhere on the film to redraw."
            : "Drag on the X-ray to draw a box for this finding."
        ),
        edit && isNew && el("p", { class: "mt-2 text-xs text-slate-400" },
          "Add the details and/or draw the box, in either order, then finish this finding."
        ),
        !edit ? null : el("div", { class: "mt-3 grid grid-cols-2 gap-2" },
          ...["location", "size"].map((k) =>
            el("label", { class: "block" },
              el("span", { class: "text-xs font-semibold text-slate-500 capitalize" }, k),
              el("input", {
                id: `finding-${k}-${f._id || f.id}`,
                class: "mt-1 w-full rounded-xl border border-slate-300 bg-white px-2 py-1.5 outline-none focus:border-ha-blue",
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
            class: "mt-1 w-full rounded-xl border border-slate-300 bg-white px-2 py-1.5 outline-none focus:border-ha-blue disabled:bg-slate-100",
            value: f.pattern || "Other",
            onChange: (e) => patchFinding(f._id || f.id, { pattern: e.target.value }, { refresh: true }),
          },
            ...PATTERNS.map((p) => el("option", { value: p }, p))
          ),
          el("p", { class: "mt-1 text-xs text-slate-400" },
            "How the opacity looks on the film (nodule, consolidation, ground-glass…). Used in the saved finding and in Word/PDF."
          )
        ),
        edit && isNew && el("button", {
          id: "finish-manual-finding",
          class: "mt-3 w-full rounded-xl bg-ha-blue px-3 py-2 text-sm font-semibold text-white hover:bg-[#074f85] disabled:opacity-50",
          disabled: busy,
          onClick: finishManualFinding,
        }, "Finish this finding"),
        edit && !isManualFinding(f) && el("div", { class: "mt-3 flex justify-center gap-2" },
          f.status !== "accepted" && el("button", {
            id: `accept-finding-${f._id || f.id}`,
            class: "min-w-[7.5rem] rounded-xl bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700",
            onClick: () => acceptFinding(f._id || f.id),
          }, "Accept"),
          el("button", {
            id: `reject-finding-${f._id || f.id}`,
            class: "min-w-[7.5rem] rounded-xl border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50",
            onClick: () => removeFinding(f._id || f.id, selectedIndex),
          }, "Reject")
        )
      );
    }

    // Point-form list of every finding, with the selected row opened as the
    // editable card so the film box, Accept/Reject, and fields stay bound.
    function findingsPanel(items) {
      if (selectedIndex > items.length - 1) selectedIndex = items.length - 1;
      if (selectedIndex < 0) selectedIndex = 0;

      const select = (i) => {
        selectedIndex = i;
        render();
      };

      const active = items[selectedIndex];

      return el("div", {},
        el("div", { class: "flex items-center justify-between gap-2" },
          el("b", { class: "text-slate-900" }, "Findings"),
          el("span", { class: "text-xs font-semibold text-slate-500" },
            `${items.length} ${items.length === 1 ? "finding" : "findings"}`
          )
        ),

        el("ul", {
          id: "findings-list",
          class: "mt-3 max-h-64 overflow-y-auto divide-y divide-slate-100 rounded-xl border border-slate-200",
        },
          ...items.map((f, i) => {
            const selected = i === selectedIndex;
            const isNew = isUnsavedManual(f);
            const meta = findingPointMeta(f);
            return el("li", {},
              el("button", {
                type: "button",
                class: `flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors ${
                  selected ? "bg-blue-50" : "bg-white hover:bg-slate-50"
                }`,
                title: `${i + 1}. ${f.label || "Finding"}`,
                "aria-current": selected ? "true" : "false",
                onClick: () => select(i),
              },
                el("span", {
                  class: `mt-0.5 w-5 shrink-0 text-sm font-bold ${selected ? "text-ha-blue" : "text-slate-400"}`,
                }, `${i + 1}.`),
                el("span", { class: "min-w-0 flex-1" },
                  el("span", { class: "flex items-start justify-between gap-2" },
                    el("span", { class: "font-semibold text-slate-900" }, f.label || "Finding"),
                    el("span", { class: "flex shrink-0 flex-wrap justify-end gap-1" },
                      showProvenance && isManualFinding(f)
                        ? el("b", { class: "rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600" },
                            isNew ? "New" : "Manual")
                        : !showProvenance
                        ? null
                        : el("b", { class: "rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-ha-blue" },
                            `${Math.round((f.confidence ?? 0) * 100)}%`),
                      f.status === "accepted" && el("b", {
                        class: "rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-semibold text-green-700",
                      }, "Accepted")
                    )
                  ),
                  meta ? el("span", { class: "mt-0.5 block text-sm text-slate-500" }, meta) : null
                )
              )
            );
          })
        ),

        active && el("div", { class: "mt-3" }, findingCard(active, selectedIndex))
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

      // Image + findings — the report itself stays in MongoDB and is only
      // pulled out when someone downloads it.
      el("div", { class: "mt-5 grid gap-5 xl:grid-cols-2" },
        // X-ray image w/ bbox overlays
        el("section", { class: "rounded-2xl bg-slate-950 p-4 text-white" },
          el("div", { class: "flex flex-wrap items-center justify-between gap-2" },
            el("div", { class: "flex items-baseline gap-2" },
              el("b", {}, "Chest X-Ray"),
              el("span", { class: "text-xs text-slate-400" }, _imageSrc ? "· loaded from MongoDB GridFS" : "")
            ),
            visible.length > 0 && el("button", {
              id: "toggle-bboxes",
              type: "button",
              class: "rounded-lg border border-white/20 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white hover:bg-white/20",
              onClick: () => { showBoxes = !showBoxes; render(); },
            }, showBoxes ? "Hide boxes" : "Show boxes")
          ),
          el("div", { class: "mt-3 flex justify-center rounded-xl bg-gradient-to-b from-slate-500 to-slate-900" },
            el("div", {
              id: "xray-stage",
              class: `relative inline-block max-w-full touch-none ${canEditBox() ? "cursor-crosshair" : ""}`,
              onPointerdown: onFilmPointerDown,
              onPointermove: onFilmPointerMove,
              onPointerup: onFilmPointerUp,
              onPointercancel: onFilmPointerUp,
            },
              _imageSrc
                ? el("img", { src: _imageSrc, class: "pointer-events-none block max-h-[560px] max-w-full h-auto w-auto", alt: "Chest X-ray" })
                : el("div", { class: "pointer-events-none flex h-[320px] w-full min-w-[240px] items-center justify-center text-slate-300 text-sm" }, localCase.imageId ? "Loading image…" : "No image"),
              (() => {
                const active = visible[selectedIndex];
                if (!showBoxes || !hasBbox(active)) return null;
                return el("div", {
                  class: "pointer-events-none absolute border-2 border-yellow-300 bg-yellow-300/25",
                  dataset: { bbox: "1" },
                  style: {
                    left: active.bbox[0] + "%",
                    top: active.bbox[1] + "%",
                    width: active.bbox[2] + "%",
                    height: active.bbox[3] + "%",
                  },
                  title: active.label,
                },
                  el("span", {
                    class: "absolute -top-5 left-0 bg-black px-1 text-xs text-white",
                    dataset: { bboxLabel: "1" },
                  }, `F${selectedIndex + 1}`),
                  canEditBox() && ["nw", "ne", "sw", "se"].map((h) =>
                    el("span", {
                      class: "absolute h-2.5 w-2.5 rounded-sm border border-yellow-200 bg-yellow-300",
                      style: {
                        left: h.includes("w") ? "-5px" : "auto",
                        right: h.includes("e") ? "-5px" : "auto",
                        top: h.includes("n") ? "-5px" : "auto",
                        bottom: h.includes("s") ? "-5px" : "auto",
                      },
                    })
                  )
                );
              })()
            )
          ),
          canEditBox() && el("p", { class: "mt-2 text-center text-xs text-slate-400" },
            hasBbox((localCase.findings || [])[selectedIndex])
              ? "Drag the box to move it, a corner to resize, or elsewhere to redraw."
              : "Drag on the film to draw this finding's box."
          )
        ),

        el("section", { class: "flex flex-col gap-5" },
          findings.length === 0
            ? el("div", { class: "card text-center text-slate-500" },
                el("p", {}, "No findings yet — add one by hand."),
                edit && !busy && el("div", { class: "mt-3 flex flex-wrap items-center justify-center gap-2" },
                  el("button", {
                    class: "inline-flex items-center gap-1 rounded-xl border border-ha-blue px-4 py-2 text-sm font-semibold text-ha-blue hover:bg-blue-50",
                    onClick: addFinding,
                  }, "+ Add manually"),
                )
              )
            : el("div", { class: "card" },
                findingsPanel(visible),
                edit && el("button", {
                  class: "mt-2 w-full rounded-xl border border-ha-blue px-3 py-2 text-sm font-semibold text-ha-blue hover:bg-blue-50",
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
              onInput: (e) => { remarksDraft = e.target.value; remarksDirty = true; queueReportSync(); },
            }, remarksDraft),
            el("p", { class: "mt-2 text-xs text-slate-500" },
              localCase.status === "finalized"
                ? "This case is finalized. Remarks are saved as notes only and are not written into the report, Word, or PDF."
                : "Edits are written back to MongoDB (reportText on this case). Word and PDF always use that saved copy."
            ),
            canRemark && el("p", { id: "mongo-report-status", class: "mt-1 text-xs font-medium text-ha-blue" })
          ),
          showProvenance && (localCase.editLog || []).length > 0 && el("div", { class: "card" },
            el("h2", { class: "text-lg font-bold text-slate-900" }, "Draft log (AI vs manual)"),
            el("p", { class: "mt-1 text-xs text-slate-500" },
              "Shown while editing. The signed report the doctor sees has no source tags."
            ),
            el("ul", { class: "mt-3 space-y-2 text-sm" },
              ...(localCase.editLog || []).slice(-12).reverse().map((row) =>
                el("li", { class: "flex gap-2 border-b border-slate-100 pb-2 last:border-0" },
                  el("b", {
                    class: row.kind === "ai"
                      ? "rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-ha-blue"
                      : "rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-slate-700",
                  }, row.kind === "ai" ? "AI" : "Manual"),
                  el("span", { class: "min-w-0 text-slate-700" },
                    row.summary || "",
                    el("span", { class: "mt-0.5 block text-xs text-slate-400" },
                      [row.userName, row.at && new Date(row.at).toLocaleString()].filter(Boolean).join(" · ")
                    )
                  )
                )
              )
            )
          )
        )
      )
    );

    mount(target, root);
  }

  await refreshFromServer();
  if (signal.aborted || leaving) return;
  if (localCase && !isGenerating(localCase)) fillFromLocalParser();
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
