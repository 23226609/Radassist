// src/lib/reportExport.js
// Builds a downloadable copy of the case report (plain sections → DOCX / PDF).

import { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun } from "docx";
import { api } from "../api.js";

export const REMARKS_HEADING = "Radiologist remarks";
export const MANUAL_FINDINGS_HEADING = "Clinician-added findings";

function splitOnHeading(reportText, heading) {
  const text = String(reportText || "").replace(/\r\n/g, "\n");
  const marker = `\n\n${heading}\n`;
  const idx = text.indexOf(marker);
  if (idx >= 0) {
    return {
      body: text.slice(0, idx).trim(),
      section: text.slice(idx + marker.length).trim(),
    };
  }
  if (text.startsWith(`${heading}\n`)) {
    return { body: "", section: text.slice(heading.length).trim() };
  }
  return { body: text.trim(), section: "" };
}

export function splitReportAndRemarks(reportText) {
  const { body, section } = splitOnHeading(reportText, REMARKS_HEADING);
  return { body, remarks: section };
}

const SCAFFOLD_LINE = /^(?:radiology report|header|frontal chest x-?ray)\s*:?\s*$/i;
const COVER_LINE = /^(?:patient\s*id|patient|age|sex|name)\s*:/i;
const HISTORY_LINE = /^clinical history\s*:?\s*(.*)$/i;
const FINDINGS_LINE = /^(?:imaging findings|findings)\b\s*:?\s*.*$/i;
const IMPRESSION_LINE = /^(?:impression|conclusion)\s*:?\s*$/i;
const BOILER_LINE = /^this report provides a comprehensive analysis\b/i;

