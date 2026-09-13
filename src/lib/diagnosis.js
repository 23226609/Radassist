// src/lib/diagnosis.js
// Which dashboard rows still need an Azure worklist label.

export function needsAzureDiagnosis(c = {}) {
  if (c.diagnosisSource === "azure") return false;
  if (!String(c.reportText || "").trim()) return false;
  if (c.diagnosisSource === "local") return true;
  const d = String(c.diagnosis || "").trim();
  if (!d) return true;
  if (/^(awaiting ai analysis|ai report)$/i.test(d)) return true;
  if (/^chest x[- ]?ray/i.test(d)) return true;
  return d.length > 90;
}
