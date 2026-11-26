// "Download PDF" for the patient: the same endorsed report the doctor downloads from the worklist
// (buildReportBlocks in reportExport.js, the plain variant), written by the project's own PDF writer.
// The plain-language summary is not part of it, and neither is the case ID.
//
// It is built from one patient case, as the server already limited it for that patient: the report text,
// the endorser and the dates. CURV's draft, the Second Reader, agent evidence and the audit log never reach
// the patient's browser, so they cannot be in this file. The patient has no access to the film, so the
// report is text only.

import { buildReportBlocks, buildReportPdfBytes, triggerDownload } from "./reportExport.js";
import { rasterBlocks } from "./pdfRaster.js";
import { reportDate } from "../components/patientReportNav.js";

function patientName(c) {
  const full = String(c?.patientName || "").trim();
  if (full) return full;
  return [c?.firstName, c?.middleName, c?.lastName].map((x) => String(x || "").trim()).filter(Boolean).join(" ");
}

// The only parts of a case the PDF may read, the same list the server gives a patient. Anything else on the
// object (history, findings, edit log, AI output...) is dropped before the report is laid out.
const ALLOWED = ["patientId", "patientName", "firstName", "middleName", "lastName", "age", "sex", "status", "view", "examinedAt", "finalizedAt", "finalizedByName", "reportText"];
const allowListed = (c) => Object.fromEntries(ALLOWED.filter((k) => c?.[k] !== undefined).map((k) => [k, c[k]]));

/** The doctor's report, with the patient's name in place of the case ID, and without a "Referring doctor" row (not sent to patients). */
export function buildPatientReportBlocks(c) {
  const blocks = buildReportBlocks(allowListed(c), "plain");
  const name = patientName(c);
  const out = [];
  for (const b of blocks) {
    if (b.type === "line" && /^Case\b/.test(b.text || "")) {
      if (name) out.push({ type: "field", label: "Patient name", value: name });
    } else if (b.type === "field" && b.label === "Referring doctor") continue;
    else out.push(b);
  }
  return out;
}

export function patientPdfName(c) {
  return `RadAssist-Report-${(reportDate(c) || "report").replace(/\//g, "-")}.pdf`;
}

/** Make and save the PDF. Only an endorsed report gets one. `raster` and `save` are for tests. */
export async function downloadPatientReportPdf(c, { raster, save = triggerDownload } = {}) {
  if (c?.status !== "finalized") throw new Error("Only an endorsed report can be downloaded.");
  const blocks = await rasterBlocks(buildPatientReportBlocks(c), raster);
  const bytes = buildReportPdfBytes(c, null, { blocks, images: [] });
  save(new Blob([bytes], { type: "application/pdf" }), patientPdfName(c));
}
