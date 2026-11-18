// src/lib/reportExport.js
// Builds a downloadable copy of the case report (plain sections → DOCX / PDF).

import { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun } from "docx";
import { api } from "../api.js";
import { ensureTags, reportTitle, examinationName, commentLines, THANKS_LINE } from "../../shared/reportTags.js";
import { boxesForTag } from "./findingTags.js";
import { linesOfTag, spacingOf, describeMeasurement } from "./measure.js";

import {
  REMARKS_HEADING,
  splitOnHeading,
  splitReportAndRemarks,
  applyRemarksToReport,
  normalizeReportShape,
  withoutThinking,
  restoreThinking,
} from "../../shared/reportText.js";

// The plain-text rules live in shared/reportText.js so the API uses the same ones.
export { REMARKS_HEADING, splitReportAndRemarks, applyRemarksToReport, normalizeReportShape, withoutThinking, restoreThinking };
export const MANUAL_FINDINGS_HEADING = "Clinician-added findings";

export const MEASUREMENTS_HEADING = "Measurements";

export function measurementLines(measurements) {
  return (Array.isArray(measurements) ? measurements : [])
    .filter((m) => String(m?.text || "").trim())
    .map((m, i) => {
      const label = String(m.label || "").trim();
      return `${i + 1}. ${label ? `${label}: ` : ""}${String(m.text).trim()}`;
    });
}

export function splitManualFindings(reportText) {
  const { body, section } = splitOnHeading(reportText, MANUAL_FINDINGS_HEADING);
  return { body, manual: section };
}

export function isManualFinding(f) {
  const source = String(f?.source || "").toLowerCase();
  if (source === "manual" || source === "clinician") return true;
  return String(f?._id || f?.id || "").startsWith("tmp-");
}