// CURV sometimes ignores the Findings / Thinking / Impression tags and writes
// a second cover ("Radiology Report", patient id, "Imaging Findings", "Conclusion").
// The download already has that cover, so fold the body back into one shape.
export function normalizeReportShape(reportText) {
  const src = String(reportText || "").replace(/\r\n/g, "\n").trim();
  if (!src) return "";
  const alternate = /^(?:radiology report|imaging findings)\b/im.test(src)
    || /^patient id\s*:/im.test(src)
    || /^conclusion\s*:?\s*$/im.test(src);
  if (!alternate) return src;

  const lines = src.split("\n");
  const out = [];
  let seenFindings = false;
  let skipHistory = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!seenFindings) {
      if (!line || SCAFFOLD_LINE.test(line) || COVER_LINE.test(line)) continue;
      const history = line.match(HISTORY_LINE);
      if (history) {
        skipHistory = !history[1];
        continue;
      }
      if (skipHistory) {
        skipHistory = false;
        continue;
      }
      if (FINDINGS_LINE.test(line)) {
        seenFindings = true;
        out.push("Findings:");
        continue;
      }
      seenFindings = true;
    }
    if (!line && out.length && !out[out.length - 1]) continue;
    if (IMPRESSION_LINE.test(line)) {
      out.push("Impression:");
      continue;
    }
    if (FINDINGS_LINE.test(line) && /^imaging findings\b/i.test(line)) {
      out.push("Findings:");
      continue;
    }
    if (BOILER_LINE.test(line)) break;
    out.push(raw.replace(/[ \t]+$/g, ""));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const THINKING_BLOCK = /(^|\n)([ \t]*#*\s*Thinking\s*:?[ \t]*\n[\s\S]*?)(?=\n[ \t]*#*\s*(?:Findings|Impression|Conclusion|Radiologist remarks|Clinician-added findings)\s*:?[ \t]*\n|$)/i;

// The model's reasoning is kept in the stored draft but never shown or exported.
export function withoutThinking(reportText) {
  const src = String(reportText || "").replace(/\r\n/g, "\n");
  const cleaned = src.replace(new RegExp(THINKING_BLOCK.source, "gi"), "$1");
  return cleaned.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The editor shows the report without Thinking. Put the stored block back
// before Impression so saving an edit does not drop it.
export function restoreThinking(original, edited) {
  const text = String(edited || "").replace(/\r\n/g, "\n").trim();
  const match = String(original || "").replace(/\r\n/g, "\n").match(THINKING_BLOCK);
  if (!match || THINKING_BLOCK.test(text)) return text;
  const block = match[2].trim();
  const at = text.search(/(^|\n)[ \t]*#*\s*(?:Impression|Conclusion)\s*:?[ \t]*(\n|$)/i);
  if (at < 0) return `${text}\n\n${block}`.trim();
  return `${text.slice(0, at).trimEnd()}\n\n${block}\n\n${text.slice(at).trimStart()}`.trim();
}

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

// Puts the clinician's remarks in their own section at the end of the stored
// report. Saving again replaces that section instead of stacking copies.
export function applyRemarksToReport(reportText, remarks) {
  const { body } = splitReportAndRemarks(reportText);
  const note = String(remarks || "").trim();
  if (!note) return { reportText: body, remarks: "" };
  return {
    reportText: `${body}\n\n${REMARKS_HEADING}\n${note}`,
    remarks: note,
  };
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

function drawMeasurements(ctx, width, height, measurements) {
  const list = (Array.isArray(measurements) ? measurements : []).filter((m) => String(m?.text || "").trim());
  if (!list.length) return;
  const scale = Math.max(width, height) / 1000;
  ctx.lineCap = "round";
  ctx.font = `bold ${Math.round(22 * scale)}px Helvetica, Arial, sans-serif`;
  ctx.textBaseline = "bottom";
  list.forEach((m, i) => {
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
    const name = String(m.label || "").trim();
    const tag = `${i + 1} · ${name ? `${name} ` : ""}${String(m.text).trim()}`;
    const pad = 4 * scale;
    const tw = ctx.measureText(tag).width;
    const th = 26 * scale;
    const cx = Math.min(width - tw / 2 - pad, Math.max(tw / 2 + pad, (x1 + x2) / 2));
    const cy = Math.min(height - pad, Math.max(th + pad, (y1 + y2) / 2 - 6 * scale));
    ctx.fillStyle = "rgba(0,0,0,0.8)";
    ctx.fillRect(cx - tw / 2 - pad, cy - th, tw + pad * 2, th);
    ctx.fillStyle = "#fff";
    ctx.fillText(tag, cx - tw / 2, cy - pad / 2);
  });
}

async function rasterizeJpeg(bytes, measurements = []) {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  try {
    const blob = new Blob([bytes]);
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, bmp.width);
    canvas.height = Math.max(1, bmp.height);
    const ctx = canvas.getContext("2d");
    if (!ctx || typeof canvas.toBlob !== "function") return null;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0);
    drawMeasurements(ctx, canvas.width, canvas.height, measurements);
    const jpegBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!jpegBlob) return null;
    const jpeg = new Uint8Array(await jpegBlob.arrayBuffer());
    return { bytes: jpeg, type: "jpg", width: canvas.width, height: canvas.height, components: 3 };
  } catch {
    return null;
  }
}

async function loadCaseFilm(c) {
  const shared = c?.shareImageUrl;
  const id = c?.imageId;
  if (!shared && !id) return null;
  try {
    const blob = shared
      ? await fetch(shared).then((res) => {
        if (!res.ok) throw new Error(`Image fetch failed: HTTP ${res.status}`);
        return res.blob();
      })
      : await api.fetchImage(id);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const meta = parseImageMeta(bytes) || {};
    const film = {
      bytes,
      type: meta.type || "",
      width: meta.width || 0,
      height: meta.height || 0,
      components: meta.components || 3,
    };
    const measured = measurementLines(c.measurements).length > 0;
    if (film.type === "jpg" && film.width && film.height && !measured) return film;
    const converted = await rasterizeJpeg(bytes, c.measurements);
    if (converted) return converted;
    return film.width && film.height && film.type ? film : null;
  } catch (err) {
    console.warn("[report] could not attach X-ray to export:", err.message);
    return null;
  }
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

export function reportSignOff(c = {}, signerName = "") {
  const doctor = String(c.finalizedByName || signerName || "").trim() || "Reporting radiologist";
  const when = c.status === "finalized" && c.updatedAt ? new Date(c.updatedAt) : new Date();
  const date = Number.isNaN(when.getTime())
    ? ""
    : when.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return { doctor, date };
}

function reportBody(c = {}) {
  const split = splitReportAndRemarks(c.reportText);
  const manual = splitManualFindings(split.body);
  let body = withoutThinking(normalizeReportShape(manual.body));
  if (manual.manual) body = `${body}\n\n${MANUAL_FINDINGS_HEADING}\n${manual.manual}`.trim();
  const measured = measurementLines(c.measurements);
  if (measured.length) body = `${body}\n\n${MEASUREMENTS_HEADING}\n${measured.join("\n")}`.trim();
  if (split.remarks) body = `${body}\n\n${REMARKS_HEADING}\n${split.remarks}`.trim();
  return body;
}

export function buildReportSections(c = {}) {
  const findings = Array.isArray(c.findings) ? c.findings : [];
  return {
    title: "Chest X-ray Report",
    caseId: c.caseId || c._id || "",
    patientId: c.patientId || "",
    age: c.age || "",
    sex: c.sex || "",
    history: c.history || "",
    body: reportBody(c),
    signOff: reportSignOff(c),
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

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function filmForReport(c) {
  return Promise.race([
    loadCaseFilm(c),
    new Promise((resolve) => setTimeout(() => resolve(null), 20000)),
  ]);
}

export async function downloadReportDocx(c) {
  const s = buildReportSections(c);
  const film = await filmForReport(c);
  const children = [
    new Paragraph({ text: s.title, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({
      children: [new TextRun({ text: `Case ${s.caseId}`, italics: true, color: "475569" })],
    }),
    new Paragraph({
      text: [s.patientId && `Patient ${s.patientId}`, s.age && `${s.age} years`, s.sex]
        .filter(Boolean)
        .join(" · "),
    }),
  ];
  if (s.history) {
    children.push(new Paragraph({ text: `Clinical history: ${s.history}` }));
  }
  if (film && ["jpg", "png", "gif", "bmp"].includes(film.type)) {
    const box = fitImageBox(film.width, film.height, 520, 400);
    children.push(new Paragraph({ text: "Chest X-ray", heading: HeadingLevel.HEADING_2 }));
    children.push(new Paragraph({
      children: [
        new ImageRun({
          type: film.type,
          data: film.bytes,
          transformation: { width: box.width, height: box.height },
          altText: { name: "Chest X-ray", title: "Chest X-ray", description: "Uploaded chest X-ray" },
        }),
      ],
    }));
  }
  children.push(new Paragraph({ text: "" }));
  for (const line of s.body.split("\n")) {
    children.push(new Paragraph({ text: line }));
  }
  children.push(new Paragraph({ text: "" }));
  children.push(new Paragraph({ text: `Date: ${s.signOff.date}` }));
  children.push(new Paragraph({ text: `Reporting doctor: ${s.signOff.doctor}` }));
  children.push(new Paragraph({ text: "" }));
  children.push(new Paragraph({
    children: [new TextRun({ text: "Signature", bold: true, size: 20 })],
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: s.signOff.doctor, italics: true, size: 36, font: "Times New Roman" })],
  }));
  children.push(new Paragraph({ text: "______________________________" }));
  const blob = await Packer.toBlob(new Document({
    sections: [{ properties: {}, children }],
  }));
  triggerDownload(blob, `${s.fileBase}.docx`);
}

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

function escapePdf(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
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

// Custom PDF so we do not pull in jsPDF. JPEG films are embedded with DCTDecode.
export function buildReportPdfBytes(c, film = null) {
  const s = buildReportSections(c);
  const headerLines = [
    s.title,
    `Case ${s.caseId}`,
    [s.patientId && `Patient ${s.patientId}`, s.age && `${s.age} years`, s.sex].filter(Boolean).join(" · "),
    s.history ? `Clinical history: ${s.history}` : "",
    "",
  ];
  if (film?.type === "jpg" && film.bytes && film.width && film.height) {
    headerLines.push("Chest X-ray", "");
  }
  const bodyLines = [
    ...wrapPlain(s.body || "(No report text)", 90),
    "",
    `Date: ${s.signOff.date}`,
    `Reporting doctor: ${s.signOff.doctor}`,
    "",
    "Signature",
    s.signOff.doctor,
    "______________________________",
  ];

  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 50;
  const leading = 14;
  const contentWidth = pageWidth - margin * 2;
  const usableHeight = pageHeight - margin * 2;
  const jpegFilm = film?.type === "jpg" && film.bytes && film.width && film.height ? film : null;
  const headerH = headerLines.length * leading;
  const maxImgH = Math.max(80, Math.min(360, usableHeight - headerH - leading * 4));
  const imgBox = jpegFilm ? fitImageBox(jpegFilm.width, jpegFilm.height, contentWidth, maxImgH) : null;

  const pages = [];
  if (jpegFilm && imgBox) {
    const firstBudget = Math.max(0, Math.floor((usableHeight - headerH - imgBox.height - leading) / leading));
    pages.push({
      lines: [...headerLines, ...bodyLines.slice(0, firstBudget)],
      image: imgBox,
      imageAfter: headerLines.length,
    });
    let rest = bodyLines.slice(firstBudget);
    const perPage = Math.floor(usableHeight / leading);
    while (rest.length) {
      pages.push({ lines: rest.slice(0, perPage) });
      rest = rest.slice(perPage);
    }
  } else {
    const lines = [...headerLines, ...bodyLines];
    const perPage = Math.floor(usableHeight / leading);
    for (let i = 0; i < lines.length; i += perPage) pages.push({ lines: lines.slice(i, i + perPage) });
  }
  if (!pages.length) pages.push({ lines: [""] });

  // Object ids: 1 catalog, 2 pages tree, 3 font, optional 4 image, then stream/page pairs.
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let imageId = 0;
  if (jpegFilm && imgBox) {
    objects.push(jpegImageObject(jpegFilm));
    imageId = objects.length;
  }
  const kidIds = [];
  for (const page of pages) {
    let stream = "";
    if (page.image && imageId) {
      const imgY = pageHeight - margin - (page.imageAfter * leading) - page.image.height;
      stream += `q ${page.image.width} 0 0 ${page.image.height} ${margin} ${imgY} cm /Im1 Do Q\n`;
    }
    stream += "BT /F1 11 Tf\n";
    let extra = 0;
    page.lines.forEach((line, i) => {
      if (page.image && i === page.imageAfter) extra = page.image.height + 8;
      const y = pageHeight - margin - i * leading - extra;
      stream += `1 0 0 1 ${margin} ${y} Tm (${escapePdf(line)}) Tj\n`;
    });
    stream += "ET\n";
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
    const streamId = objects.length;
    const xobj = imageId && page.image ? ` /XObject << /Im1 ${imageId} 0 R >>` : "";
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents ${streamId} 0 R /Resources << /Font << /F1 3 0 R >>${xobj} >> >>`);
    kidIds.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Count ${kidIds.length} /Kids [${kidIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  return encodePdf(objects);
}

async function reportPdfBlob(c) {
  const film = await filmForReport(c);
  const bytes = buildReportPdfBytes(c, film?.type === "jpg" ? film : null);
  return new Blob([bytes], { type: "application/pdf" });
}

export async function downloadReportPdf(c) {
  const s = buildReportSections(c);
  triggerDownload(await reportPdfBlob(c), `${s.fileBase}.pdf`);
}

// `win` must be opened synchronously in the click handler; a window opened
// after an await is blocked as a popup. Without one the PDF is downloaded.
export async function previewReportPdf(c, win) {
  if (!win || win.closed) {
    await downloadReportPdf(c);
    return;
  }
  const url = URL.createObjectURL(await reportPdfBlob(c));
  win.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
