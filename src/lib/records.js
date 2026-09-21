// Drop local caches after Mongo add/delete so lists match the database.

import { state, setPage } from "../state.js";
import { CASES_CHANGED, stopAnalysisWatchIf } from "./analysisJob.js";

function emitSync(ids = []) {
  try {
    window.dispatchEvent(new CustomEvent(CASES_CHANGED, { detail: { sync: true, ids } }));
  } catch { /* tests */ }
}

export function forgetCases(ids = []) {
  const set = new Set((ids || []).map(String).filter(Boolean));
  stopAnalysisWatchIf([...set]);
  state.cases = (state.cases || []).filter(
    (c) => !set.has(String(c.caseId || "")) && !set.has(String(c._id || ""))
  );
  const viewingDeleted = set.has(String(state.selectedCaseId || ""));
  const leave = viewingDeleted && (state.page === "review" || state.page === "case");
  if (viewingDeleted) state.selectedCaseId = null;
  emitSync([...set]);
  if (leave) setPage("dashboard");
}

export function forgetPatients(patientIds = []) {
  const set = new Set(
    (patientIds || []).map((id) => String(id || "").toLowerCase()).filter(Boolean)
  );
  const dropped = (state.cases || [])
    .filter((c) => set.has(String(c.patientId || "").toLowerCase()))
    .map((c) => c.caseId || c._id);
  if (set.has(String(state.selectedPatientId || "").toLowerCase())) {
    state.selectedPatientId = null;
  }
  if (dropped.length) forgetCases(dropped);
  else emitSync();
}