function normalizeWs(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function unitMatchesNeedle(unit, needle) {
  const s = normalizeWs(unit).toLowerCase();
  const n = normalizeWs(needle).toLowerCase();
  if (!s || !n) return false;
  if (s.includes(n)) return true;
  // Azure often stores a longer paraphrase than the CURV sentence.
  if (n.length >= 20 && s.length >= 20 && n.includes(s)) return true;
  return false;
}

// Drop the whole sentence that contains a phrase, not the matching words
// inside it — otherwise "Clear lung fields" leaves "The chest X-ray
// demonstrates  without evidence of consolidation…".
export function stripPassage(text, passage) {
  const needle = normalizeWs(passage);
  if (!needle || needle.length < 6) return String(text || "");
  const src = String(text || "").replace(/\r\n/g, "\n");
  const cleaned = src.replace(/[^.!?\n]+(?:[.!?]+)?/g, (unit) => (
    unitMatchesNeedle(unit, needle) ? "" : unit
  ));
  return cleaned
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +\./g, ".")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Drops a rejected finding's wording from the stored report so Word/PDF
// and a later Azure re-summary no longer include it.
export function removeFindingFromReport(reportText, finding) {
  const split = splitReportAndRemarks(reportText);
  let body = splitManualFindings(split.body).body;
  const passages = [finding?.sentence, finding?.label]
    .map((s) => String(s || "").trim())
    .filter((s, i, arr) => s.length >= 6 && arr.indexOf(s) === i);
  for (const passage of passages) body = stripPassage(body, passage);
  return applyRemarksToReport(body, split.remarks);
}

export function formatFindingSentence(f) {
  const label = String(f?.label || "").trim() || "Finding";
  const location = String(f?.location || "").trim();
  const size = String(f?.size || "").trim();
  const pattern = String(f?.pattern || "").trim();
  let s = label;
  if (location) s += ` in ${location}`;
  if (size) s += `, ${size}`;
  if (pattern && pattern !== "Other") s += `, ${pattern.toLowerCase()}`;
  if (!/[.!?]$/.test(s)) s += ".";
  return s;
}

function replaceContainingSentence(text, needle, replacement) {
  const src = String(text || "").replace(/\r\n/g, "\n");
  const needleNorm = normalizeWs(needle);
  const repl = String(replacement || "").trim();
  if (!needleNorm || needleNorm.length < 6 || !repl) return { text: src, replaced: false };
  let replaced = false;
  const cleaned = src.replace(/[^.!?\n]+(?:[.!?]+)?/g, (unit) => {
    if (replaced || !unitMatchesNeedle(unit, needleNorm)) return unit;
    replaced = true;
    const lead = unit.match(/^\s*/)?.[0] || "";
    return lead + (/[.!?]$/.test(repl) ? repl : `${repl}.`);
  });
  return {
    text: cleaned
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    replaced,
  };
}

// When a doctor edits a finding card, rewrite the matching sentence in the
// CURV report so Word/PDF/share stay in sync.
export function applyFindingChangeToReport(reportText, prev, next) {
  const split = splitReportAndRemarks(reportText);
  let body = splitManualFindings(split.body).body;
  const sentence = formatFindingSentence(next);
  const needles = [prev?.sentence, prev?.label]
    .map((s) => String(s || "").trim())
    .filter((s, i, arr) => s.length >= 6 && arr.indexOf(s) === i);
  for (const needle of needles) {
    const out = replaceContainingSentence(body, needle, sentence);
    if (out.replaced) {
      body = out.text;
      break;
    }
  }
  const applied = applyRemarksToReport(body, split.remarks);
  return { ...applied, sentence };
}

function formatManualFinding(f, i) {
  const label = String(f?.label || "").trim() || "Finding";
  const lines = [`${i + 1}. ${label}`];
  const sentence = String(f?.sentence || "").trim();
  if (sentence && sentence !== label) lines.push(sentence);
  if (f?.location) lines.push(`Location: ${f.location}`);
  if (f?.size) lines.push(`Size: ${f.size}`);
  if (f?.pattern && f.pattern !== "Other") lines.push(`Pattern: ${f.pattern}`);
  return lines.join("\n");
}

// Writes hand-added findings into the report body (before remarks) so the
// Report window, Word, and PDF all include them. Replaces the previous
// clinician-added block instead of stacking copies.
export function composeReportText(reportText, { remarks, findings } = {}) {
  const split = splitReportAndRemarks(reportText);
  const note = remarks !== undefined ? String(remarks || "").trim() : split.remarks;
  const original = splitManualFindings(split.body).body;
  const manual = (Array.isArray(findings) ? findings : []).filter(isManualFinding);
  let body = original;
  if (manual.length) {
    const block = manual.map((f, i) => formatManualFinding(f, i)).join("\n\n");
    body = `${original}\n\n${MANUAL_FINDINGS_HEADING}\n${block}`.trim();
  }
  return applyRemarksToReport(body, note);
}

function safeName(value) {
  return String(value || "report").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "report";
}

function asBytes(data) {
  if (!data) return null;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data);
}

function readU16(bytes, i) {
  return (bytes[i] << 8) | bytes[i + 1];
}

function readU32(bytes, i) {
  return ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
}

function jpegSize(bytes) {
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
  let i = 2;
  while (i < bytes.length - 8) {
    if (bytes[i] !== 0xFF) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) {
      i += 2;
      continue;
    }
    if (marker >= 0xC0 && marker <= 0xC3) {
      return {
        height: readU16(bytes, i + 5),
        width: readU16(bytes, i + 7),
        components: bytes[i + 9] || 3,
      };
    }
    const len = readU16(bytes, i + 2);
    if (len < 2) break;
    i += 2 + len;
  }
  return null;
}

export function parseImageMeta(data) {
  const bytes = asBytes(data);
  if (!bytes || bytes.length < 16) return null;
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
    const size = jpegSize(bytes);
    return size ? { type: "jpg", ...size } : null;
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    if (bytes.length < 24) return null;
    return { type: "png", width: readU32(bytes, 16), height: readU32(bytes, 20), components: 3 };
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return {
      type: "gif",
      width: bytes[6] | (bytes[7] << 8),
      height: bytes[8] | (bytes[9] << 8),
      components: 3,
    };
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4D && bytes.length >= 26) {
    const width = bytes[18] | (bytes[19] << 8) | (bytes[20] << 16) | (bytes[21] << 24);
    const height = Math.abs((bytes[22] | (bytes[23] << 8) | (bytes[24] << 16) | (bytes[25] << 24)) << 0);
    return { type: "bmp", width, height, components: 3 };
  }
  return null;
}

