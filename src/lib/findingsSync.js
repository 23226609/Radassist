// Rebuild finding cards after the doctor edits the report text.
// Manual cards stay. Machine cards are replaced from the new report, and
// previously accepted cards keep that status when they still match.

import { isManualFinding, splitManualFindings, splitReportAndRemarks } from "./reportExport.js";

function norm(s) {
  return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function isMachineFinding(f) {
  if (!f) return false;
  return !isManualFinding(f);
}

export function findingsOverlap(a, b) {
  const al = norm(a?.label);
  const bl = norm(b?.label);
  const as = norm(a?.sentence);
  const bs = norm(b?.sentence);
  if (al && bl && (al === bl || (al.length >= 8 && bl.includes(al)) || (bl.length >= 8 && al.includes(bl)))) {
    return true;
  }
  if (as && bs && as.length >= 12 && bs.length >= 12 && (as.includes(bs) || bs.includes(as))) {
    return true;
  }
  if (al && bs && al.length >= 8 && bs.includes(al)) return true;
  if (bl && as && bl.length >= 8 && as.includes(bl)) return true;
  return false;
}

function stillInReport(f, reportText) {
  const hay = norm(reportText);
  if (!hay) return false;
  const sentence = norm(f?.sentence);
  const label = norm(f?.label);
  if (sentence && sentence.length >= 8 && hay.includes(sentence)) return true;
  if (label && label.length >= 8 && hay.includes(label)) return true;
  return false;
}

export function overlayAzureOnParsed(parsed, azureFindings, reportText = "") {
  const azure = Array.isArray(azureFindings) ? azureFindings : [];
  const incoming = Array.isArray(parsed) ? parsed : [];
  const used = new Set();
  const out = incoming.map((p) => {
    const idx = azure.findIndex((a, i) => !used.has(i) && findingsOverlap(p, a));
    if (idx < 0) return p;
    used.add(idx);
    const a = azure[idx];
    const shortLabel = String(a.label || "").trim();
    return {
      ...p,
      label: shortLabel && shortLabel.length <= 60 ? shortLabel : p.label,
      bbox: a.bbox || p.bbox,
      bboxSource: a.bboxSource || p.bboxSource,
      confidence: a.confidence ?? p.confidence,
      location: p.location || a.location,
      size: p.size || a.size,
      pattern: p.pattern && p.pattern !== "Other" ? p.pattern : (a.pattern || p.pattern),
      source: a.source || p.source,
    };
  });
  for (let i = 0; i < azure.length; i++) {
    if (used.has(i)) continue;
    const a = azure[i];
    if (out.some((p) => findingsOverlap(p, a))) continue;
    if (stillInReport(a, reportText)) out.push(a);
  }
  return dedupeFindings(out);
}

function keepManualBox(prev) {
  return prev?.bboxSource === "manual"
    && Array.isArray(prev?.bbox)
    && prev.bbox.length === 4;
}

export function mergeFindingsFromReport(previous, parsed, reportText = "") {
  const prev = Array.isArray(previous) ? previous : [];
  const incoming = Array.isArray(parsed) ? parsed : [];
  const manual = prev.filter(isManualFinding);
  const accepted = prev.filter((f) => isMachineFinding(f) && f.status === "accepted");
  const used = new Set();
  const rebuilt = incoming.map((p) => {
    const idx = accepted.findIndex((a, i) => !used.has(i) && findingsOverlap(a, p));
    if (idx < 0) return { ...p, status: p.status || "pending" };
    used.add(idx);
    const a = accepted[idx];
    return {
      ...p,
      status: "accepted",
      _id: a._id || p._id,
      id: a.id || p.id,
      bbox: keepManualBox(a) ? a.bbox : (p.bbox || a.bbox),
      bboxSource: keepManualBox(a) ? "manual" : (p.bboxSource || a.bboxSource),
    };
  });
  const body = splitManualFindings(splitReportAndRemarks(reportText).body).body;
  const leftovers = accepted.filter((a, i) => !used.has(i) && stillInReport(a, body));
  return dedupeFindings([...manual, ...leftovers, ...rebuilt]);
}

function isNegativeFinding(f) {
  const t = `${f?.label || ""} ${f?.sentence || ""}`.toLowerCase();
  if (/\b(white-?out|opacif|consolidat|atelecta|effusion|pneumothorax|fracture|mass|nodule|pneumonia)\b/.test(t)) {
    return false;
  }
  return /\b(clear|normal|unremarkable|no (?:evidence|signs?) of|within normal limits)\b/.test(t);
}

function isWhiteoutFinding(f) {
  return /\b(white-?out|opaque hemithorax|hemithorax opacif|complete opacif)/i.test(
    `${f?.label || ""} ${f?.sentence || ""}`
  );
}

export function dedupeFindings(list) {
  const out = [];
  for (const f of Array.isArray(list) ? list : []) {
    if (out.some((p) => findingsOverlap(p, f))) continue;
    out.push(f);
  }
  if (out.some(isWhiteoutFinding)) {
    return out.filter((f) => isWhiteoutFinding(f) || !isNegativeFinding(f));
  }
  return out;
}
