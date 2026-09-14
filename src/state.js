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

export function setState(patch) {
  Object.assign(state, patch);
  // 1. Notify pub/sub subscribers
  for (const fn of listeners) fn();
  // 2. Also fire a DOM event so any non-subscriber listener can react
  window.dispatchEvent(new CustomEvent("state-render"));
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