export function fitImageBox(width, height, maxW, maxH) {
  const w = Number(width) || 1;
  const h = Number(height) || 1;
  const scale = Math.min(maxW / w, maxH / h, 1);
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- sign-off

export function reportSignOff(c = {}, signerName = "") {
  const doctor = String(c.finalizedByName || signerName || "").trim() || "Reporting radiologist";
  const stamp = c.status === "finalized" ? (c.finalizedAt || c.updatedAt) : null;
  const when = stamp ? new Date(stamp) : new Date();
  const date = Number.isNaN(when.getTime())
    ? ""
    : when.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return { doctor, date };
}

// A DICOM header records a clock reading with no zone; it is stored as UTC and
// shown as UTC so the reading is not shifted by the viewer's time zone.
export function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  // MIMIC-CXR shifts the clock into the next centuries. That reading is not
  // the day the film was taken, so it is not shown as an examination time.
  if (d.getUTCFullYear() >= 2100) return "Shifted dataset date";
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${date}, ${time}`;
}

// The Radiology Examination fields (Appendix A-XVI) this demo can fill. The
// report text itself is the body below the header.
export function reportHeaderFields(c = {}, signerName = "") {
  const sign = reportSignOff(c, signerName);
  const endorsed = c.status === "finalized";
  return [
    { label: "Modality", value: "XRAY" },
    { label: "Examination name", value: examinationName(c.view) },
    { label: "Examination date/time", value: formatDateTime(c.examinedAt) || "Not recorded" },
    { label: "Report title", value: reportTitle(c.view) },
    { label: "Report date", value: endorsed ? sign.date : "Not endorsed yet" },
    { label: "Reported by", value: endorsed ? sign.doctor : "Not endorsed yet" },
    { label: "Referring doctor", value: String(c.requestedByName || "").trim() || "Not recorded" },
  ];
}

// ------------------------------------------------------------------- body

function legacyBody(c = {}) {
  const split = splitReportAndRemarks(c.reportText);
  const manual = splitManualFindings(split.body);
  let body = withoutThinking(normalizeReportShape(manual.body));
  if (manual.manual) body = `${body}\n\n${MANUAL_FINDINGS_HEADING}\n${manual.manual}`.trim();
  const measured = measurementLines(c.measurements);
  if (measured.length) body = `${body}\n\n${MEASUREMENTS_HEADING}\n${measured.join("\n")}`.trim();
  if (split.remarks) body = `${body}\n\n${REMARKS_HEADING}\n${split.remarks}`.trim();
  return body;
}

// XRAY CHEST (PA) / FINDINGS / one sentence per line / COMMENT / – line /
// thanks / the endorsing radiologist. Thinking is never part of it.
function layoutBlocks(base, sign) {
  const tags = Array.isArray(base.findingTags) ? base.findingTags : [];
  const blocks = [
    { type: "section", text: reportTitle(base.view) },
    { type: "blank" },
    { type: "section", text: "FINDINGS" },
    ...tags
      .map((t) => String(t?.text || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((text) => ({ type: "line", text })),
    { type: "blank" },
    { type: "section", text: "COMMENT" },
    ...commentLines(base.comment).map((text) => ({ type: "line", text: `– ${text}` })),
    { type: "blank" },
    { type: "line", text: THANKS_LINE },
    { type: "line", text: sign.doctor },
  ];
  const remarks = splitReportAndRemarks(base.reportText).remarks;
  if (remarks) {
    blocks.push({ type: "blank" }, { type: "section", text: REMARKS_HEADING });
    for (const text of remarks.split("\n")) blocks.push({ type: "line", text });
  }
  return blocks;
}

function layoutText(blocks) {
  return blocks.map((b) => (b.type === "blank" ? "" : b.text)).join("\n");
}

export function buildReportSections(c = {}, signerName = "") {
  const base = ensureTags(c || {});
  const findings = Array.isArray(c.findings) ? c.findings : [];
  const tagged = (Array.isArray(base.findingTags) && base.findingTags.length > 0) || Boolean(String(base.comment || "").trim());
  const signOff = reportSignOff(c, signerName);
  const layout = tagged ? layoutBlocks(base, signOff) : null;
  return {
    title: "Chest X-ray Report",
    caseId: c.caseId || c._id || "",
    patientId: c.patientId || "",
    age: c.age || "",
    sex: c.sex || "",
    history: c.history || "",
    header: reportHeaderFields(c, signerName),
    tagged,
    layout,
    body: layout ? layoutText(layout) : legacyBody(c),
    signOff,
    findings: findings.map((f, i) => ({
      n: i + 1,
      label: f.label || `Finding ${i + 1}`,
      detail: f.sentence || "",
      location: f.location || "",
      size: f.size || "",
      pattern: f.pattern && f.pattern !== "Other" ? f.pattern : "",
      source: f.source || "",
      confidence: Math.round((f.confidence ?? 0) * 100),
    })),
    fileBase: `RadAssist-${safeName(c.patientId || c.caseId || c._id)}`,
  };
}

// ----------------------------------------------------------------- blocks
// Both downloads are one list of blocks. Word and PDF each draw it their way.
//   plain: the report and one clean film.
//   films: the report, then the whole film again for every abnormal finding
//          with only that finding's box and measurement line.

export const VARIANTS = ["plain", "films"];

export function buildReportBlocks(c = {}, variant = "plain", signerName = "") {
  const s = buildReportSections(c, signerName);
  const base = ensureTags(c || {});
  const patient = [s.patientId && `Patient ${s.patientId}`, s.age && `${s.age} years`, s.sex].filter(Boolean).join(" · ");
  const blocks = [
    { type: "title", text: s.title },
    { type: "line", text: `Case ${s.caseId}`, italic: true },
  ];
  if (patient) blocks.push({ type: "line", text: patient });
  if (s.history) blocks.push({ type: "line", text: `Clinical history: ${s.history}` });
  blocks.push({ type: "blank" });
  for (const f of s.header) blocks.push({ type: "field", label: f.label, value: f.value });
  blocks.push({ type: "blank" });
  if (variant !== "films") blocks.push({ type: "film", heading: "Chest X-ray", overlay: null });
  if (s.layout) blocks.push(...s.layout);
  else for (const text of (s.body || "(No report text)").split("\n")) blocks.push(text ? { type: "line", text } : { type: "blank" });
  blocks.push({ type: "blank" }, { type: "line", text: `Date: ${s.signOff.date}` });
  if (!s.tagged) blocks.push({ type: "line", text: `Reporting doctor: ${s.signOff.doctor}` });
  blocks.push(
    { type: "blank" },
    { type: "section", text: "Signature" },
    { type: "signature", text: s.signOff.doctor },
    { type: "line", text: "______________________________" },
  );

  if (variant === "films") {
    const tags = (Array.isArray(base.findingTags) ? base.findingTags : []).filter((t) => t.abnormal);
    const spacing = spacingOf(c);
    blocks.push({ type: "pagebreak" }, { type: "heading", text: "Finding films" });
    if (!tags.length) blocks.push({ type: "line", text: "No abnormal finding in this report." });
    tags.forEach((tag, i) => {
      const boxes = boxesForTag(base.findings, tag.key).map((f) => f.bbox);
      const lines = linesOfTag(base.measurements, tag.key);
      const n = i + 1;
      blocks.push({ type: "blank" });
      if (boxes.length) {
        blocks.push({ type: "film", heading: `Finding ${n}: ${tag.text}`, overlay: { boxes, lines: [] }, tagKey: tag.key });
      }
      if (lines.length) {
        blocks.push({ type: "film", heading: `Finding ${n} measurement: ${tag.text}`, overlay: { boxes: [], lines }, tagKey: tag.key });
        const description = describeMeasurement(tag, base.measurements, {
          view: base.view,
          spacingName: spacing.source ? spacing.name : "",
          case: base,
        });
        for (const text of description) blocks.push({ type: "line", text });
      } else if (!boxes.length) {
        blocks.push({ type: "line", text: "No box has been placed for this finding." });
      } else {
        blocks.push({ type: "line", text: "No measurement was drawn for this finding." });
      }
    });
  }
  return blocks;
}

export const filmBlocks = (blocks) => blocks.filter((b) => b.type === "film");

// ------------------------------------------------------------------ films

async function loadFilmBytes(c) {
  const shared = c?.shareImageUrl;
  const id = c?.imageId;
  if (!shared && !id) return null;
  const work = (async () => {
    const blob = shared
      ? await fetch(shared).then((res) => {
        if (!res.ok) throw new Error(`Image fetch failed: HTTP ${res.status}`);
        return res.blob();
      })
      : await api.fetchImage(id);
    return new Uint8Array(await blob.arrayBuffer());
  })();
  return Promise.race([work, new Promise((_, reject) => setTimeout(() => reject(new Error("The X-ray took too long to load.")), 20000))]);
}

function drawOverlay(ctx, width, height, overlay) {
  const scale = Math.max(width, height) / 1000;
  ctx.lineCap = "round";
  for (const b of overlay.boxes || []) {
    const [l, t, w, h] = b;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 7 * scale;
    ctx.strokeRect((l / 100) * width, (t / 100) * height, (w / 100) * width, (h / 100) * height);
    ctx.strokeStyle = "#ffd400";
    ctx.lineWidth = 4 * scale;
    ctx.strokeRect((l / 100) * width, (t / 100) * height, (w / 100) * width, (h / 100) * height);
  }
  ctx.font = `bold ${Math.round(22 * scale)}px Helvetica, Arial, sans-serif`;
  ctx.textBaseline = "bottom";
  for (const m of overlay.lines || []) {
    const x1 = (m.x1 / 100) * width;
    const y1 = (m.y1 / 100) * height;
    const x2 = (m.x2 / 100) * width;
    const y2 = (m.y2 / 100) * height;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 6 * scale;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3 * scale;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    const text = String(m.text || "").trim();
    if (!text) continue;
    const pad = 4 * scale;
    const tw = ctx.measureText(text).width;
    const th = 26 * scale;
    const cx = Math.min(width - tw / 2 - pad, Math.max(tw / 2 + pad, (x1 + x2) / 2));
    const cy = Math.min(height - pad, Math.max(th + pad, (y1 + y2) / 2 - 6 * scale));
    ctx.fillStyle = "rgba(0,0,0,0.8)";
    ctx.fillRect(cx - tw / 2 - pad, cy - th, tw + pad * 2, th);
    ctx.fillStyle = "#fff";
    ctx.fillText(text, cx - tw / 2, cy - pad / 2);
  }
}

// Draws the whole film with only the overlay given. Throws when the browser
// cannot, so a download never silently loses the boxes.
async function canvasRenderer(bytes, overlay) {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    throw new Error("This browser cannot draw the X-ray for the download.");
  }
  const bmp = await createImageBitmap(new Blob([bytes]));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, bmp.width);
  canvas.height = Math.max(1, bmp.height);
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof canvas.toBlob !== "function") throw new Error("This browser cannot draw the X-ray for the download.");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0);
  drawOverlay(ctx, canvas.width, canvas.height, overlay || {});
  const jpegBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!jpegBlob) throw new Error("The X-ray could not be drawn for the download.");
  return { bytes: new Uint8Array(await jpegBlob.arrayBuffer()), type: "jpg", width: canvas.width, height: canvas.height, components: 3 };
}

let filmRenderer = canvasRenderer;
// Tests replace the canvas, which only a browser has.
export function setFilmRenderer(fn) {
  filmRenderer = typeof fn === "function" ? fn : canvasRenderer;
}

// One image per film block, in order. `pdf` wants JPEG only.
export async function prepareFilms(c, blocks, { pdf = false, loadBytes = loadFilmBytes } = {}) {
  const wanted = filmBlocks(blocks);
  if (!wanted.length) return [];
  const needsDrawing = wanted.some((b) => b.overlay);
  let bytes = null;
  try {
    bytes = await loadBytes(c);
  } catch (err) {
    if (needsDrawing) throw err;
    console.warn("[report] could not attach X-ray to export:", err.message);
  }
  if (!bytes) {
    if (needsDrawing) throw new Error("The X-ray is not available, so the finding films cannot be drawn.");
    return wanted.map(() => null);
  }
  const meta = parseImageMeta(bytes) || {};
  const raw = { bytes, type: meta.type || "", width: meta.width || 0, height: meta.height || 0, components: meta.components || 3 };
  const out = [];
  for (const block of wanted) {
    if (block.overlay) {
      out.push(await filmRenderer(bytes, block.overlay));
    } else if (raw.type && raw.width && raw.height && (!pdf || raw.type === "jpg")) {
      out.push(raw);
    } else {
      try {
        out.push(await filmRenderer(bytes, { boxes: [], lines: [] }));
      } catch (err) {
        console.warn("[report] could not attach X-ray to export:", err.message);
        out.push(null);
      }
    }
  }
  return out;
}

// -------------------------------------------------------------------- Word

function usable(film, types) {
  return film && film.bytes && film.width && film.height && types.includes(film.type);
}

const DOCX_TYPES = ["jpg", "png", "gif", "bmp"];

// `images` holds one entry per film block, as prepareFilms returns it.
export async function buildReportDocxBlob(c, { variant = "plain", images = [], signerName = "" } = {}) {
  const blocks = buildReportBlocks(c, variant, signerName);
  const children = [];
  let k = 0;
  for (const b of blocks) {
    if (b.type === "title") children.push(new Paragraph({ text: b.text, heading: HeadingLevel.HEADING_1 }));
    else if (b.type === "heading") children.push(new Paragraph({ text: b.text, heading: HeadingLevel.HEADING_2 }));
    else if (b.type === "section") children.push(new Paragraph({ children: [new TextRun({ text: b.text, bold: true })] }));
    else if (b.type === "field") {
      children.push(new Paragraph({ children: [new TextRun({ text: `${b.label}: `, bold: true }), new TextRun({ text: b.value })] }));
    } else if (b.type === "signature") {
      children.push(new Paragraph({ children: [new TextRun({ text: b.text, italics: true, size: 36, font: "Times New Roman" })] }));
    } else if (b.type === "pagebreak") {
      children.push(new Paragraph({ text: "", pageBreakBefore: true }));
    } else if (b.type === "blank") children.push(new Paragraph({ text: "" }));
    else if (b.type === "film") {
      const film = images[k++];
      if (!usable(film, DOCX_TYPES)) continue;
      const box = fitImageBox(film.width, film.height, 520, 400);
      children.push(new Paragraph({ text: b.heading, heading: HeadingLevel.HEADING_2 }));
      children.push(new Paragraph({
        children: [new ImageRun({
          type: film.type,
          data: film.bytes,
          transformation: { width: box.width, height: box.height },
          altText: { name: b.heading, title: b.heading, description: "Chest X-ray" },
        })],
      }));
    } else children.push(new Paragraph({ children: [new TextRun({ text: b.text, italics: Boolean(b.italic) })] }));
  }
  return Packer.toBlob(new Document({ sections: [{ properties: {}, children }] }));
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const FILE_SUFFIX = { plain: "", films: "-with-finding-films" };

export async function downloadReportDocx(c, variant = "plain") {
  const s = buildReportSections(c);
  const images = await prepareFilms(c, buildReportBlocks(c, variant));
  const blob = await buildReportDocxBlob(c, { variant, images });
  triggerDownload(blob, `${s.fileBase}${FILE_SUFFIX[variant] || ""}.docx`);
}

// --------------------------------------------------------------------- PDF

function wrapPlain(text, width) {
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    const t = raw.trimEnd();
    if (!t) {
      out.push("");
      continue;
    }
    let rest = t;
    while (rest.length > width) {
      let cut = rest.lastIndexOf(" ", width);
      if (cut < 20) cut = width;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    if (rest) out.push(rest);
  }
  return out;
}

const WIN_ANSI = {
  0x2013: 0x96, 0x2014: 0x97, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2026: 0x85,
};

// PDF text is Latin-1 (WinAnsi). Anything else is written as an octal escape
// so the stream stays plain ASCII and a long dash does not turn into noise.
function escapePdf(text) {
  let out = "";
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (ch === "\\" || ch === "(" || ch === ")") out += `\\${ch}`;
    else if (code >= 32 && code < 127) out += ch;
    else {
      const byte = code < 256 && code >= 160 ? code : WIN_ANSI[code] || 63;
      out += `\\${byte.toString(8).padStart(3, "0")}`;
    }
  }
  return out;
}

function encodePdf(objects) {
  const enc = new TextEncoder();
  const parts = [enc.encode("%PDF-1.4\n")];
  const offsets = [0];
  let length = parts[0].length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(length);
    const body = typeof objects[i] === "string" ? enc.encode(objects[i]) : objects[i];
    const obj = concatBytes([enc.encode(`${i + 1} 0 obj\n`), body, enc.encode("\nendobj\n")]);
    parts.push(obj);
    length += obj.length;
  }
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`;
  parts.push(enc.encode(xref));
  return concatBytes(parts);
}

