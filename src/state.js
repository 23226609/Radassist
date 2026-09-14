// src/state.js
// Minimal pub-sub state store. The whole app subscribes once and re-renders
// on every state change.

const listeners = new Set();

export const state = {
  user: null,         // session user
  token: null,
  page: "login",      // current page: login | register | dashboard | new | review | cases | audit
  cases: [],          // all cases cached in memory
  selectedCaseId: null,
  selectedPatientId: null,
  pendingFilter: { status: "all", q: "", urgentOnly: false },
  loading: false,
  errorMsg: "",
  toast: "",          // transient banner text
};

function currentHash() {
  try { return String(window.location?.hash || ""); }
  catch { return ""; }
}

function writeHash(hash, { replace } = {}) {
  try {
    if (!window.location || currentHash() === hash) return;
    if (replace && window.history?.replaceState) {
      const url = new URL(window.location.href);
      url.hash = hash;
      window.history.replaceState(null, "", url);
      return;
    }
    window.location.hash = hash;
  } catch { /* linkedom / tests */ }
}

export function parseHash(hash = currentHash()) {
  const raw = String(hash || "").replace(/^#/, "").split("?")[0];
  const parts = raw.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); }
    catch { return part; }
  });
  const head = String(parts[0] || "").toLowerCase();
  if (!head || head === "dashboard" || head === "worklist") {
    return { page: "dashboard", selectedCaseId: null, selectedPatientId: null };
  }
  if (head === "login") return { page: "login" };
  if (head === "register") return { page: "register" };
  if (head === "audit") return { page: "audit" };
  if (head === "patients") {
    if (parts[1] === "new") return { page: "new-patient" };
    if (parts[1]) return { page: "patient", selectedPatientId: parts.slice(1).join("/") };
    return { page: "patients", selectedPatientId: null };
  }
  if (head === "cases") {
    if (parts[1] === "new") return { page: "new" };
    if (parts[1]) return { page: "case", selectedCaseId: parts[1] };
    return { page: "cases", selectedCaseId: null };
  }
  if (head === "review" && parts[1]) return { page: "review", selectedCaseId: parts[1] };
  if (head === "new") return { page: "new" };
  return { page: "dashboard" };
}

export function hashFor(s = state) {
  switch (s.page) {
    case "login": return "#/login";
    case "register": return "#/register";
    case "patients": return "#/patients";
    case "new-patient": return "#/patients/new";
    case "patient":
      return s.selectedPatientId
        ? `#/patients/${encodeURIComponent(s.selectedPatientId)}`
        : "#/patients";
    case "cases": return "#/cases";
    case "new": return "#/cases/new";
    case "case":
      return s.selectedCaseId
        ? `#/cases/${encodeURIComponent(s.selectedCaseId)}`
        : "#/cases";
    case "review":
      return s.selectedCaseId
        ? `#/review/${encodeURIComponent(s.selectedCaseId)}`
        : "#/cases";
    case "audit": return "#/audit";
    default: return "#/dashboard";
  }
}

export function applyHash() {
  const next = parseHash();
  const page = next.page || "dashboard";
  const patch = { page };
  if (next.selectedCaseId !== undefined) patch.selectedCaseId = next.selectedCaseId;
  if (next.selectedPatientId !== undefined) patch.selectedPatientId = next.selectedPatientId;
  if (
    page === state.page
    && (next.selectedCaseId === undefined || next.selectedCaseId === state.selectedCaseId)
    && (next.selectedPatientId === undefined || next.selectedPatientId === state.selectedPatientId)
  ) {
    return false;
  }
  setState(patch, { skipHash: true });
  return true;
}

export function setState(patch, { skipHash, replaceHash } = {}) {
  Object.assign(state, patch);
  if (!skipHash) writeHash(hashFor(state), { replace: replaceHash });
  for (const fn of listeners) fn();
  try { window.dispatchEvent(new CustomEvent("state-render")); }
  catch { /* tests without window events */ }
}

export function setPage(page, payload = {}) {
  setState({ page, ...payload });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Write the banner straight into the DOM. Going through setState() remounts
// the current page and wipes whatever the clinician was typing.
export function toast(msg, ms = 3500) {
  const text = String(msg || "").trim();
  let host = document.getElementById("radassist-toast");
  if (!host && typeof document !== "undefined" && document.body) {
    host = document.createElement("div");
    host.id = "radassist-toast";
    host.className = "pointer-events-none fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white shadow-lg";
    document.body.appendChild(host);
  }
  if (!host) return;
  host.textContent = text;
  host.hidden = !text;
  host.classList.remove("toast-in");
  void host.offsetWidth;
  if (text) host.classList.add("toast-in");
  clearTimeout(toast._timer);
  toast._timer = text
    ? setTimeout(() => {
        if (host.textContent === text) host.hidden = true;
      }, ms)
    : null;
}
