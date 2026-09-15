// src/lib/diagnosis.js
// Which dashboard rows still need an Azure worklist label.

import { isGenerating } from "./caseStatus.js";

export function needsAzureDiagnosis(c = {}) {
  if (isGenerating(c)) return false;
  if (!String(c.reportText || "").trim()) return false;
  const d = String(c.diagnosis || "").trim();
  const impression = String(c.reportText || "").match(/\b(?:impression|conclusion)\s*[:.\-]\s*([^\n]+)/i)?.[1] || "";
  const canned = /\bno acute cardiopulmonary (findings?|process|abnormalit(?:y|ies))\b/i;
  const prose = d.length > 50
    || /^(the |this |there )/i.test(d)
    || /\b(demonstrates|shows|reveals)\b/i.test(d);
  if (prose) return true;
  if (canned.test(d) && impression.trim() && !canned.test(impression)) return true;
  if (c.diagnosisSource === "azure") return false;
  if (c.diagnosisSource === "local") return true;
  if (!d) return true;
  if (/generating report/i.test(d)) return false;
  if (/^(awaiting ai analysis|ai report)$/i.test(d)) return true;
  if (/^chest x[- ]?ray/i.test(d)) return true;
  return d.length > 90;
}