function jpegImageObject(film) {
  const enc = new TextEncoder();
  const jpeg = film.bytes;
  const color = film.components === 1 ? "/DeviceGray" : film.components === 4 ? "/DeviceCMYK" : "/DeviceRGB";
  const header = `<< /Type /XObject /Subtype /Image /Width ${film.width} /Height ${film.height} /ColorSpace ${color} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`;
  return concatBytes([enc.encode(header), jpeg, enc.encode("\nendstream")]);
}

const PAGE = { width: 595, height: 842, margin: 50 };
const leadingOf = (size) => (size > 13 ? 22 : 14);
const MAX_FILM_H = 360;

// Turns blocks into positioned lines and images, one page at a time.
function layoutPdf(blocks, images) {
  const contentWidth = PAGE.width - PAGE.margin * 2;
  const items = [];
  let k = 0;
  for (const b of blocks) {
    if (b.type === "title") for (const t of wrapPlain(b.text, 60)) items.push({ kind: "text", text: t, font: "F2", size: 16 });
    else if (b.type === "heading") for (const t of wrapPlain(b.text, 80)) items.push({ kind: "text", text: t, font: "F2", size: 12 });
    else if (b.type === "section" || b.type === "signature") for (const t of wrapPlain(b.text, 90)) items.push({ kind: "text", text: t, font: b.type === "section" ? "F2" : "F1", size: 11 });
    else if (b.type === "field") for (const t of wrapPlain(`${b.label}: ${b.value}`, 90)) items.push({ kind: "text", text: t, font: "F1", size: 11 });
    else if (b.type === "blank") items.push({ kind: "text", text: "", font: "F1", size: 11 });
    else if (b.type === "pagebreak") items.push({ kind: "break" });
    else if (b.type === "film") {
      const film = images[k++];
      if (!usable(film, ["jpg"])) continue;
      const box = fitImageBox(film.width, film.height, contentWidth, MAX_FILM_H);
      for (const t of wrapPlain(b.heading, 80)) items.push({ kind: "text", text: t, font: "F2", size: 12, keep: true });
      items.push({ kind: "image", film, w: box.width, h: box.height });
    } else for (const t of wrapPlain(b.text, 90)) items.push({ kind: "text", text: t, font: "F1", size: 11 });
  }

  const pages = [];
  let page = { ops: [] };
  let y = PAGE.height - PAGE.margin;
  const newPage = () => {
    pages.push(page);
    page = { ops: [] };
    y = PAGE.height - PAGE.margin;
  };
  const heightOf = (it) => (it.kind === "image" ? it.h + 8 : leadingOf(it.size));
  items.forEach((it, i) => {
    if (it.kind === "break") {
      if (page.ops.length) newPage();
      return;
    }
    let need = heightOf(it);
    if (it.keep) {
      for (let j = i + 1; j < items.length && items[j].kind !== "break"; j++) {
        need += heightOf(items[j]);
        if (items[j].kind === "image") break;
      }
    }
    if (y - need < PAGE.margin && page.ops.length) newPage();
    if (it.kind === "image") {
      y -= it.h;
      page.ops.push({ kind: "image", film: it.film, x: PAGE.margin, y, w: it.w, h: it.h });
      y -= 8;
    } else {
      page.ops.push({ kind: "text", text: it.text, font: it.font, size: it.size, x: PAGE.margin, y: y - it.size });
      y -= leadingOf(it.size);
    }
  });
  pages.push(page);
  return pages;
}

