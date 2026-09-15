// Centered overlay + poll while CURV writes the draft report.

import { api } from "../api.js";
import { toast, setPage } from "../state.js";
import { isGenerating } from "./caseStatus.js";

const HOST_ID = "radassist-analysis";
const DONE = "radassist-cases-changed";
const POLL_MS = 2000;
const TIMEOUT_MS = 240000;
const BOX = "fixed inset-0 z-[60] items-center justify-center bg-slate-950/45 p-6";

let timer = null;
let watchingId = "";
let startedAt = 0;

function host() {
  let node = document.getElementById(HOST_ID);
  if (node) return node;
  if (typeof document === "undefined" || !document.body) return null;
  node = document.createElement("div");
  node.id = HOST_ID;
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  node.innerHTML = `
    <div class="w-full max-w-sm rounded-2xl bg-white px-8 py-8 text-center shadow-2xl">
      <div class="mx-auto h-11 w-11 animate-spin rounded-full border-4 border-slate-200 border-t-cyan-600"></div>
      <p class="mt-5 text-lg font-semibold text-slate-900">Generating the report</p>
      <p id="radassist-analysis-detail" class="mt-2 text-sm text-slate-500"></p>
    </div>
  `;
  document.body.appendChild(node);
  setOverlayOpen(node, false);
  return node;
}

function setOverlayOpen(node, open) {
  // Tailwind `flex` overrides the HTML `hidden` attribute, so the overlay
  // stayed on screen after the draft was ready. Toggle classes instead.
  node.className = `${BOX} ${open ? "flex" : "hidden"}`;
  node.hidden = !open;
  node.setAttribute("aria-hidden", open ? "false" : "true");
}

function setDetail(text) {
  const n = document.getElementById("radassist-analysis-detail");
  if (n) n.textContent = text || "Report and finding cards usually take a minute or two.";
}

export function showAnalysisOverlay(detail) {
  const node = host();
  if (!node) return;
  setDetail(detail);
  setOverlayOpen(node, true);
}

export function hideAnalysisOverlay() {
  const node = document.getElementById(HOST_ID);
  if (node) setOverlayOpen(node, false);
}

export function stopAnalysisWatch() {
  if (timer) clearInterval(timer);
  timer = null;
  watchingId = "";
  hideAnalysisOverlay();
}

export function stopAnalysisWatchIf(ids = []) {
  if (!watchingId) return;
  if ((ids || []).some((id) => String(id) === String(watchingId))) {
    stopAnalysisWatch();
  }
}

function finish(ok, message, created) {
  const id = created?.caseId || created?._id || watchingId;
  stopAnalysisWatch();
  if (message) toast(message);
  if (ok && id) setPage("review", { selectedCaseId: id });
  try {
    window.dispatchEvent(new CustomEvent(DONE, { detail: { ok, case: created || null } }));
  } catch { /* tests */ }
}

async function tick() {
  const id = watchingId;
  if (!id) return;
  if (Date.now() - startedAt > TIMEOUT_MS) {
    finish(false, "The report is taking longer than expected. Refresh the worklist in a moment.");
    return;
  }
  try {
    const data = await api.getCase(id);
    const c = data.case || data;
    if (!isGenerating(c)) {
      finish(true, "Draft ready — pending approve.", c);
    }
  } catch {
    /* keep waiting until timeout */
  }
}

export function startAnalysisWatch({ caseId, patientName, patientId } = {}) {
  if (timer) clearInterval(timer);
  timer = null;
  if (!caseId) return;
  watchingId = caseId;
  startedAt = Date.now();
  const who = [patientName, patientId].filter(Boolean).join(" · ");
  showAnalysisOverlay(who ? `${who}. Report and finding cards usually take a minute or two.` : "Report and finding cards usually take a minute or two.");
  tick();
  timer = setInterval(tick, POLL_MS);
}

export const CASES_CHANGED = DONE;
