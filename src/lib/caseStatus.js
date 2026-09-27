// Case workflow status.
// pending          = film stored, report still generating
// pending_approve  = draft ready, waiting for the clinician
// finalized        = signed off
// completed        = old name for pending_approve (still in Mongo)

export function caseStatus(s) {
  if (s === "completed") return "pending_approve";
  return s || "pending_approve";
}

export function analysisStateOf(c = {}) {
  if (c.analysisState === "none" || c.analysisState === "running" || c.analysisState === "done") {
    return c.analysisState;
  }
  if (caseStatus(c.status) === "pending") {
    if (/generating report/i.test(String(c.diagnosis || ""))) return "running";
    if (!String(c.reportText || "").trim()) return "none";
  }
  return "done";
}

export function isGenerating(c = {}) {
  return Boolean(c) && analysisStateOf(c) === "running";
}

export function isAwaitingAi(c = {}) {
  return Boolean(c) && caseStatus(c.status) === "pending" && analysisStateOf(c) === "none";
}

export function isAwaitingApprove(c = {}) {
  if (!c) return false;
  return caseStatus(c.status) === "pending_approve";
}

export function statusLabel(s, c) {
  if (c && isGenerating(c)) return "Generating";
  if (c && isAwaitingAi(c)) return "Awaiting AI";
  const v = caseStatus(typeof s === "object" ? s?.status : s);
  if (v === "pending") return "Awaiting AI";
  if (v === "pending_approve") return "Pending approve";
  if (v === "finalized") return "Finalized";
  return v;
}

export function statusBadgeClass(s, c) {
  if (c && isGenerating(c)) return "bg-amber-50 text-amber-700";
  if (c && isAwaitingAi(c)) return "bg-violet-50 text-violet-700";
  const v = caseStatus(typeof s === "object" ? s?.status : s);
  if (v === "pending") return "bg-violet-50 text-violet-700";
  if (v === "pending_approve") return "bg-blue-50 text-ha-blue";
  if (v === "finalized") return "bg-green-50 text-green-700";
  return "bg-slate-100 text-slate-700";
}