// Custom PDF so we do not pull in jsPDF. JPEG films are embedded with DCTDecode.
// `film` is the clean film of the plain report. For the "films" variant pass
// `options.images`, one JPEG per finding film, as prepareFilms returns it.
export function buildReportPdfBytes(c, film = null, options = {}) {
  const variant = options.variant || "plain";
  const blocks = buildReportBlocks(c, variant, options.signerName || "");
  const images = options.images || filmBlocks(blocks).map((b) => (b.overlay ? null : film));
  const pages = layoutPdf(blocks, images);

  // 1 catalog, 2 pages tree, 3 regular font, 4 bold font, then images, then page pairs.
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];
  const imageIds = new Map();
  for (const p of pages) {
    for (const op of p.ops) {
      if (op.kind !== "image" || imageIds.has(op.film)) continue;
      objects.push(jpegImageObject(op.film));
      imageIds.set(op.film, objects.length);
    }
  }
  const kidIds = [];
  for (const p of pages) {
    let stream = "";
    const used = new Map();
    for (const op of p.ops) {
      if (op.kind !== "image") continue;
      if (!used.has(op.film)) used.set(op.film, `Im${used.size + 1}`);
      stream += `q ${op.w} 0 0 ${op.h} ${op.x} ${op.y} cm /${used.get(op.film)} Do Q\n`;
    }
    stream += "BT\n";
    for (const op of p.ops) {
      if (op.kind !== "text" || !op.text) continue;
      stream += `/${op.font} ${op.size} Tf 1 0 0 1 ${op.x} ${op.y} Tm (${escapePdf(op.text)}) Tj\n`;
    }
    stream += "ET\n";
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
    const streamId = objects.length;
    const xobj = used.size ? ` /XObject << ${[...used].map(([f, name]) => `/${name} ${imageIds.get(f)} 0 R`).join(" ")} >>` : "";
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Contents ${streamId} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobj} >> >>`);
    kidIds.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Count ${kidIds.length} /Kids [${kidIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  return encodePdf(objects);
}

async function reportPdfBlob(c, variant) {
  const blocks = buildReportBlocks(c, variant);
  const images = await prepareFilms(c, blocks, { pdf: true });
  return new Blob([buildReportPdfBytes(c, null, { variant, images })], { type: "application/pdf" });
}

export async function downloadReportPdf(c, variant = "plain") {
  const s = buildReportSections(c);
  triggerDownload(await reportPdfBlob(c, variant), `${s.fileBase}${FILE_SUFFIX[variant] || ""}.pdf`);
}

const PREVIEW_WINDOW = "radassist-pdf-preview";

// Must be called synchronously in the click handler; a window opened after an
// await is blocked as a pop-up. Returns null when the browser blocked it.
export function openPreviewWindow() {
  if (typeof window.open !== "function") return null;
  const width = Math.min(960, (window.screen?.availWidth || 960) - 40);
  const height = Math.min(1000, (window.screen?.availHeight || 900) - 40);
  const left = Math.max(0, (window.screenX || 0) + ((window.outerWidth || width) - width) / 2);
  const top = Math.max(0, (window.screenY || 0) + 30);
  let win = null;
  try {
    win = window.open("", PREVIEW_WINDOW, `popup,width=${width},height=${height},left=${left},top=${top}`);
  } catch {
    win = null;
  }
  if (!win) return null;
  try {
    win.document.title = "Preparing report…";
    win.document.body.innerHTML = '<p style="font:14px system-ui,sans-serif;color:#334155;padding:24px">Preparing the PDF preview…</p>';
  } catch { /* a PDF from an earlier preview is still showing */ }
  try { win.focus(); } catch { /* some browsers refuse focus */ }
  return win;
}

// Without an open `win` the PDF is downloaded instead.
export async function previewReportPdf(c, win, variant = "plain") {
  if (!win || win.closed) {
    await downloadReportPdf(c, variant);
    return;
  }
  const url = URL.createObjectURL(await reportPdfBlob(c, variant));
  win.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
