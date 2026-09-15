// src/components/review.js
// Single-case review page.
//
// Workflow mirrors the original Radassist design:
//   1. AI gives us a free-text radiology report (markdown) in `reportText`
//      plus optional pre-structured findings in `findings`.
//   2. Finding cards are stored on the case during generate (Azure when
//      configured). Opening Review only shows them — it does not call Azure.
//      If a case has no cards, a local parse of the report fills the carousel.
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
import { downloadReportDocx, downloadReportPdf, composeReportText, splitReportAndRemarks } from "../lib/reportExport.js";
import { urgentBadge, patientDisplayName, doctorInCharge } from "../lib/tags.js";
import { isGenerating, isAwaitingApprove, statusLabel } from "../lib/caseStatus.js";

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
  let showBoxes = true;
  let drawStart = null;
  let remarksDraft = "";
  let remarksDirty = false;

  // Effective case ID that works with both caseId (new) and _id (legacy)
  const getEffectiveCaseId = () => localCase?.caseId || localCase?._id;

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
    if (state.user?.role === "nurse" || !getEffectiveCaseId()) return;
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
    localCase = {
      ...localCase,
      findings: (localCase.findings || []).map((f) => (
        String(f._id || f.id) === String(id) ? { ...f, ...patch } : f
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
    carouselIndex = next.length - 1;
    render();
  }

  function removeFinding(id, index = carouselIndex) {
    const findings = [...(localCase.findings || [])];
    const idx = findings.findIndex((f, i) => {
      const fid = String(f._id || f.id || "");
      if (id != null && id !== "" && fid && fid === String(id)) return true;
      return (id == null || id === "" || !fid) && i === index;
    });
    const removed = idx >= 0 ? findings[idx] : null;
    if (!removed || !isManualFinding(removed)) return;
    findings.splice(idx, 1);
    localCase = { ...localCase, findings };
    if (carouselIndex >= findings.length) carouselIndex = Math.max(0, findings.length - 1);
    render();
    if (isDraftFindingId(removed._id || removed.id)) return;
    persistClinicianEdits({ includeDraft: true }).catch((err) => {
      hintMongo("");
      toast(err.message || "Could not delete this finding.");
    });
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

  function canDrawOnFilm() {
    if (!localCase || isGenerating(localCase)) return false;
    if (state.user?.role === "nurse" || localCase.status === "finalized") return false;
    return isManualFinding((localCase.findings || [])[carouselIndex]);
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

  function onFilmPointerDown(e) {
    if (!canDrawOnFilm()) return;
    if (e.button != null && e.button !== 0) return;
    const stage = e.currentTarget || document.getElementById("xray-stage");
    if (!stage) return;
    drawStart = eventToPct(e, stage);
    showBoxes = true;
    try { stage.setPointerCapture?.(e.pointerId); } catch { /* tests */ }
    paintLiveBox(stage, boxFromCorners(drawStart, drawStart));
    e.preventDefault();
  }

  function onFilmPointerMove(e) {
    if (!drawStart) return;
    const stage = e.currentTarget || document.getElementById("xray-stage");
    if (!stage) return;
    paintLiveBox(stage, boxFromCorners(drawStart, eventToPct(e, stage)));
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
    tag.textContent = `F${carouselIndex + 1}`;
    const hint = document.querySelector("[data-bbox-hint]");
    if (hint) hint.textContent = "Drag on the X-ray to redraw this box.";
  }

  function onFilmPointerUp(e) {
    if (!drawStart) return;
    const stage = e.currentTarget || document.getElementById("xray-stage");
    if (!stage) return;
    const bbox = boxFromCorners(drawStart, eventToPct(e, stage));
    drawStart = null;
    e.preventDefault?.();
    const f = (localCase.findings || [])[carouselIndex];
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
      hintMongo("Saving to MongoDB…");
      const data = await api.getCase(getEffectiveCaseId());
      const stored = unwrapLegacyReport(data.case || data);
      const note = String(remarksDraft || "").trim();
      if (stored.status === "finalized" || state.user?.role === "nurse") {
        if (state.user?.role !== "nurse") {
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
      const composed = applyLocalEdits(stored.reportText, { remarks: note, findings });
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

  async function finalize() {
    if (isGenerating(localCase)) {
      toast("The report is still generating.");
      return;
    }
    if (!confirm("Finalize this report? Finalized cases are read-only for clinicians.")) return;
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
    if (state.user?.role !== "nurse") {
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

  async function toggleUrgent() {
    if (state.user?.role === "nurse") return;
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
      if (state.user?.role === "nurse") {
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
    const edit = !generating && state.user?.role !== "nurse" && localCase.status !== "finalized";
    const canRemark = !generating && state.user?.role !== "nurse";
    const canFlag = state.user?.role !== "nurse";
    const findings = localCase.findings || [];
    const visible = findings;
    const patientName = patientDisplayName(localCase);

    function findingCard(f) {
      const isNew = isUnsavedManual(f);
      return el("article", {
        class: "card mb-3",
        dataset: { id: f._id || f.id },
      },
        el("div", { class: "flex justify-between items-start gap-2" },
          el("div", { class: "flex-1" },
            el("div", { class: "flex items-center gap-2" },
              el("small", { class: "font-bold text-cyan-700 text-xs" },
                isManualFinding(f)
                  ? (isNew ? "NEW FINDING (unsaved)" : "MANUAL FINDING")
                  : `FINDING ${f._id || f.id}`
              ),
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
            isManualFinding(f)
              ? el("b", { class: "rounded-full bg-slate-100 px-3 py-0.5 text-sm text-slate-600" }, "Manual")
              : el("b", {
                  class: "rounded-full bg-cyan-50 px-3 py-0.5 text-cyan-700 text-sm",
                  title: confidenceTitle(f),
                }, `${Math.round((f.confidence ?? 0) * 100)}%`),
            edit && isManualFinding(f) && el("button", {
              id: "delete-manual-finding",
              class: "rounded-lg border border-red-200 px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-50",
              onClick: () => removeFinding(f._id || f.id, carouselIndex),
            }, "Delete")
          )
        ),
        edit && isManualFinding(f) && el("p", { class: "mt-2 text-xs text-slate-500", dataset: { bboxHint: "1" } },
          hasBbox(f) ? "Drag on the X-ray to redraw this box." : "Drag on the X-ray to draw a box for this finding."
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
          ),
          el("p", { class: "mt-1 text-xs text-slate-400" },
            "How the opacity looks on the film (nodule, consolidation, ground-glass…). Used in the saved finding and in Word/PDF."
          )
        ),
        edit && isNew && el("button", {
          id: "finish-manual-finding",
          class: "mt-3 w-full rounded-xl bg-cyan-600 px-3 py-2 text-sm font-semibold text-white hover:bg-cyan-700 disabled:opacity-50",
          disabled: busy,
          onClick: finishManualFinding,
        }, "Finish this finding")
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
          el("p", { class: "text-slate-600 mt-1 flex flex-wrap items-center gap-2" },
            el("button", {
              class: "font-semibold hover:text-cyan-700 hover:underline",
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
          el("button", {
            class: "inline-flex items-center gap-1 rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50",
            disabled: busy || generating,
            onClick: openReport,
          }, svgIcon("file-text", { size: 16 }), "Report"),
          el("button", {
            class: "inline-flex items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50",
            disabled: busy || generating,
            onClick: () => download("docx"),
          }, svgIcon("download", { size: 16 }), "Word"),
          el("button", {
            class: "inline-flex items-center gap-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50",
            disabled: busy || generating,
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
          canFlag && el("button", {
            class: localCase.urgent
              ? "rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
              : "rounded-xl border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50",
            disabled: busy,
            onClick: toggleUrgent,
          }, localCase.urgent ? "Remove urgent" : "Mark urgent"),
          generating
            ? el("span", { class: "rounded-full bg-amber-50 text-amber-700 px-3 py-1 text-xs font-bold" }, "GENERATING")
            : isAwaitingApprove(localCase)
            ? el("span", { class: "rounded-full bg-cyan-50 text-cyan-700 px-3 py-1 text-xs font-bold" }, "PENDING APPROVE")
            : localCase.status === "finalized"
            ? el("span", { class: "rounded-full bg-green-50 text-green-700 px-3 py-1 text-xs font-bold" }, "FINALIZED")
            : null
        )
      ),

      msg && el("p", { class: "mt-4 rounded-lg bg-green-50 text-green-700 p-3" }, msg),
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
              class: `relative inline-block max-w-full touch-none ${canDrawOnFilm() ? "cursor-crosshair" : ""}`,
              onPointerdown: onFilmPointerDown,
              onPointermove: onFilmPointerMove,
              onPointerup: onFilmPointerUp,
              onPointercancel: onFilmPointerUp,
            },
              _imageSrc
                ? el("img", { src: _imageSrc, class: "pointer-events-none block max-h-[560px] max-w-full h-auto w-auto", alt: "Chest X-ray" })
                : el("div", { class: "pointer-events-none flex h-[320px] w-full min-w-[240px] items-center justify-center text-slate-300 text-sm" }, localCase.imageId ? "Loading image…" : "No image"),
              (() => {
                const active = visible[carouselIndex];
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
                  el("span", { class: "absolute -top-5 left-0 bg-black px-1 text-xs text-white" }, `F${carouselIndex + 1}`)
                );
              })()
            )
          ),
          canDrawOnFilm() && el("p", { class: "mt-2 text-center text-xs text-slate-400" },
            "Drag on the film to draw this finding's box."
          )
        ),

        el("section", { class: "flex flex-col gap-5" },
          findings.length === 0
            ? el("div", { class: "card text-center text-slate-500" },
                el("p", {}, "No findings yet — add one by hand."),
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
              onInput: (e) => { remarksDraft = e.target.value; remarksDirty = true; queueReportSync(); },
            }, remarksDraft),
            el("p", { class: "mt-2 text-xs text-slate-500" },
              localCase.status === "finalized"
                ? "This case is finalized. Remarks are saved as notes only and are not written into the report, Word, or PDF."
                : "Edits are written back to MongoDB (reportText on this case). Word and PDF always use that saved copy."
            ),
            canRemark && el("p", { id: "mongo-report-status", class: "mt-1 text-xs font-medium text-cyan-700" })
          )
        )
      )
    );

    mount(target, root);
  }

  await refreshFromServer();
  if (localCase && !isGenerating(localCase)) fillFromLocalParser();
  render();
}
