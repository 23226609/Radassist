// Case workflow status.
// pending          = film stored, report still generating
// pending_approve  = draft ready, waiting for the clinician
// finalized        = signed off
// completed        = old name for pending_approve (still in Mongo)

export function caseStatus(s) {
  if (s === "completed") return "pending_approve";
  return s || "pending_approve";
}

export function isGenerating(c = {}) {
  return Boolean(c) && c.status === "pending";
}

export function isAwaitingApprove(c = {}) {
  if (!c) return false;
  return caseStatus(c.status) === "pending_approve";
}

export function statusLabel(s) {
  const v = caseStatus(s);
  if (v === "pending") return "Generating";
  if (v === "pending_approve") return "Pending approve";
  if (v === "finalized") return "Finalized";
  return v;
}

export function statusBadgeClass(s) {
  const v = caseStatus(s);
  if (v === "pending") return "bg-amber-50 text-amber-700";
  if (v === "pending_approve") return "bg-cyan-50 text-cyan-700";
  if (v === "finalized") return "bg-green-50 text-green-700";
  return "bg-slate-100 text-slate-700";
}
