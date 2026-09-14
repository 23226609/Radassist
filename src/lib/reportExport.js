// src/lib/reportExport.js
// Builds a downloadable copy of the case report (plain sections → DOCX / PDF).

import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";

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

export function splitManualFindings(reportText) {
  const { body, section } = splitOnHeading(reportText, MANUAL_FINDINGS_HEADING);
  return { body, manual: section };
}

export function isManualFinding(f) {
  const source = String(f?.source || "").toLowerCase();
  if (source === "manual" || source === "clinician") return true;
  return String(f?._id || f?.id || "").startsWith("tmp-");
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

export function buildReportSections(c = {}) {
  const findings = Array.isArray(c.findings) ? c.findings : [];
  return {
    title: "Chest X-ray Report",
    caseId: c.caseId || c._id || "",
    patientId: c.patientId || "",
    age: c.age || "",
    sex: c.sex || "",
    history: c.history || "",
    body: String(c.reportText || "").replace(/\r\n/g, "\n").trim(),
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

export async function downloadReportDocx(c) {
  const s = buildReportSections(c);
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
  children.push(new Paragraph({ text: "" }));
  for (const line of s.body.split("\n")) {
    children.push(new Paragraph({ text: line }));
  }
  if (s.findings.length) {
    children.push(new Paragraph({ text: "Findings", heading: HeadingLevel.HEADING_2 }));
    for (const f of s.findings) {
      children.push(new Paragraph({
        children: [new TextRun({ text: `${f.n}. ${f.label}`, bold: true })],
      }));
      if (f.detail) children.push(new Paragraph({ text: f.detail }));
      if (f.location) children.push(new Paragraph({ text: `Location: ${f.location}` }));
      if (f.size) children.push(new Paragraph({ text: `Size: ${f.size}` }));
      if (f.pattern) children.push(new Paragraph({ text: `Pattern: ${f.pattern}` }));
    }
  }
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

// Minimal text-only PDF — avoids pulling in jsPDF (which has a long CVE list
// and is far heavier than we need for a radiology report).
export function buildReportPdfBytes(c) {
  const s = buildReportSections(c);
  const lines = [
    s.title,
    `Case ${s.caseId}`,
    [s.patientId && `Patient ${s.patientId}`, s.age && `${s.age} years`, s.sex].filter(Boolean).join(" · "),
    s.history ? `Clinical history: ${s.history}` : "",
    "",
    ...wrapPlain(s.body || "(No report text)", 90),
  ];
  if (s.findings.length) {
    lines.push("", "Findings", "");
    for (const f of s.findings) {
      lines.push(`${f.n}. ${f.label}`);
      if (f.detail) lines.push(...wrapPlain(f.detail, 88));
      if (f.location) lines.push(`Location: ${f.location}`);
      if (f.size) lines.push(`Size: ${f.size}`);
      if (f.pattern) lines.push(`Pattern: ${f.pattern}`);
      lines.push("");
    }
  }

  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 50;
  const leading = 14;
  const perPage = Math.floor((pageHeight - margin * 2) / leading);
  const chunks = [];
  for (let i = 0; i < lines.length; i += perPage) chunks.push(lines.slice(i, i + perPage));
  if (!chunks.length) chunks.push([""]);

  // Object ids: 1 catalog, 2 pages tree, 3 font, then stream/page pairs.
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    null, // pages tree filled after we know kid ids
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const kidIds = [];
  for (const pageLines of chunks) {
    let stream = "BT /F1 11 Tf\n";
    pageLines.forEach((line, i) => {
      const y = pageHeight - margin - i * leading;
      stream += `1 0 0 1 ${margin} ${y} Tm (${escapePdf(line)}) Tj\n`;
    });
    stream += "ET\n";
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
    const streamId = objects.length;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents ${streamId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    kidIds.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Count ${kidIds.length} /Kids [${kidIds.map((id) => `${id} 0 R`).join(" ")}] >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

export async function downloadReportPdf(c) {
  const s = buildReportSections(c);
  const bytes = buildReportPdfBytes(c);
  triggerDownload(new Blob([bytes], { type: "application/pdf" }), `${s.fileBase}.pdf`);
}
