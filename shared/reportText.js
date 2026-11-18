// shared/reportText.js
// Plain-text rules for a stored report, with no DOM and no imports. The
// browser (src/lib/reportExport.js) and the Express API both use this file,
// so Thinking, remarks and the free-form CURV shape are handled one way.

export const REMARKS_HEADING = "Radiologist remarks";

export function splitOnHeading(reportText, heading) {
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

// A Thinking block runs until the next heading of the report. COMMENT is the
// heading that replaces Impression in the private-practice layout.
const NEXT_HEADING = "Findings|Impression|Conclusion|COMMENT|Radiologist remarks|Clinician-added findings";
const THINKING_BLOCK = new RegExp(
  `(^|\\n)([ \\t]*#*\\s*Thinking\\s*:?[ \\t]*\\n[\\s\\S]*?)(?=\\n[ \\t]*#*\\s*(?:${NEXT_HEADING})\\s*:?[ \\t]*\\n|$)`,
  "i"
);

// The model's reasoning is kept in the stored draft but never shown or exported.
export function withoutThinking(reportText) {
  const src = String(reportText || "").replace(/\r\n/g, "\n");
  const cleaned = src.replace(new RegExp(THINKING_BLOCK.source, "gi"), "$1");
  return cleaned.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The stored Thinking block, "Thinking:\n..." with its heading, or "".
export function thinkingBlockOf(reportText) {
  const match = String(reportText || "").replace(/\r\n/g, "\n").match(THINKING_BLOCK);
  return match ? match[2].trim() : "";
}

// Put the stored Thinking block back into an edited body so saving does not
// drop it. It goes before the closing section.
export function restoreThinking(original, edited) {
  const text = String(edited || "").replace(/\r\n/g, "\n").trim();
  const block = thinkingBlockOf(original);
  if (!block || THINKING_BLOCK.test(text)) return text;
  const at = text.search(/(^|\n)[ \t]*#*\s*(?:Impression|Conclusion|COMMENT)\s*:?[ \t]*(\n|$)/i);
  if (at < 0) return `${text}\n\n${block}`.trim();
  return `${text.slice(0, at).trimEnd()}\n\n${block}\n\n${text.slice(at).trimStart()}`.trim();
}
